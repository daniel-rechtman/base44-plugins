// provision.js - make sure the Base44 user exists BEFORE redirecting back.
//
// Why this exists: Base44's "Auto-admit SSO users" switch is only available
// for private apps where SSO is the only way in. A public app (marketing site,
// blog, public booking page) has that switch locked, and without it Base44
// refuses to log in an email that was never invited. Every phone login brings
// a synthetic email Base44 has never seen, so the login would fail with a
// generic "An error occurred during login".
//
// The fix: the Worker makes sure the user row exists before it hands back the
// authorization code. When Base44 comes to validate the token it finds an
// existing user.
//
// Do NOT create a User row through /entities/User. Base44 blocks it ("Users
// are managed through the app's authentication system"). The only route is the
// invite endpoint, the same one the SDK calls:
//   POST /apps/{appId}/runtime/users/invite-user  { user_email, role }
//
// Set PROVISION_USERS = "0" to skip all of this (private app with Auto-admit on).

import { allowlistEntity } from "./allowlist.js";

const DEFAULT_BASE = "https://app.base44.com/api/apps";

function apiBase(env) {
  return env.BASE44_API_BASE || DEFAULT_BASE;
}

function headers(env) {
  return { api_key: env.BASE44_API_KEY, "Content-Type": "application/json" };
}

export function provisioningEnabled(env) {
  return String(env.PROVISION_USERS || "1") !== "0";
}

async function findUserByEmail(env, email) {
  // Base44 filters with ?q={JSON}, not ?field=value. A plain ?email= query is
  // answered with the default list, where a brand-new user may be missing.
  const q = encodeURIComponent(JSON.stringify({ email }));
  const url = `${apiBase(env)}/${env.BASE44_APP_ID}/entities/User?q=${q}&limit=5`;
  const res = await fetch(url, { headers: headers(env) });
  if (!res.ok) throw new Error(`lookup ${res.status}`);
  const data = await res.json();
  const rows = Array.isArray(data) ? data : (data && data.items) || [];
  return rows.find((r) => String(r.email || "").toLowerCase() === email.toLowerCase()) || null;
}

async function inviteUser(env, email) {
  const base = apiBase(env).replace(/\/apps$/, "");
  const url = `${base}/apps/${env.BASE44_APP_ID}/runtime/users/invite-user`;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ user_email: email, role: env.NEW_USER_ROLE || "user" }),
  });
  const text = await res.text();
  if (!res.ok) {
    // "already exists" is reported back instead of being swallowed as success:
    // right after a user is deleted, Base44 can still answer "already exists"
    // while the row is gone.
    if (/already|exists|duplicate/i.test(text)) return { claimedExisting: true };
    throw new Error(`invite ${res.status}: ${text.slice(0, 200)}`);
  }
  return { invited: true };
}

// Idempotent: safe to call on every login.
//
// The user is invited ONLY when missing. The invite endpoint sends a "you were
// invited" email on every call. For a synthetic address that email goes
// nowhere, but a person who is linked to a real address would get one on every
// single login. So: look up first, invite only when the lookup finds nobody.
// If the lookup itself fails, invite defensively so a login is never blocked.
export async function ensureBase44User(env, { email, authId }) {
  if (!provisioningEnabled(env)) return { ok: true, skipped: true };

  let existing = null;
  let lookupOk = false;
  try {
    existing = await findUserByEmail(env, email);
    lookupOk = true;
  } catch (e) {
    console.error("USER_LOOKUP_FAILED", String((e && e.message) || e).slice(0, 160));
  }

  try {
    if (existing) {
      console.log("USER_EXISTS (no invite email sent)");
    } else {
      const inv = await inviteUser(env, email);
      console.log("USER_INVITED", inv.claimedExisting ? "(claimed-existing)" : "(fresh)",
        lookupOk ? "(lookup: not found)" : "(lookup: failed, invited defensively)");
    }
    // Mark on the allowlist row that this person logged in, and with which
    // email. This lets an admin screen show one row per person instead of two,
    // and makes later logins land on exactly the same identity.
    if (authId) {
      try {
        await fetch(`${apiBase(env)}/${env.BASE44_APP_ID}/entities/${allowlistEntity(env)}/${authId}`, {
          method: "PUT",
          headers: headers(env),
          body: JSON.stringify({ linked_email: email, last_login_at: new Date().toISOString() }),
        });
      } catch (e) {
        // Display-only marker: never blocks a login
        console.error("AUTH_LINK_FAILED", String((e && e.message) || e).slice(0, 160));
      }
    }
    return { ok: true, invited: !existing, existed: !!existing, needsProfile: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.error("USER_PROVISION_FAILED", msg.slice(0, 260));
    if (/already|exists|duplicate/i.test(msg)) return { ok: true, claimedExisting: true, needsProfile: true };
    return { ok: false, error: msg };
  }
}

// Fills in phone (and name, where Base44 accepts it) on the user row. Runs
// after the invite, with a short wait: Base44 creates the row asynchronously,
// so a single immediate attempt usually misses it. Best effort only.
//
// Note: full_name belongs to the auth system. It is set from the id_token's
// `name` claim when the user is created, and a later User update may silently
// ignore it. Sending the right `name` claim is what actually sets the name.
export async function completeUserProfile(env, { email, phone, fullName }) {
  if (!provisioningEnabled(env)) return { ok: true, skipped: true };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
    try {
      const row = await findUserByEmail(env, email);
      if (!row || !row.id) continue;
      if (row.phone === phone && (!fullName || row.full_name === fullName)) return { ok: true, already: true };
      const patch = { phone };
      if (fullName) patch.full_name = fullName;
      const res = await fetch(`${apiBase(env)}/${env.BASE44_APP_ID}/entities/User/${row.id}`, {
        method: "PUT",
        headers: headers(env),
        body: JSON.stringify(patch),
      });
      if (res.ok) return { ok: true, id: row.id };
      console.error("PROFILE_UPDATE_HTTP", res.status, (await res.text()).slice(0, 160));
    } catch (e) {
      console.error("PROFILE_UPDATE_FAILED", String((e && e.message) || e).slice(0, 160));
    }
  }
  return { ok: false };
}

// Optional: record every code that was sent in an entity of your app, so an
// admin can see that someone tried to log in, when, and whether the message
// went out. Enabled by setting LOGIN_LOG_ENTITY to the entity's name.
//
// THE CODE ITSELF IS NEVER WRITTEN. Whoever can read that entity must not be
// able to log in as someone else.
//
// Fields written (add them to the entity schema; Base44 drops unknown fields):
//   phone, email, name, status ("sent" | "failed"), provider,
//   provider_message_id, error, sent_at
// provider_message_id lets a delivery-status webhook match the row later.
export async function logLoginAttempt(env, { phone, email, name, sent }) {
  const entity = env.LOGIN_LOG_ENTITY || "";
  if (!entity) return;
  try {
    const ok = !!(sent && sent.ok);
    const row = {
      phone,
      email: email || "",
      name: name || "",
      status: ok ? "sent" : "failed",
      provider: (sent && sent.via) || String(env.OTP_PROVIDER || "green").toLowerCase(),
      provider_message_id: (sent && (sent.wamid || sent.id)) || "",
      error: ok ? "" : String((sent && (sent.reason || sent.message)) || "send_failed").slice(0, 200),
      sent_at: new Date().toISOString(),
    };
    const res = await fetch(`${apiBase(env)}/${env.BASE44_APP_ID}/entities/${entity}`, {
      method: "POST",
      headers: headers(env),
      body: JSON.stringify(row),
    });
    if (!res.ok) console.error("LOGIN_LOG_HTTP", res.status, (await res.text()).slice(0, 160));
  } catch (e) {
    console.error("LOGIN_LOG_FAILED", String((e && e.message) || e).slice(0, 160));
  }
}
