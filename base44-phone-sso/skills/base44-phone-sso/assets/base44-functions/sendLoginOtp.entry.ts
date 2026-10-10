// sendLoginOtp - delivers the login code from the business's official WhatsApp
// number, through Meta's Cloud API and an AUTHENTICATION template.
// Save as a Base44 backend function named `sendLoginOtp` (functions/sendLoginOtp/entry.ts).
//
// Why in the app and not straight from the Worker: an app that already talks
// to WhatsApp holds a valid Cloud API token as an app secret. Copying it to
// the Worker means two tokens that expire separately and one more place to
// leak from. So the Worker asks this function to send. The Worker still
// generates and verifies the code; this function only delivers it.
//
// Auth: a dedicated secret in the X-Relay-Secret header. No secret, no send.
// Damage control if that secret ever leaks: this function can only send the
// one fixed template, only with a 6-digit code, only to a plausible phone
// number. The wording of the message is Meta's and cannot be changed from here.
//
// App secrets:
//   LOGIN_OTP_RELAY_SECRET     same value as the Worker secret of that name
//   WHATSAPP_CLOUD_TOKEN       a Cloud API token allowed to send from the number
//   WHATSAPP_PHONE_NUMBER_ID   the sending number's id
//   WHATSAPP_APP_SECRET        optional; when set, appsecret_proof is added
//   LOGIN_OTP_TEMPLATE         optional, default "login_code"
//   LOGIN_OTP_TEMPLATE_LANG    optional, default "en"
//   LOGIN_OTP_COUNTRY_PREFIX   optional, e.g. "972": only numbers with this prefix
const GRAPH = "https://graph.facebook.com/v22.0";

function eq(a: string, b: string) {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function hmacHex(message: string, key: string) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const secret = Deno.env.get("LOGIN_OTP_RELAY_SECRET") || "";
  if (!secret || !eq(req.headers.get("x-relay-secret") || "", secret)) return json({ error: "forbidden" }, 403);

  const body = await req.json().catch(() => ({}));
  const to = String(body.to || "").replace(/\D/g, "");
  const code = String(body.code || "");
  const prefix = Deno.env.get("LOGIN_OTP_COUNTRY_PREFIX") || "";
  if (!/^\d{8,15}$/.test(to) || (prefix && !to.startsWith(prefix))) return json({ ok: false, error: "bad_to" }, 400);
  if (!/^\d{6}$/.test(code)) return json({ ok: false, error: "bad_code" }, 400);

  const token = Deno.env.get("WHATSAPP_CLOUD_TOKEN") || "";
  const phoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") || "";
  const appSecret = Deno.env.get("WHATSAPP_APP_SECRET") || "";
  if (!token || !phoneId) return json({ ok: false, error: "missing_whatsapp_secrets" }, 500);
  const proof = appSecret ? await hmacHex(token, appSecret) : "";

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: Deno.env.get("LOGIN_OTP_TEMPLATE") || "login_code",
      language: { code: Deno.env.get("LOGIN_OTP_TEMPLATE_LANG") || "en" },
      components: [
        { type: "body", parameters: [{ type: "text", text: code }] },
        // The "copy code" button of an AUTHENTICATION template is sent as
        // sub_type "url" carrying the code
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
      ],
    },
  };

  try {
    const r = await fetch(`${GRAPH}/${phoneId}/messages${proof ? `?appsecret_proof=${proof}` : ""}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) {
      const e = d.error || {};
      // The code is never logged
      console.error("LOGIN_OTP_META_FAILED", r.status, e.code, e.error_subcode, String(e.message || "").slice(0, 160));
      return json({ ok: false, error: "meta_error", status: r.status, code: e.code, subcode: e.error_subcode, message: e.message }, 502);
    }
    const wamid = d.messages && d.messages[0] && d.messages[0].id;
    return json({ ok: true, wamid });
  } catch (e) {
    console.error("LOGIN_OTP_NETWORK", String((e as Error)?.message || e).slice(0, 160));
    return json({ ok: false, error: "network_error" }, 502);
  }
});
