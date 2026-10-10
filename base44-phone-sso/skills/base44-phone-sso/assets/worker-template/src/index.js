// index.js - a minimal OIDC identity provider that verifies a phone number with
// a one-time code on WhatsApp and hands Base44 a stable email for it.
//
// Why this exists: Base44 SSO only accepts standard OIDC providers and keys
// every user by email. A phone-only user has no email, so off-the-shelf
// providers fail with "Email not returned by OAuth provider". This Worker
// derives <phone>@<domain>, so the same phone always lands on the same user.
//
// Flow:
//   Base44 -> GET  /authorize          (stores the OIDC request in KV, serves the page)
//             POST /authorize/send     (allowlist -> OTP -> WhatsApp)
//             POST /authorize/verify   (check code -> authorization code -> back to Base44)
//   Base44 -> POST /token              (authorization code -> RS256-signed id_token)
//
// Guiding rule: everything the browser sends is hostile. The OIDC request is
// stored server-side under a one-time sid and is never read back from a POST.

import { signJwt, sha256Hex, timingSafeEqual, randomDigits, randomToken, s256Challenge } from "./crypto.js";
import { normalizePhone } from "./phone.js";
import { sendOtp } from "./otp.js";
import { isPhoneAuthorized } from "./allowlist.js";
import { ensureBase44User, completeUserProfile, logLoginAttempt } from "./provision.js";
import { loginPage, errorPage } from "./page.js";
import { messages } from "./messages.js";

const OTP_LENGTH = 6;
const OTP_TTL_SEC = 300;              // 5 minutes
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_SEC = 45;   // tune with OTP_RESEND_COOLDOWN
const AUTH_REQ_TTL_SEC = 900;         // 15 minutes to finish a login
const AUTH_CODE_TTL_SEC = 120;
const ID_TOKEN_TTL_SEC = 3600;
// Rate limits, tunable without a code change. They exist so nobody can flood a
// person with codes (harassment + cost), not to make testing painful.
const SEND_LIMIT_PER_PHONE_PER_HOUR = 5;
const SEND_LIMIT_PER_IP_PER_HOUR = 20;
const numEnv = (env, key, fallback) => {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const html = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });

function issuerOf(env, url) {
  return (env.ISSUER || `${url.protocol}//${url.host}`).replace(/\/$/, "");
}

function allowedRedirectUris(env) {
  return String(env.ALLOWED_REDIRECT_URIS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

// THE DOMAIN OF THE DERIVED EMAIL IS EVERY USER'S IDENTITY. Set
// SYNTHETIC_EMAIL_DOMAIN once, before the first real login, and never touch it
// again. Unset (or still the template placeholder), it falls back to this
// Worker's host name, which is what version 1 of this template did; that keeps
// an upgraded deployment on the same identities, but it also means renaming
// the Worker or moving it to another domain would change them. Set it explicitly.
function syntheticEmail(env, phone, url) {
  const configured = String(env.SYNTHETIC_EMAIL_DOMAIN || "");
  const domain = configured && !configured.startsWith("__") ? configured : new URL(issuerOf(env, url)).host;
  return `${phone}@${domain}`;
}

// ---------- trusted proxy (login page served from the app's own domain) ----------
// Why: networks and devices with content filtering often block *.workers.dev
// and show a blank page, which looks like a "login loop". A backend function
// in the Base44 app can serve /authorize + send + verify from the app's domain
// and forward to this Worker (assets/base44-functions/phoneLogin). It proves
// itself with a shared secret, and only then do we accept from it the real
// client IP (otherwise every user would share the proxy's single IP for rate
// limiting) and the public URL the page should post to.
function proxyTrusted(req, env) {
  const secret = env.PROXY_SHARED_SECRET || "";
  if (!secret) return false;
  return timingSafeEqual(req.headers.get("X-Proxy-Secret") || "", secret);
}

function clientIp(req, env) {
  if (proxyTrusted(req, env)) {
    const real = (req.headers.get("X-Real-Client-IP") || "").trim();
    if (real) return real;
  }
  return req.headers.get("CF-Connecting-IP") || "unknown";
}

// Hourly window counter in KV. Returns true when the limit is EXCEEDED.
async function bumpRateLimit(env, key, limit) {
  const bucket = Math.floor(Date.now() / 3600000);
  const k = `rl:${key}:${bucket}`;
  const current = Number((await env.OIDC_KV.get(k)) || 0);
  if (current >= limit) return true;
  await env.OIDC_KV.put(k, String(current + 1), { expirationTtl: 3700 });
  return false;
}

// ---------- OIDC discovery ----------

function discovery(env, url) {
  const iss = issuerOf(env, url);
  return {
    issuer: iss,
    // Can point at the app-domain proxy. Empty = this Worker. Base44 reads this
    // document on every login, so switching takes effect immediately.
    authorization_endpoint: env.PUBLIC_AUTHORIZE_URL || `${iss}/authorize`,
    token_endpoint: `${iss}/token`,
    userinfo_endpoint: `${iss}/userinfo`,
    jwks_uri: `${iss}/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "email", "profile"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256", "plain"],
    claims_supported: ["sub", "iss", "aud", "exp", "iat", "nonce", "email", "email_verified", "name", "phone_number"],
  };
}

// ---------- /authorize ----------

async function handleAuthorize(req, env, url) {
  const t = messages(env);
  const q = url.searchParams;
  const clientId = q.get("client_id");
  const redirectUri = q.get("redirect_uri");
  const responseType = q.get("response_type");

  if (!timingSafeEqual(clientId || "", env.OIDC_CLIENT_ID)) {
    return html(errorPage(t.badRequestTitle, t.badClient, t), 400);
  }
  if (responseType !== "code") {
    return html(errorPage(t.badRequestTitle, t.badResponseType, t), 400);
  }
  const allowed = allowedRedirectUris(env);
  if (!redirectUri || !allowed.includes(redirectUri)) {
    // Never redirect to an unapproved address: that is exactly how
    // authorization codes get stolen
    return html(errorPage(t.badRequestTitle, t.badRedirect, t), 400);
  }

  const sid = randomToken(24);
  await env.OIDC_KV.put(
    `req:${sid}`,
    JSON.stringify({
      client_id: clientId,
      redirect_uri: redirectUri,
      state: q.get("state") || "",
      nonce: q.get("nonce") || "",
      scope: q.get("scope") || "openid email",
      code_challenge: q.get("code_challenge") || "",
      code_challenge_method: (q.get("code_challenge_method") || "").toUpperCase(),
    }),
    { expirationTtl: AUTH_REQ_TTL_SEC },
  );

  // Through a trusted proxy the page must post to the proxy (same origin for
  // the user's browser), not to this Worker
  const proxyBase = proxyTrusted(req, env) ? (req.headers.get("X-Proxy-Base") || "").trim() : "";
  return html(loginPage({
    sid,
    appName: env.APP_NAME || t.defaultAppName,
    accent: env.BRAND_ACCENT || "#2b2724",
    senderNote: env.LOGIN_SENDER_NOTE || "",
    sendUrl: proxyBase ? `${proxyBase}?op=send` : "/authorize/send",
    verifyUrl: proxyBase ? `${proxyBase}?op=verify` : "/authorize/verify",
    t,
    lang: String(env.LOCALE || "he").toLowerCase(),
  }));
}

async function loadRequest(env, sid) {
  if (!sid || typeof sid !== "string") return null;
  const raw = await env.OIDC_KV.get(`req:${sid}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// ---------- /authorize/send ----------

async function handleSend(req, env, ctx) {
  const t = messages(env);
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));
  const authReq = await loadRequest(env, body.sid);
  if (!authReq) return json({ message: t.sessionExpired }, 400);

  const country = env.DEFAULT_COUNTRY_CODE || "972";
  const phone = normalizePhone(body.phone, country);
  if (!phone || phone.length < 10) return json({ message: t.badPhone }, 400);

  const ip = clientIp(req, env);
  if (await bumpRateLimit(env, `ip:${ip}`, numEnv(env, "SEND_LIMIT_PER_IP", SEND_LIMIT_PER_IP_PER_HOUR))) {
    return json({ message: t.tooManyIp }, 429);
  }

  const gate = await isPhoneAuthorized(env, phone);
  if (!gate.allowed) {
    // The same message for every reason: never reveal who is on the list
    console.warn("ACCESS_DENIED", gate.reason);
    return json({ message: t.denied }, 403);
  }

  if (await bumpRateLimit(env, `phone:${phone}`, numEnv(env, "SEND_LIMIT_PER_PHONE", SEND_LIMIT_PER_PHONE_PER_HOUR))) {
    return json({ message: t.tooManyPhone }, 429);
  }

  const existingRaw = await env.OIDC_KV.get(`otp:${phone}`);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw);
      const cooldown = numEnv(env, "OTP_RESEND_COOLDOWN", OTP_RESEND_COOLDOWN_SEC);
      const since = (Date.now() - (existing.sentAt || 0)) / 1000;
      if (since < cooldown) {
        return json({ message: t.cooldown(Math.ceil(cooldown - since)) }, 429);
      }
    } catch (_) { /* corrupt record: just overwrite it */ }
  }

  const code = randomDigits(OTP_LENGTH);
  // Only a hash is stored: a leak of the KV is not enough to impersonate anyone
  await env.OIDC_KV.put(
    `otp:${phone}`,
    JSON.stringify({ hash: await sha256Hex(`${phone}:${code}`), attempts: 0, sentAt: Date.now() }),
    { expirationTtl: OTP_TTL_SEC },
  );

  // An email this person is already linked to wins over the derived one.
  // Without this, someone the owner registered with a real address would get a
  // second identity under the synthetic address: a duplicate.
  const loginEmail = gate.email || syntheticEmail(env, phone, url);

  const sent = await sendOtp(env, phone, code);
  // Optional admin-visible log (never the code itself). In the background, so
  // it cannot delay the answer. Logged on failure too.
  ctx.waitUntil(logLoginAttempt(env, { phone, email: loginEmail, name: gate.name || "", sent }));
  if (!sent.ok) {
    await env.OIDC_KV.delete(`otp:${phone}`);
    return json({ message: t.sendFailed }, 502);
  }

  await env.OIDC_KV.put(`sid_phone:${body.sid}`, phone, { expirationTtl: AUTH_REQ_TTL_SEC });

  // Provision the user now, in the background. Base44 creates the row
  // asynchronously, and the seconds the person spends waiting for the code and
  // typing it are a far more generous window than a synchronous wait at the
  // moment they press "log in".
  ctx.waitUntil(ensureBase44User(env, { email: loginEmail, authId: gate.authId || "" }));
  if (gate.name) {
    await env.OIDC_KV.put(`sid_name:${body.sid}`, gate.name, { expirationTtl: AUTH_REQ_TTL_SEC });
  }
  await env.OIDC_KV.put(`sid_email:${body.sid}`, loginEmail, { expirationTtl: AUTH_REQ_TTL_SEC });
  if (gate.authId) {
    await env.OIDC_KV.put(`sid_auth:${body.sid}`, gate.authId, { expirationTtl: AUTH_REQ_TTL_SEC });
  }
  return json({ ok: true });
}

// ---------- /authorize/verify ----------

async function handleVerify(req, env, ctx) {
  const t = messages(env);
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));
  const authReq = await loadRequest(env, body.sid);
  if (!authReq) return json({ message: t.sessionExpired }, 400);

  const phone = await env.OIDC_KV.get(`sid_phone:${body.sid}`);
  if (!phone) return json({ message: t.noCodeSent }, 400);

  const raw = await env.OIDC_KV.get(`otp:${phone}`);
  if (!raw) return json({ message: t.codeExpired }, 400);

  let rec;
  try { rec = JSON.parse(raw); } catch (_) {
    await env.OIDC_KV.delete(`otp:${phone}`);
    return json({ message: t.codeExpired }, 400);
  }

  if ((rec.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    await env.OIDC_KV.delete(`otp:${phone}`);
    return json({ message: t.tooManyAttempts }, 429);
  }

  const supplied = String(body.code || "").replace(/\D/g, "");
  const ok = timingSafeEqual(await sha256Hex(`${phone}:${supplied}`), rec.hash);

  if (!ok) {
    rec.attempts = (rec.attempts || 0) + 1;
    const left = Math.max(0, OTP_MAX_ATTEMPTS - rec.attempts);
    // Keep the ORIGINAL expiry, so wrong attempts cannot extend the code's life
    const elapsed = Math.floor((Date.now() - (rec.sentAt || Date.now())) / 1000);
    const ttl = Math.max(1, OTP_TTL_SEC - elapsed);
    await env.OIDC_KV.put(`otp:${phone}`, JSON.stringify(rec), { expirationTtl: ttl });
    return json({ message: t.wrongCode(left) }, 400);
  }

  // Success: the code is burned at once, it cannot be replayed
  await env.OIDC_KV.delete(`otp:${phone}`);

  // Make sure the user row exists in Base44 BEFORE returning an authorization
  // code. If that fails we stop here with a clear message, instead of sending
  // the person back into Base44's generic "An error occurred during login".
  const existingEmail = await env.OIDC_KV.get(`sid_email:${body.sid}`);
  const email = existingEmail || syntheticEmail(env, phone, url);
  const gateName = await env.OIDC_KV.get(`sid_name:${body.sid}`);
  const authId = await env.OIDC_KV.get(`sid_auth:${body.sid}`);
  const provisioned = await ensureBase44User(env, { email, authId: authId || "" });
  if (!provisioned.ok) {
    return json({ message: t.provisionFailed }, 502);
  }

  // Filling in the profile runs in the background; it must not delay the login
  if (provisioned.needsProfile) {
    ctx.waitUntil(completeUserProfile(env, { email, phone, fullName: gateName || "" }));
  }

  await env.OIDC_KV.delete(`sid_phone:${body.sid}`);
  await env.OIDC_KV.delete(`sid_name:${body.sid}`);
  await env.OIDC_KV.delete(`sid_email:${body.sid}`);
  await env.OIDC_KV.delete(`sid_auth:${body.sid}`);
  await env.OIDC_KV.delete(`req:${body.sid}`);

  const authCode = randomToken(32);
  await env.OIDC_KV.put(
    `code:${authCode}`,
    JSON.stringify({
      phone,
      nonce: authReq.nonce,
      client_id: authReq.client_id,
      redirect_uri: authReq.redirect_uri,
      code_challenge: authReq.code_challenge || "",
      code_challenge_method: authReq.code_challenge_method || "",
      // The email chosen at verification (existing > derived). /token must use
      // it and not derive again, or the id_token would carry a different
      // identity from the one that was provisioned.
      email,
      // The name from the allowlist. It is sent as the id_token's `name` claim,
      // which is where Base44 takes the user's full_name from (the way Google
      // supplies a name). Without it the phone number becomes the name, and it
      // cannot be fixed later: full_name belongs to the auth system and a User
      // update silently ignores it.
      name: gateName || "",
    }),
    { expirationTtl: AUTH_CODE_TTL_SEC },
  );

  const dest = new URL(authReq.redirect_uri);
  dest.searchParams.set("code", authCode);
  if (authReq.state) dest.searchParams.set("state", authReq.state);
  return json({ redirect: dest.toString() });
}

// ---------- /token ----------

function clientCredsFrom(req, form) {
  const auth = req.headers.get("Authorization") || "";
  if (auth.startsWith("Basic ")) {
    try {
      const [id, secret] = atob(auth.slice(6)).split(":");
      return { id: decodeURIComponent(id || ""), secret: decodeURIComponent(secret || "") };
    } catch (_) { /* fall through to the body parameters */ }
  }
  return { id: form.get("client_id") || "", secret: form.get("client_secret") || "" };
}

async function handleToken(req, env, url) {
  const form = new URLSearchParams(await req.text());
  const creds = clientCredsFrom(req, form);

  if (!timingSafeEqual(creds.id, env.OIDC_CLIENT_ID) ||
      !timingSafeEqual(creds.secret, env.OIDC_CLIENT_SECRET)) {
    return json({ error: "invalid_client" }, 401);
  }
  if (form.get("grant_type") !== "authorization_code") {
    return json({ error: "unsupported_grant_type" }, 400);
  }

  const code = form.get("code") || "";
  const raw = await env.OIDC_KV.get(`code:${code}`);
  if (!raw) return json({ error: "invalid_grant" }, 400);
  // One-time: deleted before the token is issued
  await env.OIDC_KV.delete(`code:${code}`);

  let rec;
  try { rec = JSON.parse(raw); } catch (_) { return json({ error: "invalid_grant" }, 400); }

  const suppliedRedirect = form.get("redirect_uri");
  if (suppliedRedirect && suppliedRedirect !== rec.redirect_uri) {
    return json({ error: "invalid_grant" }, 400);
  }

  // PKCE (RFC 7636). Base44 turns it on by default. If a challenge was stored
  // it is mandatory; otherwise a stolen authorization code could be redeemed
  // without the verifier.
  if (rec.code_challenge) {
    const verifier = form.get("code_verifier") || "";
    if (!verifier) return json({ error: "invalid_grant", error_description: "code_verifier required" }, 400);
    const method = rec.code_challenge_method || "PLAIN";
    let computed;
    if (method === "S256") computed = await s256Challenge(verifier);
    else if (method === "PLAIN") computed = verifier;
    else return json({ error: "invalid_request", error_description: "unsupported code_challenge_method" }, 400);
    if (!timingSafeEqual(computed, rec.code_challenge)) {
      return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    }
  }

  const iss = issuerOf(env, url);
  const now = Math.floor(Date.now() / 1000);
  const email = rec.email || syntheticEmail(env, rec.phone, url);

  const claims = {
    iss,
    sub: rec.phone,
    aud: env.OIDC_CLIENT_ID,
    iat: now,
    exp: now + ID_TOKEN_TTL_SEC,
    email,
    email_verified: true,
    name: rec.name || rec.phone,
    phone_number: `+${rec.phone}`,
    phone_number_verified: true,
  };
  if (rec.nonce) claims.nonce = rec.nonce;

  const idToken = await signJwt(claims, env.OIDC_PRIVATE_KEY, env.OIDC_KID);
  const accessToken = randomToken(32);
  await env.OIDC_KV.put(
    `at:${accessToken}`,
    JSON.stringify({ phone: rec.phone, email, name: rec.name || "" }),
    { expirationTtl: ID_TOKEN_TTL_SEC },
  );

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ID_TOKEN_TTL_SEC,
    id_token: idToken,
    scope: "openid email",
  });
}

async function handleUserinfo(req, env) {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return json({ error: "invalid_token" }, 401);
  const raw = await env.OIDC_KV.get(`at:${auth.slice(7)}`);
  if (!raw) return json({ error: "invalid_token" }, 401);
  const rec = JSON.parse(raw);
  return json({
    sub: rec.phone,
    email: rec.email,
    email_verified: true,
    name: rec.name || rec.phone,
    phone_number: `+${rec.phone}`,
  });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/$/, "") || "/";

    try {
      if (req.method === "GET" && p === "/.well-known/openid-configuration") {
        return json(discovery(env, url));
      }
      if (req.method === "GET" && p === "/jwks.json") {
        return json({ keys: [JSON.parse(env.OIDC_PUBLIC_JWK)] });
      }
      if (req.method === "GET" && p === "/health") {
        return json({ ok: true, issuer: issuerOf(env, url) });
      }
      if (req.method === "GET" && p === "/authorize") return handleAuthorize(req, env, url);
      if (req.method === "POST" && p === "/authorize/send") return handleSend(req, env, ctx);
      if (req.method === "POST" && p === "/authorize/verify") return handleVerify(req, env, ctx);
      if (req.method === "POST" && p === "/token") return handleToken(req, env, url);
      if (p === "/userinfo") return handleUserinfo(req, env);

      return json({ error: "not_found" }, 404);
    } catch (e) {
      console.error("UNHANDLED", p, String((e && e.stack) || e));
      return json({ error: "server_error" }, 500);
    }
  },
};
