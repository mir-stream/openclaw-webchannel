#!/usr/bin/env bash
# Showcase demo — one-click boot of the whole stack under an ISOLATED
# OPENCLAW_HOME. Your real ~/.openclaw is never touched. Ctrl+C tears everything
# down. webchannel is an openclaw PLUGIN, so the demo boots real openclaw
# gateways (from node_modules/.bin/openclaw) to host it; the two commands that
# attach the plugin — `openclaw channels add` and `openclaw gateway` — are echoed
# to the console so you can see exactly how it connects to an openclaw.
#
# Topology (DEMO_PLAN "Topology constraint"): one gateway PER agent. The fleet
# runs agent-dev (19299) and agent-ops (19399) as independent gateway processes
# under their own OPENCLAW_HOME, each serving ONE account, all sharing the demo
# SaaS trust chain + nats-server. The SaaS delivers a per-account rendezvous map
# so a widget lane dials the right gateway.
#
# Boot order:
#   saas-server → nats-server → LLM (echo, or real when ZAI_API_KEY is set)
#   → for each agent: channels add (device-flow, admin-approved) → gateway run
#
# LLM mode: with no provider key the agent talks to a fake OpenAI-completions
# server (echo) so the demo boots creds-free; the UI shows an "Echo mode" badge.
# Set ZAI_API_KEY (+ optional ZAI_BASE_URL / ZAI_MODEL) for a real model.
set -euo pipefail

# `--live` = the integrated REAL demo: same isolated-home topology, but a real
# model is mandatory (fail fast if ZAI_API_KEY is unset). Without it, the demo
# falls back to the echo LLM. Everything else (DEMO_RELAY, ZAI_* overrides) still
# composes: `DEMO_RELAY=synadia ZAI_API_KEY=… ./demo/run.sh --live`.
LIVE_MODE=0
for arg in "$@"; do
  case "$arg" in
    --live) LIVE_MODE=1 ;;
    *) echo "[demo] unknown argument: $arg (only --live is supported)" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OCH=/tmp/oc-demo
PKG_JSON="$REPO/packages/plugin/package.json"
PKG_BAK=/tmp/oc-demo.pkgbak.json

# Fresh port block — no collision with the e2e harnesses. Env-overridable so a
# second demo (or a verification run) can use an alternate port block without
# fighting an already-running instance (e.g. a live SaaS squatting :3961).
SAAS_PORT="${SAAS_PORT:-3961}"
NATS_WS="${NATS_WS:-18722}"
NATS_TCP="${NATS_TCP:-14722}"
ECHO_PORT="${ECHO_PORT:-18905}"

# The fleet: "account:port" pairs. agent-dev + agent-ops pre-boot; add-agent.sh
# adds agent-docs (19499) live. Ports env-overridable so a re-run can dodge a
# TIME_WAIT/kernel-hold on the default block from a just-killed instance.
FLEET=("agent-dev:${DEV_PORT:-19299}" "agent-ops:${OPS_PORT:-19399}")

TENANT=demo-tenant
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

# Relay mode. `local` (default): a demo-owned self-contained nats-server. `synadia`:
# a real externally-managed account (Synadia Cloud / NGS) — the SaaS mints user
# creds signed by the operator's account signing seed, so browser + agents connect
# to the managed relay. Secrets come from synadia.env (never committed). Scene ③
# chaos (kill/tamper the relay) is disabled in synadia mode — we don't own it — but
# the wiretap pane is MORE persuasive over a real third-party relay (ciphertext only).
DEMO_RELAY="${DEMO_RELAY:-local}"
if [ "$DEMO_RELAY" = synadia ]; then
  SYNADIA_ENV="${SYNADIA_ENV:-$HOME/.openclaw-webchannel-saas/synadia.env}"
  [ -f "$SYNADIA_ENV" ] || { echo "[demo] DEMO_RELAY=synadia but $SYNADIA_ENV not found"; exit 1; }
  set -a; . "$SYNADIA_ENV"; set +a
  [ -n "${NATS_ACCOUNT_SIGNING_SEED:-}" ] && [ -n "${NATS_ACCOUNT_ID:-}" ] && [ -n "${NATS_URL:-}" ] \
    || { echo "[demo] synadia.env must export NATS_ACCOUNT_SIGNING_SEED, NATS_ACCOUNT_ID, NATS_URL"; exit 1; }
  RELAY_NATS_URL="$NATS_URL"
  echo "[demo] relay: SYNADIA (managed) → $RELAY_NATS_URL"
else
  RELAY_NATS_URL="ws://127.0.0.1:$NATS_WS"
  echo "[demo] relay: local (self-contained nats-server)"
fi

SAAS_PID=""; NATS_PID=""; ECHO_PID=""
GW_PIDS=()

cleanup() {
  echo ""
  echo "[demo] tearing down…"
  for pid in "${GW_PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  [ -n "$ECHO_PID" ] && kill "$ECHO_PID" 2>/dev/null || true
  [ -n "$NATS_PID" ] && kill "$NATS_PID" 2>/dev/null || true
  [ -n "$SAAS_PID" ] && kill "$SAAS_PID" 2>/dev/null || true
  pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
  pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
  for pair in "${FLEET[@]}"; do pkill -f "gateway --port ${pair##*:}" 2>/dev/null || true; done
  if [ -f "$PKG_BAK" ]; then
    cp "$PKG_BAK" "$PKG_JSON"; rm -f "$PKG_BAK"
    echo "[demo] restored $PKG_JSON"
  fi
}
trap cleanup EXIT

# Pre-clean.
pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
for pair in "${FLEET[@]}"; do pkill -f "gateway --port ${pair##*:}" 2>/dev/null || true; done
rm -rf "$OCH"
mkdir -p "$OCH/.openclaw"

# --live requires a real model — fail fast with a friendly message rather than
# silently booting the echo LLM (which would defeat the point of --live).
if [ "$LIVE_MODE" = 1 ] && [ -z "${ZAI_API_KEY:-}" ]; then
  echo "[demo] --live needs a real model but ZAI_API_KEY is not set." >&2
  echo "[demo]   run:  ZAI_API_KEY=… ./demo/run.sh --live" >&2
  echo "[demo]   (ZAI_BASE_URL / ZAI_MODEL override the z.ai endpoint + model;" >&2
  echo "[demo]    drop --live to run the creds-free echo demo instead.)" >&2
  exit 2
fi

# LLM mode banner + provider block (shared across gateways).
LIVE_TAG=""; [ "$LIVE_MODE" = 1 ] && LIVE_TAG=" (--live)"
if [ -n "${ZAI_API_KEY:-}" ]; then
  LLM_MODE=real
  echo "[demo] LLM: REAL (z.ai) — $ZAI_MODEL @ $ZAI_BASE_URL$LIVE_TAG"
  PROVIDER_BLOCK="\"zai\": { \"baseUrl\": \"$ZAI_BASE_URL\", \"api\": \"openai-completions\", \"apiKey\": \"$ZAI_API_KEY\", \"models\": [{ \"id\": \"$ZAI_MODEL\", \"name\": \"GLM\", \"reasoning\": false, \"input\": [\"text\"], \"cost\": { \"input\": 0, \"output\": 0, \"cacheRead\": 0, \"cacheWrite\": 0 }, \"contextWindow\": 200000, \"maxTokens\": 8192 }] }"
  PRIMARY_MODEL="zai/$ZAI_MODEL"
else
  LLM_MODE=echo
  echo "[demo] LLM: ECHO (no provider key) — set ZAI_API_KEY for a real model"
  PROVIDER_BLOCK="\"echo-local\": { \"baseUrl\": \"http://127.0.0.1:$ECHO_PORT/v1\", \"api\": \"openai-completions\", \"models\": [{ \"id\": \"echo\", \"name\": \"Echo\", \"reasoning\": false, \"input\": [\"text\"], \"cost\": { \"input\": 0, \"output\": 0, \"cacheRead\": 0, \"cacheWrite\": 0 }, \"contextWindow\": 200000, \"maxTokens\": 8192 }] }"
  PRIMARY_MODEL="echo-local/echo"
fi

# Boot agent directory (set of accountIds) for the SaaS. Built from FLEET. The
# value is an empty object per account — register admission is over NATS now, so
# there is no per-account gateway URL; only the KEY set (which accounts exist)
# matters. The shared relay natsUrl is delivered by the SaaS with the creds.
DEMO_ACCOUNTS="{"
for pair in "${FLEET[@]}"; do
  acct="${pair%%:*}"
  DEMO_ACCOUNTS="$DEMO_ACCOUNTS\"$acct\":{},"
done
DEMO_ACCOUNTS="${DEMO_ACCOUNTS%,}}"

# ---------------------------------------------------------------------------
# 1. Demo SaaS — trust chain + enrollment + users + bootstrap + web surface.
# ---------------------------------------------------------------------------
PORT="$SAAS_PORT" \
SAAS_BASE_URL="$SAAS_URL" \
SAAS_ISSUER="$SAAS_ISSUER" \
DEMO_RELAY="$DEMO_RELAY" \
NATS_URL="$RELAY_NATS_URL" \
NATS_CONFIG_OUT="$OCH" \
TRUST_CHAIN_PATH="$OCH/trust-chain-$DEMO_RELAY.json" \
DEMO_TENANT="$TENANT" \
DEMO_ACCOUNTS="$DEMO_ACCOUNTS" \
DEMO_LLM_MODE="$LLM_MODE" \
DEMO_APP_HTML="$REPO/demo/web/index.html" \
DEMO_CLIENT_ENTRY="$REPO/demo/web/src/app.ts" \
  node --import tsx "$REPO/demo/saas-server.ts" >"$OCH/saas.log" 2>&1 &
SAAS_PID=$!
echo "[demo] saas-server pid=$SAAS_PID — waiting for readiness…"
for i in $(seq 1 120); do
  ready=0
  if curl -fsS "$SAAS_URL/.well-known/jwks.json" >/dev/null 2>&1; then
    if [ "$DEMO_RELAY" = synadia ]; then
      ready=1   # managed relay: no operator.jwt/resolver.json to wait for
    elif [ -f "$OCH/operator.jwt" ] && [ -f "$OCH/resolver.json" ]; then
      ready=1
    fi
  fi
  [ "$ready" = 1 ] && { echo "[demo] saas-server ready"; break; }
  kill -0 "$SAAS_PID" 2>/dev/null || { echo "[demo] saas-server died — log:"; cat "$OCH/saas.log"; exit 2; }
  sleep 0.25
  [ "$i" -eq 120 ] && { echo "[demo] TIMEOUT waiting for saas-server — log:"; cat "$OCH/saas.log"; exit 2; }
done

# ---------------------------------------------------------------------------
# 2. Relay. local: a JWT-auth nats-server assembled from the SaaS trust chain.
#    synadia: the managed relay is already running — nothing to boot here.
# ---------------------------------------------------------------------------
if [ "$DEMO_RELAY" = synadia ]; then
  echo "[demo] relay: using managed Synadia server — skipping local nats-server"
else
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
fi

# ---------------------------------------------------------------------------
# 3. LLM: echo fake OpenAI-completions server (echo mode only).
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

# Admin session (cookie jar) — approves every agent's enrollment (SaaS authority).
curl -fsS -c "$OCH/admin.jar" -X POST "$SAAS_URL/login" \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"demo"}' >/dev/null
echo "[demo] admin session established"

# ---------------------------------------------------------------------------
# boot_agent <account> <port> — write config, enroll (admin-approve), run gateway.
#   Each agent lives under its own OPENCLAW_HOME=$OCH/<account>.
# ---------------------------------------------------------------------------
boot_agent() {
  local acct="$1" port="$2"
  local home="$OCH/$acct"
  mkdir -p "$home/.openclaw"

  # NOTE: the global session.dmScope below is now REDUNDANT for webchannel —
  # the plugin FORCES its own per-account-channel-peer session scope on every
  # inbound/history site (packages/plugin/src/session-route.ts), so it self-
  # isolates users regardless of this setting. Kept (not removed) because the
  # full browser roundtrip could not be re-verified without it in this env;
  # it is harmless (it only affects non-webchannel channels + the core doctor).
  cat > "$home/.openclaw/openclaw.json" <<JSON
{
  "gateway": { "mode": "local", "bind": "loopback" },
  "session": { "dmScope": "per-channel-peer" },
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
        "$acct": {
          "tenant": "$TENANT",
          "auth": { "strategy": "jwt", "jwt": {
            "jwksUrl": "$SAAS_URL/.well-known/jwks.json",
            "issuer": "$SAAS_ISSUER",
            "audience": "$acct"
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
  echo "  ┌─ attaching webchannel account '$acct' to a gateway ───────────────"
  echo "  │ \$ openclaw channels add --channel webchannel --account $acct \\"
  echo "  │     --base-url $SAAS_URL --url $TENANT"
  echo "  │ \$ openclaw gateway --port $port"
  echo "  └───────────────────────────────────────────────────────────────────"

  local addlog="$home/channels-add.log"
  HOME="$home" OPENCLAW_HOME="$home" OPENCLAW_DISABLE_BONJOUR=1 \
    "$REPO/node_modules/.bin/openclaw" channels add --channel webchannel --account "$acct" \
      --base-url "$SAAS_URL" --url "$TENANT" >"$addlog" 2>&1 &
  local add_pid=$!

  local user_code=""
  for i in $(seq 1 240); do
    user_code="$(grep -oE 'User code: [A-Z]{4}-[A-Z]{4}' "$addlog" 2>/dev/null | head -1 | awk '{print $3}' || true)"
    [ -n "$user_code" ] && break
    kill -0 "$add_pid" 2>/dev/null || { echo "[demo] $acct channels add exited early — log:"; cat "$addlog"; exit 2; }
    sleep 0.25
  done
  [ -z "$user_code" ] && { echo "[demo] $acct TIMEOUT waiting for user_code"; cat "$addlog"; exit 2; }
  echo "[demo] $acct user_code=$user_code — admin approving…"
  curl -fsS -b "$OCH/admin.jar" -X POST "$SAAS_URL/admin/enrollments/$user_code/approve" >/dev/null || true

  set +e; wait "$add_pid"; local rc=$?; set -e
  [ "$rc" -ne 0 ] && { echo "[demo] $acct channels add failed (rc=$rc):"; cat "$addlog"; exit 2; }
  [ -f "$home/.openclaw-webchannel/$acct/credentials.json" ] || { echo "[demo] $acct creds not persisted"; cat "$addlog"; exit 2; }

  # Re-assert register-hop admission (setup adapter may write admission:auto).
  node -e '
    const fs = require("fs"); const p = process.argv[1], acct = process.argv[2];
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    const a = cfg.channels.webchannel.accounts[acct];
    a.nats = { ...(a.nats ?? {}), admission: "register-hop" };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  ' "$home/.openclaw/openclaw.json" "$acct"

  # NOTE: no gateway URL is exported — register/admission rides the plugin's
  # outbound NATS connection now, so nothing (browser or SaaS) dials this port
  # for webchannel. The --port still binds openclaw's own local gateway.
  HOME="$home" OPENCLAW_HOME="$home" OPENCLAW_DISABLE_BONJOUR=1 \
    WEBCHANNEL_NATS_URL="$RELAY_NATS_URL" \
    "$REPO/node_modules/.bin/openclaw" gateway --port "$port" --force >"$home/gateway.log" 2>&1 &
  local gw_pid=$!
  GW_PIDS+=("$gw_pid")
  echo "[demo] $acct gateway pid=$gw_pid — waiting for registration…"
  for i in $(seq 1 240); do
    grep -q "\[webchannel\] ✓ NATS mode plugin registered" "$home/gateway.log" 2>/dev/null \
      && { echo "[demo] $acct gateway ready"; return 0; }
    kill -0 "$gw_pid" 2>/dev/null || { echo "[demo] $acct gateway died:"; tail -30 "$home/gateway.log"; exit 2; }
    sleep 0.5
    [ "$i" -eq 240 ] && { echo "[demo] $acct gateway TIMEOUT:"; tail -30 "$home/gateway.log"; exit 2; }
  done
}

# ---------------------------------------------------------------------------
# 5. Pre-boot the fleet.
# ---------------------------------------------------------------------------
for pair in "${FLEET[@]}"; do
  boot_agent "${pair%%:*}" "${pair##*:}"
done

echo ""
echo "=============================================================="
echo "  ✓ demo is up${LIVE_TAG:+  [integrated live demo]} — fleet: ${FLEET[*]}"
echo "    open:   $SAAS_URL"
echo "    logins: alice / bob (chat) · admin (approve/grant)  — pw: demo"
echo "    LLM:    $LLM_MODE$LIVE_TAG"
echo "    add another agent live:  ./demo/add-agent.sh"
echo "  Ctrl+C to tear everything down."
echo "=============================================================="
echo ""

# Idle until all gateways exit (cleanup runs on EXIT).
while :; do
  for pid in "${GW_PIDS[@]}"; do kill -0 "$pid" 2>/dev/null || exit 0; done
  sleep 1
done
