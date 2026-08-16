#!/usr/bin/env bash
# TRUST-ANCHOR derivation E2E (docs/TRUST_ANCHOR_DESIGN.md). Proves a fresh
# `openclaw channels add` reaches a working encrypted register round-trip with
# ZERO hand-written JWT trust facts in openclaw.json — the derived issuer /
# issuer/JWKS derivation and account-bound audience path exercised end-to-end.
#
# WHY this harness exists (the gap it closes): EVERY other real-SaaS harness
# (run-all-real.sh, run-enrolled-transport.sh, run-two-account-isolation.sh)
# and demo/run.sh writes an EXPLICIT `auth.jwt` block (issuer/jwksUrl)
# into openclaw.json. Because of config-present-wins, NONE of them actually
# exercise `deriveAccountAuth` (packages/plugin/index-nats.ts). This one does:
# it writes NO channels.webchannel config at all — the ONLY account config is
# what `buildFullAccountPatch` (packages/plugin/src/setup.ts) emits at
# `channels add`, which by design OMITS issuer/jwksUrl and the removed audience key.
#
# It asserts three things the design promises:
#   1. openclaw.json holds NO issuer/jwksUrl or removed audience key (only auth.strategy=jwt,
#      nats.admission=register-hop, nats.credentials.mode=enrolled) — the
#      "zero hand-written trust facts" proof.
#   2. The Gate-B gateway-start readiness line (formatAccountReadiness,
#      packages/plugin/src/preflight.ts) reports the DERIVED facts:
#      issuer=<saasBaseUrl>, JWKS N>=1 keys, aud=<accountId>,
#      admission=register-hop (subscribed *.register).
#   3. A REAL headless-Chromium browser (production WebChannelNatsClient, NKEY
#      + PoP register) round-trips an encrypted echo — proving the DERIVED
#      issuer/aud actually verify the real bootstrap JWT through the live hop.
#
# change-3 invariant: the SaaS signs `iss` = its OWN base URL. We deliberately
# do NOT set a fake SAAS_ISSUER — the enrollment-server defaults SAAS_ISSUER to
# SAAS_BASE_URL, and derivation relies on exactly that invariant.
#
# Fused topology is the sibling run-all-real.sh's: one setupTrustChain feeds the
# device-flow agent creds, the JWT-auth nats-server, the register-hop JWKS, and
# the browser's NATS creds + bootstrap JWT. Everything runs under an isolated
# OPENCLAW_HOME=HOME=/tmp/oc-derived-e2e; your real ~/.openclaw is never touched.
# Distinct ports avoid colliding with the other harnesses AND any live SaaS.
# Self-cleaning (trap on EXIT), idempotent.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OCH=/tmp/oc-derived-e2e
PKG_JSON="$REPO/packages/plugin/package.json"
# Keep the backup OUTSIDE $OCH: $OCH is rm -rf'd at startup, so a backup living
# inside it would be wiped by the NEXT run before we could restore the original —
# permanently stranding the swapped (index-nats.ts) package.json in git.
PKG_BAK=/tmp/oc-derived-e2e.pkgbak.json

# Ports (GW_PORT/NATS_WS/NATS_TCP/ECHO_PORT/ISSUER_PORT/PAGE_PORT) come from
# e2e/local/ports.json — the single source of truth for both this harness family
# and the *-realserver.test.ts suites (#118/#119). Never hard-code one here; the
# hand-maintained "no collision with …" list this replaced had gone stale twice
# (this harness was colliding with run-two-account-isolation.sh on the echo port
# and with run-turn-outcome.sh on the issuer port while claiming otherwise).
. "$REPO/e2e/local/lib/harness.sh"
harness_ports run-derived-trust
ENROLLMENT_ADMIN_TOKEN="${ENROLLMENT_ADMIN_TOKEN:-local-e2e-admin-token}"

TENANT=derived-tenant
ACCOUNT_ID=derived-agent
PEER_ID=web-derived-peer
SAAS_BASE_URL="http://127.0.0.1:$ISSUER_PORT"

NATS_PID=""; ECHO_PID=""; ISSUER_PID=""; GW_PID=""; ADD_PID=""

cleanup() {
  echo "[run-derived-trust] cleanup…"
  [ -n "$ADD_PID" ]    && kill "$ADD_PID"    2>/dev/null || true
  [ -n "$GW_PID" ]     && kill "$GW_PID"     2>/dev/null || true
  [ -n "$ISSUER_PID" ] && kill "$ISSUER_PID" 2>/dev/null || true
  [ -n "$ECHO_PID" ]   && kill "$ECHO_PID"   2>/dev/null || true
  [ -n "$NATS_PID" ]   && kill "$NATS_PID"   2>/dev/null || true
  pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
  pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
  # NOTE: no broad `pkill -f enrollment-server.ts` — the issuer PORT is an env
  # var (not an argv flag), so a broad match could kill an unrelated issuer
  # (parallel harness). The ISSUER_PID kill above is sufficient.
  pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
  if [ -f "$PKG_BAK" ]; then
    cp "$PKG_BAK" "$PKG_JSON"
    rm -f "$PKG_BAK"
    echo "[run-derived-trust] restored $PKG_JSON"
  fi
}
trap cleanup EXIT

# Pre-clean leftover procs / dir.
pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
rm -rf "$OCH"
harness_prepare_private_root "$OCH"

# ---------------------------------------------------------------------------
# 0. Build the plugin bundle from the working tree (#125).
#
#    The gateway loads packages/plugin/dist/index-nats.js. Without this step the
#    gate boots whatever bundle happened to be on disk, so a green run says
#    nothing about your edit — see the incident note in e2e/local/lib/harness.sh.
#    Done before any server starts so a broken build fails fast.
# ---------------------------------------------------------------------------
harness_build_plugin run-derived-trust "$OCH/plugin-build.log"

# ---------------------------------------------------------------------------
# 1. REAL device-flow enrollment-server (single trust chain). Writes the public
#    NATS config to $OCH and serves JWKS + TEST routes (/test/nats-user +
#    /test/bootstrap-jwt for the browser peer). NOTE: SAAS_ISSUER is DELIBERATELY
#    UNSET — the server defaults it to SAAS_BASE_URL (change-3 invariant), which
#    is exactly what `deriveAccountAuth` assumes (issuer = saas.baseUrl).
# ---------------------------------------------------------------------------
PORT="$ISSUER_PORT" \
SAAS_BASE_URL="$SAAS_BASE_URL" \
NATS_URL="ws://127.0.0.1:$NATS_WS" \
NATS_CONFIG_OUT="$OCH" \
ENABLE_TEST_ROUTES=1 \
ENROLLMENT_ADMIN_TOKEN="$ENROLLMENT_ADMIN_TOKEN" \
POLL_INTERVAL_SECONDS=1 \
  node --import tsx "$REPO/packages/saas/reference/enrollment-server.ts" >"$OCH/issuer.log" 2>&1 &
ISSUER_PID=$!
echo "[run-derived-trust] enrollment-server pid=$ISSUER_PID (issuer defaults to base URL $SAAS_BASE_URL) — waiting for JWKS + NATS config…"
for i in $(seq 1 120); do
  if curl -fsS "$SAAS_BASE_URL/.well-known/jwks.json" >/dev/null 2>&1 \
     && [ -f "$OCH/operator.jwt" ] && [ -f "$OCH/resolver.json" ]; then
    echo "[run-derived-trust] issuer ready (JWKS up, NATS config written)"
    break
  fi
  if ! kill -0 "$ISSUER_PID" 2>/dev/null; then
    echo "[run-derived-trust] enrollment-server died early — log:"; cat "$OCH/issuer.log"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-derived-trust] TIMEOUT waiting for issuer — log:"; cat "$OCH/issuer.log"; exit 2
  fi
done

# ---------------------------------------------------------------------------
# 2. JWT-auth nats-server, built from the SAME trust chain's operator + resolver.
# ---------------------------------------------------------------------------
NATS_CONFIG_DIR="$OCH" NATS_TCP="$NATS_TCP" NATS_WS="$NATS_WS" \
  node --import tsx "$REPO/scripts/generate-nats-server-config.mjs"
nats-server -c "$OCH/nats.conf" >"$OCH/nats.log" 2>&1 &
NATS_PID=$!
echo "[run-derived-trust] nats-server pid=$NATS_PID (JWT-auth, ws://127.0.0.1:$NATS_WS) — waiting…"
for i in $(seq 1 120); do
  if grep -q "Server is ready" "$OCH/nats.log" 2>/dev/null; then
    echo "[run-derived-trust] nats-server ready"
    break
  fi
  if ! kill -0 "$NATS_PID" 2>/dev/null; then
    echo "[run-derived-trust] nats-server died early — log:"; cat "$OCH/nats.log"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-derived-trust] TIMEOUT waiting for nats-server — log:"; cat "$OCH/nats.log"; exit 2
  fi
done

# ---------------------------------------------------------------------------
# 3. Echo model server (no real LLM).
# ---------------------------------------------------------------------------
node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_PORT" >"$OCH/echo.log" 2>&1 &
ECHO_PID=$!
echo "[run-derived-trust] echo server pid=$ECHO_PID"

# ---------------------------------------------------------------------------
# 4. Point the webchannel plugin entry at index-nats.ts (restore on exit).
#    Crash recovery: if a prior run was hard-killed mid-swap, $PKG_BAK still holds
#    the ORIGINAL package.json while the tracked one is left swapped. Restore it
#    first, THEN take a fresh backup — so this swap is itself crash-recoverable.
# ---------------------------------------------------------------------------
if [ -f "$PKG_BAK" ]; then
  echo "[run-derived-trust] stale $PKG_BAK found — restoring original package.json before re-swapping"
  cp "$PKG_BAK" "$PKG_JSON"
  rm -f "$PKG_BAK"
fi
cp "$PKG_JSON" "$PKG_BAK"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.openclaw = j.openclaw || {};
  j.openclaw.extensions = ["./index-nats.ts"];
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$PKG_JSON"
echo "[run-derived-trust] set plugin extensions → ./index-nats.ts"

# ---------------------------------------------------------------------------
# 5. Isolated openclaw config: echo provider + single agent + the plugin. CRUCIAL:
#    there is NO `channels.webchannel` section here — no account, and above all NO
#    `auth.jwt` block. The ENTIRE account config is produced by `channels add`
#    (buildFullAccountPatch), which by design writes zero JWT trust facts. This is
#    the whole point of the harness: derivation, not hand-written config.
# ---------------------------------------------------------------------------
cat > "$OCH/.openclaw/openclaw.json" <<JSON
{
  "gateway": { "mode": "local", "bind": "loopback" },
  "models": {
    "providers": {
      "echo-local": {
        "baseUrl": "http://127.0.0.1:$ECHO_PORT/v1",
        "api": "openai-completions",
        "models": [{
          "id": "echo",
          "name": "Echo",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 8192
        }]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "echo-local/echo" },
      "compaction": { "reserveTokensFloor": 20000 }
    }
  },
  "plugins": {
    "load": { "paths": ["$REPO/packages/plugin"] },
    "allow": ["webchannel"],
    "entries": { "webchannel": { "enabled": true } }
  }
}
JSON
echo "[run-derived-trust] wrote $OCH/.openclaw/openclaw.json (NO channels.webchannel — channels add builds it)"

# ---------------------------------------------------------------------------
# 6. CONFIG-TIME credential acquisition via `openclaw channels add`. The device
#    flow runs HERE (exactly as a production operator runs it). Identity via the
#    generic flags the webchannel setup adapter maps: --base-url→saas.baseUrl,
#    --url→tenant. NO --issuer / --audience — nothing to pin. buildFullAccountPatch
#    writes the whole account block (tenant, saas.baseUrl, auth.strategy=jwt,
#    nats.admission=register-hop, nats.credentials.mode=enrolled) and NOTHING ELSE.
# ---------------------------------------------------------------------------
echo "[run-derived-trust] channels add (config-time device-flow enroll, zero trust facts)…"
HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  "$REPO/node_modules/.bin/openclaw" channels add --channel webchannel --account "$ACCOUNT_ID" \
    --base-url "$SAAS_BASE_URL" --url "$TENANT" \
  >"$OCH/channels-add.log" 2>&1 &
ADD_PID=$!
echo "[run-derived-trust] channels add pid=$ADD_PID — waiting for enrollment user_code…"

# 6a. Auto-approve: scrape the user_code from the channels-add output, POST to /approve.
USER_CODE=""
for i in $(seq 1 240); do
  USER_CODE="$(grep -oE 'User code: [A-Z]{4}-[A-Z]{4}' "$OCH/channels-add.log" 2>/dev/null | head -1 | awk '{print $3}' || true)"
  if [ -n "$USER_CODE" ]; then break; fi
  if ! kill -0 "$ADD_PID" 2>/dev/null; then
    echo "[run-derived-trust] channels add exited before user_code — log:"; cat "$OCH/channels-add.log"; exit 2
  fi
  sleep 0.25
done
[ -z "$USER_CODE" ] && { echo "[run-derived-trust] TIMEOUT waiting for user_code — channels-add log:"; cat "$OCH/channels-add.log"; exit 2; }
echo "[run-derived-trust] enrollment user_code=$USER_CODE — approving…"
APPROVE="$(curl -fsS -X POST "$SAAS_BASE_URL/approve" \
  -H "Authorization: Bearer $ENROLLMENT_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d "{\"user_code\":\"$USER_CODE\"}" || true)"
echo "[run-derived-trust] approve response: $APPROVE"

# 6b. Let `channels add` finish (polls, receives creds, persists them, exit 0).
set +e; wait "$ADD_PID"; ADD_RC=$?; set -e
ADD_PID=""
if [ "$ADD_RC" -ne 0 ]; then
  echo "[run-derived-trust] channels add failed (rc=$ADD_RC) — log:"; cat "$OCH/channels-add.log"; exit 2
fi
CRED_FILE="$(node --import tsx "$REPO/scripts/resolve-storage-path.ts" \
  credentials "$TENANT" "$ACCOUNT_ID" "$OCH")"
[ -f "$CRED_FILE" ] || { echo "[run-derived-trust] creds NOT persisted at $CRED_FILE — log:"; cat "$OCH/channels-add.log"; exit 2; }
echo "[run-derived-trust] ✓ credentials persisted at $CRED_FILE"

# ---------------------------------------------------------------------------
# 6c. ASSERT the "zero hand-written trust facts" invariant on the WRITTEN config.
#     FAIL loudly if any of issuer/jwksUrl/audience was written; require
#     auth.strategy=jwt, nats.admission=register-hop, nats.credentials.mode=enrolled.
#     We deliberately do NOT re-assert admission afterwards — buildFullAccountPatch
#     already writes register-hop, and any post-hoc rewrite would weaken the proof.
# ---------------------------------------------------------------------------
echo "[run-derived-trust] asserting openclaw.json holds ZERO JWT trust facts…"
OCH="$OCH" ACCOUNT_ID="$ACCOUNT_ID" SAAS_BASE_URL="$SAAS_BASE_URL" node -e '
  const fs = require("fs");
  const cfg = JSON.parse(fs.readFileSync(process.env.OCH + "/.openclaw/openclaw.json", "utf8"));
  const acct = process.env.ACCOUNT_ID;
  const a = cfg?.channels?.webchannel?.accounts?.[acct];
  const fail = (m) => { console.error("[run-derived-trust] CONFIG-ASSERT FAIL: " + m); process.exit(3); };
  if (!a) fail(`account "${acct}" missing from channels.webchannel.accounts`);
  const jwt = a?.auth?.jwt;
  const wrote = jwt ? Object.keys(jwt).filter((k) => ["issuer","jwksUrl","audience"].includes(k)) : [];
  if (wrote.length > 0) fail(`auth.jwt contains hand-written trust facts: ${wrote.join(", ")} = ${JSON.stringify(jwt)}`);
  if (a?.auth?.strategy !== "jwt") fail(`auth.strategy=${JSON.stringify(a?.auth?.strategy)} (expected "jwt")`);
  if (a?.nats?.admission !== "register-hop") fail(`nats.admission=${JSON.stringify(a?.nats?.admission)} (expected "register-hop")`);
  if (a?.nats?.credentials?.mode !== "enrolled") fail(`nats.credentials.mode=${JSON.stringify(a?.nats?.credentials?.mode)} (expected "enrolled")`);
  if (a?.saas?.baseUrl !== process.env.SAAS_BASE_URL) fail(`saas.baseUrl=${JSON.stringify(a?.saas?.baseUrl)} (expected ${JSON.stringify(process.env.SAAS_BASE_URL)})`);
  console.log("[run-derived-trust] ✓ CONFIG-ASSERT PASS: no issuer/jwksUrl/audience written; strategy=jwt, admission=register-hop, credentials.mode=enrolled, saas.baseUrl anchored");
  console.log("[run-derived-trust]   effective account.auth block on disk: " + JSON.stringify(a.auth));
'

# ---------------------------------------------------------------------------
# 6d. Boot the isolated gateway — CONSUME-ONLY. Identity lives in the config
#     `channels add` wrote; only the NATS connection override is passed. Capture
#     stdout so we can assert the Gate-B readiness line reports DERIVED facts.
# ---------------------------------------------------------------------------
HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
  WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$GW_PORT" --force \
  >"$OCH/gateway.log" 2>&1 &
GW_PID=$!
echo "[run-derived-trust] gateway pid=$GW_PID — waiting for structured account readiness (consume persisted creds)…"
for i in $(seq 1 240); do
  LATEST_AGGREGATE="$(grep "event=webchannel\.account_aggregate" "$OCH/gateway.log" 2>/dev/null | tail -n 1 || true)"
  if printf '%s\n' "$LATEST_AGGREGATE" | grep -Eq "event=webchannel\.account_aggregate generation=[^ ]+ state=complete servingCount=1 totalCount=1"; then
    echo "[run-derived-trust] gateway ready (consumed creds + connected)"
    break
  fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "[run-derived-trust] gateway died early — log:"; cat "$OCH/gateway.log"; exit 2
  fi
  sleep 0.5
  if [ "$i" -eq 240 ]; then
    echo "[run-derived-trust] TIMEOUT waiting for structured account readiness — log:"; cat "$OCH/gateway.log"; exit 2
  fi
done

# ASSERT the gateway loaded the bundle step 0 built (#125). Building the right
# file and the gateway LOADING it are two different claims; the build step only
# ever established the first. Reads core own resolution record from the log.
harness_assert_loaded_dist run-derived-trust "$OCH/gateway.log"

# ---------------------------------------------------------------------------
# 6e. ASSERT the Gate-B readiness line (formatAccountReadiness) reports the
#     DERIVED trust facts: issuer=<saasBaseUrl>, JWKS N>=1 keys, aud=<accountId>,
#     admission=register-hop (subscribed *.register). FAIL if issuer shows
#     "(unresolved)" or JWKS shows 0 keys / FETCH FAILED.
# ---------------------------------------------------------------------------
echo "[run-derived-trust] asserting Gate-B readiness line reports DERIVED facts…"
# Give the async readiness gate a moment to emit (JWKS resolve is awaited).
READINESS=""
for i in $(seq 1 60); do
  READINESS="$(grep -E "\[webchannel\] account \"$ACCOUNT_ID\" (READY|WARN|FAIL) " "$OCH/gateway.log" 2>/dev/null | head -1 || true)"
  [ -n "$READINESS" ] && break
  sleep 0.5
done
if [ -z "$READINESS" ]; then
  echo "[run-derived-trust] READINESS-ASSERT FAIL: no Gate-B readiness line for account $ACCOUNT_ID — gateway log tail:"
  tail -60 "$OCH/gateway.log" 2>/dev/null || true
  exit 4
fi
echo "[run-derived-trust] captured readiness line:"
echo "  >>> $READINESS"
ACCOUNT_ID="$ACCOUNT_ID" SAAS_BASE_URL="$SAAS_BASE_URL" READINESS="$READINESS" node -e '
  const line = process.env.READINESS;
  const acct = process.env.ACCOUNT_ID;
  const base = process.env.SAAS_BASE_URL;
  const fail = (m) => { console.error("[run-derived-trust] READINESS-ASSERT FAIL: " + m + "\n  line: " + line); process.exit(4); };
  // A healthy register-hop account must be READY. There is no longer a legitimate
  // WARN branch: webchannel FORCES its own per-account-channel-peer session scope
  // (src/session-route.ts), so the old dmScope="main" cross-user-leak WARN is gone
  // and the line reports the ENFORCED scope truthfully. Any FAIL or WARN is now a
  // real problem.
  if (/account "[^"]+" FAIL /.test(line)) fail("verdict is FAIL");
  if (/account "[^"]+" WARN /.test(line)) fail("verdict is WARN — no legitimate WARN branch remains (webchannel enforces its own dmScope)");
  if (!/account "[^"]+" READY /.test(line)) fail("verdict is not READY");
  // The readiness line must advertise the ENFORCED per-user isolation scope.
  if (!line.includes("dmScope=per-account-channel-peer (webchannel-enforced)")) {
    fail("readiness line does not report the enforced per-account-channel-peer dmScope");
  }
  if (line.includes("(unresolved)")) fail("issuer/aud shows (unresolved) — derivation did not resolve");
  if (line.includes("FETCH FAILED")) fail("JWKS FETCH FAILED");
  if (/JWKS 0 keys/.test(line)) fail("JWKS resolved 0 keys");
  if (!line.includes(`issuer=${base}`)) fail(`derived issuer != saasBaseUrl (expected issuer=${base})`);
  if (!line.includes(`aud=${acct}`)) fail(`derived aud != accountId (expected aud=${acct})`);
  const m = line.match(/JWKS (\d+) keys/);
  if (!m) fail("no `JWKS N keys` field in readiness line");
  if (parseInt(m[1], 10) < 1) fail("JWKS key count < 1");
  if (!line.includes("admission=register-hop (subscribed *.register)")) fail("admission not register-hop / not subscribed *.register");
  console.log(`[run-derived-trust] ✓ READINESS-ASSERT PASS: READY, derived issuer=${base}, JWKS ${m[1]} keys, aud=${acct}, admission=register-hop (subscribed *.register), dmScope=per-account-channel-peer (webchannel-enforced)`);
'

# ---------------------------------------------------------------------------
# 7. Run the REAL-BROWSER Playwright driver (NKEY-auth + PoP register). This is
#    the SAME driver run-all-real.sh uses — reused, not reinvented. Its encrypted
#    echo round-trip proves the DERIVED issuer/aud actually verify the real
#    bootstrap JWT through the live register hop.
# ---------------------------------------------------------------------------
echo "[run-derived-trust] driving the real-browser encrypted round-trip (derived trust)…"
set +e
WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
WEBCHANNEL_ISSUER_URL="$SAAS_BASE_URL" \
WEBCHANNEL_TENANT="$TENANT" WEBCHANNEL_ACCOUNT_ID="$ACCOUNT_ID" WEBCHANNEL_PEER_ID="$PEER_ID" \
WEBCHANNEL_PAGE_PORT="$PAGE_PORT" \
  node "$REPO/e2e/local/all-real.mjs"
RC=$?
set -e

echo "[run-derived-trust] driver exit code = $RC"
if [ "$RC" -ne 0 ]; then
  echo "[run-derived-trust] gateway log tail (debug):"; tail -40 "$OCH/gateway.log" 2>/dev/null || true
  echo "[run-derived-trust] nats log tail (debug):";    tail -20 "$OCH/nats.log" 2>/dev/null || true
  echo "[run-derived-trust] FAIL"
  exit "$RC"
fi

echo "[run-derived-trust] ================================================================"
echo "[run-derived-trust] PASS — fresh channels add → derived issuer/jwks/aud → encrypted"
echo "[run-derived-trust]        register round-trip, with ZERO hand-written trust facts."
echo "[run-derived-trust] readiness line asserted:"
echo "[run-derived-trust]   $READINESS"
echo "[run-derived-trust] ================================================================"
exit 0
