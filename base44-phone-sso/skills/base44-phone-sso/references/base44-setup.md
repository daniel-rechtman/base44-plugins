# Base44 setup: SSO connection, allowlist entity, management page

Two ways to act on the Base44 app:
- **Browser** (Chrome MCP) for dashboard UI: the SSO connection screen.
- **Base44 MCP tools** for data/schema/app edits: the entity, seed records, and
  the management page.

## Prerequisite: Elite plan
Base44 SSO is only available on the **Elite plan** or higher. If the SSO "Set Up"
button is missing, the app is not on Elite. This is a paid decision for the user;
do not assume or upgrade on their behalf.

## 1. Connect the Worker as an SSO provider (browser)
In the app editor: **Dashboard -> Settings -> Authentication -> Single Sign-on
(SSO) -> Set Up**. Choose **Advanced / Manual Configuration** and fill:

| Field | Value |
|-------|-------|
| Name | e.g. `Phone (WhatsApp)` |
| Client Id | `OIDC_CLIENT_ID` from `KEYS.local.json` |
| Client Secret | `OIDC_CLIENT_SECRET` from `KEYS.local.json` |
| Scope | `openid email profile` (leave as default) |
| Discovery Url | `https://<your-worker>.workers.dev/.well-known/openid-configuration` |

Leave Auth/Token/Userinfo/Jwks endpoints empty (the Discovery URL provides them).
Keep **Use PKCE** on (the Worker supports S256). Click **Enable SSO**. Base44
fetches the Discovery URL to validate; a success toast means the OIDC plumbing is
wired. The **Platform domain** shown must equal the Worker's `ALLOWED_REDIRECT_URI`.

## 2. Create the allowlist entity (Base44 MCP)
Create an entity `AuthorizedPhone` with:
- `phone` (string, required) — any format; the Worker normalizes it
- `approved` (boolean, default true)
- `display_name` (string)
- `note` (string)

**Seed the owner's own number as approved first**, otherwise enabling the gate
locks everyone out. Store it in international form without `+` (e.g. `9725...`),
though any format works because matching is format-tolerant.

## 3. Build the in-app management screen (Base44 MCP edit)
Send the Base44 builder a concise change request, e.g.:

> Add an admin-only page "Authorized Users" to manage the existing
> AuthorizedPhone entity: a table with phone, name, approved (yes/no), note, and
> add / edit / delete plus a toggle to approve or unapprove. Add a link to it in
> the main navigation.

`edit_base44_app` is asynchronous. After calling it, immediately give the user the
returned `editorUrl` as a clickable link, then poll status.

## 4. The login error you will likely see at least once
`{"message":"Phone (WhatsApp) authentication failed"}` on the callback almost
always means a **stale login session** (an old `/authorize` tab whose code or PKCE
no longer matches) or a login attempted **mid-deploy**. Fix: a completely fresh
login from the app's login screen. Health-check the Worker
(`/.well-known/openid-configuration` returns 200) and use `wrangler tail` to watch
live logs while the user retries.

## How the synthetic email keeps identity stable
The Worker returns `email = <phone>@<domain>` deterministically, so the same phone
always lands on the same Base44 user (no duplicate accounts, no random emails).
This is precisely what a managed provider like Clerk cannot do for phone-only
users (its email claim comes only from a real email address), which is why the
self-hosted Worker exists.
