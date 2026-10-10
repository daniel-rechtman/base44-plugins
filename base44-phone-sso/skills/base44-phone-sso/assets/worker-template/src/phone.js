// phone.js - phone number normalization.
//
// Every way a person can type the same number must collapse to ONE string
// (E.164 without the '+', e.g. 9725XXXXXXXX). Otherwise an approved user is
// locked out just because of how their number was typed or stored.
//
// Variants this handles (found in real allowlist data):
//   0541234567 / 054-123-4567 / (054) 123-4567 / +972-54-123-4567
//   00972541234567      international dialing prefix
//   9720541234567       country code + a leftover local leading zero
//   541234567           local number stored without its leading zero
export function normalizePhone(raw, defaultCountry = "972") {
  let d = String(raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);

  if (d.startsWith(defaultCountry)) {
    // country code followed by a leading zero: the zero is a leftover of the
    // local format, not part of the number
    const rest = d.slice(defaultCountry.length).replace(/^0+/, "");
    return rest ? defaultCountry + rest : "";
  }
  if (d.startsWith("0")) return defaultCountry + d.replace(/^0+/, "");

  // A local number saved without its leading zero. Only completed when the
  // pattern is unmistakably local, so a foreign number stored as-is is kept.
  // (Israeli patterns; extend for your own country if you need this case.)
  if (defaultCountry === "972" && (/^5\d{8}$/.test(d) || /^[234789]\d{7}$/.test(d))) {
    return defaultCountry + d;
  }
  return d;
}
