/**
 * generate-keys.mjs
 * -----------------
 * Generates a fresh RSA-2048 keypair (for RS256 JWT signing) plus a random
 * OIDC client_id / client_secret, derives the public JWK with a stable kid
 * (RFC 7638 thumbprint), prints the values, and writes them to KEYS.local.json
 * next to this project (gitignored).
 *
 * Run:  node scripts/generate-keys.mjs
 *
 * After running, update wrangler.toml's OIDC_KID to the printed KID and set
 * the secrets per the README.
 */
import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "KEYS.local.json");

// RSA-2048 keypair.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// Public JWK + stable kid (RFC 7638 thumbprint).
const jwk = crypto.createPublicKey(publicKey).export({ format: "jwk" });
const thumbInput = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
const kid = crypto.createHash("sha256").update(thumbInput).digest("base64url");
jwk.kid = kid;
jwk.use = "sig";
jwk.alg = "RS256";

// Client credentials.
const OIDC_CLIENT_ID = "mv_" + crypto.randomBytes(16).toString("hex");
const OIDC_CLIENT_SECRET = crypto.randomBytes(32).toString("base64url");

const out = {
  generated_at: new Date().toISOString(),
  kid,
  OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET,
  OIDC_PRIVATE_KEY_PKCS8_PEM: privateKey,
  public_key_pem: publicKey,
  public_jwk: jwk,
};

writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log("Wrote " + outPath);
console.log("KID            = " + kid);
console.log("OIDC_CLIENT_ID = " + OIDC_CLIENT_ID);
console.log("(client_secret + private key are in KEYS.local.json)");
console.log("\nRemember to set OIDC_KID in wrangler.toml to the KID above.");
