#!/usr/bin/env bash
# Hermetic enrolled-NATS-transport E2E (#18 — agent-side). Proves, in ONE running
# real gateway, that the PLUGIN obtains tenant-scoped NATS user
# credentials via the REAL device-flow enrollment-server (enroll → auto-approve →
# poll) through the PRODUCTION createEnrolledNatsConnection path, connects
# (NKEY-authenticated) to a JWT-auth nats-server whose operator/account come from
# the SAME setupTrustChain() the issuer uses, and completes an encrypted
# round-trip with a NKEY-authenticated driver peer.
#
# Trust unification: ONE setupTrustChain() in the reference enrollment-server
# feeds (a) the device-flow NATS user creds the agent enrolls for, (b) the
# nats-server operator/account (written to $OCH via NATS_CONFIG_OUT), (c) the
# gateway's auth JWKS for the register hop (/.well-known/jwks.json), and (d) the
# driver's NATS user creds (/test/nats-user).
#
# Everything runs under an isolated OPENCLAW_HOME=/tmp/oc-enrolled-e2e (and
# HOME=$OCH so the plugin's enrollment credential store is isolated too); your
# real ~/.openclaw and ~/.openclaw-webchannel-v2 are never touched. Distinct ports
# avoid colliding with the other harnesses. Self-cleaning (trap on EXIT).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OCH=/tmp/oc-enrolled-e2e
PKG_JSON="$REPO/packages/plugin/package.json"
# Keep the backup OUTSIDE $OCH: $OCH is rm -rf'd at startup, so a backup living
# inside it would be wiped by the NEXT run before we could restore the original —
# permanently stranding the swapped (index-nats.ts) package.json in git.
PKG_BAK=/tmp/oc-enrolled-e2e.pkgbak.json

# Ports (GW_PORT/NATS_WS/NATS_TCP/ECHO_PORT/ISSUER_PORT) come from
# e2e/local/ports.json — the single source of truth for both this harness family
# and the *-realserver.test.ts suites (#118/#119). Never hard-code one here.
. "$REPO/e2e/local/lib/harness.sh"
harness_ports run-enrolled-transport run-enrolled
ENROLLMENT_ADMIN_TOKEN="${ENROLLMENT_ADMIN_TOKEN:-local-e2e-admin-token}"

TENANT=default-tenant
ACCOUNT_ID=default-agent
PEER_ID=enrolled-driver-peer
SAAS_ISSUER="https://saas.local/enrolled-issuer"

NATS_PID=""; ECHO_PID=""; ISSUER_PID=""; GW_PID=""; ADD_PID=""

cleanup() {
  echo "[run-enrolled] cleanup…"
  [ -n "$ADD_PID" ]    && kill "$ADD_PID"    2>/dev/null || true
  [ -n "$GW_PID" ]     && kill "$GW_PID"     2>/dev/null || true
  [ -n "$ISSUER_PID" ] && kill "$ISSUER_PID" 2>/dev/null || true
  [ -n "$ECHO_PID" ]   && kill "$ECHO_PID"   2>/dev/null || true
  [ -n "$NATS_PID" ]   && kill "$NATS_PID"   2>/dev/null || true
  pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
  pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
  # NOTE: no broad `pkill -f enrollment-server.ts` — the issuer PORT is passed as
  # an env var (not an argv flag) so it can't be matched by port, and a broad
  # match would kill an unrelated enrollment-server (parallel harness/dev run).
  # The ISSUER_PID kill above is sufficient (same as gateway/nats rely on).
  pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
  if [ -f "$PKG_BAK" ]; then
    cp "$PKG_BAK" "$PKG_JSON"
    rm -f "$PKG_BAK"
    echo "[run-enrolled] restored $PKG_JSON"
  fi
}
trap cleanup EXIT

# Pre-clean leftover procs / dir.
pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
# No broad enrollment-server pkill — see cleanup() note (would kill unrelated runs).
pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
rm -rf "$OCH"
mkdir -p "$OCH/.openclaw"

# ---------------------------------------------------------------------------
# 0. Build the plugin bundle from the working tree (#125).
#
#    The gateway loads packages/plugin/dist/index-nats.js. Without this step the
#    gate boots whatever bundle happened to be on disk, so a green run says
#    nothing about your edit — see the incident note in e2e/local/lib/harness.sh.
#    Done before any server starts so a broken build fails fast.
# ---------------------------------------------------------------------------
harness_build_plugin run-enrolled "$OCH/plugin-build.log"

# ---------------------------------------------------------------------------
# 1. REAL device-flow enrollment-server (single trust chain). Writes the public
#    NATS config to $OCH and serves JWKS + test routes.
# ---------------------------------------------------------------------------
PORT="$ISSUER_PORT" \
SAAS_BASE_URL="http://127.0.0.1:$ISSUER_PORT" \
SAAS_ISSUER="$SAAS_ISSUER" \
NATS_URL="ws://127.0.0.1:$NATS_WS" \
NATS_CONFIG_OUT="$OCH" \
ENABLE_TEST_ROUTES=1 \
ENROLLMENT_ADMIN_TOKEN="$ENROLLMENT_ADMIN_TOKEN" \
POLL_INTERVAL_SECONDS=1 \
  node --import tsx "$REPO/packages/saas/reference/enrollment-server.ts" >"$OCH/issuer.log" 2>&1 &
ISSUER_PID=$!
echo "[run-enrolled] enrollment-server pid=$ISSUER_PID — waiting for JWKS + NATS config…"
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$ISSUER_PORT/.well-known/jwks.json" >/dev/null 2>&1 \
     && [ -f "$OCH/operator.jwt" ] && [ -f "$OCH/resolver.json" ]; then
    echo "[run-enrolled] issuer ready (JWKS up, NATS config written)"
    break
  fi
  if ! kill -0 "$ISSUER_PID" 2>/dev/null; then
    echo "[run-enrolled] enrollment-server died early — log:"; cat "$OCH/issuer.log"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-enrolled] TIMEOUT waiting for issuer — log:"; cat "$OCH/issuer.log"; exit 2
  fi
done

# ---------------------------------------------------------------------------
# 2. JWT-auth nats-server, built from the SAME trust chain's operator + resolver.
# ---------------------------------------------------------------------------
NATS_CONFIG_DIR="$OCH" NATS_TCP="$NATS_TCP" NATS_WS="$NATS_WS" \
  node --import tsx "$REPO/scripts/generate-nats-server-config.mjs"
nats-server -c "$OCH/nats.conf" >"$OCH/nats.log" 2>&1 &
NATS_PID=$!
echo "[run-enrolled] nats-server pid=$NATS_PID (JWT-auth, ws://127.0.0.1:$NATS_WS) — waiting…"
for i in $(seq 1 120); do
  if grep -q "Server is ready" "$OCH/nats.log" 2>/dev/null; then
    echo "[run-enrolled] nats-server ready"
    break
  fi
  if ! kill -0 "$NATS_PID" 2>/dev/null; then
    echo "[run-enrolled] nats-server died early — log:"; cat "$OCH/nats.log"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-enrolled] TIMEOUT waiting for nats-server — log:"; cat "$OCH/nats.log"; exit 2
  fi
done

# ---------------------------------------------------------------------------
# 3. Echo model server (no real LLM).
# ---------------------------------------------------------------------------
node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_PORT" >"$OCH/echo.log" 2>&1 &
ECHO_PID=$!
echo "[run-enrolled] echo server pid=$ECHO_PID"

# ---------------------------------------------------------------------------
# 4. Point the webchannel plugin entry at index-nats.ts (restore on exit).
# ---------------------------------------------------------------------------
# Crash recovery: if a prior run was hard-killed mid-swap, $PKG_BAK still holds
# the ORIGINAL package.json while the tracked one is left swapped. Restore it
# first, THEN take a fresh backup — so this swap is itself crash-recoverable.
if [ -f "$PKG_BAK" ]; then
  echo "[run-enrolled] stale $PKG_BAK found — restoring original package.json before re-swapping"
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
echo "[run-enrolled] set plugin extensions → ./index-nats.ts"

# ---------------------------------------------------------------------------
# 5. Isolated openclaw config: echo provider + single agent + webchannel(jwt).
#    `saas.baseUrl` points the enrolled plugin path at the issuer; auth.jwt.jwksUrl
#    points at the SAME issuer's JWKS so the register-hop bootstrap JWT verifies.
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
  },
  "channels": {
    "webchannel": {
      "accounts": {
        "$ACCOUNT_ID": {
          "tenant": "$TENANT",
          "auth": {
            "strategy": "jwt",
            "jwt": {
              "jwksUrl": "http://127.0.0.1:$ISSUER_PORT/.well-known/jwks.json",
              "issuer": "$SAAS_ISSUER"
            }
          },
          "dmSecurity": "allowlist",
          "allowFrom": ["$PEER_ID"]
        }
      }
    }
  }
}
JSON
echo "[run-enrolled] wrote $OCH/.openclaw/openclaw.json"

# ---------------------------------------------------------------------------
# 6. CONFIG-TIME credential acquisition via `openclaw channels add` (가-1).
#    After Cycle 1/2 the gateway is CONSUME-ONLY — it no longer enrolls. The
#    device flow runs HERE, at config time, exactly as a production operator runs
#    `openclaw channels add`. HOME=$OCH so creds persist to
#    the tuple-scoped v2 credentials path under $OCH, which the gateway
#    (also HOME=$OCH) consumes. Identity is passed via the generic CLI flags the
#    webchannel setup adapter maps: --base-url→saas.baseUrl, --url→tenant. The
#    wire identity is the --account value itself (no --token→agentId mapping
#    anymore — the handling agent is selected separately via `agents bind`).
# ---------------------------------------------------------------------------
echo "[run-enrolled] channels add (config-time device-flow enroll)…"
HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  "$REPO/node_modules/.bin/openclaw" channels add --channel webchannel --account "$ACCOUNT_ID" \
    --base-url "http://127.0.0.1:$ISSUER_PORT" --url "$TENANT" \
  >"$OCH/channels-add.log" 2>&1 &
ADD_PID=$!
echo "[run-enrolled] channels add pid=$ADD_PID — waiting for enrollment user_code…"

# 6a. Auto-approve: scrape the user_code the device flow prints to the
#     channels-add output (NOT gateway.log anymore), POST it to /approve.
USER_CODE=""
for i in $(seq 1 240); do
  USER_CODE="$(grep -oE 'User code: [A-Z]{4}-[A-Z]{4}' "$OCH/channels-add.log" 2>/dev/null | head -1 | awk '{print $3}' || true)"
  if [ -n "$USER_CODE" ]; then break; fi
  if ! kill -0 "$ADD_PID" 2>/dev/null; then
    echo "[run-enrolled] channels add exited before user_code — log:"; cat "$OCH/channels-add.log"; exit 2
  fi
  sleep 0.25
done
[ -z "$USER_CODE" ] && { echo "[run-enrolled] TIMEOUT waiting for user_code — channels-add log:"; cat "$OCH/channels-add.log"; exit 2; }
echo "[run-enrolled] enrollment user_code=$USER_CODE — approving…"
APPROVE="$(curl -fsS -X POST "http://127.0.0.1:$ISSUER_PORT/approve" \
  -H "Authorization: Bearer $ENROLLMENT_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d "{\"user_code\":\"$USER_CODE\"}" || true)"
echo "[run-enrolled] approve response: $APPROVE"

# 6b. Let `channels add` finish: it polls /poll, receives creds, persists them,
#     and exits 0 (no NATS connect happens here — acquisition only).
set +e; wait "$ADD_PID"; ADD_RC=$?; set -e
ADD_PID=""
if [ "$ADD_RC" -ne 0 ]; then
  echo "[run-enrolled] channels add failed (rc=$ADD_RC) — log:"; cat "$OCH/channels-add.log"; exit 2
fi
CRED_FILE="$(node --import tsx "$REPO/scripts/resolve-storage-path.ts" \
  credentials "$TENANT" "$ACCOUNT_ID" "$OCH")"
[ -f "$CRED_FILE" ] || { echo "[run-enrolled] creds NOT persisted at $CRED_FILE — log:"; cat "$OCH/channels-add.log"; exit 2; }
echo "[run-enrolled] ✓ credentials persisted at $CRED_FILE"

# 6b². Re-assert the register-hop admission shape AFTER `channels add`. The
#      setup adapter writes the demo-proven block (`admission: "register-hop"`,
#      `dmSecurity: "open"`) into the account — but "auto" is an EXPLICIT
#      override that disables the account-bound NATS register hop (the live
#      account subject has no prepared verifier/handler), and this harness
#      exists precisely to drive the register hop. Restore the pre-add intent:
#      register-hop admission + allowlist DM security.
node -e '
  const fs = require("fs");
  const p = process.argv[1], acct = process.argv[2], peer = process.argv[3];
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  const a = cfg.channels.webchannel.accounts[acct];
  a.nats = { ...(a.nats ?? {}), admission: "register-hop" };
  a.dmSecurity = "allowlist";
  a.allowFrom = [peer];
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
' "$OCH/.openclaw/openclaw.json" "$ACCOUNT_ID" "$PEER_ID"
echo "[run-enrolled] ✓ re-asserted admission=register-hop + dmSecurity=allowlist for account $ACCOUNT_ID"

# ---------------------------------------------------------------------------
# 6c. Boot the isolated gateway — CONSUME-ONLY. No acquisition env
#     (WEBCHANNEL_SAAS_BASE_URL/_TENANT/_ACCOUNT_ID): identity now lives in the
#     config that `channels add` wrote. Only the connection override
#     WEBCHANNEL_NATS_URL is passed. No user_code at gateway boot anymore.
# ---------------------------------------------------------------------------
HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
  WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$GW_PORT" --force \
  >"$OCH/gateway.log" 2>&1 &
GW_PID=$!
echo "[run-enrolled] gateway pid=$GW_PID — waiting for structured account readiness (consume persisted creds)…"
for i in $(seq 1 240); do
  LATEST_AGGREGATE="$(grep "event=webchannel\.account_aggregate" "$OCH/gateway.log" 2>/dev/null | tail -n 1 || true)"
  if printf '%s\n' "$LATEST_AGGREGATE" | grep -Eq "event=webchannel\.account_aggregate generation=[^ ]+ state=complete servingCount=1 totalCount=1"; then
    echo "[run-enrolled] gateway ready (consumed creds + connected)"
    break
  fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "[run-enrolled] gateway died early — log:"; cat "$OCH/gateway.log"; exit 2
  fi
  sleep 0.5
  if [ "$i" -eq 240 ]; then
    echo "[run-enrolled] TIMEOUT waiting for structured account readiness — log:"; cat "$OCH/gateway.log"; exit 2
  fi
done

# ASSERT the gateway loaded the bundle step 0 built (#125). Building the right
# file and the gateway LOADING it are two different claims; the build step only
# ever established the first. Reads core own resolution record from the log.
harness_assert_loaded_dist run-enrolled "$OCH/gateway.log"

# ---------------------------------------------------------------------------
# 7. Drive the NKEY-authenticated encrypted round-trip.
# ---------------------------------------------------------------------------
echo "[run-enrolled] driving enrolled-transport encrypted round-trip…"
set +e
WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
WEBCHANNEL_ISSUER_URL="http://127.0.0.1:$ISSUER_PORT" \
WEBCHANNEL_TENANT="$TENANT" WEBCHANNEL_ACCOUNT_ID="$ACCOUNT_ID" WEBCHANNEL_PEER_ID="$PEER_ID" \
  node --import tsx "$REPO/e2e/local/enrolled-transport-roundtrip.ts"
RC=$?
set -e

echo "[run-enrolled] driver exit code = $RC"
exit "$RC"
