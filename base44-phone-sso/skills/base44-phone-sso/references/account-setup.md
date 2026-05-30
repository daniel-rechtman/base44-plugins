# Account setup: Cloudflare + Green API

Claude **cannot create accounts** for the user (a hard safety rule). Direct the
user to sign up themselves, wait for confirmation, then continue. Both have free
tiers that are enough to get started.

## Cloudflare (hosts the Worker)
Cloudflare runs the small login server (a "Worker"). Free tier is plenty.

1. Tell the user to sign up at **https://dash.cloudflare.com/sign-up** and verify
   their email.
2. That is all that is needed up front. The skill logs in via `wrangler login`
   (a browser approval), creates the KV store, sets secrets, and deploys.
3. If `wrangler deploy` complains there is **no workers.dev subdomain**, send the
   user to **Workers & Pages** in the dashboard once to pick an account
   subdomain (one-time, free). After that the Worker URL can be enabled under the
   Worker's **Domains** tab.

## Green API (sends the WhatsApp OTP)
Green API is a WhatsApp gateway. It charges a flat monthly fee per instance, with
**no per-message cost**, which is why it beats SMS at scale.

1. Sign up at **https://console.green-api.com/**.
2. Create a new **instance** (Developer / GREEN-API type).
3. On the instance page, **scan the QR code** with the WhatsApp account that will
   send the codes (a normal phone with WhatsApp). This authorizes the instance.
4. Copy the two values from the instance page:
   - **ID Instance**  -> `GREEN_API_ID`
   - **API Token Instance** -> `GREEN_API_TOKEN`
5. Verify it is connected:
   ```bash
   curl "https://api.green-api.com/waInstance<ID>/getStateInstance/<TOKEN>"
   ```
   It must return `{"stateInstance":"authorized"}`. If it shows anything else,
   the QR was not scanned or the phone went offline; OTP delivery will fail.

## Base44 app values (assume the user already has a Base44 app)
This skill targets Base44 users, so the app exists. Collect:
- **App ID** — the part between `/apps/` and `/editor/` in the editor URL.
- **api_key** — from the app's Code / SDK snippet
  (`createClient({ appId, headers: { api_key } })`). The Worker uses it to read
  the allowlist. It is set as a Worker **secret**, never exposed to the browser.
- **Redirect URI** — `https://app.base44.com/api/apps/<app id>/auth/sso/callback`.

## Collecting secrets locally
Have the user copy `secrets.example.json` to `secrets.json` and fill in their
values (Green API id/token, Base44 app id, api_key, redirect URI, app name).
`secrets.json` is gitignored. The skill reads it to set the Worker secrets.
The OIDC client id/secret and private key are **generated** (`npm run keygen`),
not entered by hand.
