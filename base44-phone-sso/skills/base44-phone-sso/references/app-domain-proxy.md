# Serving the login page from the app's own domain

## The problem this solves

The Worker lives on `*.workers.dev`. Content filters block that domain on a
surprising number of devices: kosher phones and filtered SIMs, school and
workplace networks, some parental-control profiles. The user taps "log in", and
gets a blank white page that loads forever. They describe it as "it keeps
looping" or "nothing happens".

### Recognising it

- It happens to specific people every time, and to nobody else.
- The same person can log in from a computer or from a different network.
- Their screen is **blank**, not an error message. Ask for a screenshot or a
  screen recording before reading any code.
- On their device, `https://<worker>.workers.dev/health` does not load.
- The Worker's log shows **no request at all** from them. A login problem with
  no trace in the log is a network problem.

Clearing cookies, sending the link again and "try another browser" do not help.

## The fix

A backend function in the Base44 app serves the three browser-facing paths from
the app's domain and forwards them to the Worker. `/token` and `/jwks.json` stay
on the Worker, because Base44 calls those from its own servers.

```
browser -> https://<app-domain>/api/apps/<app id>/functions/phoneLogin -> Worker
```

### Setup

1. Generate one long random value (for example `openssl rand -base64 32`).
2. Worker: `npx wrangler secret put PROXY_SHARED_SECRET` with that value.
3. App: create a backend function `phoneLogin` from
   `assets/base44-functions/phoneLogin.entry.ts`, and set the app secrets
   `PHONE_LOGIN_WORKER_URL` (the Worker's URL) and `PHONE_LOGIN_PROXY_SECRET`
   (the same random value). Functions go live when saved; no Publish is needed.
4. Check the function by itself. Opened with no parameters it should answer
   with the Worker's "invalid request" page (HTTP 400). That proves the path
   app -> Worker works. Send a browser-like `User-Agent` when testing with
   curl, or the CDN answers 403.
5. In `wrangler.toml` set
   `PUBLIC_AUTHORIZE_URL = "https://<app-domain>/api/apps/<app id>/functions/phoneLogin"`
   and deploy. The discovery document now advertises the app-domain address,
   and Base44 picks it up on the next login.
6. Do a full login in a real browser, and confirm in the address bar that the
   phone page is on the app's domain.

### Why the shared secret matters

Through the proxy, every request reaches the Worker from the proxy's IP. The
Worker rate-limits per IP, so without help all users would share one bucket.
The proxy forwards the user's real IP in `X-Real-Client-IP`, and the Worker
believes that header **only** when `X-Proxy-Secret` matches. Anyone else who
sends those headers is ignored (there is a test for it).

The same goes for `X-Proxy-Base`, which tells the page where to post.

### Which domain to use

- The app's `*.base44.app` address always works and has no extra dependency.
- A custom domain looks better, but login now **depends on that domain being
  up**. If the domain lapses, or the registrar suspends it (an unverified
  registrant email is enough, typically about two weeks after purchase), login
  breaks for every user at once, including on the `*.base44.app` address,
  because the discovery document points at the dead domain.

If a custom domain is used, write down the rollback next to the config:

```toml
# rollback: empty this (the Worker serves the page) or use the *.base44.app URL
PUBLIC_AUTHORIZE_URL = ""
```

A quick outside check when "the whole site is down":
`whois <domain> | grep -i status`. `clientHold` means the registrar suspended
it; the cure is at the registrar (usually confirming the owner's email), not in
the app or the Worker.

### Rollback

Empty `PUBLIC_AUTHORIZE_URL` and deploy. Nothing else changes; the function can
stay in place unused.
