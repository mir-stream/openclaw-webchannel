#!/usr/bin/env bash
# Hermetic REAL-BROWSER JWT + PoP register E2E (#19). Proves that a REAL headless
# Chromium browser running the PRODUCTION WebChannelNatsClient drives the full
# JWT + Proof-of-Possession HTTP register hop — keygen IN-PAGE (X25519 +
# non-extractable Ed25519) → reference SaaS issuer /bootstrap (CORS `*`, fetched
# in-page) → PoP register against the live gateway → encrypted echo round-trip.
#
# This removes the "client runs in Node" stand-in: the Node sibling is
# run-saas-issuer-register.sh (saas-issuer-roundtrip.ts). Everything else
# (real RS256 issuer + real JWKS-over-HTTP verify, devOpen NATS, wildcard OFF on
# the jwt path, PoP register) is identical — only the DRIVER is a real browser.
#
# Browser-specific: the page origin (PAGE_PORT) differs from the gateway origin
# (GW_PORT), so the register routes need CORS — see the CORS fix in
# packages/plugin/index-nats.ts. Node fetch ignored CORS, which is why the Node
# driver never exercised this.
#
# Everything runs under an isolated OPENCLAW_HOME=/tmp/oc-browser-e2e; your real
# ~/.openclaw is never touched. Distinct ports avoid colliding with the other
# harnesses. Idempotent + self-cleaning (trap on EXIT).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OCH=/tmp/oc-browser-e2e
PKG_JSON="$REPO/packages/plugin/package.json"
# Keep the backup OUTSIDE $OCH: $OCH is rm -rf'd at startup, so a backup living
# inside it would be wiped by the NEXT run before we could restore the original —
# permanently stranding the swapped (index-nats.ts) package.json in git.
PKG_BAK=/tmp/oc-browser-e2e.pkgbak.json

GW_PORT=19099
NATS_WS=18522
NATS_TCP=14522
ECHO_PORT=18903
BOOTSTRAP_PORT=3931
PAGE_PORT=19293
SAAS_ISSUER="https://saas.local/browser-issuer"

TENANT=default-tenant
ACCOUNT_ID=default-agent
PEER_ID=web-browser-peer

NATS_PID=""; ECHO_PID=""; BOOT_PID=""; GW_PID=""

cleanup() {
  echo "[run-browser-jwt] cleanup…"
  [ -n "$GW_PID" ]   && kill "$GW_PID"   2>/dev/null || true
  [ -n "$BOOT_PID" ] && kill "$BOOT_PID" 2>/dev/null || true
  [ -n "$ECHO_PID" ] && kill "$ECHO_PID" 2>/dev/null || true
  [ -n "$NATS_PID" ] && kill "$NATS_PID" 2>/dev/null || true
  # Belt-and-braces: nuke any leftover procs from a previous flaky run.
  pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
  pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
  pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
  # NOTE: no broad `pkill -f bootstrap-server.ts` — the issuer PORT is passed as
  # an env var (not an argv flag), so a broad match could kill an unrelated
  # bootstrap-server (parallel harness). BOOT_PID kill above is sufficient.
  if [ -f "$PKG_BAK" ]; then
    cp "$PKG_BAK" "$PKG_JSON"
    rm -f "$PKG_BAK"
    echo "[run-browser-jwt] restored $PKG_JSON"
  fi
}
trap cleanup EXIT

# Pre-clean leftover procs / dir.
pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
rm -rf "$OCH"
mkdir -p "$OCH/.openclaw"

# 0. Point the webchannel plugin entry at index-nats.ts (restore on exit).
#    Crash recovery: if a prior run was hard-killed mid-swap, $PKG_BAK still holds
#    the ORIGINAL package.json while the tracked one is left swapped. Restore it
#    first, THEN take a fresh backup — so this swap is itself crash-recoverable.
if [ -f "$PKG_BAK" ]; then
  echo "[run-browser-jwt] stale $PKG_BAK found — restoring original package.json before re-swapping"
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
echo "[run-browser-jwt] set plugin extensions → ./index-nats.ts"

# 1. nats-server with a websocket listener.
cat > "$OCH/nats.conf" <<CONF
port: $NATS_TCP
websocket { port: $NATS_WS, no_tls: true }
CONF
nats-server -c "$OCH/nats.conf" >"$OCH/nats.log" 2>&1 &
NATS_PID=$!
echo "[run-browser-jwt] nats-server pid=$NATS_PID (ws://127.0.0.1:$NATS_WS)"

# 2. echo model server.
node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_PORT" >"$OCH/echo.log" 2>&1 &
ECHO_PID=$!
echo "[run-browser-jwt] echo server pid=$ECHO_PID"

# 3. REAL bootstrap-server (real RS256 issuance + real JWKS). MUST be up before
#    the gateway loads the plugin (which fetches its JWKS).
PORT="$BOOTSTRAP_PORT" \
SAAS_ISSUER="$SAAS_ISSUER" \
SAAS_BASE_URL="http://127.0.0.1:$BOOTSTRAP_PORT" \
  node --import tsx "$REPO/packages/saas/reference/bootstrap-server.ts" >"$OCH/bootstrap.log" 2>&1 &
BOOT_PID=$!
echo "[run-browser-jwt] bootstrap-server pid=$BOOT_PID — waiting for JWKS…"
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$BOOTSTRAP_PORT/.well-known/jwks.json" >/dev/null 2>&1; then
    echo "[run-browser-jwt] bootstrap JWKS up"
    break
  fi
  if ! kill -0 "$BOOT_PID" 2>/dev/null; then
    echo "[run-browser-jwt] bootstrap-server died early — log:"; cat "$OCH/bootstrap.log"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-browser-jwt] TIMEOUT waiting for bootstrap JWKS — log:"; cat "$OCH/bootstrap.log"; exit 2
  fi
done

# 4. Isolated openclaw config: echo provider + single agent + webchannel(jwt over
#    jwksUrl). The JWKS comes from the live bootstrap-server, NOT a static file.
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
          "audience": "$ACCOUNT_ID"
        }
      },
      "dmSecurity": "allowlist",
      "allowFrom": ["$PEER_ID"]
    }
  }
}
JSON
echo "[run-browser-jwt] wrote $OCH/.openclaw/openclaw.json"

# 5. Boot the isolated gateway in dev/open-NATS + jwt mode.
OPENCLAW_HOME="$OCH" HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_DEV_OPEN=1 WEBCHANNEL_NATS_URL=ws://127.0.0.1:$NATS_WS \
  WEBCHANNEL_TENANT="$TENANT" WEBCHANNEL_ACCOUNT_ID="$ACCOUNT_ID" \
  WEBCHANNEL_GW_URL=http://127.0.0.1:$GW_PORT \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$GW_PORT" --force \
  >"$OCH/gateway.log" 2>&1 &
GW_PID=$!
echo "[run-browser-jwt] gateway pid=$GW_PID — waiting for plugin registration…"

# Poll the gateway log for the readiness line (max ~60s).
for i in $(seq 1 120); do
  if grep -q "\[webchannel\] ✓ NATS mode plugin registered" "$OCH/gateway.log" 2>/dev/null; then
    echo "[run-browser-jwt] gateway ready"
    break
  fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "[run-browser-jwt] gateway died early — log:"; cat "$OCH/gateway.log"; exit 2
  fi
  sleep 0.5
  if [ "$i" -eq 120 ]; then
    echo "[run-browser-jwt] TIMEOUT waiting for gateway — log:"; cat "$OCH/gateway.log"; exit 2
  fi
done

# 6. Run the REAL-BROWSER Playwright driver (replaces the Node driver).
echo "[run-browser-jwt] driving real-browser JWT + PoP register round-trip…"
set +e
WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
WEBCHANNEL_ISSUER_URL="http://127.0.0.1:$BOOTSTRAP_PORT" \
WEBCHANNEL_TENANT="$TENANT" WEBCHANNEL_ACCOUNT_ID="$ACCOUNT_ID" WEBCHANNEL_PEER_ID="$PEER_ID" \
WEBCHANNEL_PAGE_PORT="$PAGE_PORT" \
  node "$REPO/e2e/local/browser-jwt-register.mjs"
RC=$?
set -e

echo "[run-browser-jwt] driver exit code = $RC"
if [ "$RC" -ne 0 ]; then
  echo "[run-browser-jwt] gateway log tail (debug):"
  tail -40 "$OCH/gateway.log" 2>/dev/null || true
fi
exit "$RC"
