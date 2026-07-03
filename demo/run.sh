#!/usr/bin/env bash
# Showcase demo — one-click boot of the whole stack under an ISOLATED
# OPENCLAW_HOME. Your real ~/.openclaw is never touched. Ctrl+C tears everything
# down. webchannel is an openclaw PLUGIN, so the demo boots a real openclaw
# gateway (from node_modules/.bin/openclaw) to host it; the two commands that
# attach the plugin — `openclaw channels add` and `openclaw gateway` — are echoed
# to the console so you can see exactly how it connects to an openclaw.
#
# Boot order (Phase 1):
#   saas-server → nats-server → LLM (echo, or real when ZAI_API_KEY is set)
#   → channels add agent-dev (device-flow enroll, admin-approved) → gateway run
#
# LLM mode: with no provider key the agent talks to a fake OpenAI-completions
# server (echo) so the demo boots creds-free; the UI shows an "Echo mode" badge.
# Set ZAI_API_KEY (+ optional ZAI_BASE_URL / ZAI_MODEL) for a real model.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OCH=/tmp/oc-demo
PKG_JSON="$REPO/packages/plugin/package.json"
PKG_BAK=/tmp/oc-demo.pkgbak.json

# Fresh port block — no collision with the e2e harnesses.
SAAS_PORT=3961
GW_PORT=19299
NATS_WS=18722
NATS_TCP=14722
ECHO_PORT=18905

TENANT=demo-tenant
ACCOUNT_ID=agent-dev
SAAS_ISSUER="https://saas.local/demo-issuer"
SAAS_URL="http://127.0.0.1:$SAAS_PORT"
# Seeded demo user uuids (peer ids) = the exec-approval approvers.
UUID_ALICE="11111111-1111-4111-8111-111111111111"
UUID_BOB="22222222-2222-4222-8222-222222222222"
UUID_ADMIN="99999999-9999-4999-8999-999999999999"

# Real-model provider (optional). Defaults chosen for z.ai's coding endpoint;
# override via env. Echo is used whenever ZAI_API_KEY is unset.
ZAI_BASE_URL="${ZAI_BASE_URL:-https://api.z.ai/api/coding/paas/v4}"
ZAI_MODEL="${ZAI_MODEL:-glm-4.6}"

SAAS_PID=""; NATS_PID=""; ECHO_PID=""; GW_PID=""; ADD_PID=""

cleanup() {
  echo ""
  echo "[demo] tearing down…"
  [ -n "$ADD_PID" ]  && kill "$ADD_PID"  2>/dev/null || true
  [ -n "$GW_PID" ]   && kill "$GW_PID"   2>/dev/null || true
  [ -n "$ECHO_PID" ] && kill "$ECHO_PID" 2>/dev/null || true
  [ -n "$NATS_PID" ] && kill "$NATS_PID" 2>/dev/null || true
  [ -n "$SAAS_PID" ] && kill "$SAAS_PID" 2>/dev/null || true
  pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
  pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
  pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
  if [ -f "$PKG_BAK" ]; then
    cp "$PKG_BAK" "$PKG_JSON"; rm -f "$PKG_BAK"
    echo "[demo] restored $PKG_JSON"
  fi
}
trap cleanup EXIT

# Pre-clean.
pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
rm -rf "$OCH"
mkdir -p "$OCH/.openclaw"

# LLM mode banner.
if [ -n "${ZAI_API_KEY:-}" ]; then
  LLM_MODE=real
  echo "[demo] LLM: REAL (z.ai) — $ZAI_MODEL @ $ZAI_BASE_URL"
else
  LLM_MODE=echo
  echo "[demo] LLM: ECHO (no provider key) — set ZAI_API_KEY for a real model"
fi

# ---------------------------------------------------------------------------
# 1. Demo SaaS — trust chain + enrollment + users + bootstrap + web surface.
#    Writes operator.jwt + resolver.json to $OCH for the nats-server.
# ---------------------------------------------------------------------------
PORT="$SAAS_PORT" \
SAAS_BASE_URL="$SAAS_URL" \
SAAS_ISSUER="$SAAS_ISSUER" \
NATS_URL="ws://127.0.0.1:$NATS_WS" \
NATS_CONFIG_OUT="$OCH" \
TRUST_CHAIN_PATH="$OCH/trust-chain.json" \
DEMO_TENANT="$TENANT" \
DEMO_ACCOUNTS="{\"$ACCOUNT_ID\":{\"registerBaseUrl\":\"http://127.0.0.1:$GW_PORT\"}}" \
DEMO_LLM_MODE="$LLM_MODE" \
DEMO_APP_HTML="$REPO/demo/web/index.html" \
DEMO_CLIENT_ENTRY="$REPO/demo/web/src/app.ts" \
  node --import tsx "$REPO/demo/saas-server.ts" >"$OCH/saas.log" 2>&1 &
SAAS_PID=$!
echo "[demo] saas-server pid=$SAAS_PID — waiting for JWKS + NATS config…"
for i in $(seq 1 120); do
  if curl -fsS "$SAAS_URL/.well-known/jwks.json" >/dev/null 2>&1 \
     && [ -f "$OCH/operator.jwt" ] && [ -f "$OCH/resolver.json" ]; then
    echo "[demo] saas-server ready"
    break
  fi
  kill -0 "$SAAS_PID" 2>/dev/null || { echo "[demo] saas-server died — log:"; cat "$OCH/saas.log"; exit 2; }
  sleep 0.25
  [ "$i" -eq 120 ] && { echo "[demo] TIMEOUT waiting for saas-server — log:"; cat "$OCH/saas.log"; exit 2; }
done

# ---------------------------------------------------------------------------
# 2. JWT-auth nats-server, assembled from the SaaS trust chain's operator+resolver.
# ---------------------------------------------------------------------------
OCH="$OCH" NATS_TCP="$NATS_TCP" NATS_WS="$NATS_WS" node -e '
  const fs = require("fs");
  const dir = process.env.OCH;
  const operatorJwtPath = dir + "/operator.jwt";
  const resolver = JSON.parse(fs.readFileSync(dir + "/resolver.json", "utf8"));
  const preload = Object.entries(resolver).map(([k, v]) => `  ${k}: "${v}"`).join("\n");
  const conf = [
    `port: ${process.env.NATS_TCP}`,
    `websocket {`, `  port: ${process.env.NATS_WS}`, `  no_tls: true`, `}`,
    `operator: "${operatorJwtPath}"`,
    `resolver: MEMORY`,
    `resolver_preload: {`, preload, `}`, "",
  ].join("\n");
  fs.writeFileSync(dir + "/nats.conf", conf);
'
nats-server -c "$OCH/nats.conf" >"$OCH/nats.log" 2>&1 &
NATS_PID=$!
echo "[demo] nats-server pid=$NATS_PID (ws://127.0.0.1:$NATS_WS) — waiting…"
for i in $(seq 1 120); do
  grep -q "Server is ready" "$OCH/nats.log" 2>/dev/null && { echo "[demo] nats-server ready"; break; }
  kill -0 "$NATS_PID" 2>/dev/null || { echo "[demo] nats-server died — log:"; cat "$OCH/nats.log"; exit 2; }
  sleep 0.25
  [ "$i" -eq 120 ] && { echo "[demo] TIMEOUT waiting for nats-server — log:"; cat "$OCH/nats.log"; exit 2; }
done

# ---------------------------------------------------------------------------
# 3. LLM: echo fake OpenAI-completions server (no provider key needed).
# ---------------------------------------------------------------------------
if [ "$LLM_MODE" = echo ]; then
  node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_PORT" >"$OCH/echo.log" 2>&1 &
  ECHO_PID=$!
  echo "[demo] echo LLM pid=$ECHO_PID (http://127.0.0.1:$ECHO_PORT/v1)"
fi

# ---------------------------------------------------------------------------
# 4. Point the webchannel plugin entry at index-nats.ts (restore on exit).
# ---------------------------------------------------------------------------
if [ -f "$PKG_BAK" ]; then cp "$PKG_BAK" "$PKG_JSON"; rm -f "$PKG_BAK"; fi
cp "$PKG_JSON" "$PKG_BAK"
node -e '
  const fs = require("fs"); const p = process.argv[1];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.openclaw = j.openclaw || {}; j.openclaw.extensions = ["./index-nats.ts"];
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$PKG_JSON"

# ---------------------------------------------------------------------------
# 5. Isolated openclaw config: provider + agent + webchannel(jwt) + approvals.
# ---------------------------------------------------------------------------
if [ "$LLM_MODE" = real ]; then
  PROVIDER_BLOCK=$(cat <<JSON
      "zai": {
        "baseUrl": "$ZAI_BASE_URL",
        "api": "openai-completions",
        "apiKey": "$ZAI_API_KEY",
        "models": [{ "id": "$ZAI_MODEL", "name": "GLM", "reasoning": false, "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000, "maxTokens": 8192 }]
      }
JSON
)
  PRIMARY_MODEL="zai/$ZAI_MODEL"
else
  PROVIDER_BLOCK=$(cat <<JSON
      "echo-local": {
        "baseUrl": "http://127.0.0.1:$ECHO_PORT/v1",
        "api": "openai-completions",
        "models": [{ "id": "echo", "name": "Echo", "reasoning": false, "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000, "maxTokens": 8192 }]
      }
JSON
)
  PRIMARY_MODEL="echo-local/echo"
fi

cat > "$OCH/.openclaw/openclaw.json" <<JSON
{
  "gateway": { "mode": "local", "bind": "loopback" },
  "models": {
    "providers": {
$PROVIDER_BLOCK
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "$PRIMARY_MODEL" },
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
      "history": { "enabled": true },
      "execApprovals": {
        "enabled": true,
        "approvers": ["$UUID_ALICE", "$UUID_BOB", "$UUID_ADMIN"]
      },
      "accounts": {
        "$ACCOUNT_ID": {
          "tenant": "$TENANT",
          "auth": {
            "strategy": "jwt",
            "jwt": {
              "jwksUrl": "$SAAS_URL/.well-known/jwks.json",
              "issuer": "$SAAS_ISSUER",
              "audience": "$ACCOUNT_ID"
            }
          },
          "dmSecurity": "allowlist",
          "allowFrom": ["$UUID_ALICE", "$UUID_BOB", "$UUID_ADMIN"]
        }
      }
    }
  }
}
JSON
echo "[demo] wrote $OCH/.openclaw/openclaw.json"

# ---------------------------------------------------------------------------
# 6. Attach the plugin to openclaw — the CONNECT experience (echoed verbatim).
#    `channels add` runs the device-flow enroll; the demo admin approves it.
# ---------------------------------------------------------------------------
echo ""
echo "  ┌─ this is how webchannel attaches to an openclaw gateway ──────────"
echo "  │ \$ openclaw channels add --channel webchannel --account $ACCOUNT_ID \\"
echo "  │     --base-url $SAAS_URL --url $TENANT"
echo "  └───────────────────────────────────────────────────────────────────"
echo ""
HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  "$REPO/node_modules/.bin/openclaw" channels add --channel webchannel --account "$ACCOUNT_ID" \
    --base-url "$SAAS_URL" --url "$TENANT" \
  >"$OCH/channels-add.log" 2>&1 &
ADD_PID=$!
echo "[demo] channels add pid=$ADD_PID — waiting for the enrollment user_code…"

USER_CODE=""
for i in $(seq 1 240); do
  USER_CODE="$(grep -oE 'User code: [A-Z]{4}-[A-Z]{4}' "$OCH/channels-add.log" 2>/dev/null | head -1 | awk '{print $3}' || true)"
  [ -n "$USER_CODE" ] && break
  kill -0 "$ADD_PID" 2>/dev/null || { echo "[demo] channels add exited early — log:"; cat "$OCH/channels-add.log"; exit 2; }
  sleep 0.25
done
[ -z "$USER_CODE" ] && { echo "[demo] TIMEOUT waiting for user_code — log:"; cat "$OCH/channels-add.log"; exit 2; }
echo "[demo] enrollment user_code=$USER_CODE — admin approving (SaaS authority)…"

# The demo admin logs in (session cookie) and approves via the admin-gated route —
# exactly the production shape (an operator approves in the SaaS dashboard).
curl -fsS -c "$OCH/admin.jar" -X POST "$SAAS_URL/login" \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"demo"}' >/dev/null
APPROVE="$(curl -fsS -b "$OCH/admin.jar" -X POST \
  "$SAAS_URL/admin/enrollments/$USER_CODE/approve" || true)"
echo "[demo] approve → $APPROVE"

set +e; wait "$ADD_PID"; ADD_RC=$?; set -e
ADD_PID=""
[ "$ADD_RC" -ne 0 ] && { echo "[demo] channels add failed (rc=$ADD_RC) — log:"; cat "$OCH/channels-add.log"; exit 2; }
CRED_FILE="$OCH/.openclaw-webchannel/$ACCOUNT_ID/credentials.json"
[ -f "$CRED_FILE" ] || { echo "[demo] creds NOT persisted at $CRED_FILE — log:"; cat "$OCH/channels-add.log"; exit 2; }
echo "[demo] ✓ credentials persisted"

# 6b. Re-assert register-hop admission (the setup adapter may write admission:auto,
#     which disables the HTTP register hop the browser drives). See run-all-real.sh.
node -e '
  const fs = require("fs");
  const p = process.argv[1], acct = process.argv[2];
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  const a = cfg.channels.webchannel.accounts[acct];
  a.nats = { ...(a.nats ?? {}), admission: "register-hop" };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
' "$OCH/.openclaw/openclaw.json" "$ACCOUNT_ID"
echo "[demo] ✓ admission=register-hop re-asserted"

# ---------------------------------------------------------------------------
# 7. Boot the gateway — CONSUME-ONLY (loads the persisted creds).
# ---------------------------------------------------------------------------
echo ""
echo "  ┌─ and this runs the gateway that hosts the plugin ─────────────────"
echo "  │ \$ openclaw gateway --port $GW_PORT"
echo "  └───────────────────────────────────────────────────────────────────"
echo ""
HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
  WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$GW_PORT" --force \
  >"$OCH/gateway.log" 2>&1 &
GW_PID=$!
echo "[demo] gateway pid=$GW_PID — waiting for plugin registration…"
for i in $(seq 1 240); do
  grep -q "\[webchannel\] ✓ NATS mode plugin registered" "$OCH/gateway.log" 2>/dev/null \
    && { echo "[demo] gateway ready"; break; }
  kill -0 "$GW_PID" 2>/dev/null || { echo "[demo] gateway died — log:"; tail -40 "$OCH/gateway.log"; exit 2; }
  sleep 0.5
  [ "$i" -eq 240 ] && { echo "[demo] TIMEOUT waiting for gateway — log:"; tail -40 "$OCH/gateway.log"; exit 2; }
done

echo ""
echo "=============================================================="
echo "  ✓ demo is up"
echo "    open:   $SAAS_URL"
echo "    logins: alice / bob (chat) · admin (approve/grant)  — pw: demo"
echo "    LLM:    $LLM_MODE"
echo "  Ctrl+C to tear everything down."
echo "=============================================================="
echo ""

# Idle until Ctrl+C (cleanup runs on EXIT).
while kill -0 "$GW_PID" 2>/dev/null; do sleep 1; done
