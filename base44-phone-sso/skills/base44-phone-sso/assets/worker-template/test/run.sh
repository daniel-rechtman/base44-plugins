#!/bin/bash
# Runs the test suite against a local Worker + fake services. No accounts, no
# real messages. Needs only: npm install && npm run keygen
#
# Usage: bash test/run.sh [suite ...]      (default: all four)
#   green           Green API delivers
#   meta            Meta Cloud API delivers
#   green-failover  first Green instance is dead, the second delivers
#   meta-fallback   Meta is down, Green delivers
set -u
cd "$(dirname "$0")/.." || exit 1

[ -f KEYS.local.json ] || { echo "KEYS.local.json is missing. Run: npm run keygen"; exit 1; }

export PHONE_SSO_TEST_DIR="${PHONE_SSO_TEST_DIR:-/tmp/phone-sso-test}"
HAD_DEV_VARS=0
[ -f .dev.vars ] && { cp .dev.vars .dev.vars.testbak; HAD_DEV_VARS=1; }

write_dev_vars() {
  local suite="$1"
  node -e '
    const k = JSON.parse(require("fs").readFileSync("KEYS.local.json", "utf8"));
    const suite = process.argv[1];
    const v = {
      OIDC_CLIENT_ID: k.OIDC_CLIENT_ID,
      OIDC_CLIENT_SECRET: k.OIDC_CLIENT_SECRET,
      OIDC_KID: k.OIDC_KID,
      OIDC_PUBLIC_JWK: JSON.stringify(k.OIDC_PUBLIC_JWK),
      OIDC_PRIVATE_KEY: k.OIDC_PRIVATE_KEY,
      BASE44_API_KEY: "test-key",
      BASE44_APP_ID: "test-app",
      ALLOWED_REDIRECT_URIS: "https://app.base44.com/api/apps/test-app/auth/sso/callback",
      SYNTHETIC_EMAIL_DOMAIN: "phone.test-app.example",
      DEFAULT_COUNTRY_CODE: "972",
      LOCALE: "en",
      PROVISION_USERS: "1",
      OTP_RESEND_COOLDOWN: "1",
      SEND_LIMIT_PER_PHONE: "200",
      SEND_LIMIT_PER_IP: "500",
      PROXY_SHARED_SECRET: "test-proxy-secret",
      PUBLIC_AUTHORIZE_URL: "",
      META_RELAY_URL: "",
      META_API_BASE: "http://127.0.0.1:8798",
      BASE44_API_BASE: "http://127.0.0.1:8798/api/apps",
      GREEN_API_BASE: "http://127.0.0.1:8798",
      META_TOKEN: "test-token",
      META_PHONE_NUMBER_ID: "1000",
      GREEN_API_ID: "1101",
      GREEN_API_TOKEN: "faketoken",
      OTP_PROVIDER: "green",
      OTP_FALLBACK_GREEN: "1",
      OTP_FALLBACK_META: "0",
    };
    if (suite === "meta") { v.OTP_PROVIDER = "meta"; }
    if (suite === "green-failover") { v.GREEN_API_ID = "9999"; v.GREEN_API_ID_2 = "2202"; v.GREEN_API_TOKEN_2 = "faketoken2"; }
    if (suite === "meta-fallback") { v.OTP_PROVIDER = "meta"; v.META_PHONE_NUMBER_ID = "down"; }
    // dotenv rules: double quotes expand \\n (needed for the PEM); single quotes
    // keep the value verbatim (needed for JSON, which is full of double quotes).
    const line = (key, val) => {
      const s = String(val);
      return s.includes("\n") ? key + "=\"" + s.replace(/\n/g, "\\n") + "\"" : key + "=\x27" + s + "\x27";
    };
    require("fs").writeFileSync(".dev.vars", Object.entries(v).map(([a, b]) => line(a, b)).join("\n") + "\n");
  ' "$suite"
}

expect_via() {
  case "$1" in
    green) echo "green:1101" ;;
    meta) echo "meta" ;;
    green-failover) echo "green:2202" ;;
    meta-fallback) echo "green:1101" ;;
  esac
}

run_suite() {
  local suite="$1"
  echo ""
  echo "======== suite: $suite ========"
  rm -rf .wrangler/state "$PHONE_SSO_TEST_DIR"
  mkdir -p "$PHONE_SSO_TEST_DIR"
  write_dev_vars "$suite"
  node test/fakes.mjs > "$PHONE_SSO_TEST_DIR/fakes.log" 2>&1 &
  local FP=$!
  npx wrangler dev --local --port 8799 > "$PHONE_SSO_TEST_DIR/wrangler.log" 2>&1 &
  local WP=$!
  local up=0
  for _ in $(seq 1 60); do
    curl -s -o /dev/null "http://127.0.0.1:8799/health" && { up=1; break; }
    sleep 1
  done
  local R=1
  if [ $up -eq 1 ]; then
    EXPECT_VIA="$(expect_via "$suite")" node test/e2e.mjs
    R=$?
  else
    echo "  the local Worker did not start. See $PHONE_SSO_TEST_DIR/wrangler.log"
    tail -5 "$PHONE_SSO_TEST_DIR/wrangler.log"
  fi
  kill $WP $FP 2>/dev/null
  wait $WP $FP 2>/dev/null
  pkill -f "wrangler dev --local --port 8799" 2>/dev/null
  pkill -f "test/fakes.mjs" 2>/dev/null
  sleep 1
  return $R
}

FAIL=0
node test/normalize.mjs || FAIL=1
for s in ${@:-green meta green-failover meta-fallback}; do run_suite "$s" || FAIL=1; done

rm -f .dev.vars
[ $HAD_DEV_VARS -eq 1 ] && mv .dev.vars.testbak .dev.vars
echo ""
[ $FAIL -eq 0 ] && echo "ALL SUITES PASSED" || echo "THERE ARE FAILURES"
exit $FAIL
