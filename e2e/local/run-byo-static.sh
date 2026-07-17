#!/usr/bin/env bash
# P0-3 S4 — Mode B: STATIC (BYO-NATS) serving E2E + the shared adversarial suite.
#
# A BYO relay is a TRANSPORT choice, not an auth bypass. This harness proves it:
#   - TWO accounts are ENROLLED via `channels add` (the attested agent IDENTITY is
#     still required for every account — a static relay does not remove it);
#   - the gateway's NATS TRANSPORT comes from STATIC creds injected out-of-band
#     (WEBCHANNEL_NATS_USER_JWT/_SEED + credentials.mode:"static"), NOT the enrolled
#     device-flow bundle. The static agent creds are obtained from the reference
#     `/test/nats-user` role:"agent" route (TTL-bounded, P0-3 R5-2) — the valid
#     equivalent of an operator minting agent creds with nsc, without exporting the
#     account seed;
#   - a real browser then completes an encrypted echo round-trip, and the shared
#     N1-N3 adversarial legs run against this static gateway;
#   - a fail-closed leg proves a static account WITHOUT enrollment is skipped
#     (identity-missing), never served.
#
# ONE tenant-wide agent cred serves BOTH accounts (same tenant subtree). Isolated
# OPENCLAW_HOME=/tmp/oc-byo-static-e2e; distinct ports; self-cleaning (trap).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OCH=/tmp/oc-byo-static-e2e

# Distinct ports — no collision with the other harnesses.
GW_PORT=19499
NATS_WS=18822
NATS_TCP=14822
ISSUER_PORT=3981
ECHO_PORT=18908
PAGE_PORT=19595

TENANT=default-tenant
ACCT_A=accta
ACCT_B=acctb
ACCT_STATIC_NOENROLL=acctnoenroll
PEER_A=web-byo-peer
ISS="http://127.0.0.1:$ISSUER_PORT"
ENROLLMENT_ADMIN_TOKEN="${ENROLLMENT_ADMIN_TOKEN:-local-e2e-admin-token}"

NATS_PID=""; ISSUER_PID=""; ECHO_PID=""; GW_PID=""; ADD_PID=""
GW_STOPPED=0

# Shared negative-legs suite (N1-N3) + the N3 SIGSTOP fail-safe helpers.
# shellcheck source=lib-negative-legs.sh
source "$REPO/e2e/local/lib-negative-legs.sh"

cleanup() {
  echo "[run-byo] cleanup…"
  # N3 fail-safe: a SIGSTOPped gateway ignores TERM/pkill. Resume it UNCONDITIONALLY
  # before any TERM (never gated on GW_STOPPED — closes the STOP-before-flag race),
  # then TERM, then a SIGKILL fallback.
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

# Pre-clean.
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

# 0. Build the plugin dist from CURRENT src. The gateway loads the plugin via the
#    package.json `openclaw.extensions` (./dist/index-nats.js), so a stale dist
#    would run pre-P0-3 code (the removed static-creds throw) — rebuild it so the
#    static (BYO) path under test is the current source. dist is gitignored.
echo "[run-byo] building plugin dist from current src…"
( cd "$REPO/packages/plugin" && npm run build ) >"$OCH/plugin-build.log" 2>&1 \
  || { echo "[run-byo] plugin build FAILED"; cat "$OCH/plugin-build.log"; exit 2; }
echo "[run-byo] ✓ plugin dist built"

# 1. Trust chain / issuer (test routes on) + JWT-auth nats-server.
PORT="$ISSUER_PORT" SAAS_BASE_URL="$ISS" SAAS_ISSUER="$ISS" \
NATS_URL="ws://127.0.0.1:$NATS_WS" NATS_CONFIG_OUT="$OCH" ENABLE_TEST_ROUTES=1 \
ENROLLMENT_ADMIN_TOKEN="$ENROLLMENT_ADMIN_TOKEN" POLL_INTERVAL_SECONDS=1 \
  node --import tsx "$REPO/packages/saas/reference/enrollment-server.ts" >"$OCH/issuer.log" 2>&1 &
ISSUER_PID=$!
for i in $(seq 1 120); do
  curl -fsS "$ISS/.well-known/jwks.json" >/dev/null 2>&1 && [ -f "$OCH/resolver.json" ] && break
  kill -0 "$ISSUER_PID" 2>/dev/null || { echo "[run-byo] issuer died"; cat "$OCH/issuer.log"; exit 2; }
  sleep 0.25
  [ "$i" -eq 120 ] && { echo "[run-byo] issuer timeout"; cat "$OCH/issuer.log"; exit 2; }
done
OCH="$OCH" NATS_TCP="$NATS_TCP" NATS_WS="$NATS_WS" node -e '
  const fs=require("fs"), d=process.env.OCH;
  const r=JSON.parse(fs.readFileSync(d+"/resolver.json","utf8"));
  const preload=Object.entries(r).map(([k,v])=>`  ${k}: "${v}"`).join("\n");
  fs.writeFileSync(d+"/nats.conf", `port: ${process.env.NATS_TCP}\nwebsocket { port: ${process.env.NATS_WS}, no_tls: true }\noperator: "${d}/operator.jwt"\nresolver: MEMORY\nresolver_preload: {\n${preload}\n}\n`);
'
nats-server -c "$OCH/nats.conf" >"$OCH/nats.log" 2>&1 &
NATS_PID=$!
for i in $(seq 1 120); do
  grep -q "Server is ready" "$OCH/nats.log" 2>/dev/null && break
  kill -0 "$NATS_PID" 2>/dev/null || { echo "[run-byo] nats died"; cat "$OCH/nats.log"; exit 2; }
  sleep 0.25
  [ "$i" -eq 120 ] && { echo "[run-byo] nats timeout"; cat "$OCH/nats.log"; exit 2; }
done
echo "[run-byo] issuer + nats-server up"

# 2. Echo model server.
node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_PORT" >"$OCH/echo.log" 2>&1 &
ECHO_PID=$!

# 3. Config: TWO enrolled/static accounts + ONE static-but-unenrolled account
#    (the fail-closed leg). All under credentials.mode:"static".
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
          "nats": { "credentials": { "mode": "static" } },
          "auth": { "strategy": "jwt", "jwt": {
            "jwksUrl": "$ISS/.well-known/jwks.json", "issuer": "$ISS", "audience": "$ACCT_A" } },
          "dmSecurity": "allowlist",
          "allowFrom": ["$PEER_A"]
        },
        "$ACCT_B": {
          "tenant": "$TENANT",
          "nats": { "credentials": { "mode": "static" } },
          "auth": { "strategy": "jwt", "jwt": {
            "jwksUrl": "$ISS/.well-known/jwks.json", "issuer": "$ISS", "audience": "$ACCT_B" } },
          "dmSecurity": "open"
        },
        "$ACCT_STATIC_NOENROLL": {
          "tenant": "$TENANT",
          "nats": { "credentials": { "mode": "static" } },
          "auth": { "strategy": "jwt", "jwt": {
            "jwksUrl": "$ISS/.well-known/jwks.json", "issuer": "$ISS", "audience": "$ACCT_STATIC_NOENROLL" } }
        }
      }
    }
  }
}
JSON
echo "[run-byo] wrote config (2 enrolled/static accounts + 1 static-no-enroll fail-closed account)"

# 4. Enroll ACCT_A + ACCT_B for IDENTITY (device flow). The static twist is that
#    the gateway will NOT use the enrolled transport creds — only the persisted
#    identityKey + issuer — dialing instead with the injected static agent creds.
enroll_account() {
  local acct="$1" log="$OCH/channels-add-$1.log" code=""
  HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
    "$REPO/node_modules/.bin/openclaw" channels add --channel webchannel --account "$acct" \
      --base-url "$ISS" --url "$TENANT" >"$log" 2>&1 &
  ADD_PID=$!
  for i in $(seq 1 240); do
    code="$(grep -oE 'User code: [A-Z]{4}-[A-Z]{4}' "$log" 2>/dev/null | head -1 | awk '{print $3}' || true)"
    [ -n "$code" ] && break
    kill -0 "$ADD_PID" 2>/dev/null || { echo "[run-byo] channels add $acct exited early"; cat "$log"; exit 2; }
    sleep 0.25
  done
  [ -n "$code" ] || { echo "[run-byo] no user_code for $acct"; cat "$log"; exit 2; }
  curl -fsS -X POST "$ISS/approve" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $ENROLLMENT_ADMIN_TOKEN" -d "{\"user_code\":\"$code\"}" >/dev/null
  wait "$ADD_PID" || { echo "[run-byo] channels add $acct failed"; cat "$log"; exit 2; }
  ADD_PID=""
  [ -f "$OCH/.openclaw-webchannel/$acct/credentials.json" ] || { echo "[run-byo] no creds for $acct"; exit 2; }
  echo "[run-byo] ✓ enrolled identity for $acct"
}
enroll_account "$ACCT_A"
enroll_account "$ACCT_B"
# NOTE: ACCT_STATIC_NOENROLL is deliberately NOT enrolled (the fail-closed leg).
# Re-assert mode:static (channels add rewrites the nats block).
node -e '
  const fs=require("fs"), p=process.argv[1];
  const cfg=JSON.parse(fs.readFileSync(p,"utf8"));
  for (const a of Object.values(cfg.channels.webchannel.accounts)) {
    a.nats = { ...(a.nats||{}), admission: "register-hop", credentials: { mode: "static" } };
  }
  fs.writeFileSync(p, JSON.stringify(cfg,null,2));
' "$OCH/.openclaw/openclaw.json"

# 5. Mint the STATIC agent creds OUT-OF-BAND (TTL-bounded /test/nats-user agent).
#    ONE tenant-wide agent cred serves BOTH accounts' subtrees.
AGENT_CREDS="$(curl -fsS -X POST "$ISS/test/nats-user" -H 'Content-Type: application/json' \
  -d "{\"tenant\":\"$TENANT\",\"role\":\"agent\"}")"
STATIC_JWT="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).userJwt)' "$AGENT_CREDS")"
STATIC_SEED="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).userSeed)' "$AGENT_CREDS")"
[ -n "$STATIC_JWT" ] && [ -n "$STATIC_SEED" ] || { echo "[run-byo] failed to mint static agent creds: $AGENT_CREDS"; exit 2; }
echo "[run-byo] ✓ minted TTL-bounded static agent creds (tenant-wide, out-of-band)"

# 6. Boot the gateway with STATIC transport (env creds + mode:static). No enrolled
#    transport is consumed — identity comes from the persisted identityKey.
HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
  WEBCHANNEL_NATS_USER_JWT="$STATIC_JWT" \
  WEBCHANNEL_NATS_USER_SEED="$STATIC_SEED" \
  WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$GW_PORT" --force \
  >"$OCH/gateway.log" 2>&1 &
GW_PID=$!
echo "[run-byo] gateway pid=$GW_PID (STATIC source) — waiting for registration…"
for i in $(seq 1 240); do
  grep -q "\[webchannel\] ✓ NATS mode plugin registered" "$OCH/gateway.log" 2>/dev/null && break
  kill -0 "$GW_PID" 2>/dev/null || { echo "[run-byo] gateway died early"; cat "$OCH/gateway.log"; exit 2; }
  sleep 0.5
  [ "$i" -eq 240 ] && { echo "[run-byo] gateway timeout"; cat "$OCH/gateway.log"; exit 2; }
done

# 6a. Assert BOTH enrolled accounts serve via the STATIC source (2-of-2 — a down
#     ACCT_B must fail here, not only surface later via N2).
for a in "$ACCT_A" "$ACCT_B"; do
  if ! grep -qE "account \"$a\" credential source: static" "$OCH/gateway.log" 2>/dev/null; then
    echo "[run-byo] FAIL — $a did not serve via the static source. gateway log:"; grep -i "credential source\|static\|$a" "$OCH/gateway.log" | tail -20; exit 3
  fi
  # `credential source: static` is logged BEFORE the identityKey guard in
  # packages/plugin/index-nats.ts, so 6a alone would pass even if the account was
  # skipped before the channel was built. Also gate on the per-account channel line
  # (mirrors the same gate in run-external-account.sh / run-all-real.sh) for 2-of-2 parity.
  if ! grep -q "account \"$a\" ✓ encrypted NATS channel" "$OCH/gateway.log" 2>/dev/null; then
    echo "[run-byo] FAIL — $a logged static source but built NO encrypted NATS channel. gateway log:"; tail -40 "$OCH/gateway.log"; exit 3
  fi
done
echo "[run-byo] ✓ both enrolled accounts serving via STATIC (BYO-NATS) transport"

# 6b. Fail-closed leg: the static-but-unenrolled account is skipped (identity-missing).
#     Match the identity-missing branch's UNIQUE phrase ("uses static (BYO-NATS)
#     credentials but has NO") — NOT the generic "refusing to serve", which the
#     shared-audience skip (index-nats.ts:380) and the F2 backstop (:522) also emit.
#     A future regression that skips this account for a DIFFERENT reason must FAIL
#     this leg, not silently match a generic string.
if ! grep -qF "account \"$ACCT_STATIC_NOENROLL\" uses static (BYO-NATS) credentials but has NO" "$OCH/gateway.log" 2>/dev/null; then
  echo "[run-byo] FAIL — static account $ACCT_STATIC_NOENROLL was NOT identity-missing skipped. gateway log:"; grep -i "$ACCT_STATIC_NOENROLL" "$OCH/gateway.log" | tail -20; exit 3
fi
echo "[run-byo] ✓ fail-closed: static-but-unenrolled account skipped (identity-missing)"

# 7. Echo round-trip (real browser, production client) against the static gateway.
echo "[run-byo] driving the encrypted echo round-trip (Mode B, static gateway)…"
set +e
WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
WEBCHANNEL_ISSUER_URL="$ISS" \
WEBCHANNEL_TENANT="$TENANT" WEBCHANNEL_ACCOUNT_ID="$ACCT_A" WEBCHANNEL_PEER_ID="$PEER_A" \
WEBCHANNEL_PAGE_PORT="$PAGE_PORT" \
  node "$REPO/e2e/local/all-real.mjs"
ECHO_RC=$?
set -e
[ "$ECHO_RC" -ne 0 ] && { echo "[run-byo] echo round-trip FAILED (rc=$ECHO_RC) — gateway log tail:"; tail -40 "$OCH/gateway.log"; exit 3; }
echo "[run-byo] ✓ echo round-trip OK (Mode B)"

# 8. Shared adversarial suite N1-N3 (N2 uses accountA-token → accountB.register).
run_all_negative_legs || { echo "[run-byo] negative legs FAILED"; exit 3; }

echo "[run-byo] ✓✓ Mode B (static BYO-NATS) PROVEN: enrolled-identity static serving + echo + N1-N3 + fail-closed skip"
exit 0
