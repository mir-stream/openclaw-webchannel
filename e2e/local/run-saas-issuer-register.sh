#!/usr/bin/env bash
# Hermetic REAL-SaaS-issuer E2E: prove the reference bootstrap-server (NOT a
# fixture) mints an RS256 bootstrap JWT, served via its REAL JWKS endpoint, that
# the plugin verifies over HTTP (auth.jwt.jwksUrl) through the live NATS register
# hop (`…{peerId}.register`) — admitting the peer for an encrypted round-trip.
#
# This is the sibling of run-jwt-register.sh (which self-mints from a static
# jwksFile). Here the JWT SOURCE is the real bootstrap-server; everything else
# (devOpen NATS, wildcard OFF on the jwt path, PoP register) is identical.
#
# JWT issuance is INDEPENDENT of NATS transport: NATS stays devOpen (no
# enrollment). The full enrolled-NATS-transport (device-flow) variant is a
# separate follow-up.
#
# Everything runs under an isolated OPENCLAW_HOME=/tmp/oc-saas-e2e; your real
# ~/.openclaw is never touched. Distinct ports avoid colliding with the other
# harness. Idempotent + self-cleaning (trap on EXIT).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OCH=/tmp/oc-saas-e2e
PKG_JSON="$REPO/packages/plugin/package.json"
# Keep the backup OUTSIDE $OCH: $OCH is rm -rf'd at startup, so a backup living
# inside it would be wiped by the NEXT run before we could restore the original —
# permanently stranding the swapped (index-nats.ts) package.json in git.
PKG_BAK=/tmp/oc-saas-e2e.pkgbak.json

GW_PORT=18899
NATS_WS=18322
NATS_TCP=14322
ECHO_PORT=18901
BOOTSTRAP_PORT=3911
SAAS_ISSUER="https://saas.local/issuer"

NATS_PID=""; ECHO_PID=""; BOOT_PID=""; GW_PID=""

cleanup() {
  echo "[run-saas-issuer] cleanup…"
  [ -n "$GW_PID" ]   && kill "$GW_PID"   2>/dev/null || true
  [ -n "$BOOT_PID" ] && kill "$BOOT_PID" 2>/dev/null || true
  [ -n "$ECHO_PID" ] && kill "$ECHO_PID" 2>/dev/null || true
  [ -n "$NATS_PID" ] && kill "$NATS_PID" 2>/dev/null || true
  # Belt-and-braces: nuke any leftover procs from a previous flaky run.
  pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
  pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
  pkill -f "bootstrap-server.ts" 2>/dev/null || true
  pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
  # Restore the plugin package.json entry.
  if [ -f "$PKG_BAK" ]; then
    cp "$PKG_BAK" "$PKG_JSON"
    rm -f "$PKG_BAK"
    echo "[run-saas-issuer] restored $PKG_JSON"
  fi
}
trap cleanup EXIT

# Pre-clean leftover procs / dir.
pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
pkill -f "bootstrap-server.ts" 2>/dev/null || true
pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
rm -rf "$OCH"
mkdir -p "$OCH/.openclaw"

# 0. Point the webchannel plugin entry at index-nats.ts (restore on exit).
#    Crash recovery: if a prior run was hard-killed mid-swap, $PKG_BAK still holds
#    the ORIGINAL package.json while the tracked one is left swapped. Restore it
#    first, THEN take a fresh backup — so this swap is itself crash-recoverable.
if [ -f "$PKG_BAK" ]; then
  echo "[run-saas-issuer] stale $PKG_BAK found — restoring original package.json before re-swapping"
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
echo "[run-saas-issuer] set plugin extensions → ./index-nats.ts"

# 1. nats-server with a websocket listener.
cat > "$OCH/nats.conf" <<CONF
port: $NATS_TCP
websocket { port: $NATS_WS, no_tls: true }
CONF
nats-server -c "$OCH/nats.conf" >"$OCH/nats.log" 2>&1 &
NATS_PID=$!
echo "[run-saas-issuer] nats-server pid=$NATS_PID (ws://127.0.0.1:$NATS_WS)"

# 2. echo model server.
node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_PORT" >"$OCH/echo.log" 2>&1 &
ECHO_PID=$!
echo "[run-saas-issuer] echo server pid=$ECHO_PID"

# 3. REAL bootstrap-server (real RS256 issuance + real JWKS).
#    MUST be up before the gateway loads the plugin (which fetches its JWKS).
PORT="$BOOTSTRAP_PORT" \
SAAS_ISSUER="$SAAS_ISSUER" \
SAAS_BASE_URL="http://127.0.0.1:$BOOTSTRAP_PORT" \
WEBCHANNEL_NATS_DEV_OPEN=1 \
  node --import tsx "$REPO/packages/saas/reference/bootstrap-server.ts" >"$OCH/bootstrap.log" 2>&1 &
BOOT_PID=$!
echo "[run-saas-issuer] bootstrap-server pid=$BOOT_PID — waiting for JWKS…"
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$BOOTSTRAP_PORT/.well-known/jwks.json" >/dev/null 2>&1; then
    echo "[run-saas-issuer] bootstrap JWKS up"
    break
  fi
  if ! kill -0 "$BOOT_PID" 2>/dev/null; then
    echo "[run-saas-issuer] bootstrap-server died early — log:"; cat "$OCH/bootstrap.log"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-saas-issuer] TIMEOUT waiting for bootstrap JWKS — log:"; cat "$OCH/bootstrap.log"; exit 2
  fi
done

# 4. Isolated openclaw config: echo provider + single agent + webchannel(jwt over jwksUrl).
#    NOTE: no nats/encryption/devOpen keys under channels.webchannel — the plugin
#    schema rejects unknown keys; devOpen is env-driven below. The JWKS comes from
#    the live bootstrap-server (jwksUrl), NOT a static file — that's the point.
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
          "jwksUrl": "http://127.0.0.1:$BOOTSTRAP_PORT/.well-known/jwks.json",
          "issuer": "$SAAS_ISSUER",
          "audience": "default"
        }
      },
      "dmSecurity": "allowlist",
      "allowFrom": ["web-saas-peer"]
    }
  }
}
JSON
echo "[run-saas-issuer] wrote $OCH/.openclaw/openclaw.json"

# 5. Boot the isolated gateway in dev/open-NATS + jwt mode.
OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_DEV_OPEN=1 WEBCHANNEL_NATS_URL=ws://127.0.0.1:$NATS_WS \
  WEBCHANNEL_GW_URL=http://127.0.0.1:$GW_PORT \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$GW_PORT" --force \
  >"$OCH/gateway.log" 2>&1 &
GW_PID=$!
echo "[run-saas-issuer] gateway pid=$GW_PID — waiting for plugin registration…"

# Poll the gateway log for the readiness line (max ~60s).
for i in $(seq 1 120); do
  if grep -q "\[webchannel\] ✓ NATS mode plugin registered" "$OCH/gateway.log" 2>/dev/null; then
    echo "[run-saas-issuer] gateway ready"
    break
  fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "[run-saas-issuer] gateway died early — log:"; cat "$OCH/gateway.log"; exit 2
  fi
  sleep 0.5
  if [ "$i" -eq 120 ]; then
    echo "[run-saas-issuer] TIMEOUT waiting for gateway — log:"; cat "$OCH/gateway.log"; exit 2
  fi
done

# 6. Run the real-SaaS-issuer Node driver.
echo "[run-saas-issuer] driving real-SaaS-issued JWT + PoP register round-trip…"
set +e
WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
WEBCHANNEL_BOOTSTRAP_URL="http://127.0.0.1:$BOOTSTRAP_PORT" \
  node --import tsx "$REPO/e2e/local/saas-issuer-roundtrip.ts"
RC=$?
set -e

echo "[run-saas-issuer] driver exit code = $RC"
exit "$RC"
