// keygen.mjs - creates the RS256 key pair and the OIDC client credentials.
// Writes KEYS.local.json (secret, gitignored) and fills the three OIDC
// placeholders in wrangler.toml. Run once per deployment.
//
// Rotating keys later (npm run keygen -- --force) logs nobody out of Base44,
// but you must update OIDC_CLIENT_SECRET and OIDC_PRIVATE_KEY as Worker
// secrets, the vars in wrangler.toml, and the client id/secret in Base44's SSO
// settings, then deploy.
import { generateKeyPairSync, randomBytes, createHash } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const OUT = "KEYS.local.json";
if (existsSync(OUT) && !process.argv.includes("--force")) {
  console.error(`${OUT} already exists. To replace the keys: npm run keygen -- --force`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const jwk = publicKey.export({ format: "jwk" });
const kid = createHash("sha256").update(jwk.n).digest("hex").slice(0, 16);

const out = {
  OIDC_KID: kid,
  OIDC_PUBLIC_JWK: { ...jwk, kid, alg: "RS256", use: "sig" },
  OIDC_PRIVATE_KEY: privatePem,
  OIDC_CLIENT_ID: `base44-${randomBytes(8).toString("hex")}`,
  OIDC_CLIENT_SECRET: randomBytes(32).toString("base64url"),
};

writeFileSync(OUT, JSON.stringify(out, null, 2), { mode: 0o600 });
console.log(`Wrote ${OUT}`);
console.log(`  OIDC_KID       = ${kid}`);
console.log(`  OIDC_CLIENT_ID = ${out.OIDC_CLIENT_ID}`);
console.log("  (the private key and the client secret are NOT printed; they are in the file only)");

// Fill the placeholders in wrangler.toml, when they are still there.
const TOML = "wrangler.toml";
if (existsSync(TOML)) {
  const before = readFileSync(TOML, "utf8");
  const after = before
    .replace("__OIDC_CLIENT_ID__", out.OIDC_CLIENT_ID)
    .replace("__OIDC_KID__", kid)
    .replace("__OIDC_PUBLIC_JWK__", JSON.stringify(out.OIDC_PUBLIC_JWK));
  if (after !== before) {
    writeFileSync(TOML, after);
    console.log(`Filled OIDC_CLIENT_ID, OIDC_KID and OIDC_PUBLIC_JWK in ${TOML}`);
  } else {
    console.log(`${TOML} has no OIDC placeholders left. Update OIDC_CLIENT_ID, OIDC_KID and OIDC_PUBLIC_JWK there by hand.`);
  }
}
