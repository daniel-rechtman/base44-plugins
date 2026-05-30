/**
 * MeetVault Phone OIDC Identity Provider — Cloudflare Worker
 * =========================================================
 *
 * A self-hosted OpenID Connect (OIDC) provider that authenticates users by
 * their phone number. A 6-digit OTP is delivered over WhatsApp via the
 * Green API. The phone number IS the user identity.
 *
 * Designed to be plugged into a Base44 app as an "Advanced / Manual" SSO
 * (OIDC) provider using the authorization-code flow (confidential client),
 * with optional PKCE (S256).
 *
 * Endpoints:
 *   GET  /.well-known/openid-configuration   discovery document
 *   GET  /authorize                          phone + OTP login UI (RTL Hebrew)
 *   POST /authorize/send                     (internal) send OTP via WhatsApp
 *   POST /authorize/verify                   (internal) verify OTP -> issue code
 *   POST /token                              exchange code for tokens
 *   GET  /userinfo                           Bearer access_token -> claims
 *   GET  /jwks  and  /.well-known/jwks.json  public RSA JWK set
 *
 * Required environment (Worker secrets / vars):
 *   GREEN_API_ID            Green API idInstance
 *   GREEN_API_TOKEN         Green API apiTokenInstance
 *   OIDC_CLIENT_ID          the single allowed client_id
 *   OIDC_CLIENT_SECRET      the matching client_secret
 *   OIDC_PRIVATE_KEY        RSA-2048 private key, PKCS8 PEM
 *   OIDC_KID                key id matching the published JWK
 *   ALLOWED_REDIRECT_URI    the single allowed redirect_uri
 *   ISSUER                  (optional) override issuer origin
 *
 * KV bindings:
 *   OIDC_KV   single namespace, key prefixes used:
 *               otp:<phone>        -> { code, attempts, expiresAt }   TTL 300s
 *               authcode:<code>    -> { phone, client_id, redirect_uri,
 *                                       nonce, code_challenge, ... }  TTL 300s
 *               at:<token>         -> { phone }                       TTL 3600s
 *               rl:<phone>         -> request count (sliding window)  TTL 900s
 */

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------
const OTP_TTL_SECONDS = 300;          // OTP valid for 5 minutes
const CODE_TTL_SECONDS = 300;         // auth code valid for 5 minutes
const ACCESS_TOKEN_TTL_SECONDS = 3600; // access token / id_token valid 1 hour
const MAX_OTP_VERIFY_ATTEMPTS = 5;    // wrong-code attempts before lockout
const RL_MAX_SENDS = 5;               // max OTP sends...
const RL_WINDOW_SECONDS = 900;        // ...per 15 minutes per phone
const SCOPES_SUPPORTED = ["openid", "profile", "email", "phone"];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** JSON Response helper. */
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

/** HTML Response helper. */
function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html;charset=UTF-8",
      "cache-control": "no-store",
    },
  });
}

/** OAuth-style error redirect or JSON. */
function oauthError(error, description, status = 400) {
  return json({ error, error_description: description }, status);
}

/** base64url encode an ArrayBuffer or Uint8Array. */
function base64urlFromBytes(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url encode a UTF-8 string. */
function base64url(str) {
  return base64urlFromBytes(new TextEncoder().encode(str));
}

/** Cryptographically random token, base64url. */
function randomToken(byteLen = 32) {
  const b = new Uint8Array(byteLen);
  crypto.getRandomValues(b);
  return base64urlFromBytes(b);
}

/** Generate a numeric OTP of given length (default 6). */
function generateOtp(len = 6) {
  const digits = new Uint32Array(len);
  crypto.getRandomValues(digits);
  let out = "";
  for (let i = 0; i < len; i++) out += (digits[i] % 10).toString();
  return out;
}

/** Constant-time string comparison (mitigates timing attacks). */
function timingSafeEqual(a, b) {
  const ab = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  // Always compare to a fixed-length buffer to avoid leaking length cheaply.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] || 0) ^ (bb[i] || 0);
  }
  return diff === 0;
}

/**
 * Normalize a phone number to E.164 digits without "+", defaulting to Israel.
 * Accepts forms like: 0501234567, 050-123-4567, +972501234567, 972501234567,
 * 972-52-540-3226. Returns null if it cannot produce a plausible number.
 */
function normalizePhone(raw, defaultCountry = "972") {
  if (!raw) return null;
  // Keep leading + marker, strip everything else that is not a digit.
  let s = String(raw).trim();
  const hadPlus = s.startsWith("+") || s.startsWith("00");
  s = s.replace(/[^\d]/g, "");
  if (!s) return null;

  if (s.startsWith("00")) s = s.slice(2); // 00 prefix -> international

  if (hadPlus) {
    // Already international; just return digits.
    return s.length >= 8 && s.length <= 15 ? s : null;
  }

  // Israel local handling: leading 0 means local subscriber number.
  if (s.startsWith("0")) {
    return defaultCountry + s.slice(1);
  }

  // Already starts with country code (e.g. 972...) — accept as-is.
  if (s.startsWith(defaultCountry)) {
    return s.length >= 11 && s.length <= 15 ? s : null;
  }

  // Bare local number without leading 0 (e.g. 501234567) -> prepend country.
  if (s.length >= 8 && s.length <= 10) {
    return defaultCountry + s;
  }

  // Otherwise assume it's already a full international number.
  return s.length >= 11 && s.length <= 15 ? s : null;
}

/** Pretty +E.164 form for display/claims, e.g. "+972501234567". */
function toPlusForm(e164digits) {
  return "+" + e164digits;
}

/** Compute the issuer origin from the request, allowing ISSUER override. */
function issuerOf(request, env) {
  if (env.ISSUER) return env.ISSUER.replace(/\/+$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

// ---------------------------------------------------------------------------
// JWT signing (RS256) using Web Crypto
// ---------------------------------------------------------------------------

/** Parse a PKCS8 PEM string into an ArrayBuffer of the DER body. */
function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

let _cachedKey = null;
/** Import the RSA private key for RS256 signing (cached per isolate). */
async function importPrivateKey(pem) {
  if (_cachedKey) return _cachedKey;
  const keyData = pemToArrayBuffer(pem);
  _cachedKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return _cachedKey;
}

/** Sign a JWT (RS256). header/payload are plain objects. */
async function signJwt(header, payload, privateKeyPem) {
  const key = await importPrivateKey(privateKeyPem);
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64urlFromBytes(sig)}`;
}

/**
 * Build the public JWK from the private key PEM at runtime, so the JWKS
 * endpoint always matches the signing key. Cached per isolate.
 */
let _cachedJwk = null;
async function publicJwkFromPrivate(pem, kid) {
  if (_cachedJwk) return _cachedJwk;
  const keyData = pemToArrayBuffer(pem);
  // Import as a key we can export the public JWK from.
  const priv = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["sign"]
  );
  const fullJwk = await crypto.subtle.exportKey("jwk", priv);
  // Keep only the public components.
  _cachedJwk = {
    kty: fullJwk.kty,
    n: fullJwk.n,
    e: fullJwk.e,
    alg: "RS256",
    use: "sig",
    kid,
  };
  return _cachedJwk;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/** Verify a PKCE code_verifier against a stored S256 code_challenge. */
async function verifyPkce(codeVerifier, codeChallenge) {
  if (!codeChallenge) return true; // no PKCE was used
  if (!codeVerifier) return false;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier)
  );
  return timingSafeEqual(base64urlFromBytes(digest), codeChallenge);
}

// ---------------------------------------------------------------------------
// Green API — send WhatsApp message
// ---------------------------------------------------------------------------

async function sendWhatsAppOtp(env, phoneDigits, code) {
  const url = `https://api.green-api.com/waInstance${env.GREEN_API_ID}/sendMessage/${env.GREEN_API_TOKEN}`;
  const message =
    `קוד האימות שלך הוא: ${code}\n` +
    `הקוד תקף ל-5 דקות. אל תשתף אותו עם אף אחד.\n\n` +
    `${env.APP_NAME || "Phone Login"}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatId: `${phoneDigits}@c.us`, message }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Green API send failed: ${resp.status} ${text}`);
  }
  return resp.json().catch(() => ({}));
}

// ---------------------------------------------------------------------------
// Client / request validation
// ---------------------------------------------------------------------------

function validateClientId(env, clientId) {
  return typeof clientId === "string" && timingSafeEqual(clientId, env.OIDC_CLIENT_ID);
}

function validateRedirectUri(env, redirectUri) {
  return typeof redirectUri === "string" && redirectUri === env.ALLOWED_REDIRECT_URI;
}

/**
 * Authorization gate: is this phone allowed to log in?
 * Queries the Base44 `AuthorizedPhone` entity (managed from inside the app).
 * - If enforcement is NOT configured (no BASE44_API_KEY / BASE44_APP_ID),
 *   allow everyone (backwards compatible).
 * - If enforcement IS configured, FAIL CLOSED: deny on lookup error, on a
 *   missing record, or when the record's `approved` is explicitly false.
 * phone is the normalized E.164-without-plus form (e.g. "972501234567").
 */
async function isPhoneAuthorized(env, phone) {
  if (!env.BASE44_API_KEY || !env.BASE44_APP_ID) return true; // enforcement off
  const base = (env.BASE44_API_URL || "https://app.base44.com").replace(/\/+$/, "");
  // Fetch the whole (small) allowlist and compare on the NORMALIZED phone, so a
  // record stored in any format (0501234567 / 501234567 / +972... / 972...)
  // still matches the normalized login input. We do NOT filter server-side by
  // the exact string, because the stored string may be in a different format.
  const url =
    `${base}/api/apps/${env.BASE44_APP_ID}/entities/AuthorizedPhone?limit=1000`;
  let resp;
  try {
    resp = await fetch(url, {
      headers: { api_key: env.BASE44_API_KEY, accept: "application/json" },
    });
  } catch (e) {
    return false; // network error -> fail closed
  }
  if (!resp.ok) return false;
  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return false;
  }
  const list = Array.isArray(data)
    ? data
    : data.results || data.data || data.items || [];
  // Normalize BOTH sides before comparing; require approved !== false.
  return list.some(
    (r) => normalizePhone(r.phone) === phone && r.approved !== false
  );
}

// ---------------------------------------------------------------------------
// HTML login page (RTL Hebrew)
// ---------------------------------------------------------------------------

/**
 * Renders the single-page login UI. Step 1 (phone) and Step 2 (OTP) are both
 * present in the DOM; JavaScript toggles between them and talks to the
 * /authorize/send and /authorize/verify endpoints via fetch. The original
 * OIDC params are carried in a hidden form payload.
 */
function loginPage(params, appName = "Phone Login") {
  // params is a plain object of the validated query params; embed as JSON.
  const paramsJson = JSON.stringify(params).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>כניסה ל-${appName}</title>
<style>
  :root {
    --bg: #0b1020;
    --card: #151b2e;
    --accent: #4f8cff;
    --accent-2: #25d366;
    --text: #eef2ff;
    --muted: #9aa4c7;
    --err: #ff6b6b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center;
    background: linear-gradient(160deg, #0b1020, #131a30 60%, #0b1020);
    font-family: -apple-system, "Segoe UI", "Heebo", Arial, sans-serif;
    color: var(--text); padding: 20px;
  }
  .card {
    width: 100%; max-width: 400px; background: var(--card);
    border: 1px solid rgba(255,255,255,0.06); border-radius: 20px;
    padding: 32px 28px; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  .logo { font-size: 26px; font-weight: 800; text-align: center; margin-bottom: 6px;
          background: linear-gradient(90deg, var(--accent), var(--accent-2));
          -webkit-background-clip: text; background-clip: text; color: transparent; }
  .sub { text-align: center; color: var(--muted); font-size: 14px; margin-bottom: 26px; }
  label { display: block; font-size: 13px; color: var(--muted); margin: 0 0 8px 2px; }
  .row { display: flex; gap: 8px; }
  .cc {
    background: #0e1426; border: 1px solid rgba(255,255,255,0.08); color: var(--text);
    border-radius: 12px; padding: 0 12px; display: flex; align-items: center;
    font-size: 16px; min-width: 78px; justify-content: center;
  }
  input[type=tel], input[type=text] {
    width: 100%; background: #0e1426; border: 1px solid rgba(255,255,255,0.08);
    color: var(--text); border-radius: 12px; padding: 14px 14px; font-size: 18px;
    outline: none; transition: border-color .15s; direction: ltr; text-align: left;
  }
  input:focus { border-color: var(--accent); }
  .otp-input { letter-spacing: 10px; text-align: center; font-size: 26px; }
  button {
    width: 100%; margin-top: 18px; padding: 14px; border: 0; border-radius: 12px;
    font-size: 16px; font-weight: 700; color: #06122a; cursor: pointer;
    background: linear-gradient(90deg, var(--accent), #6fa8ff); transition: opacity .15s;
  }
  button:hover { opacity: .92; }
  button:disabled { opacity: .5; cursor: default; }
  .msg { margin-top: 14px; font-size: 13px; text-align: center; min-height: 18px; }
  .msg.err { color: var(--err); }
  .msg.ok { color: var(--accent-2); }
  .hidden { display: none; }
  .back { background: none; color: var(--muted); font-weight: 500; margin-top: 10px; padding: 6px; }
  .foot { text-align: center; color: var(--muted); font-size: 11px; margin-top: 22px; }
  .wa { color: var(--accent-2); }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">${appName}</div>
    <div class="sub">התחברות מאובטחת באמצעות מספר הטלפון</div>

    <!-- Step 1: phone -->
    <div id="step-phone">
      <label for="phone">מספר טלפון</label>
      <div class="row">
        <div class="cc">+972</div>
        <input id="phone" type="tel" inputmode="numeric" autocomplete="tel"
               placeholder="050-000-0000" maxlength="15" />
      </div>
      <button id="sendBtn">שלח קוד ב-<span class="wa">WhatsApp</span></button>
      <div id="msg1" class="msg"></div>
    </div>

    <!-- Step 2: OTP -->
    <div id="step-otp" class="hidden">
      <label for="otp">הקלד את הקוד שקיבלת ב-WhatsApp</label>
      <input id="otp" class="otp-input" type="text" inputmode="numeric"
             autocomplete="one-time-code" placeholder="------" maxlength="6" />
      <button id="verifyBtn">אימות והתחברות</button>
      <button id="backBtn" class="back">חזרה לשינוי המספר</button>
      <div id="msg2" class="msg"></div>
    </div>

    <div class="foot">הקוד נשלח לוואטסאפ. תקף ל-5 דקות.</div>
  </div>

<script>
  const PARAMS = ${paramsJson};
  const $ = (id) => document.getElementById(id);
  let currentPhone = "";

  function setMsg(el, text, kind) {
    el.textContent = text || "";
    el.className = "msg" + (kind ? " " + kind : "");
  }

  async function postForm(path, data) {
    const body = new URLSearchParams();
    for (const k in data) body.append(k, data[k]);
    const r = await fetch(path, { method: "POST", body });
    let j = {};
    try { j = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, body: j };
  }

  // Step 1: send OTP
  $("sendBtn").addEventListener("click", async () => {
    const phone = $("phone").value.trim();
    if (!phone) { setMsg($("msg1"), "נא להזין מספר טלפון", "err"); return; }
    $("sendBtn").disabled = true;
    setMsg($("msg1"), "שולח קוד...", "");
    const res = await postForm("/authorize/send", { phone, client_id: PARAMS.client_id });
    $("sendBtn").disabled = false;
    if (!res.ok) {
      setMsg($("msg1"), res.body.error_description || "שליחת הקוד נכשלה. נסה שוב.", "err");
      return;
    }
    currentPhone = res.body.phone;
    $("step-phone").classList.add("hidden");
    $("step-otp").classList.remove("hidden");
    setMsg($("msg2"), "קוד נשלח אל " + res.body.display, "ok");
    $("otp").focus();
  });

  // Step 2: verify OTP -> server returns a redirect URL we navigate to.
  $("verifyBtn").addEventListener("click", async () => {
    const code = $("otp").value.trim();
    if (code.length < 6) { setMsg($("msg2"), "הקוד חייב להכיל 6 ספרות", "err"); return; }
    $("verifyBtn").disabled = true;
    setMsg($("msg2"), "מאמת...", "");
    const payload = Object.assign({ phone: currentPhone, code }, PARAMS);
    const res = await postForm("/authorize/verify", payload);
    if (res.ok && res.body.redirect) {
      window.location.href = res.body.redirect;
      return;
    }
    $("verifyBtn").disabled = false;
    setMsg($("msg2"), res.body.error_description || "קוד שגוי. נסה שוב.", "err");
  });

  $("backBtn").addEventListener("click", () => {
    $("step-otp").classList.add("hidden");
    $("step-phone").classList.remove("hidden");
    setMsg($("msg1"), "", "");
    $("otp").value = "";
  });

  // Enter-key convenience
  $("phone").addEventListener("keydown", (e) => { if (e.key === "Enter") $("sendBtn").click(); });
  $("otp").addEventListener("keydown", (e) => { if (e.key === "Enter") $("verifyBtn").click(); });
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /.well-known/openid-configuration */
function handleDiscovery(request, env) {
  const iss = issuerOf(request, env);
  return json({
    issuer: iss,
    authorization_endpoint: `${iss}/authorize`,
    token_endpoint: `${iss}/token`,
    userinfo_endpoint: `${iss}/userinfo`,
    jwks_uri: `${iss}/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: SCOPES_SUPPORTED,
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
    ],
    code_challenge_methods_supported: ["S256"],
    claims_supported: [
      "sub", "iss", "aud", "exp", "iat", "nonce",
      "email", "email_verified", "name", "preferred_username", "phone_number",
    ],
  });
}

/** GET /jwks  and  /.well-known/jwks.json */
async function handleJwks(request, env) {
  const jwk = await publicJwkFromPrivate(env.OIDC_PRIVATE_KEY, env.OIDC_KID);
  return json(
    { keys: [jwk] },
    200,
    { "cache-control": "public, max-age=3600" }
  );
}

/** GET /authorize — validate params, render login page. */
function handleAuthorize(request, env) {
  const url = new URL(request.url);
  const q = url.searchParams;

  const clientId = q.get("client_id");
  const redirectUri = q.get("redirect_uri");
  const responseType = q.get("response_type");
  const scope = q.get("scope") || "openid";
  const state = q.get("state") || "";
  const nonce = q.get("nonce") || "";
  const codeChallenge = q.get("code_challenge") || "";
  const codeChallengeMethod = q.get("code_challenge_method") || "";

  // Validate the client and redirect_uri BEFORE rendering anything.
  if (!validateClientId(env, clientId)) {
    return oauthError("invalid_client", "Unknown client_id");
  }
  if (!validateRedirectUri(env, redirectUri)) {
    return oauthError("invalid_request", "redirect_uri is not allowed");
  }
  if (responseType !== "code") {
    return oauthError("unsupported_response_type", "Only response_type=code is supported");
  }
  if (codeChallenge && codeChallengeMethod !== "S256") {
    return oauthError("invalid_request", "Only code_challenge_method=S256 is supported");
  }

  // Pass the validated params into the page so they can be echoed back.
  const params = {
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
  };
  const appName = env.APP_NAME || "Phone Login";
  return html(loginPage(params, appName));
}

/** POST /authorize/send — rate-limit, generate + store OTP, send via WhatsApp. */
async function handleSend(request, env) {
  const form = await request.formData();
  const rawPhone = form.get("phone");
  const clientId = form.get("client_id");

  if (!validateClientId(env, clientId)) {
    return oauthError("invalid_client", "Unknown client_id");
  }
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    return oauthError("invalid_request", "מספר טלפון לא תקין");
  }

  // Authorization gate: only numbers approved in Base44 may receive a code.
  if (!(await isPhoneAuthorized(env, phone))) {
    return oauthError(
      "access_denied",
      "המספר אינו מורשה להתחבר. פנה למנהל המערכת.",
      403
    );
  }

  // Rate limit: max RL_MAX_SENDS sends per RL_WINDOW_SECONDS per phone.
  const rlKey = `rl:${phone}`;
  const rlRaw = await env.OIDC_KV.get(rlKey);
  const count = rlRaw ? parseInt(rlRaw, 10) || 0 : 0;
  if (count >= RL_MAX_SENDS) {
    return oauthError(
      "too_many_requests",
      "נשלחו יותר מדי קודים. נסה שוב בעוד מספר דקות.",
      429
    );
  }

  // Generate and store the OTP.
  const code = generateOtp(6);
  const record = {
    code,
    attempts: 0,
    expiresAt: Date.now() + OTP_TTL_SECONDS * 1000,
  };
  await env.OIDC_KV.put(`otp:${phone}`, JSON.stringify(record), {
    expirationTtl: OTP_TTL_SECONDS,
  });

  // Increment rate-limit counter (preserve remaining window via fresh TTL is
  // acceptable here; a slightly generous window is fine for OTP throttling).
  await env.OIDC_KV.put(rlKey, String(count + 1), {
    expirationTtl: RL_WINDOW_SECONDS,
  });

  // Send via WhatsApp.
  try {
    await sendWhatsAppOtp(env, phone, code);
  } catch (e) {
    return oauthError("server_error", "שליחת הקוד נכשלה. נסה שוב מאוחר יותר.", 502);
  }

  // Masked display number, e.g. +972 *** *** 226
  const display = toPlusForm(phone).replace(/(\+\d{3})\d+(\d{3})$/, "$1 *** *** $2");
  return json({ ok: true, phone, display });
}

/** POST /authorize/verify — verify OTP, issue single-use auth code, return redirect. */
async function handleVerify(request, env) {
  const form = await request.formData();
  const phoneRaw = form.get("phone");
  const code = form.get("code");
  const clientId = form.get("client_id");
  const redirectUri = form.get("redirect_uri");
  const state = form.get("state") || "";
  const nonce = form.get("nonce") || "";
  const codeChallenge = form.get("code_challenge") || "";

  if (!validateClientId(env, clientId)) {
    return oauthError("invalid_client", "Unknown client_id");
  }
  if (!validateRedirectUri(env, redirectUri)) {
    return oauthError("invalid_request", "redirect_uri is not allowed");
  }
  const phone = normalizePhone(phoneRaw);
  if (!phone) {
    return oauthError("invalid_request", "מספר טלפון לא תקין");
  }

  const otpKey = `otp:${phone}`;
  const rawRec = await env.OIDC_KV.get(otpKey);
  if (!rawRec) {
    return oauthError("invalid_grant", "הקוד פג תוקף. בקש קוד חדש.");
  }
  const rec = JSON.parse(rawRec);

  if (Date.now() > rec.expiresAt) {
    await env.OIDC_KV.delete(otpKey);
    return oauthError("invalid_grant", "הקוד פג תוקף. בקש קוד חדש.");
  }
  if (rec.attempts >= MAX_OTP_VERIFY_ATTEMPTS) {
    await env.OIDC_KV.delete(otpKey);
    return oauthError("invalid_grant", "יותר מדי ניסיונות שגויים. בקש קוד חדש.");
  }

  if (!timingSafeEqual(String(code || ""), rec.code)) {
    rec.attempts += 1;
    // Keep remaining TTL roughly; recompute from expiresAt.
    const ttl = Math.max(1, Math.ceil((rec.expiresAt - Date.now()) / 1000));
    await env.OIDC_KV.put(otpKey, JSON.stringify(rec), { expirationTtl: ttl });
    const left = MAX_OTP_VERIFY_ATTEMPTS - rec.attempts;
    return oauthError("invalid_grant", `קוד שגוי. נותרו ${left} ניסיונות.`);
  }

  // Correct code — consume the OTP (single use).
  await env.OIDC_KV.delete(otpKey);

  // Issue a single-use authorization code bound to all the params.
  const authCode = randomToken(32);
  const codeRecord = {
    phone,
    client_id: clientId,
    redirect_uri: redirectUri,
    nonce,
    code_challenge: codeChallenge,
    created: Date.now(),
  };
  await env.OIDC_KV.put(`authcode:${authCode}`, JSON.stringify(codeRecord), {
    expirationTtl: CODE_TTL_SECONDS,
  });

  // Build the redirect back to Base44.
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", authCode);
  if (state) redirect.searchParams.set("state", state);

  return json({ ok: true, redirect: redirect.toString() });
}

/** Extract client credentials from Authorization: Basic or form body. */
function extractClientCreds(request, form) {
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(auth.slice(6).trim());
      const idx = decoded.indexOf(":");
      if (idx >= 0) {
        return {
          id: decodeURIComponent(decoded.slice(0, idx)),
          secret: decodeURIComponent(decoded.slice(idx + 1)),
        };
      }
    } catch (e) { /* fall through */ }
  }
  return {
    id: form.get("client_id") || "",
    secret: form.get("client_secret") || "",
  };
}

/** POST /token — exchange auth code for id_token + access_token. */
async function handleToken(request, env) {
  const form = await request.formData();
  const grantType = form.get("grant_type");
  const code = form.get("code");
  const redirectUri = form.get("redirect_uri");
  const codeVerifier = form.get("code_verifier");

  if (grantType !== "authorization_code") {
    return oauthError("unsupported_grant_type", "Only authorization_code is supported");
  }

  // Client authentication.
  const creds = extractClientCreds(request, form);
  if (!validateClientId(env, creds.id) || !timingSafeEqual(creds.secret, env.OIDC_CLIENT_SECRET)) {
    return oauthError("invalid_client", "Client authentication failed", 401);
  }

  if (!code) {
    return oauthError("invalid_request", "Missing code");
  }

  // Look up + consume the auth code (single use).
  const codeKey = `authcode:${code}`;
  const rawCode = await env.OIDC_KV.get(codeKey);
  if (!rawCode) {
    return oauthError("invalid_grant", "Authorization code is invalid or expired");
  }
  // Delete immediately to enforce single use even on concurrent requests.
  await env.OIDC_KV.delete(codeKey);
  const cr = JSON.parse(rawCode);

  // redirect_uri must match the one used at /authorize.
  if (!redirectUri || redirectUri !== cr.redirect_uri) {
    return oauthError("invalid_grant", "redirect_uri mismatch");
  }
  // client_id binding.
  if (cr.client_id !== creds.id) {
    return oauthError("invalid_grant", "client_id mismatch");
  }
  // PKCE.
  const pkceOk = await verifyPkce(codeVerifier, cr.code_challenge);
  if (!pkceOk) {
    return oauthError("invalid_grant", "PKCE verification failed");
  }

  // Build identity claims.
  const iss = issuerOf(request, env);
  const phone = cr.phone;                 // E.164 digits, no +
  const plus = toPlusForm(phone);         // +972...
  const sub = phone;
  // Synthetic, stable email so Base44 (which keys users by email) accepts the
  // phone-only user. Defaults to the Worker's own host; override via env.
  const emailDomain = env.SYNTHETIC_EMAIL_DOMAIN || new URL(iss).host;
  const email = `${phone}@${emailDomain}`;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ACCESS_TOKEN_TTL_SECONDS;

  const idTokenPayload = {
    iss,
    sub,
    aud: creds.id,
    iat: now,
    exp,
    email,
    email_verified: true,
    name: plus,
    preferred_username: plus,
    phone_number: plus,
    phone_number_verified: true,
  };
  if (cr.nonce) idTokenPayload.nonce = cr.nonce;

  const idToken = await signJwt(
    { alg: "RS256", typ: "JWT", kid: env.OIDC_KID },
    idTokenPayload,
    env.OIDC_PRIVATE_KEY
  );

  // Opaque access token, stored so /userinfo can resolve it.
  const accessToken = randomToken(32);
  await env.OIDC_KV.put(
    `at:${accessToken}`,
    JSON.stringify({ phone, email, sub, name: plus, phone_number: plus }),
    { expirationTtl: ACCESS_TOKEN_TTL_SECONDS }
  );

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    id_token: idToken,
    scope: "openid profile email phone",
  });
}

/** GET /userinfo — resolve Bearer access token to claims. */
async function handleUserinfo(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return json(
      { error: "invalid_token" },
      401,
      { "www-authenticate": 'Bearer error="invalid_token"' }
    );
  }
  const token = auth.slice(7).trim();
  const raw = await env.OIDC_KV.get(`at:${token}`);
  if (!raw) {
    return json(
      { error: "invalid_token" },
      401,
      { "www-authenticate": 'Bearer error="invalid_token"' }
    );
  }
  const u = JSON.parse(raw);
  return json({
    sub: u.sub,
    email: u.email,
    email_verified: true,
    name: u.name,
    preferred_username: u.name,
    phone_number: u.phone_number,
    phone_number_verified: true,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    try {
      if (method === "GET" && pathname === "/.well-known/openid-configuration") {
        return handleDiscovery(request, env);
      }
      if (method === "GET" && (pathname === "/jwks" || pathname === "/.well-known/jwks.json")) {
        return handleJwks(request, env);
      }
      if (method === "GET" && pathname === "/authorize") {
        return handleAuthorize(request, env);
      }
      if (method === "POST" && pathname === "/authorize/send") {
        return handleSend(request, env);
      }
      if (method === "POST" && pathname === "/authorize/verify") {
        return handleVerify(request, env);
      }
      if (method === "POST" && pathname === "/token") {
        return handleToken(request, env);
      }
      if (method === "GET" && pathname === "/userinfo") {
        return handleUserinfo(request, env);
      }
      if (method === "GET" && pathname === "/") {
        return new Response("MeetVault Phone OIDC Provider — see /.well-known/openid-configuration", {
          status: 200,
          headers: { "content-type": "text/plain;charset=UTF-8" },
        });
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ error: "server_error", error_description: String(err && err.message || err) }, 500);
    }
  },
};
