#!/usr/bin/env bash
# Scene ② — "agents appear from anywhere". Boots a NEW gateway ("another
# machine") that device-flow enrolls a fresh account (agent-docs, 19499) against
# the ALREADY-RUNNING demo SaaS + nats-server. Its enrollment pops in the admin
# panel; approving it (in the browser, as admin) makes the agent reachable, then
# an admin grant makes it selectable in an open widget. Denying it shows the
# authority refusing.
#
# Run this in a SECOND terminal while ./demo/run.sh is up. It touches NO ports or
# browser config the running demo owns — only its own OPENCLAW_HOME.
#
# Approval: by default this WAITS for a human to approve in the admin panel
# (that IS the scene). Pass --auto-approve to approve programmatically (for
# unattended testing).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OCH=/tmp/oc-demo
SAAS_PORT=3961
NATS_WS=18722
SAAS_URL="http://127.0.0.1:$SAAS_PORT"
TENANT=demo-tenant

ACCOUNT=agent-docs
PORT=19499
HOME_DIR="$OCH/$ACCOUNT"

AUTO_APPROVE=0
[ "${1:-}" = "--auto-approve" ] && AUTO_APPROVE=1

# Sanity: the demo must already be up (shared SaaS + nats-server).
curl -fsS "$SAAS_URL/.well-known/jwks.json" >/dev/null 2>&1 \
  || { echo "[add-agent] demo SaaS not reachable at $SAAS_URL — start ./demo/run.sh first"; exit 1; }
[ -f "$OCH/operator.jwt" ] || { echo "[add-agent] $OCH/operator.jwt missing — is the demo running?"; exit 1; }

GW_PID=""; ADD_PID=""
cleanup() {
  echo ""
  echo "[add-agent] tearing down agent-docs…"
  [ -n "$ADD_PID" ] && kill "$ADD_PID" 2>/dev/null || true
  [ -n "$GW_PID" ]  && kill "$GW_PID"  2>/dev/null || true
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

UUID_ALICE="11111111-1111-4111-8111-111111111111"
UUID_BOB="22222222-2222-4222-8222-222222222222"
UUID_ADMIN="99999999-9999-4999-8999-999999999999"

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
      "accounts": {
        "$ACCOUNT": {
          "tenant": "$TENANT",
          "auth": { "strategy": "jwt", "jwt": {
            "jwksUrl": "$SAAS_URL/.well-known/jwks.json",
            "issuer": "https://saas.local/demo-issuer",
            "audience": "$ACCOUNT"
          } },
          "dmSecurity": "allowlist",
          "allowFrom": ["$UUID_ALICE", "$UUID_BOB", "$UUID_ADMIN"]
        }
      }
    }
  }
}
JSON

echo ""
echo "  ┌─ a new agent enrolls from 'another machine' ──────────────────────"
echo "  │ \$ openclaw channels add --channel webchannel --account $ACCOUNT \\"
echo "  │     --base-url $SAAS_URL --url $TENANT"
echo "  └───────────────────────────────────────────────────────────────────"

ADDLOG="$HOME_DIR/channels-add.log"
HOME="$HOME_DIR" OPENCLAW_HOME="$HOME_DIR" OPENCLAW_DISABLE_BONJOUR=1 \
  "$REPO/node_modules/.bin/openclaw" channels add --channel webchannel --account "$ACCOUNT" \
    --base-url "$SAAS_URL" --url "$TENANT" >"$ADDLOG" 2>&1 &
ADD_PID=$!

USER_CODE=""
for i in $(seq 1 240); do
  USER_CODE="$(grep -oE 'User code: [A-Z]{4}-[A-Z]{4}' "$ADDLOG" 2>/dev/null | head -1 | awk '{print $3}' || true)"
  [ -n "$USER_CODE" ] && break
  kill -0 "$ADD_PID" 2>/dev/null || { echo "[add-agent] channels add exited early:"; cat "$ADDLOG"; exit 2; }
  sleep 0.25
done
[ -z "$USER_CODE" ] && { echo "[add-agent] TIMEOUT waiting for user_code"; cat "$ADDLOG"; exit 2; }

echo ""
echo "  🔔 enrollment request '$USER_CODE' for account '$ACCOUNT' is now PENDING."
if [ "$AUTO_APPROVE" = 1 ]; then
  echo "  --auto-approve → approving programmatically…"
  curl -fsS -c "$OCH/addagent.jar" -X POST "$SAAS_URL/login" \
    -H 'Content-Type: application/json' -d '{"username":"admin","password":"demo"}' >/dev/null
  curl -fsS -b "$OCH/addagent.jar" -X POST "$SAAS_URL/admin/enrollments/$USER_CODE/approve" >/dev/null || true
else
  echo "  → Approve (or Deny) it in the admin panel at $SAAS_URL (log in as admin)."
  echo "     Then grant it to alice/bob to make it selectable in their widget."
fi
echo ""

# Block until channels add finishes (approved → creds persisted; denied → error).
set +e; wait "$ADD_PID"; ADD_RC=$?; set -e
ADD_PID=""
if [ "$ADD_RC" -ne 0 ]; then
  echo "[add-agent] enrollment did not complete (denied or expired). channels-add log:"
  tail -8 "$ADDLOG"
  exit 0
fi
[ -f "$HOME_DIR/.openclaw-webchannel/$ACCOUNT/credentials.json" ] || { echo "[add-agent] creds not persisted"; exit 2; }
echo "[add-agent] ✓ $ACCOUNT approved + credentials persisted"

# Re-assert register-hop admission, then boot the gateway.
node -e '
  const fs = require("fs"); const p = process.argv[1], acct = process.argv[2];
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  const a = cfg.channels.webchannel.accounts[acct];
  a.nats = { ...(a.nats ?? {}), admission: "register-hop" };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
' "$HOME_DIR/.openclaw/openclaw.json" "$ACCOUNT"

HOME="$HOME_DIR" OPENCLAW_HOME="$HOME_DIR" OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
  WEBCHANNEL_GW_URL="http://127.0.0.1:$PORT" \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$PORT" --force >"$HOME_DIR/gateway.log" 2>&1 &
GW_PID=$!
echo "[add-agent] $ACCOUNT gateway pid=$GW_PID — waiting for registration…"
for i in $(seq 1 240); do
  grep -q "\[webchannel\] ✓ NATS mode plugin registered" "$HOME_DIR/gateway.log" 2>/dev/null \
    && { echo "[add-agent] ✓ $ACCOUNT is live on :$PORT"; break; }
  kill -0 "$GW_PID" 2>/dev/null || { echo "[add-agent] gateway died:"; tail -20 "$HOME_DIR/gateway.log"; exit 2; }
  sleep 0.5
  [ "$i" -eq 240 ] && { echo "[add-agent] gateway TIMEOUT:"; tail -20 "$HOME_DIR/gateway.log"; exit 2; }
done

echo ""
echo "  ✓ agent-docs added. It appears in the admin panel; grant it to a user to"
echo "    make its tab show up in their open widget. Ctrl+C to remove it."
echo ""
while kill -0 "$GW_PID" 2>/dev/null; do sleep 1; done
