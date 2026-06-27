#!/usr/bin/env bash
# Hermetic enrolled-NATS-transport E2E (#18 — agent-side). Proves, in ONE running
# real gateway with devOpen OFF, that the PLUGIN obtains tenant-scoped NATS user
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
# real ~/.openclaw and ~/.openclaw-webchannel are never touched. Distinct ports
# avoid colliding with the other harnesses. Self-cleaning (trap on EXIT).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OCH=/tmp/oc-enrolled-e2e
PKG_JSON="$REPO/packages/plugin/package.json"
# Keep the backup OUTSIDE $OCH: $OCH is rm -rf'd at startup, so a backup living
# inside it would be wiped by the NEXT run before we could restore the original —
# permanently stranding the swapped (index-nats.ts) package.json in git.
PKG_BAK=/tmp/oc-enrolled-e2e.pkgbak.json

GW_PORT=18999
NATS_WS=18422
NATS_TCP=14422
ECHO_PORT=18902
ISSUER_PORT=3921

TENANT=default-tenant
AGENT_ID=default-agent
PEER_ID=enrolled-driver-peer
SAAS_ISSUER="https://saas.local/enrolled-issuer"

NATS_PID=""; ECHO_PID=""; ISSUER_PID=""; GW_PID=""

cleanup() {
  echo "[run-enrolled] cleanup…"
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
# 1. REAL device-flow enrollment-server (single trust chain). Writes the public
#    NATS config to $OCH and serves JWKS + test routes.
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
      "auth": {
        "strategy": "jwt",
        "jwt": {
          "jwksUrl": "http://127.0.0.1:$ISSUER_PORT/.well-known/jwks.json",
          "issuer": "$SAAS_ISSUER",
          "audience": "$AGENT_ID"
        }
      },
      "dmSecurity": "allowlist",
      "allowFrom": ["$PEER_ID"]
    }
  }
}
JSON
echo "[run-enrolled] wrote $OCH/.openclaw/openclaw.json"

# ---------------------------------------------------------------------------
# 6. Boot the isolated gateway. NO WEBCHANNEL_NATS_DEV_OPEN → enrolled path runs.
#    HOME=$OCH isolates the plugin's enrollment credential store under $OCH.
# ---------------------------------------------------------------------------
HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
  WEBCHANNEL_SAAS_BASE_URL="http://127.0.0.1:$ISSUER_PORT" \
  WEBCHANNEL_TENANT="$TENANT" WEBCHANNEL_AGENT_ID="$AGENT_ID" \
  WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$GW_PORT" --force \
  >"$OCH/gateway.log" 2>&1 &
GW_PID=$!
echo "[run-enrolled] gateway pid=$GW_PID — waiting for enrollment user_code…"

# 6a. Auto-approve: scrape the user_code the plugin prints (displayInstructions),
#     then POST it to the issuer's /approve route.
USER_CODE=""
for i in $(seq 1 240); do
  USER_CODE="$(grep -oE 'User code: [A-Z]{4}-[A-Z]{4}' "$OCH/gateway.log" 2>/dev/null | head -1 | awk '{print $3}' || true)"
  if [ -n "$USER_CODE" ]; then break; fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "[run-enrolled] gateway died before enrollment — log:"; cat "$OCH/gateway.log"; exit 2
  fi
  sleep 0.25
done
[ -z "$USER_CODE" ] && { echo "[run-enrolled] TIMEOUT waiting for user_code — gateway log:"; cat "$OCH/gateway.log"; exit 2; }
echo "[run-enrolled] enrollment user_code=$USER_CODE — approving…"
APPROVE="$(curl -fsS -X POST "http://127.0.0.1:$ISSUER_PORT/approve" \
  -H 'Content-Type: application/json' -d "{\"user_code\":\"$USER_CODE\"}" || true)"
echo "[run-enrolled] approve response: $APPROVE"

# 6b. Wait for the plugin to poll, receive creds, NKEY-connect, and register.
echo "[run-enrolled] waiting for plugin registration (enrolled NATS connect)…"
for i in $(seq 1 240); do
  if grep -q "\[webchannel\] ✓ NATS mode plugin registered" "$OCH/gateway.log" 2>/dev/null; then
    echo "[run-enrolled] gateway ready (enrolled + connected)"
    break
  fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "[run-enrolled] gateway died early — log:"; cat "$OCH/gateway.log"; exit 2
  fi
  sleep 0.5
  if [ "$i" -eq 240 ]; then
    echo "[run-enrolled] TIMEOUT waiting for gateway registration — log:"; cat "$OCH/gateway.log"; exit 2
  fi
done

# ---------------------------------------------------------------------------
# 7. Drive the NKEY-authenticated encrypted round-trip.
# ---------------------------------------------------------------------------
echo "[run-enrolled] driving enrolled-transport encrypted round-trip…"
set +e
WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
WEBCHANNEL_ISSUER_URL="http://127.0.0.1:$ISSUER_PORT" \
WEBCHANNEL_TENANT="$TENANT" WEBCHANNEL_AGENT_ID="$AGENT_ID" WEBCHANNEL_PEER_ID="$PEER_ID" \
  node --import tsx "$REPO/e2e/local/enrolled-transport-roundtrip.ts"
RC=$?
set -e

echo "[run-enrolled] driver exit code = $RC"
exit "$RC"
