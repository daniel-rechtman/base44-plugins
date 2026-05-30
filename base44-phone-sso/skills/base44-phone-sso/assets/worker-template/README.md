# Phone OIDC Provider (Cloudflare Worker)

A self-hosted **OpenID Connect** Identity Provider on a single Cloudflare Worker.
Users sign in with their **phone number**; a 6-digit OTP is delivered over
**WhatsApp** via the **Green API**. The phone number *is* the user identity.

Plug it into a Base44 app as an **Advanced / Manual SSO (OIDC)** provider.

```
GET  /.well-known/openid-configuration   discovery
GET  /authorize                          RTL Hebrew phone + OTP login UI
POST /authorize/send                     (internal) send OTP over WhatsApp
POST /authorize/verify                   (internal) verify OTP, issue auth code
POST /token                              code -> id_token (RS256) + access_token
GET  /userinfo                           Bearer access_token -> claims
GET  /jwks   /.well-known/jwks.json      public RSA JWK
```

## Why a synthetic email?
Base44 keys users by **email**, but phone-only users have none. So `/token`
issues a **stable synthetic email** `<phone>@<domain>` with `email_verified:true`.
Same phone always maps to the same email, so it is always the same Base44 user.

## Phone allowlist (managed inside Base44)
Before sending an OTP, the Worker checks the Base44 `AuthorizedPhone` entity. Only
**approved** numbers receive a code; everyone else is rejected. Matching is
format-tolerant (it normalizes both sides), so `0501234567`, `501234567`,
`+972501234567` and `972501234567` are treated as the same number.

---

## Setup (Claude usually drives these via the skill)

### 1. Install + log in
```powershell
npm install
npx wrangler login          # opens the browser once; approve in Cloudflare
```

### 2. Create the KV namespace
```powershell
npx wrangler kv namespace create OIDC_KV
```
Paste the printed `id` into `wrangler.toml` (replace `__KV_NAMESPACE_ID__`).

### 3. Generate keys + client credentials
```powershell
npm run keygen
```
Writes `KEYS.local.json` (RSA private key, public JWK, `OIDC_KID`,
`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`). Put the printed `OIDC_KID` into
`wrangler.toml` (replace `__OIDC_KID__`). **Never commit `KEYS.local.json`.**

### 4. Fill `wrangler.toml`
Replace `__BASE44_APP_ID__` with your Base44 app id and set `APP_NAME`.

### 5. Set the secrets
```powershell
npx wrangler secret put GREEN_API_ID         # from secrets.json
npx wrangler secret put GREEN_API_TOKEN      # from secrets.json
npx wrangler secret put BASE44_API_KEY       # from secrets.json
npx wrangler secret put OIDC_CLIENT_ID       # from KEYS.local.json
npx wrangler secret put OIDC_CLIENT_SECRET   # from KEYS.local.json
npx wrangler secret put OIDC_PRIVATE_KEY     # the full PEM from KEYS.local.json
```

### 6. Deploy + enable the public URL
```powershell
npx wrangler deploy
```
Then in the Cloudflare dashboard: Workers & Pages -> your Worker -> **Domains** ->
enable the **Worker URL** (workers.dev). Note the URL, e.g.
`https://phone-oidc.<subdomain>.workers.dev`.

### 7. Connect to Base44 (Advanced / Manual SSO)
| Field | Value |
|-------|-------|
| Discovery URL | `https://<your-worker>.workers.dev/.well-known/openid-configuration` |
| Client ID | `OIDC_CLIENT_ID` from `KEYS.local.json` |
| Client Secret | `OIDC_CLIENT_SECRET` from `KEYS.local.json` |
| Scope | `openid email profile` |
| Redirect URI (auto) | `https://app.base44.com/api/apps/<app id>/auth/sso/callback` |

### 8. Test
Open the app login, choose the SSO provider, enter an **approved** phone, get the
OTP on WhatsApp, type it, get signed in. An unapproved number is rejected.

---

## Security model
- No secrets in the frontend. The login page only carries public OAuth params.
- OTP: 6 digits, single-use, 5-min expiry, max 5 wrong attempts, 5 sends / 15 min.
- Auth codes: single-use, 5-min TTL, bound to client + redirect + nonce + PKCE.
- Tokens signed RS256; the private key lives only as a Worker secret.
- Only the one configured `client_id` and `redirect_uri` are accepted.

## Regenerating keys
`npm run keygen` writes a fresh `KEYS.local.json`. After it, update `OIDC_KID` in
`wrangler.toml`, re-run the changed `wrangler secret put` commands, and re-enter
the new client id/secret in Base44.
