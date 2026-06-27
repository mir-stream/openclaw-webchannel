#!/usr/bin/env bash
# Hermetic JWT-register E2E: prove the HTTP /webchannel/nats/register hop is the
# SOLE peer-admission path. With channels.webchannel.auth.strategy="jwt" the agent
# does NOT subscribeWildcard (see index-nats.ts wildcard gate), so a successful
# round-trip means registerPeer happened ONLY via the live HTTP register route,
# driven by the production client's `registration` (PoP) path.
#
# Everything runs under an isolated OPENCLAW_HOME=/tmp/oc-e2e; your real
# ~/.openclaw is never touched. Idempotent + self-cleaning (trap on EXIT).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OCH=/tmp/oc-e2e
PKG_JSON="$REPO/packages/plugin/package.json"
PKG_BAK="$OCH/package.json.bak"

GW_PORT=18799
NATS_WS=18222
NATS_TCP=14222
ECHO_PORT=18900

NATS_PID=""; ECHO_PID=""; GW_PID=""

cleanup() {
  echo "[run-jwt-register] cleanup…"
  [ -n "$GW_PID" ]   && kill "$GW_PID"   2>/dev/null || true
  [ -n "$ECHO_PID" ] && kill "$ECHO_PID" 2>/dev/null || true
  [ -n "$NATS_PID" ] && kill "$NATS_PID" 2>/dev/null || true
  # Belt-and-braces: nuke any leftover procs from a previous flaky run.
  pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
  pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
  pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
  # Restore the plugin package.json entry.
  if [ -f "$PKG_BAK" ]; then
    cp "$PKG_BAK" "$PKG_JSON"
    rm -f "$PKG_BAK"
    echo "[run-jwt-register] restored $PKG_JSON"
  fi
}
trap cleanup EXIT

# Pre-clean leftover procs / dir.
pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
# NOTE: GW_PORT=18799 is the dedicated dev-harness port; this pkill would also
# kill a developer's own gateway if they happen to run one on 18799.
pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
rm -rf "$OCH"
mkdir -p "$OCH/.openclaw"

# 0. Point the webchannel plugin entry at index-nats.ts (restore on exit).
cp "$PKG_JSON" "$PKG_BAK"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.openclaw = j.openclaw || {};
  j.openclaw.extensions = ["./index-nats.ts"];
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$PKG_JSON"
echo "[run-jwt-register] set plugin extensions → ./index-nats.ts"

# 1. nats-server with a websocket listener.
cat > "$OCH/nats.conf" <<CONF
port: $NATS_TCP
websocket { port: $NATS_WS, no_tls: true }
CONF
nats-server -c "$OCH/nats.conf" >"$OCH/nats.log" 2>&1 &
NATS_PID=$!
echo "[run-jwt-register] nats-server pid=$NATS_PID (ws://127.0.0.1:$NATS_WS)"

# 2. RS256 signing key + JWKS — MUST exist before the gateway loads the plugin.
node "$REPO/e2e/local/gen-jwt-fixtures.mjs" "$OCH"

# 3. echo model server.
node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_PORT" >"$OCH/echo.log" 2>&1 &
ECHO_PID=$!
echo "[run-jwt-register] echo server pid=$ECHO_PID"

# 4. Isolated openclaw config: echo provider + single agent + webchannel(jwt).
#    NOTE: no nats/encryption/devOpen keys under channels.webchannel — the plugin
#    schema rejects unknown keys; devOpen is env-driven below.
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
          "jwksFile": "$OCH/jwks.json",
          "issuer": "https://e2e-issuer.test",
          "audience": "default-agent"
        }
      },
      "dmSecurity": "allowlist",
      "allowFrom": ["web-jwt-peer"]
    }
  }
}
JSON
echo "[run-jwt-register] wrote $OCH/.openclaw/openclaw.json"

# 5. Boot the isolated gateway in dev/open-NATS + jwt mode.
OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_DEV_OPEN=1 WEBCHANNEL_NATS_URL=ws://127.0.0.1:$NATS_WS \
  WEBCHANNEL_TENANT=default-tenant WEBCHANNEL_AGENT_ID=default-agent \
  WEBCHANNEL_GW_URL=http://127.0.0.1:$GW_PORT \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$GW_PORT" --force \
  >"$OCH/gateway.log" 2>&1 &
GW_PID=$!
echo "[run-jwt-register] gateway pid=$GW_PID — waiting for plugin registration…"

# Poll the gateway log for the readiness line (max ~60s).
for i in $(seq 1 120); do
  if grep -q "\[webchannel\] ✓ NATS mode plugin registered" "$OCH/gateway.log" 2>/dev/null; then
    echo "[run-jwt-register] gateway ready"
    break
  fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "[run-jwt-register] gateway died early — log:"; cat "$OCH/gateway.log"; exit 2
  fi
  sleep 0.5
  if [ "$i" -eq 120 ]; then
    echo "[run-jwt-register] TIMEOUT waiting for gateway — log:"; cat "$OCH/gateway.log"; exit 2
  fi
done

# 6. Run the JWT-register Node driver.
echo "[run-jwt-register] driving JWT + PoP register round-trip…"
set +e
WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
WEBCHANNEL_RS256_PRIVATE="$OCH/rs256-private.jwk.json" \
  node --import tsx "$REPO/e2e/local/jwt-register-roundtrip.ts"
RC=$?
set -e

echo "[run-jwt-register] driver exit code = $RC"
exit "$RC"
