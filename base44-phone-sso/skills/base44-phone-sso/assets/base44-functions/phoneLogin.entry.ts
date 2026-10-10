// phoneLogin - serves the phone login page from the APP'S OWN DOMAIN.
// Save as a Base44 backend function named `phoneLogin` (functions/phoneLogin/entry.ts).
//
// Why this exists: the identity provider is a Cloudflare Worker on
// *.workers.dev. Networks and devices with content filtering (kosher phones,
// school / workplace filters, some parental controls) often block that domain
// and show a blank page that loads forever. To the user it looks like a
// "login loop". The app's own domain is open for them, so this function
// proxies the only three paths the browser ever touches:
//
//   GET  ?<the authorize query>   -> Worker /authorize         (the HTML page)
//   POST ?op=send   {sid,phone}   -> Worker /authorize/send    (send the code)
//   POST ?op=verify {sid,code}    -> Worker /authorize/verify  (check it -> redirect)
//
// /token and /jwks stay on the Worker: Base44 calls them from its own servers,
// not from the user's phone.
//
// It proves itself to the Worker with a shared secret. Only then does the
// Worker honour X-Real-Client-IP. Without that every user would share the
// rate limit of this proxy's single IP.
//
// Public on purpose: this is a login page, there is no user yet.
//
// App secrets:
//   PHONE_LOGIN_WORKER_URL    https://<your-worker>.workers.dev
//   PHONE_LOGIN_PROXY_SECRET  same value as the Worker secret PROXY_SHARED_SECRET
//   PHONE_LOGIN_PUBLIC_URL    optional; the public URL of THIS function. Set it
//                             when the function sits behind a custom domain and
//                             the Host header does not show it.
const WORKER = (Deno.env.get("PHONE_LOGIN_WORKER_URL") || "").replace(/\/$/, "");
const SECRET = Deno.env.get("PHONE_LOGIN_PROXY_SECRET") || "";
const PUBLIC_URL = (Deno.env.get("PHONE_LOGIN_PUBLIC_URL") || "").replace(/\/$/, "");

// The user's public IP. The platform passes an x-forwarded-for chain that can
// start with internal addresses, so skip loopback / private ranges and take
// the first public one, falling back to other headers proxies commonly set.
function isPrivateIp(ip: string) {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc|fd|fe80:)/i.test(ip);
}
function clientIp(req: Request) {
  const candidates: string[] = [];
  for (const h of ["x-forwarded-for", "forwarded", "true-client-ip", "cf-connecting-ip", "x-real-ip", "x-client-ip"]) {
    const v = req.headers.get(h) || "";
    if (!v) continue;
    if (h === "forwarded") {
      for (const m of v.matchAll(/for=\"?\[?([^\];,\"]+)/gi)) candidates.push(m[1]);
    } else {
      for (const part of v.split(",")) candidates.push(part.trim());
    }
  }
  return candidates.find((ip) => ip && !isPrivateIp(ip)) || "";
}

// Where the page should post. An explicit value wins; otherwise this request's own URL.
function publicBase(req: Request) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const u = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || u.host;
  const proto = req.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${host}${u.pathname}`;
}

function upstreamHeaders(req: Request) {
  return {
    "X-Proxy-Secret": SECRET,
    "X-Proxy-Base": publicBase(req),
    "X-Real-Client-IP": clientIp(req),
    "User-Agent": req.headers.get("user-agent") || "",
    "Accept-Language": req.headers.get("accept-language") || "",
  };
}

const jsonHeaders = { "Content-Type": "application/json", "Cache-Control": "no-store" };

Deno.serve(async (req) => {
  if (!WORKER || !SECRET) {
    return new Response(JSON.stringify({ error: "proxy_not_configured" }), { status: 500, headers: jsonHeaders });
  }
  const url = new URL(req.url);
  const op = url.searchParams.get("op") || "";
  try {
    if (req.method === "POST" && (op === "send" || op === "verify")) {
      const body = await req.text();
      const r = await fetch(`${WORKER}/authorize/${op}`, {
        method: "POST",
        headers: { ...upstreamHeaders(req), "Content-Type": "application/json" },
        body,
      });
      const text = await r.text();
      // A refusal from the Worker used to pass through here silently, which
      // made "a user says she is stuck" impossible to diagnose from this side.
      // The full story is in the Worker's log; this records who, when and at
      // which step. The code itself is never part of the body that is logged.
      if (!r.ok) {
        let reason = "";
        try {
          const j = JSON.parse(text);
          reason = String(j.error || j.message || "").slice(0, 120);
        } catch (_) { reason = text.slice(0, 120); }
        console.error(`PHONE_LOGIN_UPSTREAM_FAIL op=${op} status=${r.status} reason=${reason}`);
      }
      return new Response(text, { status: r.status, headers: jsonHeaders });
    }
    if (req.method === "GET") {
      url.searchParams.delete("op");
      const r = await fetch(`${WORKER}/authorize?${url.searchParams.toString()}`, { headers: upstreamHeaders(req) });
      return new Response(await r.text(), {
        status: r.status,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: jsonHeaders });
  } catch (e) {
    console.error("phoneLogin proxy error:", String((e as Error)?.message || e).slice(0, 200));
    return new Response(JSON.stringify({ message: "The login page is temporarily unavailable. Please try again in a moment." }), { status: 502, headers: jsonHeaders });
  }
});
