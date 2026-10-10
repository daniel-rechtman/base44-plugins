# Phone login for Base44: the identity provider (Cloudflare Worker)

A small OIDC provider. It verifies a phone number with a one-time code sent on
WhatsApp and returns a stable email for that phone, so "log in with your phone"
works on a Base44 app whose SSO only accepts standard OIDC providers and keys
every user by email.

## Files

| File | Role |
|---|---|
| `src/index.js` | Router: discovery, jwks, authorize, send, verify, token, userinfo |
| `src/otp.js` | Picks the delivery provider and falls back when it fails |
| `src/green.js` | Delivery through Green API (plain text), several instances in order |
| `src/meta.js` | Delivery through Meta's Cloud API (AUTHENTICATION template), direct or through a relay |
| `src/allowlist.js` | Who may log in: reads the allowlist entity in the Base44 app |
| `src/provision.js` | Makes sure the Base44 user exists; optional login log |
| `src/phone.js` | Phone normalization (every typed format -> one string) |
| `src/crypto.js` | RS256 signing, hashing, constant-time compare, unbiased random digits, PKCE |
| `src/page.js` | The login page (no dependencies, no secrets) |
| `src/messages.js` | Every user-facing string (`LOCALE` = `he` or `en`) |
| `scripts/keygen.mjs` | Generates the key pair + client credentials, fills `wrangler.toml` |
| `test/` | Fake services + an end-to-end suite. No accounts needed |

## Setup

```bash
npm install
npm run keygen                         # writes KEYS.local.json, fills wrangler.toml
npm test                               # 4 suites against fake services
npx wrangler login
npx wrangler kv namespace create OIDC_KV   # paste the id into wrangler.toml
```

Fill the remaining placeholders in `wrangler.toml` (`__BASE44_APP_ID__`,
`__SYNTHETIC_EMAIL_DOMAIN__`) and choose `OTP_PROVIDER`.

Secrets are set one by one and never printed. Pipe them from the local files:

```bash
node -e 'process.stdout.write(require("./KEYS.local.json").OIDC_CLIENT_SECRET)' | npx wrangler secret put OIDC_CLIENT_SECRET
node -e 'process.stdout.write(require("./KEYS.local.json").OIDC_PRIVATE_KEY)'   | npx wrangler secret put OIDC_PRIVATE_KEY
node -e 'process.stdout.write(require("./secrets.json").BASE44_API_KEY)'        | npx wrangler secret put BASE44_API_KEY
# plus the provider secrets you use: GREEN_API_ID, GREEN_API_TOKEN, ...
npx wrangler deploy
```

Health check: `curl https://<worker>.workers.dev/.well-known/openid-configuration`

## Before the gate goes live

**Add the owner's own number to the allowlist first.** From the moment the
Worker is connected, only numbers on the list can log in, the owner included.

## Security decisions

- **The OIDC request lives on the server.** The browser only gets a one-time
  `sid`. `redirect_uri` and `client_id` are never read back from a POST, so a
  browser cannot divert an authorization code.
- **`redirect_uri` is checked against a closed list** (`ALLOWED_REDIRECT_URIS`).
- **The code is stored hashed** (`sha256(phone:code)`). A KV leak is not enough
  to impersonate anyone.
- **The gate fails closed.** A network error talking to Base44 means "not allowed".
- **One denial message for every reason.** It does not reveal who is on the list.
- **One-time everything.** The OTP is deleted on success; the authorization
  code is deleted before the token is issued.
- **Wrong attempts do not extend a code's life** (the original expiry is kept).
- **PKCE is enforced** whenever Base44 sent a challenge.
- **Limits:** codes per phone per hour, codes per IP per hour, a resend
  cooldown, 5 attempts per code. All tunable in `wrangler.toml`.
- **No secrets in the browser.** The login page carries only the `sid`.
- **The code is never logged**, not by the Worker, not by the relay, not by the
  optional login log.

## Logs

`npx wrangler tail` shows live logs. Useful markers: `ACCESS_DENIED`,
`OTP_PROVIDER_FAILED`, `OTP_PROVIDER_FALLBACK`, `GREEN_FALLBACK_USED`,
`META_SEND_FAILED`, `USER_INVITED`, `USER_EXISTS`, `USER_PROVISION_FAILED`.
