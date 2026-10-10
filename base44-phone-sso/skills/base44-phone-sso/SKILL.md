---
name: base44-phone-sso
description: >-
  Set up, extend or debug phone-number login (a one-time code on WhatsApp) for a
  Base44 app, end to end, even for someone starting from zero. Deploys a
  self-hosted OIDC identity provider as a Cloudflare Worker, connects it to
  Base44 as an Advanced/Manual SSO provider, gates logins with an in-app
  allowlist, and delivers the code through Green API or from the business's
  official number through Meta's WhatsApp Cloud API, with automatic failover
  between providers. Use this skill whenever the user wants people to log in to
  a Base44 app with a phone number instead of email, wants WhatsApp or SMS
  one-time-code login on Base44, mentions "login with phone", "OTP login",
  "WhatsApp login", "Green API login", "כניסה עם טלפון", "קוד אימות בוואטסאפ",
  "התחברות עם מספר טלפון לבייס44", "התחברות עם קוד אימות", or asks why phone
  login on Base44 fails with "Email not returned by OAuth provider". Also use it
  to fix an existing phone login: a login "loop" or a blank white page on some
  phones, codes that do not arrive, an invitation email on every login, a user
  who appears twice or under a phone number instead of a name, moving the code
  to the official business number, or adding a backup sender. Trigger even if
  they do not say "OIDC", "Cloudflare" or "Worker" by name: those are the
  implementation, and this skill is the canonical way to do phone login on Base44.
---

# Base44 phone-number login (one-time code on WhatsApp)

Give a Base44 app a "log in with your phone number" option. The user types a
phone number, gets a 6-digit code on WhatsApp, types it, and is signed in. No
email, no password.

## Why this is not a one-click Base44 setting

Base44's SSO only accepts standard **OIDC** identity providers, and it keys every
user by **email**. Phone-only users have no email, so off-the-shelf providers
fail with `Email not returned by OAuth provider`: their email claim comes only
from a real address and cannot be synthesized.

The fix is a small **self-hosted OIDC provider** (one Cloudflare Worker) that
sends the code on WhatsApp and hands Base44 a **stable derived email**
`<phone>@<domain>`, so the same phone always maps to the same Base44 user and
Row-Level Security keeps working.

```
[Base44 login] --OIDC--> [Worker: the guard] --code--> [WhatsApp: Green API or Meta]
                              |  reads the allowlist, makes sure the user exists
                              v
                    [Base44 app: allowlist entity + User]

optional:  browser -> [phoneLogin function on the APP'S domain] -> Worker
           (for networks that block *.workers.dev)
optional:  Worker -> [sendLoginOtp function in the app] -> Meta Cloud API
           (the app already holds the WhatsApp token)
```

The whole Worker is in `assets/worker-template/` (read its `README.md`), the two
optional app functions are in `assets/base44-functions/`. Nothing in them is
secret; every credential is a Worker secret or an app secret set at deploy time.

## Three decisions to settle with the user first

1. **Who sends the code?** Read `references/otp-providers.md` before answering.
   - **Green API**: fastest to launch. Plain text from an ordinary WhatsApp
     number, flat monthly price, no template approval. Unofficial channel, so
     always configure a second instance as backup.
   - **Meta Cloud API**: the code arrives from the business's official number.
     Needs a **verified business** and an approved **AUTHENTICATION** template;
     priced per message. A number that is on the Cloud API cannot also run on
     Green API.
   - A common path: launch on Green, switch to Meta when verification passes,
     keep Green as the automatic fallback.
2. **Is the app public or private?** A public app (site, blog, public booking)
   has "Auto-admit SSO users" locked, so the Worker must create the user itself
   (`PROVISION_USERS = "1"`, the default). See `references/base44-setup.md`.
3. **Will users be on filtered networks?** Kosher phones, school and workplace
   filters often block `*.workers.dev`. If that audience exists, serve the
   login page through the app's own domain from day one. See
   `references/app-domain-proxy.md`.

## Prerequisites

- **SSO available on the Base44 app.** It is a paid-plan feature (Elite at the
  time of writing). If the SSO "Set Up" button is missing, tell the user; it is
  their paid decision, never upgrade for them.
- A **Cloudflare account**, and a **Green API account** and/or a WhatsApp
  Business account on Meta's Cloud API. You cannot create accounts for the
  user: open the signup page and wait. See `references/account-setup.md`.
- Node and `npx wrangler` locally.

## The build, step by step

Work from a copy of `assets/worker-template/` in the user's project. Use the
browser for dashboard screens and the Base44 tools for data and app edits.

1. **Accounts + secrets.** Walk the user through signup, then have them copy
   `secrets.example.json` to `secrets.json` (gitignored) and fill in their own
   values. Never ask them to paste a secret into the chat.
2. **Keys.** `npm install`, `npm run keygen`. Writes `KEYS.local.json` and
   fills the OIDC placeholders in `wrangler.toml`.
3. **Prove the template works before touching any account:** `npm test`. Four
   suites run against fake services (Green, Meta, Green failover, Meta falling
   back to Green). They must pass.
4. **Fill `wrangler.toml`**: `__BASE44_APP_ID__`, `__SYNTHETIC_EMAIL_DOMAIN__`,
   `APP_NAME`, `LOCALE`, `DEFAULT_COUNTRY_CODE`, `OTP_PROVIDER`. Choose the
   email domain carefully: it can never change (see gotchas).
5. **Cloudflare.** `npx wrangler login` (the user approves in the browser),
   `npx wrangler kv namespace create OIDC_KV`, paste the id.
6. **Secrets.** Pipe each value from the local files into
   `npx wrangler secret put <NAME>` so nothing prints to the transcript. The
   list per provider is at the bottom of `wrangler.toml`.
7. **Deploy.** `npx wrangler deploy`, then check
   `curl https://<worker>.workers.dev/.well-known/openid-configuration` -> 200.
8. **Allowlist entity + admin page** in the app, and **add the owner's own
   number first**. See `references/base44-setup.md`.
9. **Connect Base44 SSO** (Advanced / Manual, Discovery URL + client id/secret).
   See `references/base44-setup.md`.
10. **Optional pieces**, each with its own reference: the Meta relay
    (`otp-providers.md`), the app-domain login page (`app-domain-proxy.md`),
    the login log (`LOGIN_LOG_ENTITY` in `wrangler.toml`).
11. **Test end to end in a real browser**: a fresh login from the app, an
    unapproved number is refused, a wrong code is refused, the user lands back
    where they started, and the user's name (not the phone) shows in the app.
    Only ever send test codes to a number the user told you to use.

## Hard-won gotchas

**Identity**
- **The derived-email domain is forever.** Changing `SYNTHETIC_EMAIL_DOMAIN`
  gives every user a new identity. It must also look like a real domain:
  `.local` and `.invalid` fail email validation. Use `phone.<app>.base44.app`.
- **Upgrading a deployment made with version 1 of this skill:** v1 derived the
  email from the Worker's host name when the var was unset. Set
  `SYNTHETIC_EMAIL_DOMAIN` to that exact host before deploying the new Worker,
  and keep the `approved` / `display_name` allowlist fields; both still work.
- **Deleting a user does not reset the person.** The phone derives the same
  email again, so on the next login they get a new User row that matches every
  record keyed by that email. If the owner wants a clean slate, the records
  keyed by email must be deleted too.
- **The name comes from the token.** Base44 sets `full_name` from the
  id_token's `name` claim when the user is created, and later updates to it can
  be silently ignored. Put the name on the allowlist row *before* the first
  login, or the phone number becomes the name.
- **A person already registered with a real email** must keep it. The Worker
  uses `linked_email` from the allowlist row before deriving one. Without it
  they get a second, empty identity.

**Base44**
- **You cannot create a User through the entities API.** Only the invite
  endpoint works, and it emails the address on every call. The Worker looks the
  user up first and invites only when missing. If someone reports an invitation
  email on every login, the lookup is failing: check the log for
  `USER_LOOKUP_FAILED`.
- **Entity writes drop fields that are not in the schema**, silently. Add
  `linked_email` and `last_login_at` to the allowlist entity or the Worker's
  markers vanish.
- **Requests to a Base44-hosted domain need a browser-like `User-Agent`.**
  Without one the CDN answers 403 (error 1010). This bites Workers, scripts and
  health checks alike.
- **Backend functions go live when saved**, without Publish. Frontend changes
  need Publish.

**Delivery**
- **Codes are an AUTHENTICATION template or nothing.** Meta rejects a code sent
  through a Utility template, and AUTHENTICATION templates cannot be created
  until the business is verified. Plan for that wait; launch on Green meanwhile.
- **Green answers 200 even when it did not send.** Only `idMessage` proves the
  message was queued. The template treats a 200 without it as a failure.
- **One sender is a single point of failure.** Configure a second Green
  instance (`GREEN_API_ID_2`) and leave `OTP_FALLBACK_GREEN` on.

**Reachability**
- **A "login loop" on some phones is usually a blocked domain.** A filtered
  device shows a blank page on `*.workers.dev` that loads forever. Ask what the
  screen looks like and whether Wi-Fi behaves differently before touching code.
  The fix is the app-domain proxy.
- **If the login page is served from a custom domain, login depends on that
  domain.** A lapsed or suspended domain (for example an unverified registrant
  email at the registrar) takes login down for everyone. Know the rollback:
  empty `PUBLIC_AUTHORIZE_URL`, or point it at the app's `*.base44.app` address.

**Process**
- **Account creation is the user's job.** Open the page and wait.
- **Deploying is a real, public action.** `wrangler secret put` and
  `wrangler deploy` publish a credential-bearing server. Get an explicit
  go-ahead first.
- **The gate fails closed.** Once connected, only listed numbers get in,
  including the owner. Seed the owner's number first.
- **Never log, store or display the code.** Not in the Worker, not in the
  relay, not in a login log an admin can read.
- **`... authentication failed` right after a correct code** is almost always a
  stale login tab or a login during a deploy. Retry from a completely fresh
  login and watch `npx wrangler tail`.

More symptoms and their causes: `references/troubleshooting.md`.

## Tuning

Everything per-deployment is a var in `wrangler.toml`: branding (`APP_NAME`,
`BRAND_ACCENT`, `LOGIN_SENDER_NOTE`), language (`LOCALE`, strings in
`src/messages.js`), limits (`SEND_LIMIT_PER_PHONE`, `SEND_LIMIT_PER_IP`,
`OTP_RESEND_COOLDOWN`), the allowlist entity name, and the delivery chain. Code
length, expiry and attempts are constants at the top of `src/index.js`.
