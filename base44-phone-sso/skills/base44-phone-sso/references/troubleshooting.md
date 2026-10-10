# Troubleshooting

Start with two commands. They answer most questions:

```bash
curl -s https://<worker>.workers.dev/.well-known/openid-configuration   # is it up, where does it send people
npx wrangler tail                                                       # live log while the user retries
```

A problem that leaves **no line in the log** never reached the Worker: look at
the network and the domain, not at the code.

| Symptom | Likely cause | What to do |
|---|---|---|
| `Email not returned by OAuth provider` | `SYNTHETIC_EMAIL_DOMAIN` is empty or not a valid-looking domain, or the scope lacks `email` | Set a real-looking domain; scope `openid email profile` |
| Every number is refused | Wrong `BASE44_API_KEY`, wrong `BASE44_APP_ID`, or the allowlist entity does not exist. The gate fails closed | Log shows `ALLOWLIST_LOOKUP_FAILED`. Fix the key or the entity name |
| One approved person is refused | Their row is inactive, or the number is stored in a shape the normalizer cannot reach (wrong country, missing digits) | Log shows `ACCESS_DENIED not_listed` or `inactive`. Compare the stored value with what they type |
| The code does not arrive (Green) | Instance logged out or its phone is offline | `getStateInstance` must be `authorized`. Add a backup instance |
| The code does not arrive (Meta) | Template not approved, name or language mismatch, wrong phone number id, expired token | Log shows `META_SEND_FAILED` / `META_RELAY_FAILED` with Meta's code |
| Meta: button parameter error | The template's button type differs from the envelope sent | `META_OTP_BUTTON_TYPE`: `url` -> `copy_code` -> `none` |
| Meta: cannot create the template | The business is not verified | Wait for verification. Run on Green meanwhile |
| "... authentication failed" after a correct code | Stale login tab, or a login during a deploy | Fresh login from the app |
| "An error occurred during login" at Base44 | The user does not exist and could not be created | Log shows `USER_PROVISION_FAILED`. Check the api_key; `PROVISION_USERS` must not be `0` on a public app |
| An invitation email on every login | The user lookup fails, so the Worker invites defensively each time | Log shows `USER_LOOKUP_FAILED`. Fix the api_key or the User read permission |
| The user's name is their phone number | No name on the allowlist row at first login | Add the name before first login; for existing users show the allowlist name in the UI |
| A person appears twice in the admin list | The allowlist row and the User row are not joined | `linked_email` missing from the entity schema, or the list does not join on it |
| A deleted user "comes back" with old data | Same phone -> same derived email -> matches records keyed by that email | Delete the records too, or accept that deletion is not a reset |
| Blank page / "loop" on some phones only | `*.workers.dev` blocked by a content filter | `app-domain-proxy.md` |
| Login broke for everyone at once | The domain in `PUBLIC_AUTHORIZE_URL` is down, or the Worker was deleted | Check the domain (`whois`), roll `PUBLIC_AUTHORIZE_URL` back |
| 403 when calling an app function from a script or Worker | Missing browser-like `User-Agent` (CDN error 1010) | Send `User-Agent: Mozilla/5.0 ...` |
| "Too many attempts" during testing | Rate limits | Raise `SEND_LIMIT_PER_PHONE` / `SEND_LIMIT_PER_IP`, lower `OTP_RESEND_COOLDOWN`, deploy |
| The user lands on the home page after login | The login was started without the original page | Fix the link that starts the login (`from_url`), not the Worker |

## Asking the right questions first

When someone reports "I cannot log in", get these before opening any file:

1. What exactly is on the screen? A screenshot or a recording.
2. Which step: the app's login button, the phone page, the code, or after it?
3. Does it work from another network or device?
4. Did a code arrive on WhatsApp?

Step and network together usually name the cause before any log is read.

## Testing without bothering real users

- `npm test` exercises the whole flow against fake services.
- For a real end-to-end test, use a number the owner explicitly approved for
  testing, and add it to the allowlist. Codes expire in 5 minutes: type them
  as soon as they arrive.
- Never send a test code to a customer's number.
