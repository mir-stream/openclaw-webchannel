#!/usr/bin/env bash
# P0-3 S4 — Mode C: EXTERNAL (managed / Synadia-shape) NATS account E2E + N1-N3.
#
# Proves that SaaS-minted, signing-key-signed, `issuer_account`-stamped creds
# actually CONNECT to a resolver-backed nats-server (the existing
# external-nats-account.test.ts only checks JWT shape). Topology:
#   - mint-external-account.ts synthesizes operator + account (with a delegated
#     signing key) JWTs;
#   - nats-server runs with `operator:` + `resolver: MEMORY` + `resolver_preload`
#     of that account;
#   - the reference SaaS boots in EXTERNAL mode (NATS_ACCOUNT_SIGNING_SEED +
#     NATS_ACCOUNT_ID), so every cred it mints is signed by the signing key on
#     behalf of the account identity;
#   - two accounts enroll, the gateway consumes those external creds and CONNECTS,
#     a real browser round-trips, and the shared N1-N3 adversarial legs run.
#
# NO downgrade: if the real resolver refuses the creds, Mode C BLOCKS (plan §D5).
# Real NGS is out of CI scope (creds secrets). Isolated OPENCLAW_HOME; distinct
# ports; self-cleaning (trap with the N3 SIGSTOP fail-safe).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OCH=/tmp/oc-external-acct-e2e

GW_PORT=19599
NATS_WS=18922
NATS_TCP=14922
ISSUER_PORT=3991
ECHO_PORT=18909
PAGE_PORT=19695

TENANT=default-tenant
ACCT_A=accta
ACCT_B=acctb
PEER_A=web-ext-peer
ISS="http://127.0.0.1:$ISSUER_PORT"
ENROLLMENT_ADMIN_TOKEN="${ENROLLMENT_ADMIN_TOKEN:-local-e2e-admin-token}"

NATS_PID=""; ISSUER_PID=""; ECHO_PID=""; GW_PID=""; ADD_PID=""
GW_STOPPED=0

# shellcheck source=lib-negative-legs.sh
source "$REPO/e2e/local/lib-negative-legs.sh"

cleanup() {
  echo "[run-ext] cleanup…"
  if [ -n "$GW_PID" ]; then
    kill -CONT "$GW_PID" 2>/dev/null || true
    kill "$GW_PID" 2>/dev/null || true
    kill -9 "$GW_PID" 2>/dev/null || true
  fi
  [ -n "$ECHO_PID" ]   && kill "$ECHO_PID"   2>/dev/null || true
  [ -n "$NATS_PID" ]   && kill "$NATS_PID"   2>/dev/null || true
  [ -n "$ISSUER_PID" ] && kill "$ISSUER_PID" 2>/dev/null || true
  [ -n "$ADD_PID" ]    && kill "$ADD_PID"    2>/dev/null || true
  pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
  pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
  pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
}
# Signal traps (INT/TERM) convert to a normal exit so the EXIT trap runs the N3
# SIGSTOP kill -CONT fail-safe exactly once: a CI cancel (e2e-gate concurrency
# cancel-in-progress) landing in the N3 STOP window must still resume the gateway.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
# A STOPPED gateway (a previous run killed mid-N3) ignores TERM; CONT then KILL is
# the only self-heal — otherwise the orphan keeps holding $GW_PORT and the next
# run EADDRINUSEs on every subsequent run until a manual kill -9.
pkill -CONT -f "gateway --port $GW_PORT" 2>/dev/null || true
pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
pkill -9 -f "gateway --port $GW_PORT" 2>/dev/null || true
rm -rf "$OCH"
mkdir -p "$OCH/.openclaw"

# 0. Build plugin dist from current src (see run-byo-static.sh for the rationale).
echo "[run-ext] building plugin dist from current src…"
( cd "$REPO/packages/plugin" && npm run build ) >"$OCH/plugin-build.log" 2>&1 \
  || { echo "[run-ext] plugin build FAILED"; cat "$OCH/plugin-build.log"; exit 2; }

# 1. Synthesize the external operator/account and write the resolver nats.conf.
EXT="$(node --import tsx "$REPO/e2e/local/mint-external-account.ts")" || { echo "[run-ext] mint-external-account failed"; exit 2; }
OPERATOR_JWT="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).operatorJwt)' "$EXT")"
ACCOUNT_PUB="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).accountPublicKey)' "$EXT")"
ACCOUNT_JWT="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).accountJwt)' "$EXT")"
SIGNING_SEED="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).signingSeed)' "$EXT")"
[ -n "$OPERATOR_JWT" ] && [ -n "$ACCOUNT_PUB" ] && [ -n "$ACCOUNT_JWT" ] && [ -n "$SIGNING_SEED" ] \
  || { echo "[run-ext] external account material incomplete"; exit 2; }
printf '%s' "$OPERATOR_JWT" > "$OCH/operator.jwt"
OCH="$OCH" NATS_TCP="$NATS_TCP" NATS_WS="$NATS_WS" ACCOUNT_PUB="$ACCOUNT_PUB" ACCOUNT_JWT="$ACCOUNT_JWT" node -e '
  const fs=require("fs"), d=process.env.OCH;
  fs.writeFileSync(d+"/nats.conf",
    `port: ${process.env.NATS_TCP}\nwebsocket { port: ${process.env.NATS_WS}, no_tls: true }\n` +
    `operator: "${d}/operator.jwt"\nresolver: MEMORY\n` +
    `resolver_preload: {\n  ${process.env.ACCOUNT_PUB}: "${process.env.ACCOUNT_JWT}"\n}\n`);
'
nats-server -c "$OCH/nats.conf" >"$OCH/nats.log" 2>&1 &
NATS_PID=$!
for i in $(seq 1 120); do
  grep -q "Server is ready" "$OCH/nats.log" 2>/dev/null && break
  kill -0 "$NATS_PID" 2>/dev/null || { echo "[run-ext] nats died"; cat "$OCH/nats.log"; exit 2; }
  sleep 0.25
  [ "$i" -eq 120 ] && { echo "[run-ext] nats timeout"; cat "$OCH/nats.log"; exit 2; }
done
echo "[run-ext] ✓ resolver nats-server up (external account $ACCOUNT_PUB preloaded)"

# 2. Reference SaaS in EXTERNAL mode — mints signing-key-signed, issuer_account creds.
PORT="$ISSUER_PORT" SAAS_BASE_URL="$ISS" SAAS_ISSUER="$ISS" \
NATS_URL="ws://127.0.0.1:$NATS_WS" ENABLE_TEST_ROUTES=1 \
NATS_ACCOUNT_SIGNING_SEED="$SIGNING_SEED" NATS_ACCOUNT_ID="$ACCOUNT_PUB" \
ENROLLMENT_ADMIN_TOKEN="$ENROLLMENT_ADMIN_TOKEN" POLL_INTERVAL_SECONDS=1 \
  node --import tsx "$REPO/packages/saas/reference/enrollment-server.ts" >"$OCH/issuer.log" 2>&1 &
ISSUER_PID=$!
for i in $(seq 1 120); do
  curl -fsS "$ISS/.well-known/jwks.json" >/dev/null 2>&1 && break
  kill -0 "$ISSUER_PID" 2>/dev/null || { echo "[run-ext] issuer died"; cat "$OCH/issuer.log"; exit 2; }
  sleep 0.25
  [ "$i" -eq 120 ] && { echo "[run-ext] issuer timeout"; cat "$OCH/issuer.log"; exit 2; }
done
echo "[run-ext] ✓ reference SaaS up (EXTERNAL mode)"

# 3. Echo model server.
node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_PORT" >"$OCH/echo.log" 2>&1 &
ECHO_PID=$!

# 4. Config: TWO enrolled accounts (default enrolled mode — the gateway consumes
#    the external-account creds the SaaS delivers and CONNECTS to the resolver server).
cat > "$OCH/.openclaw/openclaw.json" <<JSON
{
  "gateway": { "mode": "local", "bind": "loopback" },
  "models": {
    "providers": {
      "echo-local": {
        "baseUrl": "http://127.0.0.1:$ECHO_PORT/v1",
        "api": "openai-completions",
        "models": [{ "id": "echo", "name": "Echo", "reasoning": false, "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000, "maxTokens": 8192 }]
      }
    }
  },
  "agents": { "defaults": { "model": { "primary": "echo-local/echo" }, "compaction": { "reserveTokensFloor": 20000 } } },
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
          "dmSecurity": "open"
        }
      }
    }
  }
}
JSON
echo "[run-ext] wrote config (2 enrolled accounts, external-account transport)"

enroll_account() {
  local acct="$1" log="$OCH/channels-add-$1.log" code=""
  HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
    "$REPO/node_modules/.bin/openclaw" channels add --channel webchannel --account "$acct" \
      --base-url "$ISS" --url "$TENANT" >"$log" 2>&1 &
  ADD_PID=$!
  for i in $(seq 1 240); do
    code="$(grep -oE 'User code: [A-Z]{4}-[A-Z]{4}' "$log" 2>/dev/null | head -1 | awk '{print $3}' || true)"
    [ -n "$code" ] && break
    kill -0 "$ADD_PID" 2>/dev/null || { echo "[run-ext] channels add $acct exited early"; cat "$log"; exit 2; }
    sleep 0.25
  done
  [ -n "$code" ] || { echo "[run-ext] no user_code for $acct"; cat "$log"; exit 2; }
  curl -fsS -X POST "$ISS/approve" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $ENROLLMENT_ADMIN_TOKEN" -d "{\"user_code\":\"$code\"}" >/dev/null
  wait "$ADD_PID" || { echo "[run-ext] channels add $acct failed"; cat "$log"; exit 2; }
  ADD_PID=""
  [ -f "$OCH/.openclaw-webchannel/$acct/credentials.json" ] || { echo "[run-ext] no creds for $acct"; exit 2; }
  echo "[run-ext] ✓ enrolled $acct (external-account creds)"
}
enroll_account "$ACCT_A"
enroll_account "$ACCT_B"

# 5. Boot the gateway — consumes the external-account enrolled creds and CONNECTS
#    to the resolver server. Registration success IS the external-connect proof.
HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
  WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$GW_PORT" --force \
  >"$OCH/gateway.log" 2>&1 &
GW_PID=$!
echo "[run-ext] gateway pid=$GW_PID — waiting for registration (external-account CONNECT)…"
for i in $(seq 1 240); do
  grep -q "\[webchannel\] ✓ NATS mode plugin registered" "$OCH/gateway.log" 2>/dev/null && break
  kill -0 "$GW_PID" 2>/dev/null || { echo "[run-ext] gateway died early"; cat "$OCH/gateway.log"; exit 2; }
  sleep 0.5
  [ "$i" -eq 240 ] && { echo "[run-ext] gateway timeout"; cat "$OCH/gateway.log"; exit 2; }
done
# Assert BOTH accounts connect via external-account creds (2-of-2 — a down ACCT_B
# must fail here, not only surface later via N2).
for a in "$ACCT_A" "$ACCT_B"; do
  if ! grep -q "account \"$a\" ✓ encrypted NATS channel" "$OCH/gateway.log" 2>/dev/null; then
    echo "[run-ext] FAIL — $a did not connect via external-account creds. gateway log:"; tail -40 "$OCH/gateway.log"; exit 3
  fi
done
echo "[run-ext] ✓ both external-account creds CONNECTED to the resolver nats-server (not just JWT-shape valid)"

# 6. Echo round-trip (real browser).
echo "[run-ext] driving the encrypted echo round-trip (Mode C, external account)…"
set +e
WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
WEBCHANNEL_ISSUER_URL="$ISS" \
WEBCHANNEL_TENANT="$TENANT" WEBCHANNEL_ACCOUNT_ID="$ACCT_A" WEBCHANNEL_PEER_ID="$PEER_A" \
WEBCHANNEL_PAGE_PORT="$PAGE_PORT" \
  node "$REPO/e2e/local/all-real.mjs"
ECHO_RC=$?
set -e
[ "$ECHO_RC" -ne 0 ] && { echo "[run-ext] echo round-trip FAILED (rc=$ECHO_RC) — gateway log tail:"; tail -40 "$OCH/gateway.log"; exit 3; }
echo "[run-ext] ✓ echo round-trip OK (Mode C)"

# 7. Shared adversarial suite N1-N3.
run_all_negative_legs || { echo "[run-ext] negative legs FAILED"; exit 3; }

echo "[run-ext] ✓✓ Mode C (external account) PROVEN: resolver CONNECT + echo + N1-N3"
exit 0
