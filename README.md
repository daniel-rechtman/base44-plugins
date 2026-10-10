# base44-plugins

Claude Code plugins for [Base44](https://base44.com) builders, by Daniel Rechtman.

## Plugins

### `base44-phone-sso`: phone-number login for Base44 apps

Add "log in with your phone number" to a Base44 app. The user enters a phone
number, gets a 6-digit code on **WhatsApp**, types it, and is signed in. No
email, no password.

It works by deploying a small **self-hosted OIDC identity provider** (one free
Cloudflare Worker) that sends the code on WhatsApp and hands Base44 a stable
derived email, so the phone becomes a real Base44 user and Row-Level Security
keeps working. Approved numbers are managed from inside the app.

**New in 2.0**

- **Two ways to deliver the code**, with automatic failover: Green API (plain
  WhatsApp text, quick to launch) or Meta's WhatsApp Cloud API (the business's
  official number, AUTHENTICATION template). Several Green instances can back
  each other up.
- **Send through the app.** If the app already talks to WhatsApp, the Worker
  can ask a backend function to deliver the code, so the token lives in one place.
- **Login page on the app's own domain.** Filtered networks often block
  `*.workers.dev` and show a blank page. An optional backend function serves
  the login page from the app's domain instead.
- **Users are created for you.** Public apps cannot auto-admit SSO users; the
  Worker now makes sure the user exists, without an invitation email on every login.
- **Names, not phone numbers.** The name on the allowlist becomes the user's name.
- **A test suite that needs no accounts**: fake services, four delivery
  scenarios, 26 checks each.
- Hebrew and English login pages, a troubleshooting guide, and a longer list of
  hard-won gotchas.

Upgrading from 1.0: the allowlist fields `approved` and `display_name` are
still honoured. The Worker is now several files and a few var names changed
(`ALLOWED_REDIRECT_URI` became `ALLOWED_REDIRECT_URIS`, the client id is a var),
so redeploy from the new template rather than patching the old one. Keep the
derived-email domain exactly as it was, or every user gets a new identity: if
you never set `SYNTHETIC_EMAIL_DOMAIN`, version 1 used the Worker's host name,
so set the var to that host explicitly before deploying.

SSO on Base44 is a paid-plan feature (Elite at the time of writing).

---

## Install (in Claude Code)

```text
/plugin marketplace add daniel-rechtman/base44-plugins
/plugin install base44-phone-sso@base44-plugins
```

Then describe what you want, e.g. *"set up phone-number login for my Base44
app"*, and the skill walks you through it: accounts, key generation, the
Cloudflare deploy, the Base44 SSO connection, and the in-app allowlist page.

To update later:
```text
/plugin marketplace update base44-plugins
```

---

## התקנה בעברית

ב-Claude Code, שתי פקודות:

```text
/plugin marketplace add daniel-rechtman/base44-plugins
/plugin install base44-phone-sso@base44-plugins
```

ואז מבקשים "תקים לי כניסה עם מספר טלפון לאפליקציית Base44 שלי", והסקיל מוביל
צעד אחרי צעד: פתיחת חשבונות, יצירת מפתחות, פריסת השרת, חיבור ל-Base44 ובניית
מסך לניהול המספרים המאושרים.

מה חדש בגרסה 2: שליחת הקוד מהמספר הרשמי של העסק דרך מטא או דרך Green API עם
גיבוי אוטומטי ביניהם, עמוד התחברות שמוגש מהדומיין של האפליקציה (למכשירים עם
סינון שחוסמים את כתובת השרת), יצירת משתמשים אוטומטית באפליקציות ציבוריות בלי
מייל הזמנה בכל כניסה, ומדריך תקלות.

---

## Security note

The bundled Worker keeps **all secrets server-side** (Cloudflare Worker secrets
and Base44 app secrets). Nothing sensitive ships to the browser, and the
one-time code is never written to a log or a database. You provide your own
Green API, Meta, Cloudflare and Base44 credentials locally; none of them live
in this repository.

## License

MIT
