# base44-plugins

Claude Code plugins for [Base44](https://base44.com) builders, by Daniel Rechtman.

## Plugins

### `base44-phone-sso` — phone-number login for Base44 apps
Add "log in with your phone number" to a Base44 app. The user enters a phone
number, gets a 6-digit code on **WhatsApp**, types it, and is signed in. No email,
no password.

It works by deploying a tiny **self-hosted OIDC identity provider** (one free
Cloudflare Worker) that sends the code over WhatsApp via the **Green API** and
hands Base44 a stable synthetic email, so the phone becomes a real Base44 user
(and Row-Level Security keeps working). Approved numbers are managed from inside
the Base44 app. Requires the Base44 **Elite** plan (SSO is Elite-only).

---

## Install (in Claude Code)

```text
/plugin marketplace add daniel-rechtman/base44-plugins
/plugin install base44-phone-sso@base44-plugins
```

Then just describe what you want, e.g. *"set up phone-number login for my Base44
app"*, and the skill walks you through it end-to-end (account setup, key
generation, Cloudflare deploy, Base44 SSO wiring, and the in-app management page).

To update later:
```text
/plugin marketplace update base44-plugins
```

---

## התקנה בעברית

ב-Claude Code, הרץ שתי פקודות:

```text
/plugin marketplace add daniel-rechtman/base44-plugins
/plugin install base44-phone-sso@base44-plugins
```

ואז בקש "תקים לי כניסה עם מספר טלפון לאפליקציית Base44 שלי", והסקיל יוביל אותך
צעד-צעד: פתיחת חשבונות (Cloudflare + Green API), יצירת מפתחות, פריסת השרת,
חיבור ל-Base44, ובניית מסך ניהול המספרים המאושרים. דרוש מנוי Elite ב-Base44.

---

## Security note
The bundled Worker keeps **all secrets server-side** (Cloudflare Worker secrets).
Nothing sensitive ships to the browser. You provide your own Green API, Cloudflare,
and Base44 credentials locally; none of them live in this repository.

## License
MIT
