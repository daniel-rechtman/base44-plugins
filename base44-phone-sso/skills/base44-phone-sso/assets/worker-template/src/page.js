// page.js - the login page. One HTML document, no build step, no secrets.
//
// The page only knows a one-time request id (sid). Everything about the OIDC
// request (client_id, redirect_uri, state, nonce, PKCE challenge) stays on the
// server in KV, so a browser cannot tamper with it.

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// sendUrl / verifyUrl: where the page POSTs. Relative by default (the Worker's
// own origin). When the page is served through the app-domain proxy, the proxy
// asks for absolute URLs that point back at itself.
export function loginPage({ sid, appName, accent = "#2b2724", senderNote = "", sendUrl = "/authorize/send", verifyUrl = "/authorize/verify", t, lang = "he" }) {
  const name = escapeHtml(appName || t.defaultAppName);
  const note = escapeHtml(senderNote || "");
  // Strings the inline script needs. JSON-encoded, never interpolated raw.
  const S = JSON.stringify({
    busy: t.busy, sendBtn: t.sendBtn, verifyBtn: t.verifyBtn, pageSub: t.pageSub,
    codeSentSub: t.codeSentSub, codeValid: t.codeValid, needPhone: t.needPhone,
    needCode: t.needCode, sendFailed: t.sendFailedGeneric, wrongCode: t.wrongCodeGeneric,
    networkError: t.networkError,
  }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="${escapeHtml(lang)}" dir="${t.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${name}</title>
<style>
  :root { --accent: ${escapeHtml(accent)}; --ink: #2b2724; --muted: #6f675f; --line: #e8e2db; --bg: #faf8f5; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center; padding:24px;
         background:var(--bg); color:var(--ink);
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif; }
  .card { width:100%; max-width:400px; background:#fff; border:1px solid var(--line);
          border-radius:20px; padding:40px 32px; }
  h1 { margin:0 0 6px; font-size:22px; font-weight:600; letter-spacing:-0.01em; }
  p.sub { margin:0 0 28px; color:var(--muted); font-size:14px; line-height:1.6; }
  label { display:block; font-size:13px; color:var(--muted); margin-bottom:8px; }
  input { width:100%; padding:14px 16px; font-size:17px; font-family:inherit;
          border:1px solid var(--line); border-radius:12px; background:#fff; color:var(--ink);
          transition:border-color .2s; }
  input:focus { outline:none; border-color:var(--accent); }
  #code { letter-spacing:.5em; text-align:center; font-weight:600; }
  button { width:100%; margin-top:18px; padding:15px; font-size:16px; font-weight:600;
           font-family:inherit; color:#fff; background:var(--ink); border:none;
           border-radius:12px; cursor:pointer; transition:opacity .2s; min-height:48px; }
  button:hover:not(:disabled) { opacity:.88; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .msg { margin-top:16px; font-size:14px; line-height:1.5; min-height:20px; }
  .msg.err { color:#b3261e; }
  .msg.ok { color:#1e7a4d; }
  .link { margin-top:18px; text-align:center; }
  .link button { background:none; color:var(--muted); font-size:13px; font-weight:400;
                 padding:6px; margin:0; width:auto; min-height:44px; text-decoration:underline; }
  .hide { display:none; }
  /* Between verifying the code and the redirect back there are a few seconds
     while the app finishes signing the user in. Without this the screen looks stuck. */
  .connecting { text-align:center; padding:12px 0 4px; }
  .spinner { width:32px; height:32px; margin:0 auto 14px; border-radius:50%;
             border:3px solid var(--line); border-top-color:var(--accent);
             animation:spin .8s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .connecting p { margin:0; font-size:15px; color:var(--ink); font-weight:600; }
  .connecting span { display:block; margin-top:6px; font-size:13px; color:var(--muted); }
  .sender-note { margin:20px 0 0; padding-top:16px; border-top:1px solid var(--line);
                 font-size:12px; line-height:1.6; color:var(--muted); text-align:center; }
</style>
</head>
<body>
<div class="card">
  <h1>${name}</h1>
  <p class="sub" id="sub">${escapeHtml(t.pageSub)}</p>

  <div id="step-phone">
    <label for="phone">${escapeHtml(t.phoneLabel)}</label>
    <input id="phone" type="tel" inputmode="tel" autocomplete="tel"
           placeholder="${escapeHtml(t.phonePlaceholder)}" dir="ltr">
    <button id="send">${escapeHtml(t.sendBtn)}</button>
  </div>

  <div id="step-code" class="hide">
    <label for="code">${escapeHtml(t.codeLabel)}</label>
    <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code"
           maxlength="6" placeholder="······" dir="ltr">
    <button id="verify">${escapeHtml(t.verifyBtn)}</button>
    <div class="link"><button id="back" type="button">${escapeHtml(t.changeNumber)}</button></div>
  </div>

  <div id="step-connecting" class="connecting hide">
    <div class="spinner"></div>
    <p>${escapeHtml(t.connecting)}</p>
    <span>${escapeHtml(t.connectingSub)}</span>
  </div>

  <div class="msg" id="msg"></div>
  ${note ? `<p class="sender-note">${note}</p>` : ""}
</div>

<script>
(function () {
  var SID = ${JSON.stringify(sid)};
  var SEND_URL = ${JSON.stringify(sendUrl)};
  var VERIFY_URL = ${JSON.stringify(verifyUrl)};
  var S = ${S};
  var $ = function (id) { return document.getElementById(id); };
  var msg = $("msg");

  function say(text, kind) {
    msg.textContent = text || "";
    msg.className = "msg" + (kind ? " " + kind : "");
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ sid: SID }, body))
    }).then(function (r) {
      return r.json().then(function (d) { return { status: r.status, data: d }; });
    });
  }

  function busy(btn, on, label) {
    btn.disabled = on;
    btn.textContent = on ? S.busy : label;
  }

  $("send").addEventListener("click", function () {
    var phone = $("phone").value.trim();
    if (!phone) return say(S.needPhone, "err");
    busy($("send"), true, S.sendBtn);
    say("");
    post(SEND_URL, { phone: phone }).then(function (r) {
      busy($("send"), false, S.sendBtn);
      if (r.status !== 200) return say(r.data.message || S.sendFailed, "err");
      $("step-phone").classList.add("hide");
      $("step-code").classList.remove("hide");
      $("sub").textContent = S.codeSentSub;
      say(S.codeValid, "ok");
      $("code").focus();
    }).catch(function () {
      busy($("send"), false, S.sendBtn);
      say(S.networkError, "err");
    });
  });

  $("verify").addEventListener("click", function () {
    var code = $("code").value.trim();
    if (!code) return say(S.needCode, "err");
    busy($("verify"), true, S.verifyBtn);
    say("");
    post(VERIFY_URL, { code: code }).then(function (r) {
      if (r.status === 200 && r.data.redirect) {
        // Swap the form for a progress state: the redirect takes a few seconds
        $("step-code").classList.add("hide");
        $("sub").classList.add("hide");
        $("step-connecting").classList.remove("hide");
        say("");
        window.location.href = r.data.redirect;
        return;
      }
      busy($("verify"), false, S.verifyBtn);
      say(r.data.message || S.wrongCode, "err");
    }).catch(function () {
      busy($("verify"), false, S.verifyBtn);
      say(S.networkError, "err");
    });
  });

  $("back").addEventListener("click", function () {
    $("step-code").classList.add("hide");
    $("step-phone").classList.remove("hide");
    $("sub").textContent = S.pageSub;
    $("code").value = "";
    say("");
  });

  ["phone", "code"].forEach(function (id) {
    $(id).addEventListener("keydown", function (e) {
      if (e.key === "Enter") $(id === "phone" ? "send" : "verify").click();
    });
  });
})();
</script>
</body>
</html>`;
}

export function errorPage(title, detail, t) {
  const dir = (t && t.dir) || "ltr";
  return `<!doctype html><html dir="${dir}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#faf8f5;
color:#2b2724;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center}
h1{font-size:20px;font-weight:600;margin:0 0 8px}p{color:#6f675f;font-size:14px;margin:0;max-width:340px;line-height:1.6}
</style></head><body><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></div></body></html>`;
}
