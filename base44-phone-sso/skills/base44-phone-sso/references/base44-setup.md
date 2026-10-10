# Base44 setup: the allowlist, the SSO connection, and how users come to exist

Two ways to act on the app:
- **Browser** for dashboard screens (the SSO connection).
- **Base44 tools** for data, schema and app edits.

## 1. The allowlist entity

Create an entity (default name `AuthorizedPhone`; change it with
`ALLOWLIST_ENTITY`) with these fields:

| Field | Type | Purpose |
|---|---|---|
| `phone` | string, required | Any format. The Worker normalizes both sides |
| `full_name` | string | Becomes the user's name on first login |
| `is_active` | boolean, default true | `false` blocks the number without deleting it |
| `note` | string | Free text for the owner |
| `linked_email` | string | Written by the Worker: the email this person logs in as |
| `last_login_at` | string (date-time) | Written by the Worker |

`linked_email` and `last_login_at` must be in the schema. Base44 silently drops
fields it does not know, and then every admin screen that wants to show "has
this person logged in yet" has nothing to read.

Lists created with version 1 of this skill use `approved` and `display_name`.
The Worker still honours both.

Restrict the entity to admins (Row-Level Security). The Worker reads it with the
app's api_key, so it does not need to be readable by users.

**Add the owner's own number first.** The gate fails closed: from the moment SSO
is connected, a number that is not on the list cannot log in.

### The admin page

Ask the Base44 builder for a concise change, for example:

> Add an admin-only page to manage the AuthorizedPhone entity: a table with
> name, phone, active (yes/no), note and last login, with add / edit / delete
> and a switch to activate or deactivate. Link it from the admin navigation.

`edit_base44_app` is asynchronous: give the user the returned editor link right
away, then poll.

If the app already has a "customers" or "patients" screen, fold the allowlist
into it instead of a separate page. Show one row per person: join the allowlist
row and the User row on `linked_email` (or on the normalized phone), otherwise
someone who has logged in shows up twice, once as "not logged in yet".

## 2. Connect the Worker as an SSO provider (browser)

In the editor: **Dashboard -> Settings -> Authentication -> Single Sign-on (SSO)
-> Set Up**, choose **Advanced / Manual Configuration**:

| Field | Value |
|---|---|
| Name | What the button will say, e.g. "Phone number" |
| Client Id | `OIDC_CLIENT_ID` from `KEYS.local.json` |
| Client Secret | `OIDC_CLIENT_SECRET` from `KEYS.local.json` |
| Scope | `openid email profile` |
| Discovery Url | `https://<your-worker>.workers.dev/.well-known/openid-configuration` |

Leave the individual endpoint fields empty (the Discovery URL provides them),
keep **Use PKCE** on, click **Enable SSO**. Base44 fetches the Discovery URL to
validate; a success toast means the plumbing is wired. The redirect URI shown on
that screen must be in the Worker's `ALLOWED_REDIRECT_URIS`, exactly.

Have the user type the client secret into the Base44 screen themselves.

Base44 re-reads the discovery document on each login, so later changes to
`PUBLIC_AUTHORIZE_URL` take effect on the next login without touching this
screen.

## 3. How a user comes to exist (public apps)

Base44's **Auto-admit SSO users** switch is only offered to private apps where
SSO is the only way in. On a public app it is locked, and Base44 refuses to log
in an email nobody invited. Every phone login brings an email Base44 has never
seen, so without help the login ends in a generic "An error occurred during
login".

The Worker handles it (`src/provision.js`, on by default):

1. When the code is sent, it looks the user up by email. Missing -> it calls the
   invite endpoint in the background. The 15 to 60 seconds the person spends
   reading and typing the code are when Base44 creates the row.
2. When the code is verified, it checks again before returning to Base44. If
   the user still cannot be created, the person sees a clear message on the
   login page instead of a broken redirect.
3. It marks `linked_email` and `last_login_at` on the allowlist row.
4. In the background it fills in `phone` on the User row.

Things that follow from this:

- The invite endpoint **sends an email on every call**. The Worker invites only
  when the lookup finds nobody, which is why a derived address never gets mail
  and a real linked address gets exactly one.
- Users cannot be created through `/entities/User`; Base44 rejects it.
- Filter the User entity with `?q={"email":"..."}`. A plain `?email=` query is
  answered with the default list and can miss a user who exists.
- For a private app with Auto-admit on, set `PROVISION_USERS = "0"`.

## 4. Names

`full_name` is owned by Base44's auth system. It is taken from the id_token's
`name` claim when the user is created, and a later update through the entities
API can be silently ignored. So:

- Put the name on the allowlist row **before** the person's first login.
- If a user was already created with a phone number as their name, show the
  allowlist name in the app's UI instead (a small backend function that returns
  the allowlist name for the logged-in user works well).

## 5. After login

Base44 carries the page the user started from through the OIDC `state`, and
returns them there. If people land on the home page instead of the page they
wanted, the login was started without that page in `from_url`; fix the link or
button that starts the login, not the Worker.

## 6. The error you will see at least once

`{"message":"<provider name> authentication failed"}` on the callback, right
after a correct code, almost always means a **stale login tab** (an old
`/authorize` page whose code or PKCE no longer matches) or a login made **during
a deploy**. Start a completely fresh login from the app. If it repeats, check
the Worker's health URL and watch `npx wrangler tail` while the user retries.
