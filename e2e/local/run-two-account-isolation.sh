#!/usr/bin/env bash
# 가-1 Cycle 3 — 2-ACCOUNT ROUTING-ISOLATION E2E (AC6, the completion gate).
#
# Stands up ONE openclaw gateway (index-nats plugin) serving TWO webchannel
# accounts simultaneously — acctA and acctB — each with its own auth.jwt audience
# (= the account id itself), bound to a DISTINCT agent via `binding.account`
# (the equivalent of `openclaw agents bind --bind webchannel:acctA --agent agentA`
# / `--bind webchannel:acctB --agent agentB`). The handling agent is DECOUPLED
# from the wire identity: the wire identity IS the accountId, and the agent is a
# pure `agents bind` concern (telegram-like). Each agent uses a DISTINCT echo model
# (distinct ECHO_PREFIX) so the agent that handled a turn is observable in the reply.
#
# Then a Node driver (the PRODUCTION WebChannelNatsClient) drives a message into
# EACH account and asserts ROUTING ISOLATION:
#   - acctA's reply carries agentA's prefix and NOT agentB's, and
#   - acctB's reply carries agentB's prefix and NOT agentA's.
#
# This exercises the REAL stack (no unit mocks):
#   - registerFull MULTIPLEX  → two NatsChannels, one per account
#   - single register route's JWT-aud→account DISPATCH → aud=acctA hits acctA's
#     channel.registerPeer (Cycle 2 C2 invariant), aud=acctB hits acctB's
#   - binding.account ROUTING → resolveAgentRoute(accountId) picks the bound agent
#
# Credentials ride the enrolled trust chain: ONE setupTrustChain() in the
# reference enrollment-server issues real per-account device-flow NATS creds and
# registry-pinned agent keys (no dev identity), so each account admits its peer
# via the register hop just like production. This isolates the
# multiplex+dispatch+routing layer on the same trust chain the other harnesses
# use. The single-account CONFIG-TIME channels-add enrollment path is covered by
# run-enrolled-transport.sh and run-all-real.sh.
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
ISSUER_PORT=3971
ECHO_A_PORT=18906
ECHO_B_PORT=18907

TENANT=default-tenant
AGENT_A=agentA
AGENT_B=agentB
ACCT_A=accta            # canonical (lowercased) account ids — see account-config canonicalize
ACCT_B=acctb
PEER_A=web-accta-peer
PEER_B=web-acctb-peer
ISS="http://127.0.0.1:$ISSUER_PORT"
# P1-1: operator actions (approve/deny/revoke) are bearer-guarded, fail-closed 503.
ENROLLMENT_ADMIN_TOKEN="${ENROLLMENT_ADMIN_TOKEN:-local-e2e-admin-token}"
ECHO_A_PREFIX="AGENT-A-ECHO: "
ECHO_B_PREFIX="AGENT-B-ECHO: "

NATS_PID=""; ISSUER_PID=""; ECHO_A_PID=""; ECHO_B_PID=""; GW_PID=""; ADD_PID=""

cleanup() {
  echo "[run-two-acct] cleanup…"
  [ -n "$GW_PID" ]     && kill "$GW_PID"     2>/dev/null || true
  [ -n "$ECHO_A_PID" ] && kill "$ECHO_A_PID" 2>/dev/null || true
  [ -n "$ECHO_B_PID" ] && kill "$ECHO_B_PID" 2>/dev/null || true
  [ -n "$NATS_PID" ]   && kill "$NATS_PID"   2>/dev/null || true
  [ -n "$ISSUER_PID" ] && kill "$ISSUER_PID" 2>/dev/null || true
  [ -n "$ADD_PID" ]    && kill "$ADD_PID"    2>/dev/null || true
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

# 1. One trust chain supplies the operator, enrollment credentials, JWKS, and pins.
PORT="$ISSUER_PORT" SAAS_BASE_URL="$ISS" SAAS_ISSUER="$ISS" \
NATS_URL="ws://127.0.0.1:$NATS_WS" NATS_CONFIG_OUT="$OCH" ENABLE_TEST_ROUTES=1 \
ENROLLMENT_ADMIN_TOKEN="$ENROLLMENT_ADMIN_TOKEN" \
POLL_INTERVAL_SECONDS=1 node --import tsx \
  "$REPO/packages/saas/reference/enrollment-server.ts" >"$OCH/issuer.log" 2>&1 &
ISSUER_PID=$!
for i in $(seq 1 120); do
  curl -fsS "$ISS/.well-known/jwks.json" >/dev/null 2>&1 && [ -f "$OCH/resolver.json" ] && break
  kill -0 "$ISSUER_PID" 2>/dev/null || { cat "$OCH/issuer.log"; exit 2; }
  sleep 0.25
done
OCH="$OCH" NATS_TCP="$NATS_TCP" NATS_WS="$NATS_WS" node -e '
  const fs=require("fs"), d=process.env.OCH;
  const r=JSON.parse(fs.readFileSync(d+"/resolver.json","utf8"));
  const preload=Object.entries(r).map(([k,v])=>`  ${k}: "${v}"`).join("\n");
  fs.writeFileSync(d+"/nats.conf", `port: ${process.env.NATS_TCP}\nwebsocket { port: ${process.env.NATS_WS}, no_tls: true }\noperator: "${d}/operator.jwt"\nresolver: MEMORY\nresolver_preload: {\n${preload}\n}\n`);
'
nats-server -c "$OCH/nats.conf" >"$OCH/nats.log" 2>&1 &
NATS_PID=$!
echo "[run-two-acct] nats-server pid=$NATS_PID (ws://127.0.0.1:$NATS_WS)"
for i in $(seq 1 120); do
  grep -q "Server is ready" "$OCH/nats.log" 2>/dev/null && break
  kill -0 "$NATS_PID" 2>/dev/null || { echo "nats died"; cat "$OCH/nats.log"; exit 2; }
  sleep 0.25
done

# 3. TWO echo model servers — distinct prefixes make the agents distinguishable.
ECHO_PREFIX="$ECHO_A_PREFIX" node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_A_PORT" >"$OCH/echoA.log" 2>&1 &
ECHO_A_PID=$!
ECHO_PREFIX="$ECHO_B_PREFIX" node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_B_PORT" >"$OCH/echoB.log" 2>&1 &
ECHO_B_PID=$!
echo "[run-two-acct] echo servers: A pid=$ECHO_A_PID ($ECHO_A_PORT), B pid=$ECHO_B_PID ($ECHO_B_PORT)"

# 4. Isolated config: TWO providers + TWO agents + TWO webchannel accounts + TWO
#    account-scoped bindings (the persisted form of `agents bind --bind
#    webchannel:<acct> --agent <agent>`). Per-account auth.jwt audience = the
#    account id itself (the wire identity); the handling agent is decoupled and
#    selected ONLY via the bindings below — no per-account config agentId.
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
          "auth": { "strategy": "jwt", "jwt": {
            "jwksUrl": "$ISS/.well-known/jwks.json", "issuer": "$ISS", "audience": "$ACCT_A" } },
          "dmSecurity": "allowlist",
          "allowFrom": ["$PEER_A"]
        },
        "$ACCT_B": {
          "tenant": "$TENANT",
          "auth": { "strategy": "jwt", "jwt": {
            "jwksUrl": "$ISS/.well-known/jwks.json", "issuer": "$ISS", "audience": "$ACCT_B" } },
          "dmSecurity": "allowlist",
          "allowFrom": ["$PEER_B"]
        }
      }
    }
  }
}
JSON
echo "[run-two-acct] wrote $OCH/.openclaw/openclaw.json (2 accounts, 2 agents, 2 bindings)"

enroll_account() {
  local acct="$1" log="$OCH/channels-add-$1.log" code=""
  HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
    "$REPO/node_modules/.bin/openclaw" channels add --channel webchannel --account "$acct" \
      --base-url "$ISS" --url "$TENANT" >"$log" 2>&1 &
  ADD_PID=$!
  for i in $(seq 1 240); do
    code="$(grep -oE 'User code: [A-Z]{4}-[A-Z]{4}' "$log" 2>/dev/null | head -1 | awk '{print $3}' || true)"
    [ -n "$code" ] && break
    kill -0 "$ADD_PID" 2>/dev/null || { cat "$log"; exit 2; }
    sleep 0.25
  done
  [ -n "$code" ] || { cat "$log"; exit 2; }
  curl -fsS -X POST "$ISS/approve" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $ENROLLMENT_ADMIN_TOKEN" \
    -d "{\"user_code\":\"$code\"}" >/dev/null
  wait "$ADD_PID" || { cat "$log"; exit 2; }
  ADD_PID=""
  [ -f "$OCH/.openclaw-webchannel/$acct/credentials.json" ] || exit 2
}
enroll_account "$ACCT_A"
enroll_account "$ACCT_B"

# 5. Boot ONE gateway serving BOTH enrolled accounts.
OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  HOME="$OCH" WEBCHANNEL_NATS_URL=ws://127.0.0.1:$NATS_WS \
  WEBCHANNEL_GW_URL=http://127.0.0.1:$GW_PORT \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$GW_PORT" --force \
  >"$OCH/gateway.log" 2>&1 &
GW_PID=$!
echo "[run-two-acct] gateway pid=$GW_PID — waiting for structured multiplex readiness (2 accounts)…"
for i in $(seq 1 120); do
  # Aggregate readiness requires both configured accounts to be serving.
  if grep -Eq "event=webchannel\.account_aggregate generation=[^ ]+ state=complete servingCount=2 totalCount=2" "$OCH/gateway.log" 2>/dev/null; then
    echo "[run-two-acct] gateway ready:"
    grep -E "account \"(${ACCT_A}|${ACCT_B})\" ✓ encrypted NATS channel|event=webchannel\.account_aggregate" "$OCH/gateway.log" | sed 's/^/  /' || true
    break
  fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "[run-two-acct] gateway died early — log:"; cat "$OCH/gateway.log"; exit 2
  fi
  sleep 0.5
  if [ "$i" -eq 120 ]; then
    echo "[run-two-acct] TIMEOUT waiting for structured multiplex readiness — log:"; cat "$OCH/gateway.log"; exit 2
  fi
done

# Sanity: BOTH accounts must have built a channel (2-of-2 serving).
if ! grep -q "account \"$ACCT_A\" ✓ encrypted NATS channel" "$OCH/gateway.log" 2>/dev/null \
   || ! grep -q "account \"$ACCT_B\" ✓ encrypted NATS channel" "$OCH/gateway.log" 2>/dev/null; then
  echo "[run-two-acct] FAIL — both accounts did not build channels. gateway log:"; cat "$OCH/gateway.log"; exit 2
fi

run_account() {
  # The wire identity is the ACCOUNT id (= JWT aud); the handling agent is chosen
  # by the binding (webchannel:<acct> → <agent>), NOT carried on the wire.
  local label="$1" peer="$2" acct="$3" expect="$4" forbid="$5"
  echo "[run-two-acct] driving $label (peer=$peer, account=$acct)…"
  set +e
  WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
  WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
  WEBCHANNEL_ISSUER_URL="$ISS" WEBCHANNEL_TENANT="$TENANT" \
  WEBCHANNEL_PEER_ID="$peer" WEBCHANNEL_ACCOUNT_ID="$acct" \
  EXPECT_PREFIX="$expect" FORBID_PREFIX="$forbid" \
  SEND_MESSAGE="hello from $label" \
    node --import tsx "$REPO/e2e/local/two-account-isolation-roundtrip.ts"
  local rc=$?
  set -e
  return $rc
}

# 6. Drive acctA → MUST reach agentA (A prefix), MUST NOT reach agentB (no B prefix).
run_account "acctA" "$PEER_A" "$ACCT_A" "$ECHO_A_PREFIX" "$ECHO_B_PREFIX" || {
  echo "[run-two-acct] acctA isolation FAILED — gateway log tail:"; tail -40 "$OCH/gateway.log"; exit 3
}
# 7. Drive acctB → MUST reach agentB (B prefix), MUST NOT reach agentA (no A prefix).
run_account "acctB" "$PEER_B" "$ACCT_B" "$ECHO_B_PREFIX" "$ECHO_A_PREFIX" || {
  echo "[run-two-acct] acctB isolation FAILED — gateway log tail:"; tail -40 "$OCH/gateway.log"; exit 3
}

echo "[run-two-acct] ✓ 2-ACCOUNT ROUTING ISOLATION PROVEN (AC6): acctA→agentA, acctB→agentB, no cross-leak"
exit 0
