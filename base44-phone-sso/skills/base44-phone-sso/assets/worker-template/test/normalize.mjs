// normalize.mjs - every way of typing one number must give one string.
import { normalizePhone } from "../src/phone.js";
const N = (s) => normalizePhone(s, "972");
const T = "972541234567";
let pass = 0, fail = 0;
const t = (input, expected, note = "") => {
  const got = N(input);
  const ok = got === expected;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${JSON.stringify(input).padEnd(22)} -> ${got.padEnd(14)}${ok ? "" : " (expected " + expected + ")"} ${note}`);
  ok ? pass++ : fail++;
};

console.log("\nFormats a person may type:");
t("0541234567", T);
t("054-1234567", T);
t("054-123-4567", T);
t("054 123 4567", T);
t(" 0541234567 ", T);
t("+972541234567", T);
t("972541234567", T);
t("00972541234567", T, "international dialing prefix");
t("+972-54-123-4567", T);
t("+972 54 123 4567", T);
t("(054) 123-4567", T);

console.log("\nReal traps found in stored data:");
t("9720541234567", T, "country code + leftover zero");
t("00972-054-1234567", T, "both");
t("541234567", T, "no leading zero");
t("+9720541234567", T, "plus + country code + zero");

console.log("\nLandlines:");
t("021234567", "97221234567");
t("02-123-4567", "97221234567");

console.log("\nMust not match anything:");
t("", "");
t("abc", "");

console.log(`\npassed ${pass} · failed ${fail}\n`);
process.exit(fail ? 1 : 0);
