// otp.js - which provider delivers the code, and what happens when it fails.
//
// OTP_PROVIDER picks the primary: "green" (default) or "meta".
//
//   green primary -> falls back to Meta only when OTP_FALLBACK_META = "1".
//                    Without an approved AUTHENTICATION template Meta rejects
//                    the send anyway, so the fallback is opt-in.
//   meta primary  -> falls back to Green whenever a Green instance is
//                    configured (turn off with OTP_FALLBACK_GREEN = "0").
//
// Inside Green, several instances are tried in order (see green.js).
// A login must not depend on a single point of failure.

import { normalizePhone } from "./phone.js";
import { greenInstances, sendOtpViaGreen } from "./green.js";
import { sendOtpViaMeta } from "./meta.js";

export async function sendOtp(env, rawPhone, code) {
  const phone = normalizePhone(rawPhone, env.DEFAULT_COUNTRY_CODE || "972");
  const provider = String(env.OTP_PROVIDER || "green").toLowerCase();

  const steps = [];
  if (provider === "meta") {
    steps.push({ label: "meta", run: () => sendOtpViaMeta(env, phone, code) });
    if (String(env.OTP_FALLBACK_GREEN || "1") !== "0" && greenInstances(env).length > 0) {
      steps.push({ label: "green", run: () => sendOtpViaGreen(env, phone, code) });
    }
  } else {
    steps.push({ label: "green", run: () => sendOtpViaGreen(env, phone, code) });
    if (String(env.OTP_FALLBACK_META || "") === "1") {
      steps.push({ label: "meta", run: () => sendOtpViaMeta(env, phone, code) });
    }
  }

  let last = { ok: false, reason: "no_provider_configured" };
  for (const step of steps) {
    last = await step.run();
    if (last.ok) {
      if (step.label !== steps[0].label) console.log("OTP_PROVIDER_FALLBACK", step.label);
      return last;
    }
    console.error("OTP_PROVIDER_FAILED", step.label, last.reason || "");
  }
  return last;
}
