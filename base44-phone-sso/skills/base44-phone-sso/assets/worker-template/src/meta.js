// meta.js - send the one-time code through Meta's WhatsApp Cloud API, from the
// business's official number.
//
// Why a template and not free text: free text is only delivered inside the
// 24-hour customer-service window. Someone logging in has not necessarily
// written to the business recently, so the code must go out as a template.
//
// Why the AUTHENTICATION category specifically: Meta requires it for codes.
// Sending a code through a Utility or Marketing template is rejected or, when
// it slips through, is a policy violation that can lower the number's quality
// rating or disable it. AUTHENTICATION templates need a VERIFIED business.
//
// Shape of an AUTHENTICATION template: a fixed body ("<CODE> is your
// verification code") with one variable, plus a button. The code is sent twice,
// once in the body and once in the button. That is Meta's structure, not a bug.

const DEFAULT_GRAPH_VERSION = "v22.0";
// Overridable for tests only; in production it stays the real Graph API.
const DEFAULT_API_BASE = "https://graph.facebook.com";

function buttonComponent(subType, code) {
  // copy_code uses a different parameter envelope than url (one-tap autofill)
  if (subType === "copy_code") {
    return {
      type: "button",
      sub_type: "copy_code",
      index: "0",
      parameters: [{ type: "coupon_code", coupon_code: code }],
    };
  }
  return {
    type: "button",
    sub_type: "url",
    index: "0",
    parameters: [{ type: "text", text: code }],
  };
}

// Send through a relay: a backend function in the Base44 app that already
// holds a valid WhatsApp token (see assets/base44-functions/sendLoginOtp).
// This avoids keeping a second copy of the token in the Worker, where it would
// expire on its own schedule. The Worker still generates and verifies the
// code; the relay only delivers it.
//
// A browser-like User-Agent is required: the CDN in front of Base44-hosted
// domains rejects requests without one (Cloudflare error 1010).
async function sendOtpViaRelay(env, phoneE164, code) {
  let res;
  try {
    res = await fetch(env.META_RELAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; base44-phone-sso)",
        "X-Relay-Secret": env.LOGIN_OTP_RELAY_SECRET || "",
      },
      body: JSON.stringify({ to: phoneE164, code }),
    });
  } catch (e) {
    console.error("META_RELAY_NETWORK_ERROR", String((e && e.message) || e));
    return { ok: false, reason: "network_error", via: "meta-relay" };
  }
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch (_) { /* handled below */ }
  if (!res.ok || !data.ok) {
    // The code is never logged
    console.error("META_RELAY_FAILED", res.status, data.error || "", data.code || "", data.subcode || "", String(data.message || text).slice(0, 160));
    return { ok: false, reason: "meta_relay_error", status: res.status, code: data.code, subcode: data.subcode, via: "meta-relay" };
  }
  return { ok: true, wamid: data.wamid, via: "meta-relay" };
}

export async function sendOtpViaMeta(env, phoneE164, code) {
  if (env.META_RELAY_URL) return sendOtpViaRelay(env, phoneE164, code);

  const version = env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
  const base = env.META_API_BASE || DEFAULT_API_BASE;
  const url = `${base}/${version}/${env.META_PHONE_NUMBER_ID}/messages`;

  const components = [{ type: "body", parameters: [{ type: "text", text: code }] }];
  // An authentication template without a button is valid; skip it with "none".
  const subType = env.META_OTP_BUTTON_TYPE || "url";
  if (subType !== "none") components.push(buttonComponent(subType, code));

  const payload = {
    messaging_product: "whatsapp",
    to: phoneE164,
    type: "template",
    template: {
      name: env.META_TEMPLATE_NAME || "login_code",
      language: { code: env.META_TEMPLATE_LANG || "en" },
      components,
    },
  };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.META_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("META_SEND_NETWORK_ERROR", String((e && e.message) || e));
    return { ok: false, reason: "network_error", via: "meta" };
  }

  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch (_) { /* handled below */ }

  if (!res.ok || data.error) {
    const err = data.error || {};
    // The code is never logged, only what Meta said
    console.error("META_SEND_FAILED", res.status, err.code, err.error_subcode, err.message);
    return {
      ok: false,
      reason: "meta_error",
      status: res.status,
      code: err.code,
      subcode: err.error_subcode,
      message: err.message || text.slice(0, 300),
      via: "meta",
    };
  }

  const wamid = data.messages && data.messages[0] && data.messages[0].id;
  return { ok: true, wamid, via: "meta" };
}
