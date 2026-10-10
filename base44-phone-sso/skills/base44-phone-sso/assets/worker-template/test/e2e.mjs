// e2e.mjs - end to end against a local Worker (wrangler dev on :8799) and the
// fake services (test/fakes.mjs on :8798). Started by test/run.sh.
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

const DIR = process.env.PHONE_SSO_TEST_DIR || "/tmp/phone-sso-test";
const read = (name) => { try { return readFileSync(`${DIR}/${name}`, "utf8").trim(); } catch (_) { return ""; } };
const EXPECT_VIA = process.env.EXPECT_VIA || "";

const B = "http://127.0.0.1:8799";
const K = JSON.parse(readFileSync("KEYS.local.json", "utf8"));
const RU = "https://app.base44.com/api/apps/test-app/auth/sso/callback";
const EMAIL_DOMAIN = "phone.test-app.example";
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
  ok ? pass++ : fail++;
};

async function startFlow({ pkce = true, headers = {} } = {}) {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const u = new URL(B + "/authorize");
  u.searchParams.set("client_id", K.OIDC_CLIENT_ID);
  u.searchParams.set("redirect_uri", RU);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", "st1");
  u.searchParams.set("nonce", "n1");
  u.searchParams.set("scope", "openid email profile");
  if (pkce) {
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
  }
  const html = await (await fetch(u, { headers })).text();
  const sid = (html.match(/var SID = "([^"]+)"/) || [])[1];
  return { sid, verifier, html };
}

const post = (path, body) =>
  fetch(B + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const token = (params) =>
  fetch(B + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params) });

async function getCode(sid, phone = "0500000001") {
  await post("/authorize/send", { sid, phone });
  const otp = read("otp.txt");
  const r = await (await post("/authorize/verify", { sid, code: otp })).json();
  return (String(r.redirect || "").match(/code=([^&]*)/) || [])[1];
}

const base = { grant_type: "authorization_code", client_id: K.OIDC_CLIENT_ID, client_secret: K.OIDC_CLIENT_SECRET };
const claimsOf = (idToken) => JSON.parse(Buffer.from(idToken.split(".")[1], "base64url"));

console.log("\nDiscovery:");
{
  const d = await (await fetch(B + "/.well-known/openid-configuration")).json();
  check("issuer + endpoints present", !!d.issuer && !!d.token_endpoint && !!d.jwks_uri);
  const jwks = await (await fetch(B + "/jwks.json")).json();
  check("published key matches the generated kid", jwks.keys[0].kid === K.OIDC_KID);
}

console.log("\nPKCE:");
{
  const { sid, verifier } = await startFlow();
  const code = await getCode(sid);
  const r = await (await token({ ...base, code, code_verifier: verifier, redirect_uri: RU })).json();
  check("correct verifier -> id_token", !!r.id_token);
  if (EXPECT_VIA) check(`delivered by ${EXPECT_VIA}`, read("via.txt") === EXPECT_VIA, read("via.txt"));
  if (r.id_token) {
    const c = claimsOf(r.id_token);
    // someone already linked to a real address logs into THAT user, not a new one
    check("uses the linked email, not the derived one", c.email === "dana@example.com", c.email);
    check("nonce returned", c.nonce === "n1");
    check("name = the name on the allowlist", c.name === "Dana Cohen", c.name);
    check("aud = client_id", c.aud === K.OIDC_CLIENT_ID);
    check("sub = normalized phone", c.sub === "972500000001", c.sub);
  }
}
{
  const { sid } = await startFlow();
  const code = await getCode(sid);
  const r = await (await token({ ...base, code })).json();
  check("no verifier -> rejected", r.error === "invalid_grant");
}
{
  const { sid } = await startFlow();
  const code = await getCode(sid);
  const r = await (await token({ ...base, code, code_verifier: randomBytes(48).toString("base64url") })).json();
  check("wrong verifier -> rejected", r.error === "invalid_grant");
}

console.log("\nWithout PKCE (backward compatible):");
{
  const { sid } = await startFlow({ pkce: false });
  const code = await getCode(sid);
  const r = await (await token({ ...base, code })).json();
  check("plain flow still works", !!r.id_token);
}

console.log("\nAllowlist gate:");
{
  const { sid } = await startFlow();
  const r = await post("/authorize/send", { sid, phone: "0509999999" });
  check("number not on the list -> 403", r.status === 403);
}
{
  const { sid } = await startFlow();
  const r = await post("/authorize/send", { sid, phone: "050-000-0002" });
  check("stored as 9720500000002, typed 050-000-0002 -> found", r.status === 200);
}
{
  const { sid, verifier } = await startFlow();
  const code = await getCode(sid, "0500000003");
  const r = await (await token({ ...base, code, code_verifier: verifier })).json();
  const c = r.id_token ? claimsOf(r.id_token) : {};
  check("first login -> derived email", c.email === `972500000003@${EMAIL_DOMAIN}`, c.email);
}
{
  const { sid } = await startFlow();
  const r = await post("/authorize/send", { sid, phone: "050-000-0004" });
  check("deactivated number -> 403", r.status === 403);
}
{
  const { sid } = await startFlow();
  const r = await post("/authorize/send", { sid, phone: "0500000005" });
  check("v1 schema row (approved / display_name) -> allowed", r.status === 200);
}

console.log("\nWrong code:");
{
  const { sid } = await startFlow();
  await post("/authorize/send", { sid, phone: "0500000003" });
  const otp = read("otp.txt");
  const wrong = otp === "000000" ? "111111" : "000000";
  const r1 = await post("/authorize/verify", { sid, code: wrong });
  check("wrong code -> 400", r1.status === 400);
  const r2 = await (await post("/authorize/verify", { sid, code: otp })).json();
  check("right code still works afterwards", !!r2.redirect);
}

console.log("\nUser provisioning:");
{
  const before = Number(read("invites.txt") || 0);
  const a = await startFlow();
  const code1 = await getCode(a.sid);
  await token({ ...base, code: code1, code_verifier: a.verifier });
  const mid = Number(read("invites.txt") || 0);
  const b2 = await startFlow();
  // a fresh code needs the resend cooldown to be off (run.sh sets it to 1s)
  await new Promise((r) => setTimeout(r, 1300));
  const code2 = await getCode(b2.sid);
  await token({ ...base, code: code2, code_verifier: b2.verifier });
  const after = Number(read("invites.txt") || 0);
  check("existing user -> no second invite email", after === mid, `invites ${before} -> ${mid} -> ${after}`);
  let users = [];
  try { users = JSON.parse(read("users.json") || "[]"); } catch (_) {}
  check("user was created with the linked email", users.some((u) => u.email === "dana@example.com"));
}

console.log("\nApp-domain proxy:");
{
  const direct = await startFlow();
  check("no proxy secret -> page posts to the Worker", direct.html.includes('var SEND_URL = "/authorize/send"'));
  const spoof = await startFlow({ headers: { "X-Proxy-Secret": "wrong", "X-Proxy-Base": "https://evil.example/fn" } });
  check("wrong proxy secret -> proxy headers ignored", spoof.html.includes('var SEND_URL = "/authorize/send"'));
  const viaProxy = await startFlow({ headers: { "X-Proxy-Secret": "test-proxy-secret", "X-Proxy-Base": "https://app.example/fn/phoneLogin" } });
  check("trusted proxy -> page posts back to the proxy", viaProxy.html.includes('var SEND_URL = "https://app.example/fn/phoneLogin?op=send"'));
}

console.log("\nRedirect allow-list:");
{
  const u = new URL(B + "/authorize");
  u.searchParams.set("client_id", K.OIDC_CLIENT_ID);
  u.searchParams.set("redirect_uri", "https://evil.example/callback");
  u.searchParams.set("response_type", "code");
  const r = await fetch(u);
  check("unknown redirect_uri -> 400, no redirect", r.status === 400);
}

console.log("\nOne-time use:");
{
  const { sid, verifier } = await startFlow();
  await new Promise((r) => setTimeout(r, 1300));
  const code = await getCode(sid);
  await token({ ...base, code, code_verifier: verifier });
  const r2 = await (await token({ ...base, code, code_verifier: verifier })).json();
  check("authorization code reused -> rejected", r2.error === "invalid_grant");
}

console.log(`\npassed ${pass} · failed ${fail}\n`);
process.exit(fail ? 1 : 0);
