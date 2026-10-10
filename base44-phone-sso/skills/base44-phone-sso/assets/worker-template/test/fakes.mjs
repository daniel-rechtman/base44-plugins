// fakes.mjs - a fake Green API + Meta Graph API + Base44 REST, for local tests
// only. Nothing here talks to a real service and every number below is made up.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";

const DIR = process.env.PHONE_SSO_TEST_DIR || "/tmp/phone-sso-test";
mkdirSync(DIR, { recursive: true });
const put = (name, value) => writeFileSync(`${DIR}/${name}`, String(value));

// The allowlist, stored the messy way real lists are stored.
const AUTHORIZED = [
  { id: "a1", phone: "972500000001", full_name: "Dana Cohen", is_active: true, linked_email: "dana@example.com" },
  { id: "a2", phone: "9720500000002", full_name: "Leftover Zero", is_active: true },
  { id: "a3", phone: "050-000-0003", full_name: "Never Logged In", is_active: true },
  { id: "a4", phone: "972500000004", full_name: "Deactivated", is_active: false },
  { id: "a5", phone: "972500000005", display_name: "V1 Schema Row", approved: true },
];
const USERS = [];
let invites = 0;
put("invites.txt", 0);

createServer((req, res) => {
  let b = "";
  req.on("data", (d) => (b += d));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    const url = req.url;

    // ---- Green API ----
    const green = url.match(/waInstance(\d+)\/sendMessage/);
    if (green) {
      // instance 9999 plays a logged-out number: Green answers 200 with no idMessage
      if (green[1] === "9999") return res.end(JSON.stringify({}));
      const p = JSON.parse(b || "{}");
      const m = String(p.message || "").match(/\b(\d{6})\b/);
      put("otp.txt", m ? m[1] : "");
      put("via.txt", `green:${green[1]}`);
      return res.end(JSON.stringify({ idMessage: "GREEN_TEST" }));
    }

    // ---- Meta Graph API ----
    if (url.includes("/messages")) {
      // phone number id "down" plays an outage / a rejected template
      if (url.includes("/down/")) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { code: 131000, message: "simulated outage" } }));
      }
      const p = JSON.parse(b || "{}");
      put("otp.txt", p.template.components[0].parameters[0].text);
      put("via.txt", "meta");
      return res.end(JSON.stringify({ messages: [{ id: "wamid.TEST" }] }));
    }

    // ---- Base44: invite ----
    if (url.includes("/runtime/users/invite-user")) {
      const p = JSON.parse(b || "{}");
      invites++;
      put("invites.txt", invites);
      if (!USERS.find((u) => u.email === p.user_email)) {
        USERS.push({ id: "u_" + (USERS.length + 1), email: p.user_email, role: p.role });
      }
      put("users.json", JSON.stringify(USERS));
      return res.end(JSON.stringify({ success: true }));
    }

    // ---- Base44: allowlist ----
    if (/\/entities\/AuthorizedPhone\/[^/?]+$/.test(url)) {
      const row = AUTHORIZED.find((r) => r.id === url.split("/").pop());
      if (row) Object.assign(row, JSON.parse(b || "{}"));
      return res.end(JSON.stringify(row || {}));
    }
    if (url.includes("/entities/AuthorizedPhone")) return res.end(JSON.stringify(AUTHORIZED));

    // ---- Base44: User lookup (?q={"email":...}) and update ----
    if (/\/entities\/User\/u_\d+$/.test(url)) {
      const row = USERS.find((u) => u.id === url.split("/").pop());
      if (row) Object.assign(row, JSON.parse(b || "{}"));
      put("users.json", JSON.stringify(USERS));
      return res.end(JSON.stringify(row || {}));
    }
    if (url.includes("/entities/User")) {
      let q = {};
      try { q = JSON.parse(new URL(url, "http://x").searchParams.get("q") || "{}"); } catch (_) {}
      return res.end(JSON.stringify(USERS.filter((u) => !q.email || u.email === q.email)));
    }

    res.statusCode = 404;
    res.end("{}");
  });
}).listen(8798, () => console.log("fakes :8798"));
