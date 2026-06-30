#!/usr/bin/env bash
# 가-1 Cycle 3 — 2-ACCOUNT ROUTING-ISOLATION E2E (AC6, the completion gate).
#
# Stands up ONE openclaw gateway (index-nats plugin) serving TWO webchannel
# accounts simultaneously — acctA (agentId=agentA) and acctB (agentId=agentB) —
# each with its own auth.jwt audience, bound to a DISTINCT agent via
# `binding.account` (webchannel:acctA→agentA, webchannel:acctB→agentB). Each agent
# uses a DISTINCT echo model (distinct ECHO_PREFIX) so the agent that handled a
# turn is observable in the reply text.
#
# Then a Node driver (the PRODUCTION WebChannelNatsClient) drives a message into
# EACH account and asserts ROUTING ISOLATION:
#   - acctA's reply carries agentA's prefix and NOT agentB's, and
#   - acctB's reply carries agentB's prefix and NOT agentA's.
#
# This exercises the REAL stack (no unit mocks):
#   - registerFull MULTIPLEX  → two NatsChannels, one per account
#   - single register route's JWT-aud→account DISPATCH → aud=agentA hits acctA's
#     channel.registerPeer (Cycle 2 C2 invariant), aud=agentB hits acctB's
#   - binding.account ROUTING → resolveAgentRoute(accountId) picks the bound agent
#
# Credential source is dev/open-NATS (WEBCHANNEL_NATS_DEV_OPEN=1), as in the
# other register-focused harnesses (run-jwt-register / run-saas-issuer-register /
# run-browser-jwt-register): it isolates the multiplex+dispatch+routing layer
# without per-account NATS-cred plumbing. The CONFIG-TIME channels-add enrollment
# path is covered separately by run-enrolled-transport.sh and run-all-real.sh.
#
# Everything runs under an isolated OPENCLAW_HOME=/tmp/oc-two-acct-e2e; your real
# ~/.openclaw is never touched. Distinct ports avoid colliding with the other
# harnesses. Idempotent + self-cleaning (trap on EXIT).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OCH=/tmp/oc-two-acct-e2e
PKG_JSON="$REPO/packages/plugin/package.json"
# Keep the backup OUTSIDE $OCH ($OCH is rm -rf'd at startup).
PKG_BAK=/tmp/oc-two-acct-e2e.pkgbak.json

# Distinct ports — no collision with the other harnesses.
GW_PORT=19299
NATS_WS=18722
NATS_TCP=14722
ECHO_A_PORT=18906
ECHO_B_PORT=18907

TENANT=default-tenant
AGENT_A=agentA
AGENT_B=agentB
ACCT_A=accta            # canonical (lowercased) account ids — see account-config canonicalize
ACCT_B=acctb
PEER_A=web-accta-peer
PEER_B=web-acctb-peer
ISS="https://e2e-issuer.test"
ECHO_A_PREFIX="AGENT-A-ECHO: "
ECHO_B_PREFIX="AGENT-B-ECHO: "

NATS_PID=""; ECHO_A_PID=""; ECHO_B_PID=""; GW_PID=""

cleanup() {
  echo "[run-two-acct] cleanup…"
  [ -n "$GW_PID" ]     && kill "$GW_PID"     2>/dev/null || true
  [ -n "$ECHO_A_PID" ] && kill "$ECHO_A_PID" 2>/dev/null || true
  [ -n "$ECHO_B_PID" ] && kill "$ECHO_B_PID" 2>/dev/null || true
  [ -n "$NATS_PID" ]   && kill "$NATS_PID"   2>/dev/null || true
  pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
  pkill -f "echo-openai-server.mjs $ECHO_A_PORT" 2>/dev/null || true
  pkill -f "echo-openai-server.mjs $ECHO_B_PORT" 2>/dev/null || true
  pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
  if [ -f "$PKG_BAK" ]; then
    cp "$PKG_BAK" "$PKG_JSON"
    rm -f "$PKG_BAK"
    echo "[run-two-acct] restored $PKG_JSON"
  fi
}
trap cleanup EXIT

# Pre-clean leftover procs / dir.
pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
pkill -f "echo-openai-server.mjs $ECHO_A_PORT" 2>/dev/null || true
pkill -f "echo-openai-server.mjs $ECHO_B_PORT" 2>/dev/null || true
pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
rm -rf "$OCH"
mkdir -p "$OCH/.openclaw"

# 0. Point the webchannel plugin entry at index-nats.ts (restore on exit).
if [ -f "$PKG_BAK" ]; then
  echo "[run-two-acct] stale $PKG_BAK found — restoring original package.json before re-swapping"
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
echo "[run-two-acct] set plugin extensions → ./index-nats.ts"

# 1. nats-server with a websocket listener (open/dev mode).
cat > "$OCH/nats.conf" <<CONF
port: $NATS_TCP
websocket { port: $NATS_WS, no_tls: true }
CONF
nats-server -c "$OCH/nats.conf" >"$OCH/nats.log" 2>&1 &
NATS_PID=$!
echo "[run-two-acct] nats-server pid=$NATS_PID (ws://127.0.0.1:$NATS_WS)"
for i in $(seq 1 120); do
  grep -q "Server is ready" "$OCH/nats.log" 2>/dev/null && break
  kill -0 "$NATS_PID" 2>/dev/null || { echo "nats died"; cat "$OCH/nats.log"; exit 2; }
  sleep 0.25
done

# 2. RS256 signing key + JWKS — shared issuer (only `aud` distinguishes accounts).
node "$REPO/e2e/local/gen-jwt-fixtures.mjs" "$OCH"

# 3. TWO echo model servers — distinct prefixes make the agents distinguishable.
ECHO_PREFIX="$ECHO_A_PREFIX" node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_A_PORT" >"$OCH/echoA.log" 2>&1 &
ECHO_A_PID=$!
ECHO_PREFIX="$ECHO_B_PREFIX" node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_B_PORT" >"$OCH/echoB.log" 2>&1 &
ECHO_B_PID=$!
echo "[run-two-acct] echo servers: A pid=$ECHO_A_PID ($ECHO_A_PORT), B pid=$ECHO_B_PID ($ECHO_B_PORT)"

# 4. Isolated config: TWO providers + TWO agents + TWO webchannel accounts + TWO
#    account-scoped bindings. Per-account auth.jwt audience = that account's agentId.
cat > "$OCH/.openclaw/openclaw.json" <<JSON
{
  "gateway": { "mode": "local", "bind": "loopback" },
  "models": {
    "providers": {
      "echoA-local": {
        "baseUrl": "http://127.0.0.1:$ECHO_A_PORT/v1",
        "api": "openai-completions",
        "models": [{ "id": "echo", "name": "EchoA", "reasoning": false, "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000, "maxTokens": 8192 }]
      },
      "echoB-local": {
        "baseUrl": "http://127.0.0.1:$ECHO_B_PORT/v1",
        "api": "openai-completions",
        "models": [{ "id": "echo", "name": "EchoB", "reasoning": false, "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000, "maxTokens": 8192 }]
      }
    }
  },
  "agents": {
    "defaults": { "model": { "primary": "echoA-local/echo" }, "compaction": { "reserveTokensFloor": 20000 } },
    "list": [
      { "id": "$AGENT_A", "model": { "primary": "echoA-local/echo" } },
      { "id": "$AGENT_B", "model": { "primary": "echoB-local/echo" } }
    ]
  },
  "bindings": [
    { "agentId": "$AGENT_A", "match": { "channel": "webchannel", "accountId": "$ACCT_A" } },
    { "agentId": "$AGENT_B", "match": { "channel": "webchannel", "accountId": "$ACCT_B" } }
  ],
  "plugins": {
    "load": { "paths": ["$REPO/packages/plugin"] },
    "allow": ["webchannel"],
    "entries": { "webchannel": { "enabled": true } }
  },
  "channels": {
    "webchannel": {
      "accounts": {
        "$ACCT_A": {
          "tenant": "$TENANT",
          "agentId": "$AGENT_A",
          "auth": { "strategy": "jwt", "jwt": {
            "jwksFile": "$OCH/jwks.json", "issuer": "$ISS", "audience": "$AGENT_A" } },
          "dmSecurity": "allowlist",
          "allowFrom": ["$PEER_A"]
        },
        "$ACCT_B": {
          "tenant": "$TENANT",
          "agentId": "$AGENT_B",
          "auth": { "strategy": "jwt", "jwt": {
            "jwksFile": "$OCH/jwks.json", "issuer": "$ISS", "audience": "$AGENT_B" } },
          "dmSecurity": "allowlist",
          "allowFrom": ["$PEER_B"]
        }
      }
    }
  }
}
JSON
echo "[run-two-acct] wrote $OCH/.openclaw/openclaw.json (2 accounts, 2 agents, 2 bindings)"

# 5. Boot ONE gateway serving BOTH accounts (dev/open-NATS).
OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_DEV_OPEN=1 WEBCHANNEL_NATS_URL=ws://127.0.0.1:$NATS_WS \
  WEBCHANNEL_GW_URL=http://127.0.0.1:$GW_PORT \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$GW_PORT" --force \
  >"$OCH/gateway.log" 2>&1 &
GW_PID=$!
echo "[run-two-acct] gateway pid=$GW_PID — waiting for multiplex registration (2 accounts)…"
for i in $(seq 1 120); do
  # Cycle 2 readiness line: "✓ NATS mode plugin registered (N of M ... serving)".
  if grep -q "\[webchannel\] ✓ NATS mode plugin registered" "$OCH/gateway.log" 2>/dev/null; then
    echo "[run-two-acct] gateway ready:"
    grep -E "account \"(${ACCT_A}|${ACCT_B})\" ✓ encrypted NATS channel|NATS mode plugin registered" "$OCH/gateway.log" | sed 's/^/  /' || true
    break
  fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "[run-two-acct] gateway died early — log:"; cat "$OCH/gateway.log"; exit 2
  fi
  sleep 0.5
  if [ "$i" -eq 120 ]; then
    echo "[run-two-acct] TIMEOUT waiting for gateway — log:"; cat "$OCH/gateway.log"; exit 2
  fi
done

# Sanity: BOTH accounts must have built a channel (2-of-2 serving).
if ! grep -q "account \"$ACCT_A\" ✓ encrypted NATS channel" "$OCH/gateway.log" 2>/dev/null \
   || ! grep -q "account \"$ACCT_B\" ✓ encrypted NATS channel" "$OCH/gateway.log" 2>/dev/null; then
  echo "[run-two-acct] FAIL — both accounts did not build channels. gateway log:"; cat "$OCH/gateway.log"; exit 2
fi

run_account() {
  local label="$1" peer="$2" agent="$3" expect="$4" forbid="$5"
  echo "[run-two-acct] driving $label (peer=$peer, agent=$agent)…"
  set +e
  WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
  WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
  WEBCHANNEL_RS256_PRIVATE="$OCH/rs256-private.jwk.json" \
  WEBCHANNEL_ISSUER="$ISS" WEBCHANNEL_TENANT="$TENANT" \
  WEBCHANNEL_PEER_ID="$peer" WEBCHANNEL_AGENT_ID="$agent" \
  EXPECT_PREFIX="$expect" FORBID_PREFIX="$forbid" \
  SEND_MESSAGE="hello from $label" \
    node --import tsx "$REPO/e2e/local/two-account-isolation-roundtrip.ts"
  local rc=$?
  set -e
  return $rc
}

# 6. Drive acctA → MUST reach agentA (A prefix), MUST NOT reach agentB (no B prefix).
run_account "acctA" "$PEER_A" "$AGENT_A" "$ECHO_A_PREFIX" "$ECHO_B_PREFIX" || {
  echo "[run-two-acct] acctA isolation FAILED — gateway log tail:"; tail -40 "$OCH/gateway.log"; exit 3
}
# 7. Drive acctB → MUST reach agentB (B prefix), MUST NOT reach agentA (no A prefix).
run_account "acctB" "$PEER_B" "$AGENT_B" "$ECHO_B_PREFIX" "$ECHO_A_PREFIX" || {
  echo "[run-two-acct] acctB isolation FAILED — gateway log tail:"; tail -40 "$OCH/gateway.log"; exit 3
}

echo "[run-two-acct] ✓ 2-ACCOUNT ROUTING ISOLATION PROVEN (AC6): acctA→agentA, acctB→agentB, no cross-leak"
exit 0
