// green.js - send the one-time code through Green API (plain WhatsApp text).
//
// Green API drives an ordinary WhatsApp account over the WhatsApp Web
// protocol. Flat monthly price, no per-message cost, no template approval.
// It is NOT an official Meta channel, so treat the sending number as
// replaceable: keep a second instance configured as a backup.
//
// A number that is registered on Meta's Cloud API cannot also run on Green
// API. If the business number is already on the Cloud API, either send through
// Meta (meta.js) or use a different number here.

import { messages } from "./messages.js";

// Every configured instance, in priority order: the main one, then
// GREEN_API_ID_2..5. Each instance is a different WhatsApp number, so when one
// drops (logged out, subscription ended, temporary block) the next keeps
// delivering codes.
export function greenInstances(env) {
  const list = [];
  if (env.GREEN_API_ID && env.GREEN_API_TOKEN) {
    list.push({ id: String(env.GREEN_API_ID), token: String(env.GREEN_API_TOKEN), label: "green" });
  }
  for (let i = 2; i <= 5; i++) {
    const id = env[`GREEN_API_ID_${i}`];
    const token = env[`GREEN_API_TOKEN_${i}`];
    if (id && token) list.push({ id: String(id), token: String(token), label: `green${i}` });
  }
  return list;
}

// One instance. Green answers 200 even when the message was NOT queued; the
// only proof of acceptance is idMessage, so a 200 without it counts as a
// failure and falls through to the backup.
export async function sendViaGreenInstance(env, inst, phoneE164, code) {
  const base = env.GREEN_API_BASE || "https://api.green-api.com";
  const url = `${base}/waInstance${inst.id}/sendMessage/${inst.token}`;
  const biz = env.OTP_BUSINESS_NAME || env.APP_NAME || "";
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: `${phoneE164}@c.us`, message: messages(env).otpText(biz, code) }),
    });
  } catch (e) {
    console.error("GREEN_SEND_NETWORK_ERROR", inst.label, String((e && e.message) || e));
    return { ok: false, reason: "network_error", via: inst.label };
  }

  const body = await res.text();
  if (!res.ok) {
    // The code is never logged
    console.error("GREEN_SEND_FAILED", inst.label, res.status, body.slice(0, 200));
    return { ok: false, reason: "green_error", status: res.status, via: inst.label };
  }

  let data = {};
  try { data = JSON.parse(body); } catch (_) { /* handled below */ }
  if (!data.idMessage) {
    console.error("GREEN_SEND_NO_ID", inst.label, body.slice(0, 200));
    return { ok: false, reason: "green_no_id", via: inst.label };
  }
  return { ok: true, id: data.idMessage, via: inst.label };
}

export async function sendOtpViaGreen(env, phoneE164, code) {
  const instances = greenInstances(env);
  if (instances.length === 0) {
    console.error("GREEN_MISSING_CREDENTIALS");
    return { ok: false, reason: "missing_credentials" };
  }

  const tried = [];
  for (const inst of instances) {
    const r = await sendViaGreenInstance(env, inst, phoneE164, code);
    if (r.ok) {
      if (tried.length) console.log("GREEN_FALLBACK_USED", inst.label, "after", tried.join(","));
      return r;
    }
    tried.push(`${inst.label}:${r.reason}`);
  }
  console.error("GREEN_ALL_INSTANCES_FAILED", tried.join(" | "));
  return { ok: false, reason: "green_all_failed", tried };
}
