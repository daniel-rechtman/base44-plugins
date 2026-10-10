# Account setup: Cloudflare, and a way to send WhatsApp messages

You **cannot create accounts** for the user. Open the signup page, wait for them
to finish, then continue. Never ask them to paste a token into the chat: they
put it in `secrets.json` on their own machine and you pipe it from there.

## Cloudflare (hosts the Worker)

The free tier is enough.

1. The user signs up at **https://dash.cloudflare.com/sign-up** and verifies
   their email.
2. That is all up front. `npx wrangler login` (a browser approval) does the
   rest: the KV store, the secrets, the deploy.
3. If `wrangler deploy` says there is **no workers.dev subdomain**, the user
   opens **Workers & Pages** once and picks an account subdomain (one-time,
   free). Then the Worker URL can be enabled under the Worker's **Domains** tab.

## Option A: Green API (plain WhatsApp text)

Green API drives an ordinary WhatsApp account. Flat monthly fee per instance,
no per-message cost, no template approval.

1. Sign up at **https://console.green-api.com/**.
2. Create an **instance**.
3. On the instance page, **scan the QR code** with the WhatsApp account that
   will send the codes. That authorizes the instance.
4. Copy two values into `secrets.json`:
   - **ID Instance** -> `GREEN_API_ID`
   - **API Token Instance** -> `GREEN_API_TOKEN`
5. Verify it is connected:
   ```bash
   curl "https://api.green-api.com/waInstance<ID>/getStateInstance/<TOKEN>"
   ```
   It must return `{"stateInstance":"authorized"}`. Anything else means the QR
   was not scanned or the phone went offline, and codes will not go out.
6. **Strongly recommended:** a second instance on a *different* WhatsApp number,
   as `GREEN_API_ID_2` / `GREEN_API_TOKEN_2`. When the first drops, the Worker
   moves to the second on its own.

Constraints to tell the user:
- The sending number must stay logged in on a phone that is online.
- A number registered on Meta's Cloud API **cannot** be used here. Use another.
- Users see the sender's number, so pick one whose name makes sense, and set
  `LOGIN_SENDER_NOTE` so the login page says who the code will come from.

## Option B: Meta WhatsApp Cloud API (the official business number)

Use this when the business already has, or wants, its number on the Cloud API.
The full walkthrough is in `otp-providers.md`. What must exist first:

- A WhatsApp Business Account whose **business is verified** by Meta.
- An **AUTHENTICATION** template, approved, in the language you will send.
- Either a permanent token the Worker can use, or (better) an app that already
  holds a WhatsApp token, in which case the Worker sends through the app.

Business verification can take days and can be rejected over paperwork. Do not
block the launch on it: start on Green and switch later with one config change.

## Base44 app values

- **App ID**: the part between `/apps/` and `/editor/` in the editor URL.
- **api_key**: from the app's API / SDK settings. The Worker uses it to read the
  allowlist and to make sure users exist. It is a Worker **secret**.
- **Redirect URI**: shown on the SSO setup screen. Normally
  `https://app.base44.com/api/apps/<app id>/auth/sso/callback`. Copy the exact
  value from the screen into `ALLOWED_REDIRECT_URIS`.
