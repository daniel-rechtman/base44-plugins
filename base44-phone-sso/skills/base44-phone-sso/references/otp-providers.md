# Delivering the code: Green API, Meta's Cloud API, and failover

The Worker generates and verifies the code itself. A provider only delivers it.
That is why providers can be swapped or chained without touching the login logic.

## Choosing

| | Green API | Meta WhatsApp Cloud API |
|---|---|---|
| The code arrives from | an ordinary WhatsApp number | the business's official number |
| Message | free text you control (`src/messages.js`) | Meta's fixed AUTHENTICATION wording |
| To start | scan a QR code | verified business + approved template |
| Price | flat monthly, per instance | per message |
| Risk | unofficial channel: the number can be logged out or limited | official channel |
| Can share a number with the other | no | no |

Typical path: launch on **Green**, apply for business verification in parallel,
switch `OTP_PROVIDER` to `meta` when the template is approved, and keep Green
configured as the automatic fallback.

## The chain

`src/otp.js` builds the order from three vars:

- `OTP_PROVIDER = "green"` (default): Green first. Meta is tried afterwards only
  when `OTP_FALLBACK_META = "1"`, because without an approved template Meta
  rejects the send anyway.
- `OTP_PROVIDER = "meta"`: Meta first, then Green whenever a Green instance is
  configured (`OTP_FALLBACK_GREEN = "0"` turns that off).

Inside Green, instances are tried in order: `GREEN_API_ID`, then `_2` to `_5`.
Each is a different WhatsApp number.

Log markers: `OTP_PROVIDER_FAILED <provider>`, `OTP_PROVIDER_FALLBACK <provider>`,
`GREEN_FALLBACK_USED <instance>`, `GREEN_ALL_INSTANCES_FAILED`.

## Green API details

- Setup is in `account-setup.md`.
- **A 200 is not a delivery.** Green answers 200 with an empty body when the
  instance is logged out or the message was not queued. Only `idMessage` proves
  acceptance; the template treats its absence as a failure and moves on.
- Keep an eye on the instance state (`getStateInstance` must say `authorized`).
- Secrets: `GREEN_API_ID`, `GREEN_API_TOKEN` (and `_2`...).

## Meta Cloud API details

### What Meta requires

- **A verified business.** Until verification passes, creating a template in
  the AUTHENTICATION category is refused (the WhatsApp account's health status
  shows the reason; error 141010 is the unverified-business one). Nothing in
  the API works around it.
- **The AUTHENTICATION category.** A code sent through a Utility template is
  rejected with an incorrect-category error. Do not try to disguise a code as a
  utility message: it risks the number's quality rating.
- **The fixed format.** An AUTHENTICATION template has Meta's wording ("<code>
  is your verification code"), optional security and expiry lines, and a
  copy-code or one-tap button. You choose the language and the options, not
  the sentence.

### Creating the template

In WhatsApp Manager -> Message templates -> Create template -> Authentication:
choose the language, tick the security recommendation if wanted, set the expiry
to 5 minutes (it matches the Worker), choose the **Copy code** button, submit.
Once the business is verified, approval usually takes minutes.

Set `META_TEMPLATE_NAME` and `META_TEMPLATE_LANG` to match exactly. A wrong
language code fails the same way as a missing template.

### Sending: two ways

**Through the app (recommended when the app already uses WhatsApp).**
The app holds a working Cloud API token as a secret. The Worker asks a backend
function to send, so there is no second copy of the token.

1. Create a backend function `sendLoginOtp` from
   `assets/base44-functions/sendLoginOtp.entry.ts`.
2. Generate one long random value. Set it as `LOGIN_OTP_RELAY_SECRET` in the
   app's secrets **and** as a Worker secret of the same name.
3. Make sure the app has `WHATSAPP_CLOUD_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`
   (rename in the function if the app uses other names). Optionally
   `LOGIN_OTP_TEMPLATE`, `LOGIN_OTP_TEMPLATE_LANG`, `LOGIN_OTP_COUNTRY_PREFIX`.
4. In `wrangler.toml` set
   `META_RELAY_URL = "https://<app-domain>/api/apps/<app id>/functions/sendLoginOtp"`
   and deploy.

The function refuses everything except: the right secret, a 6-digit code, a
plausible number. If the secret leaked, the worst an attacker could do is send
Meta's fixed code message.

When adding secrets to an existing app, add only the new ones. Do not rewrite
secrets the app already has; scheduled automations may hold the old values.

**Directly from the Worker.** Set `META_PHONE_NUMBER_ID` in `wrangler.toml`,
leave `META_RELAY_URL` empty, and put a permanent System User token (with
`whatsapp_business_messaging`) in the Worker secret `META_TOKEN`. The user
creates that token in Meta Business Settings and places it in `secrets.json`
themselves. Never generate, read or copy a live token on their behalf.

### Button parameter errors

`META_OTP_BUTTON_TYPE` defaults to `url` (the envelope used for one-tap and
copy-code buttons). If Meta answers with a button-parameter error, try
`copy_code`, then `none`. Change the var, deploy, send one test code.

### Delivery status

The relay returns Meta's message id (`wamid`). With `LOGIN_LOG_ENTITY` set, the
Worker stores it as `provider_message_id`, so an existing WhatsApp status
webhook in the app can mark the row delivered or read.

## Switching providers safely

1. Send a code through the new provider **before** switching: with the relay,
   call the function once with the secret and the user's own number.
2. Change `OTP_PROVIDER`, deploy.
3. Do one full login in a real browser, to a number the user approved for tests.
4. Watch `npx wrangler tail` for `OTP_PROVIDER_FAILED` during the first day.
5. Rollback is the same var flipped back. Keep the old provider's secrets in
   place until the new one has carried real logins.

## What must never happen

The code is never written to a log, an entity or a screen: not by the Worker,
not by the relay, not by a login log. An admin who can read "a code was sent to
this number" must not be able to read the code.
