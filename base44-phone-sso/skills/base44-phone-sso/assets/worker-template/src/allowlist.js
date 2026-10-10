// allowlist.js - who is allowed to log in.
//
// Source of truth: an ordinary Base44 entity (default name AuthorizedPhone)
// that the app owner manages from an admin page.
//
// Why not the built-in User entity: a User row only exists AFTER the first
// login. Someone the owner just approved is not there yet, so a gate that reads
// User can never let a new person in. The allowlist entity is a normal entity
// and is always readable with the app's api_key.
//
// The two complement each other:
//   allowlist entity = who MAY log in   (permission, kept forever)
//   User             = who HAS logged in (profile)
//
// The gate fails CLOSED: any error returns "not allowed".

import { normalizePhone } from "./phone.js";

const DEFAULT_BASE = "https://app.base44.com/api/apps";

export function allowlistEntity(env) {
  return env.ALLOWLIST_ENTITY || "AuthorizedPhone";
}

async function fetchRows(env, entity, query) {
  const base = env.BASE44_API_BASE || DEFAULT_BASE;
  const url = `${base}/${env.BASE44_APP_ID}/entities/${entity}${query}`;
  const res = await fetch(url, {
    headers: { api_key: env.BASE44_API_KEY, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`${entity} ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data && data.items) || [];
}

export async function isPhoneAuthorized(env, phoneE164) {
  const country = env.DEFAULT_COUNTRY_CODE || "972";
  const target = normalizePhone(phoneE164, country);
  if (!target || target.length < 8) return { allowed: false, reason: "empty_phone" };

  let rows;
  try {
    // The whole list is fetched and matched here, because the stored numbers
    // are in whatever format the owner typed. Raise the limit for big lists.
    rows = await fetchRows(env, allowlistEntity(env), `?limit=${env.ALLOWLIST_LIMIT || 2000}`);
  } catch (e) {
    console.error("ALLOWLIST_LOOKUP_FAILED", String((e && e.message) || e));
    return { allowed: false, reason: "lookup_failed" };
  }

  const hit = (rows || []).find((r) => normalizePhone(r.phone, country) === target);
  if (!hit) return { allowed: false, reason: "not_listed" };
  // is_active is the current field; approved is the v1 name. Either one set to
  // false blocks the number.
  if (hit.is_active === false || hit.approved === false) return { allowed: false, reason: "inactive" };

  return {
    allowed: true,
    name: hit.full_name || hit.display_name || "",
    // The email this person was already linked to on a previous login. Empty on
    // the first login, in which case the synthetic email is derived from the phone.
    email: hit.linked_email || "",
    authId: hit.id || "",
  };
}
