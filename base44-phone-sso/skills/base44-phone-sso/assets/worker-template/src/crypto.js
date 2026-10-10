// crypto.js - Worker crypto helpers: base64url, RS256 JWT signing, hashing,
// constant-time comparison, unbiased random digits, PKCE.

const enc = new TextEncoder();

export function b64urlFromBytes(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64url(str) {
  return b64urlFromBytes(enc.encode(str));
}

// PEM (PKCS#8) -> CryptoKey for RS256 signing
export async function importPrivateKey(pem) {
  const body = String(pem)
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    raw.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function signJwt(payload, privatePem, kid) {
  const header = { alg: "RS256", typ: "JWT", kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = await importPrivateKey(privatePem);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(signingInput));
  return `${signingInput}.${b64urlFromBytes(sig)}`;
}

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time comparison: does not leak how many characters matched
export function timingSafeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

// Uniformly distributed random digits (rejects values that cause modulo bias)
export function randomDigits(length) {
  const digits = [];
  while (digits.length < length) {
    const buf = new Uint8Array(length * 2);
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte >= 250) continue; // 250 = 25*10, the rest divides evenly by 10
      digits.push(byte % 10);
      if (digits.length === length) break;
    }
  }
  return digits.join("");
}

export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64urlFromBytes(buf);
}

// PKCE: base64url(SHA-256(verifier)) - RFC 7636 S256
export async function s256Challenge(verifier) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(verifier));
  return b64urlFromBytes(buf);
}
