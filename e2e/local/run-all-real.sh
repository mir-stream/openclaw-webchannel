#!/usr/bin/env bash
# #21 — ALL-REAL fusion E2E. ONE live harness where a REAL headless-Chromium
# browser running the PRODUCTION WebChannelNatsClient:
#   (a) NATS-layer NKEY-authenticates to a REAL JWT-auth nats-server, AND
#   (b) drives the JWT + Proof-of-Possession HTTP register hop,
# against a REAL enrolled plugin (gateway, devOpen OFF) whose NATS creds were
# acquired AT CONFIG TIME via `openclaw channels add` (가-1: the device-flow
# EnrollmentClient runs in the setup hook, not at gateway boot) and which the
# CONSUME-ONLY gateway then loads to connect to the SAME nats-server — all from
# ONE shared trust chain — completing an encrypted round-trip. The only stand-in
# left is the echo LLM.
#
# This FUSES the #18 server topology (run-enrolled-transport.sh: unified issuer +
# JWT-auth nats-server from ONE setupTrustChain + enrolled plugin, devOpen OFF)
# with the #19 browser driver (browser-jwt-register.mjs → here: all-real.mjs).
#
# Trust unification: ONE setupTrustChain() in the reference enrollment-server
# feeds (a) the device-flow NATS user creds the agent enrolls for, (b) the
# nats-server operator/account (written to $OCH via NATS_CONFIG_OUT), (c) the
# gateway's auth JWKS for the register hop, (d) the BROWSER's NATS user creds
# (/test/nats-user) and bootstrap JWT (/test/bootstrap-jwt).
#
# Everything runs under an isolated OPENCLAW_HOME=HOME=/tmp/oc-allreal-e2e; your
# real ~/.openclaw is never touched. Distinct ports avoid colliding with the
# other harnesses. Self-cleaning (trap on EXIT).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OCH=/tmp/oc-allreal-e2e
PKG_JSON="$REPO/packages/plugin/package.json"
# Keep the backup OUTSIDE $OCH: $OCH is rm -rf'd at startup, so a backup living
# inside it would be wiped by the NEXT run before we could restore the original —
# permanently stranding the swapped (index-nats.ts) package.json in git.
PKG_BAK=/tmp/oc-allreal-e2e.pkgbak.json

# Distinct ports — no collision with the other harnesses
# (18799/18899/18999/19099/18222/18422/18522/3911/3921/3931/etc.).
GW_PORT=19199
NATS_WS=18622
NATS_TCP=14622
ECHO_PORT=18904
ISSUER_PORT=3941
PAGE_PORT=19393

TENANT=default-tenant
ACCOUNT_ID=default-agent
PEER_ID=web-allreal-peer
SAAS_ISSUER="https://saas.local/allreal-issuer"

NATS_PID=""; ECHO_PID=""; ISSUER_PID=""; GW_PID=""; ADD_PID=""

cleanup() {
  echo "[run-all-real] cleanup…"
  [ -n "$ADD_PID" ]    && kill "$ADD_PID"    2>/dev/null || true
  [ -n "$GW_PID" ]     && kill "$GW_PID"     2>/dev/null || true
  [ -n "$ISSUER_PID" ] && kill "$ISSUER_PID" 2>/dev/null || true
  [ -n "$ECHO_PID" ]   && kill "$ECHO_PID"   2>/dev/null || true
  [ -n "$NATS_PID" ]   && kill "$NATS_PID"   2>/dev/null || true
  pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
  pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
  # NOTE: no broad `pkill -f enrollment-server.ts` — the issuer PORT is an env var
  # (not an argv flag), so a broad match could kill an unrelated issuer (parallel
  # harness). The ISSUER_PID kill above is sufficient.
  pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
  if [ -f "$PKG_BAK" ]; then
    cp "$PKG_BAK" "$PKG_JSON"
    rm -f "$PKG_BAK"
    echo "[run-all-real] restored $PKG_JSON"
  fi
}
trap cleanup EXIT

# Pre-clean leftover procs / dir.
pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
rm -rf "$OCH"
mkdir -p "$OCH/.openclaw"

# ---------------------------------------------------------------------------
# 1. REAL device-flow enrollment-server (single trust chain). Writes the public
#    NATS config to $OCH and serves JWKS + TEST routes (/test/nats-user +
#    /test/bootstrap-jwt for the browser peer).
# ---------------------------------------------------------------------------
PORT="$ISSUER_PORT" \
SAAS_BASE_URL="http://127.0.0.1:$ISSUER_PORT" \
SAAS_ISSUER="$SAAS_ISSUER" \
NATS_URL="ws://127.0.0.1:$NATS_WS" \
NATS_CONFIG_OUT="$OCH" \
ENABLE_TEST_ROUTES=1 \
POLL_INTERVAL_SECONDS=1 \
  node --import tsx "$REPO/packages/saas/reference/enrollment-server.ts" >"$OCH/issuer.log" 2>&1 &
ISSUER_PID=$!
echo "[run-all-real] enrollment-server pid=$ISSUER_PID — waiting for JWKS + NATS config…"
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$ISSUER_PORT/.well-known/jwks.json" >/dev/null 2>&1 \
     && [ -f "$OCH/operator.jwt" ] && [ -f "$OCH/resolver.json" ]; then
    echo "[run-all-real] issuer ready (JWKS up, NATS config written)"
    break
  fi
  if ! kill -0 "$ISSUER_PID" 2>/dev/null; then
    echo "[run-all-real] enrollment-server died early — log:"; cat "$OCH/issuer.log"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-all-real] TIMEOUT waiting for issuer — log:"; cat "$OCH/issuer.log"; exit 2
  fi
done

# ---------------------------------------------------------------------------
# 2. JWT-auth nats-server, built from the SAME trust chain's operator + resolver.
# ---------------------------------------------------------------------------
OCH="$OCH" NATS_TCP="$NATS_TCP" NATS_WS="$NATS_WS" node -e '
  const fs = require("fs");
  const dir = process.env.OCH;
  const operatorJwtPath = dir + "/operator.jwt";
  const resolver = JSON.parse(fs.readFileSync(dir + "/resolver.json", "utf8"));
  const preload = Object.entries(resolver).map(([k, v]) => `  ${k}: "${v}"`).join("\n");
  const conf = [
    `port: ${process.env.NATS_TCP}`,
    `websocket {`,
    `  port: ${process.env.NATS_WS}`,
    `  no_tls: true`,
    `}`,
    `operator: "${operatorJwtPath}"`,
    `resolver: MEMORY`,
    `resolver_preload: {`,
    preload,
    `}`,
    "",
  ].join("\n");
  fs.writeFileSync(dir + "/nats.conf", conf);
'
nats-server -c "$OCH/nats.conf" >"$OCH/nats.log" 2>&1 &
NATS_PID=$!
echo "[run-all-real] nats-server pid=$NATS_PID (JWT-auth, ws://127.0.0.1:$NATS_WS) — waiting…"
for i in $(seq 1 120); do
  if grep -q "Server is ready" "$OCH/nats.log" 2>/dev/null; then
    echo "[run-all-real] nats-server ready"
    break
  fi
  if ! kill -0 "$NATS_PID" 2>/dev/null; then
    echo "[run-all-real] nats-server died early — log:"; cat "$OCH/nats.log"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-all-real] TIMEOUT waiting for nats-server — log:"; cat "$OCH/nats.log"; exit 2
  fi
done

# ---------------------------------------------------------------------------
# 3. Echo model server (no real LLM).
# ---------------------------------------------------------------------------
node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_PORT" >"$OCH/echo.log" 2>&1 &
ECHO_PID=$!
echo "[run-all-real] echo server pid=$ECHO_PID"

# ---------------------------------------------------------------------------
# 4. Point the webchannel plugin entry at index-nats.ts (restore on exit).
#    Crash recovery: if a prior run was hard-killed mid-swap, $PKG_BAK still holds
#    the ORIGINAL package.json while the tracked one is left swapped. Restore it
#    first, THEN take a fresh backup — so this swap is itself crash-recoverable.
# ---------------------------------------------------------------------------
if [ -f "$PKG_BAK" ]; then
  echo "[run-all-real] stale $PKG_BAK found — restoring original package.json before re-swapping"
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
echo "[run-all-real] set plugin extensions → ./index-nats.ts"

# ---------------------------------------------------------------------------
# 5. Isolated openclaw config: echo provider + single agent + webchannel(jwt).
#    `saas.baseUrl` (via WEBCHANNEL_SAAS_BASE_URL) points the enrolled plugin path
#    at the issuer; auth.jwt.jwksUrl points at the SAME issuer's JWKS so the
#    register-hop bootstrap JWT verifies.
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
              "issuer": "$SAAS_ISSUER",
              "audience": "$ACCOUNT_ID"
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
echo "[run-all-real] wrote $OCH/.openclaw/openclaw.json"

# ---------------------------------------------------------------------------
# 6. CONFIG-TIME credential acquisition via `openclaw channels add` (가-1).
#    After Cycle 1/2 the gateway is CONSUME-ONLY — it no longer enrolls. The
#    device flow runs HERE, at config time (exactly as a production operator runs
#    `openclaw channels add`). HOME=$OCH so creds persist to
#    $OCH/.openclaw-webchannel/<account>/credentials.json, which the gateway
#    (also HOME=$OCH) consumes. Identity via the generic flags the webchannel
#    setup adapter maps: --base-url→saas.baseUrl, --url→tenant. The wire identity
#    is the --account value itself (no --token→agentId mapping anymore — the
#    handling agent is selected separately via `agents bind`).
# ---------------------------------------------------------------------------
echo "[run-all-real] channels add (config-time device-flow enroll)…"
HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  "$REPO/node_modules/.bin/openclaw" channels add --channel webchannel --account "$ACCOUNT_ID" \
    --base-url "http://127.0.0.1:$ISSUER_PORT" --url "$TENANT" \
  >"$OCH/channels-add.log" 2>&1 &
ADD_PID=$!
echo "[run-all-real] channels add pid=$ADD_PID — waiting for enrollment user_code…"

# 6a. Auto-approve: scrape the user_code from the channels-add output (NOT
#     gateway.log anymore), POST it to /approve.
USER_CODE=""
for i in $(seq 1 240); do
  USER_CODE="$(grep -oE 'User code: [A-Z]{4}-[A-Z]{4}' "$OCH/channels-add.log" 2>/dev/null | head -1 | awk '{print $3}' || true)"
  if [ -n "$USER_CODE" ]; then break; fi
  if ! kill -0 "$ADD_PID" 2>/dev/null; then
    echo "[run-all-real] channels add exited before user_code — log:"; cat "$OCH/channels-add.log"; exit 2
  fi
  sleep 0.25
done
[ -z "$USER_CODE" ] && { echo "[run-all-real] TIMEOUT waiting for user_code — channels-add log:"; cat "$OCH/channels-add.log"; exit 2; }
echo "[run-all-real] enrollment user_code=$USER_CODE — approving…"
APPROVE="$(curl -fsS -X POST "http://127.0.0.1:$ISSUER_PORT/approve" \
  -H 'Content-Type: application/json' -d "{\"user_code\":\"$USER_CODE\"}" || true)"
echo "[run-all-real] approve response: $APPROVE"

# 6b. Let `channels add` finish (polls, receives creds, persists them, exit 0).
set +e; wait "$ADD_PID"; ADD_RC=$?; set -e
ADD_PID=""
if [ "$ADD_RC" -ne 0 ]; then
  echo "[run-all-real] channels add failed (rc=$ADD_RC) — log:"; cat "$OCH/channels-add.log"; exit 2
fi
CRED_FILE="$OCH/.openclaw-webchannel/$ACCOUNT_ID/credentials.json"
[ -f "$CRED_FILE" ] || { echo "[run-all-real] creds NOT persisted at $CRED_FILE — log:"; cat "$OCH/channels-add.log"; exit 2; }
echo "[run-all-real] ✓ credentials persisted at $CRED_FILE"

# 6b². Re-assert the register-hop admission shape AFTER `channels add`. The
#      setup adapter writes the demo-proven block (`admission: "auto"`,
#      `dmSecurity: "open"`) into the account — but "auto" is an EXPLICIT
#      override that disables the HTTP register hop (no aud→account dispatch
#      entry ⇒ challenge 401 "No account for token audience"), and this harness
#      drives the register hop. Restore the pre-add intent.
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
echo "[run-all-real] ✓ re-asserted admission=register-hop + dmSecurity=allowlist for account $ACCOUNT_ID"

# ---------------------------------------------------------------------------
# 6c. Boot the isolated gateway — CONSUME-ONLY. No acquisition env: identity
#     lives in the config `channels add` wrote; only the connection override
#     WEBCHANNEL_NATS_URL is passed. No user_code at gateway boot anymore.
# ---------------------------------------------------------------------------
HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
  WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$GW_PORT" --force \
  >"$OCH/gateway.log" 2>&1 &
GW_PID=$!
echo "[run-all-real] gateway pid=$GW_PID — waiting for plugin registration (consume persisted creds)…"
for i in $(seq 1 240); do
  if grep -q "\[webchannel\] ✓ NATS mode plugin registered" "$OCH/gateway.log" 2>/dev/null; then
    echo "[run-all-real] gateway ready (consumed creds + connected)"
    break
  fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "[run-all-real] gateway died early — log:"; cat "$OCH/gateway.log"; exit 2
  fi
  sleep 0.5
  if [ "$i" -eq 240 ]; then
    echo "[run-all-real] TIMEOUT waiting for gateway registration — log:"; cat "$OCH/gateway.log"; exit 2
  fi
done

# P0-1 T3b: a real gateway boot must expose no browser-facing WEBCHANNEL socket
# endpoint. Reality check (probed live): the OpenClaw CORE gateway accepts a WS
# upgrade on ANY path of its port and immediately issues its authenticated
# control-protocol `connect.challenge` — that surface is core OpenClaw, not
# ours, and cannot be removed by this plugin. The correct invariant is
# therefore INDISTINGUISHABILITY: /webchannel/ws must behave exactly like an
# unregistered path (same status; if 101, the first frame is the core
# connect.challenge and carries no webchannel-protocol markers).
t3b_probe() {
  # $1=path $2=outfile; prints http_code; rc propagated (28 = held open, OK)
  curl -sS --connect-timeout 2 --max-time 5 -o "$2" -w '%{http_code}' \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "http://127.0.0.1:$GW_PORT$1"
}
set +e
WC_STATUS=$(t3b_probe /webchannel/ws "$OCH/t3b-webchannel.out"); WC_RC=$?
CN_STATUS=$(t3b_probe /p0-1-unregistered-canary "$OCH/t3b-canary.out"); CN_RC=$?
set -e
if [ "$WC_RC" -ne 0 ] && [ "$WC_RC" -ne 28 ]; then
  echo "[run-all-real] FAIL — T3b probe errored (curl rc=$WC_RC)" >&2
  exit 2
fi
if [ "$WC_STATUS" != "$CN_STATUS" ]; then
  echo "[run-all-real] FAIL — /webchannel/ws ($WC_STATUS) differs from unregistered path ($CN_STATUS): a webchannel-specific route exists" >&2
  exit 2
fi
if [ "$WC_STATUS" = "101" ]; then
  # LC_ALL=C + -a: the capture starts with a raw WS frame byte (0x81). BSD grep
  # in a UTF-8 locale silently fails to match lines carrying invalid multibyte
  # sequences, and binary heuristics vary across grep implementations.
  if ! LC_ALL=C grep -aq 'connect.challenge' "$OCH/t3b-webchannel.out"; then
    echo "[run-all-real] FAIL — 101 on /webchannel/ws without the core connect.challenge (unknown upgrade handler)" >&2
    exit 2
  fi
  if LC_ALL=C grep -aqE '"type"[[:space:]]*:[[:space:]]*"(agent_message|history|approval_request|approval_snapshot|approval_resolved|typing|commands|ack|progress|reasoning|turn_settled)"' "$OCH/t3b-webchannel.out"; then
    echo "[run-all-real] FAIL — /webchannel/ws answered with webchannel-protocol frames" >&2
    exit 2
  fi
  echo "[run-all-real] ✓ T3b: /webchannel/ws is indistinguishable from an unregistered path (core gateway challenge only)"
else
  echo "[run-all-real] ✓ T3b: no upgrade accepted on /webchannel/ws (HTTP $WC_STATUS, matches unregistered path)"
fi

# ---------------------------------------------------------------------------
# 7. Run the REAL-BROWSER Playwright driver (NKEY-auth + PoP register).
# ---------------------------------------------------------------------------
echo "[run-all-real] driving the ALL-REAL real-browser round-trip…"
set +e
WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
WEBCHANNEL_ISSUER_URL="http://127.0.0.1:$ISSUER_PORT" \
WEBCHANNEL_TENANT="$TENANT" WEBCHANNEL_ACCOUNT_ID="$ACCOUNT_ID" WEBCHANNEL_PEER_ID="$PEER_ID" \
WEBCHANNEL_PAGE_PORT="$PAGE_PORT" \
  node "$REPO/e2e/local/all-real.mjs"
RC=$?
set -e

echo "[run-all-real] driver exit code = $RC"
if [ "$RC" -ne 0 ]; then
  echo "[run-all-real] gateway log tail (debug):"; tail -40 "$OCH/gateway.log" 2>/dev/null || true
  echo "[run-all-real] nats log tail (debug):";    tail -20 "$OCH/nats.log" 2>/dev/null || true
fi
exit "$RC"
