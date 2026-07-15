#!/usr/bin/env bash
# Phase 5 aside — "one gateway, many accounts" (process-level tenancy).
#
# Boots ONE openclaw gateway (port 19599) whose config lists TWO webchannel
# accounts — team-sales + team-support — enrolls BOTH under the same
# OPENCLAW_HOME, and points both accounts' rendezvous at that single gateway. The
# plugin's registerFull multiplex builds one NatsChannel per account; the single
# register route dispatches each browser to the right account by the JWT `aud`.
#
# Story: distinct from scene ②'s "another machine per agent" — here ONE gateway
# process serves several accounts, and DIFFERENT users land on DIFFERENT accounts
# (alice → team-sales, bob → team-support) through the SAME openclaw.
#
# Run in a SECOND terminal while ./demo/run.sh is up. Touches only its own
# OPENCLAW_HOME + port 19599. Pass --auto-approve to approve + grant unattended.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OCH=/tmp/oc-demo
SAAS_PORT=3961
NATS_WS=18722
SAAS_URL="http://127.0.0.1:$SAAS_PORT"
TENANT=demo-tenant
ISSUER="https://saas.local/demo-issuer"

PORT=19599
HOME_DIR="$OCH/multiplex"
ACCOUNTS=(team-sales team-support)
# Which seeded user each account is granted to (index-aligned with ACCOUNTS).
GRANTEES=(alice bob)

AUTO_APPROVE=0
[ "${1:-}" = "--auto-approve" ] && AUTO_APPROVE=1

UUID_ALICE="11111111-1111-4111-8111-111111111111"
UUID_BOB="22222222-2222-4222-8222-222222222222"
UUID_ADMIN="99999999-9999-4999-8999-999999999999"

curl -fsS "$SAAS_URL/.well-known/jwks.json" >/dev/null 2>&1 \
  || { echo "[multiplex] demo SaaS not reachable at $SAAS_URL — start ./demo/run.sh first"; exit 1; }
[ -f "$OCH/operator.jwt" ] || { echo "[multiplex] $OCH/operator.jwt missing — is the demo running?"; exit 1; }

GW_PID=""
cleanup() {
  echo ""
  echo "[multiplex] tearing down the multiplex gateway…"
  [ -n "$GW_PID" ] && kill "$GW_PID" 2>/dev/null || true
  pkill -f "gateway --port $PORT" 2>/dev/null || true
}
trap cleanup EXIT

pkill -f "gateway --port $PORT" 2>/dev/null || true
rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR/.openclaw"

# Provider + primary model must match the running demo (echo unless a real key).
if [ -n "${ZAI_API_KEY:-}" ]; then
  ZAI_BASE_URL="${ZAI_BASE_URL:-https://api.z.ai/api/coding/paas/v4}"; ZAI_MODEL="${ZAI_MODEL:-glm-4.6}"
  PROVIDER_BLOCK="\"zai\": { \"baseUrl\": \"$ZAI_BASE_URL\", \"api\": \"openai-completions\", \"apiKey\": \"$ZAI_API_KEY\", \"models\": [{ \"id\": \"$ZAI_MODEL\", \"name\": \"GLM\", \"reasoning\": false, \"input\": [\"text\"], \"cost\": { \"input\": 0, \"output\": 0, \"cacheRead\": 0, \"cacheWrite\": 0 }, \"contextWindow\": 200000, \"maxTokens\": 8192 }] }"
  PRIMARY_MODEL="zai/$ZAI_MODEL"
else
  PROVIDER_BLOCK="\"echo-local\": { \"baseUrl\": \"http://127.0.0.1:18905/v1\", \"api\": \"openai-completions\", \"models\": [{ \"id\": \"echo\", \"name\": \"Echo\", \"reasoning\": false, \"input\": [\"text\"], \"cost\": { \"input\": 0, \"output\": 0, \"cacheRead\": 0, \"cacheWrite\": 0 }, \"contextWindow\": 200000, \"maxTokens\": 8192 }] }"
  PRIMARY_MODEL="echo-local/echo"
fi

# Config with BOTH accounts under ONE gateway (each its own jwt.audience = its id).
ACCT_BLOCKS=""
for acct in "${ACCOUNTS[@]}"; do
  [ -n "$ACCT_BLOCKS" ] && ACCT_BLOCKS="$ACCT_BLOCKS,"
  ACCT_BLOCKS="$ACCT_BLOCKS
        \"$acct\": {
          \"tenant\": \"$TENANT\",
          \"auth\": { \"strategy\": \"jwt\", \"jwt\": {
            \"jwksUrl\": \"$SAAS_URL/.well-known/jwks.json\",
            \"issuer\": \"$ISSUER\",
            \"audience\": \"$acct\"
          } },
          \"dmSecurity\": \"allowlist\",
          \"allowFrom\": [\"$UUID_ALICE\", \"$UUID_BOB\", \"$UUID_ADMIN\"]
        }"
done

cat > "$HOME_DIR/.openclaw/openclaw.json" <<JSON
{
  "gateway": { "mode": "local", "bind": "loopback" },
  "models": { "providers": { $PROVIDER_BLOCK } },
  "agents": { "defaults": { "model": { "primary": "$PRIMARY_MODEL" }, "compaction": { "reserveTokensFloor": 20000 } } },
  "plugins": {
    "load": { "paths": ["$REPO/packages/plugin"] },
    "allow": ["webchannel"],
    "entries": { "webchannel": { "enabled": true } }
  },
  "channels": {
    "webchannel": {
      "history": { "enabled": true },
      "execApprovals": { "enabled": true, "approvers": ["$UUID_ALICE", "$UUID_BOB", "$UUID_ADMIN"] },
      "accounts": { $ACCT_BLOCKS
      }
    }
  }
}
JSON

# Admin session (approvals + grants + rendezvous registration).
curl -fsS -c "$OCH/multiplex.jar" -X POST "$SAAS_URL/login" \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"demo"}' >/dev/null

echo ""
echo "  ┌─ ONE gateway, MANY accounts ──────────────────────────────────────"
echo "  │ enrolling ${ACCOUNTS[*]} under a single OPENCLAW_HOME, one gateway :$PORT"
echo "  └───────────────────────────────────────────────────────────────────"

# Enroll EACH account under the SAME home (each channels add blocks until approved).
for acct in "${ACCOUNTS[@]}"; do
  addlog="$HOME_DIR/channels-add-$acct.log"
  HOME="$HOME_DIR" OPENCLAW_HOME="$HOME_DIR" OPENCLAW_DISABLE_BONJOUR=1 \
    "$REPO/node_modules/.bin/openclaw" channels add --channel webchannel --account "$acct" \
      --base-url "$SAAS_URL" --url "$TENANT" >"$addlog" 2>&1 &
  add_pid=$!

  user_code=""
  for i in $(seq 1 240); do
    user_code="$(grep -oE 'User code: [A-Z]{4}-[A-Z]{4}' "$addlog" 2>/dev/null | head -1 | awk '{print $3}' || true)"
    [ -n "$user_code" ] && break
    kill -0 "$add_pid" 2>/dev/null || { echo "[multiplex] $acct channels add exited early:"; cat "$addlog"; exit 2; }
    sleep 0.25
  done
  [ -z "$user_code" ] && { echo "[multiplex] $acct TIMEOUT waiting for user_code"; cat "$addlog"; exit 2; }

  echo "  🔔 $acct enrollment '$user_code' pending"
  if [ "$AUTO_APPROVE" = 1 ]; then
    curl -fsS -b "$OCH/multiplex.jar" -X POST "$SAAS_URL/admin/enrollments/$user_code/approve" >/dev/null || true
    echo "     → approved (--auto-approve)"
  else
    echo "     → approve it in the admin panel at $SAAS_URL (log in as admin)"
  fi

  set +e; wait "$add_pid"; rc=$?; set -e
  [ "$rc" -ne 0 ] && { echo "[multiplex] $acct enrollment did not complete (denied/expired):"; tail -8 "$addlog"; exit 2; }
  [ -f "$HOME_DIR/.openclaw-webchannel/$acct/credentials.json" ] || { echo "[multiplex] $acct creds not persisted"; exit 2; }
  # Re-assert register-hop admission (setup adapter may write admission:register-hop).
  node -e '
    const fs = require("fs"); const p = process.argv[1], acct = process.argv[2];
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    const a = cfg.channels.webchannel.accounts[acct];
    a.nats = { ...(a.nats ?? {}), admission: "register-hop" };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  ' "$HOME_DIR/.openclaw/openclaw.json" "$acct"
  echo "  ✓ $acct approved + creds persisted"
done

# ONE gateway serves BOTH accounts (registerFull multiplex).
# NOTE: no WEBCHANNEL_GW_URL is exported — register/admission rides the plugin's
# outbound NATS connection, so nothing dials this port for webchannel.
HOME="$HOME_DIR" OPENCLAW_HOME="$HOME_DIR" OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$PORT" --force >"$HOME_DIR/gateway.log" 2>&1 &
GW_PID=$!
echo "[multiplex] gateway pid=$GW_PID serving ${#ACCOUNTS[@]} accounts — waiting…"
for i in $(seq 1 240); do
  if grep -qE "NATS mode plugin registered \(${#ACCOUNTS[@]} of" "$HOME_DIR/gateway.log" 2>/dev/null; then
    echo "[multiplex] ✓ one gateway (pid=$GW_PID) serving: ${ACCOUNTS[*]} on :$PORT"; break
  fi
  kill -0 "$GW_PID" 2>/dev/null || { echo "[multiplex] gateway died:"; tail -20 "$HOME_DIR/gateway.log"; exit 2; }
  sleep 0.5
  [ "$i" -eq 240 ] && { echo "[multiplex] gateway TIMEOUT:"; tail -20 "$HOME_DIR/gateway.log"; exit 2; }
done

# Declare BOTH accounts into the SaaS directory + grant each to its user. There
# is no per-account URL — the ONE gateway subscribes both accounts' register
# subjects, so declaring them into the directory is enough to make them dialable.
for idx in "${!ACCOUNTS[@]}"; do
  acct="${ACCOUNTS[$idx]}"; grantee="${GRANTEES[$idx]}"
  curl -fsS -b "$OCH/multiplex.jar" -X POST "$SAAS_URL/admin/accounts" \
    -H 'Content-Type: application/json' \
    -d "{\"accountId\":\"$acct\"}" >/dev/null || true
  if [ "$AUTO_APPROVE" = 1 ]; then
    # Grant = replace the user's account set with (existing ∪ acct). Read then write.
    cur="$(curl -fsS -b "$OCH/multiplex.jar" "$SAAS_URL/admin/users" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=JSON.parse(s).users.find(x=>x.username===process.argv[1]);process.stdout.write(JSON.stringify(u?u.allowedAccounts:[]))})' "$grantee")"
    next="$(node -e 'const c=JSON.parse(process.argv[1]);const a=process.argv[2];process.stdout.write(JSON.stringify([...new Set([...c,a])]))' "$cur" "$acct")"
    curl -fsS -b "$OCH/multiplex.jar" -X POST "$SAAS_URL/admin/users/$grantee/accounts" \
      -H 'Content-Type: application/json' -d "{\"accounts\":$next}" >/dev/null || true
    echo "  ✓ granted $acct → $grantee"
  else
    echo "  → grant $acct to $grantee in the admin panel (User → agent grants)"
  fi
done

echo ""
echo "=============================================================="
echo "  ✓ multiplex up — ONE gateway (pid=$GW_PID, :$PORT) serves: ${ACCOUNTS[*]}"
echo "    log in as alice → team-sales · bob → team-support"
echo "    both tabs are the SAME openclaw process. Ctrl+C to tear down."
echo "=============================================================="
wait "$GW_PID"
