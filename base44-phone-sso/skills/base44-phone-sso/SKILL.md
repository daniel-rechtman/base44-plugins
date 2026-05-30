---
name: base44-phone-sso
description: >-
  Set up phone-number login (WhatsApp OTP via Green API) for a Base44 app,
  end-to-end, even for someone starting from zero. Deploys a self-hosted OIDC
  identity provider as a Cloudflare Worker, connects it to Base44 as an
  Advanced/Manual SSO provider, and adds an in-app allowlist of approved numbers.
  Use this skill whenever the user wants users to log in to a Base44 app with a
  phone number instead of email, wants WhatsApp or SMS one-time-code login on
  Base44, mentions "login with phone", "OTP login", "WhatsApp login", "Green API
  login", "כניסה עם טלפון", "אימות בוואטסאפ", "התחברות עם מספר טלפון לבייס44", or
  asks why phone login on Base44 fails with "Email not returned by OAuth
  provider". Trigger even if they do not say "OIDC", "Cloudflare", or "Worker" by
  name — those are the implementation, and this skill is the canonical way to do
  phone login on Base44.
---

# Base44 phone-number login (WhatsApp OTP)

Give a Base44 app a "log in with your phone number" option. The user enters a
phone number, gets a 6-digit code on WhatsApp, types it, and is signed in. No
email, no password.

## Why this is not a one-click Base44 setting

Base44's SSO only accepts standard **OIDC** identity providers, and it keys every
user by **email**. Phone-only users have no email, so off-the-shelf providers
(e.g. Clerk) fail with `Email not returned by OAuth provider` — their email claim
comes only from a real address and cannot be synthesized.

The fix is a tiny **self-hosted OIDC provider** (one Cloudflare Worker) that:
- sends the OTP over WhatsApp via the **Green API** (flat monthly cost, no
  per-message charge, using the user's own WhatsApp number), and
- hands Base44 a **stable synthetic email** `<phone>@<domain>` so the same phone
  always maps to the same Base44 user.

It also gates logins against an **allowlist** the owner manages from inside the
Base44 app, so only approved numbers can get in.

```
[Base44 app login]  --OIDC-->  [Cloudflare Worker = the "guard"]  --WhatsApp-->  [user]
                                      |  reads allowlist via API
                                      v
                               [Base44 AuthorizedPhone entity]
```

The full Worker is bundled in `assets/worker-template/`. Read its `README.md` for
endpoint and security details. It has **no secrets in its code**; everything
sensitive is a Worker secret set at deploy time.

## Before you build: prerequisites

- **Base44 app on the Elite plan** (SSO is Elite-only). If the SSO "Set Up"
  button is missing, the app is not Elite — tell the user; it is a paid decision.
- A **Cloudflare account** and a **Green API account**. Claude cannot create
  accounts — direct the user to sign up. See `references/account-setup.md` for the
  exact signup walkthrough and the values to collect.
- Node + `npx wrangler` available locally (the skill uses wrangler to deploy).

## What you need from the user (collect into `secrets.json`)

Have them copy `assets/worker-template/secrets.example.json` to `secrets.json`
(gitignored) and fill in: Green API `idInstance` + `apiTokenInstance`, Base44
`appId`, Base44 `api_key`, the Base44 redirect URI, and an `APP_NAME`. The OIDC
client id/secret and signing key are **generated**, not entered.

## The build, step by step

Work from a copy of `assets/worker-template/` in the user's project. Drive the
browser steps with the Chrome MCP and the Base44 data/app steps with the Base44
MCP tools.

1. **Accounts + secrets.** Walk the user through Cloudflare and Green API signup
   (`references/account-setup.md`), confirm the Green instance is `authorized`,
   and collect `secrets.json`.

2. **Generate keys.** `npm install`, then `npm run keygen`. This writes
   `KEYS.local.json` (RSA private key, `OIDC_KID`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET`). Never commit it.

3. **Fill `wrangler.toml`.** Replace `__OIDC_KID__`, `__BASE44_APP_ID__`, and set
   `APP_NAME`. (The KV id comes in the next step.)

4. **Log in + KV.** `npx wrangler login` (browser approval — the user clicks
   Allow). `npx wrangler kv namespace create OIDC_KV` and paste the printed `id`
   into `wrangler.toml` for `__KV_NAMESPACE_ID__`.

5. **Set the six secrets.** Pipe values straight from the files so they never
   print to the transcript:
   - `GREEN_API_ID`, `GREEN_API_TOKEN`, `BASE44_API_KEY` from `secrets.json`
   - `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and the full PEM `OIDC_PRIVATE_KEY`
     from `KEYS.local.json`

6. **Deploy + enable the URL.** `npx wrangler deploy`. If it says there is no
   workers.dev subdomain, the user picks one once in the dashboard. Then enable
   the **Worker URL** under the Worker's **Domains** tab. Health-check:
   `curl https://<worker>.workers.dev/.well-known/openid-configuration` -> 200.

7. **Connect Base44 SSO** (browser) — Advanced/Manual with the Discovery URL +
   client id/secret. See `references/base44-setup.md`.

8. **Allowlist + management page** (Base44 MCP) — create the `AuthorizedPhone`
   entity, **seed the owner's own number as approved first**, and build the
   admin-only management page. See `references/base44-setup.md`.

9. **Test end-to-end.** Fresh login from the app -> phone -> WhatsApp code -> in.
   Confirm an unapproved number is rejected
   (`POST /authorize/send` returns `access_denied`).

## Hard-won gotchas (save the user pain)

- **Account creation is the user's job.** Open the signup page for them and wait;
  never create the account yourself.
- **Deploying a live server is a real action.** `wrangler secret put` and
  `wrangler deploy` push a public, credential-bearing server. Get the user's
  explicit go-ahead before running them.
- **The gate fails closed.** Once enforcement is on, only numbers in
  `AuthorizedPhone` can log in. Always seed the owner's number first.
- **`Phone authentication failed` after a code** is almost always a stale login
  tab or a login during a deploy — retry with a completely fresh login, and use
  `wrangler tail` to watch live logs if it repeats.
- **Phone formats.** The Worker normalizes both the typed number and the stored
  allowlist value, so any format matches. Don't add per-format hacks.
- **No secrets in the frontend** by design — the login page only carries public
  OAuth params. Keep it that way.

## Tuning

Per-deployment branding and behavior live in `wrangler.toml` vars (`APP_NAME`,
optional `SYNTHETIC_EMAIL_DOMAIN`, optional `ISSUER`) and the constants at the top
of `src/index.js` (OTP length, expiry, attempt and rate limits). To reuse one
Worker for several Base44 apps, extend the single allowed `redirect_uri`/`client`
checks in `src/index.js`.
