#!/usr/bin/env bash
# INTERACTIVE chat demo — the human-facing sibling of run-all-real.sh.
#
# Boots the SAME ALL-REAL server topology (unified issuer + JWT-auth nats-server
# from ONE setupTrustChain + echo model + REAL enrolled webchannel plugin, devOpen
# OFF) but, instead of running a headless one-shot round-trip and exiting, it
# launches a persistent chat server (demo-server.mjs) and BLOCKS so a HUMAN can
# open the printed URL in a browser and chat with the live (echo) agent. Ctrl+C
# tears the whole stack down (EXIT trap).
#
# Uses a DISTINCT isolated dir (/tmp/oc-demo-e2e) and DISTINCT ports so it can run
# alongside the all-real harness without collision. Self-cleaning (trap on EXIT).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OCH=/tmp/oc-demo-e2e
PKG_JSON="$REPO/packages/plugin/package.json"
# Keep the backup OUTSIDE $OCH: $OCH is rm -rf'd at startup, so a backup living
# inside it would be wiped by the NEXT run before we could restore the original —
# permanently stranding the swapped (index-nats.ts) package.json in git.
PKG_BAK=/tmp/oc-demo-e2e.pkgbak.json

# Distinct ports — no collision with the all-real harness
# (19199/18622/14622/18904/3941/19393).
GW_PORT=19299
NATS_WS=18722
NATS_TCP=14722
ECHO_PORT=18905
ISSUER_PORT=3942
PAGE_PORT=19394

TENANT=default-tenant
ACCOUNT_ID=default-agent
PEER_ID=web-allreal-peer
SAAS_ISSUER="https://saas.local/demo-issuer"

NATS_PID=""; ECHO_PID=""; ISSUER_PID=""; GW_PID=""; DEMO_PID=""

cleanup() {
  echo "[run-demo] cleanup…"
  [ -n "$DEMO_PID" ]   && kill "$DEMO_PID"   2>/dev/null || true
  [ -n "$GW_PID" ]     && kill "$GW_PID"     2>/dev/null || true
  [ -n "$ISSUER_PID" ] && kill "$ISSUER_PID" 2>/dev/null || true
  [ -n "$ECHO_PID" ]   && kill "$ECHO_PID"   2>/dev/null || true
  [ -n "$NATS_PID" ]   && kill "$NATS_PID"   2>/dev/null || true
  pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
  pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
  # NOTE: no broad `pkill -f enrollment-server.ts` — the issuer PORT is an env var
  # (not an argv flag), so a broad match could kill an unrelated issuer (parallel
  # harness). The ISSUER_PID kill above is sufficient.
  pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
  if [ -f "$PKG_BAK" ]; then
    cp "$PKG_BAK" "$PKG_JSON"
    rm -f "$PKG_BAK"
    echo "[run-demo] restored $PKG_JSON"
  fi
}
trap cleanup EXIT

# Pre-clean leftover procs / dir.
pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
rm -rf "$OCH"
mkdir -p "$OCH/.openclaw"

# ---------------------------------------------------------------------------
# 1. REAL device-flow enrollment-server (single trust chain). Writes the public
#    NATS config to $OCH and serves JWKS + TEST routes (/test/nats-user +
#    /test/bootstrap-jwt for the browser peer).
# ---------------------------------------------------------------------------
PORT="$ISSUER_PORT" \
SAAS_BASE_URL="http://127.0.0.1:$ISSUER_PORT" \
SAAS_ISSUER="$SAAS_ISSUER" \
NATS_URL="ws://127.0.0.1:$NATS_WS" \
NATS_CONFIG_OUT="$OCH" \
ENABLE_TEST_ROUTES=1 \
POLL_INTERVAL_SECONDS=1 \
  node --import tsx "$REPO/packages/saas/reference/enrollment-server.ts" >"$OCH/issuer.log" 2>&1 &
ISSUER_PID=$!
echo "[run-demo] enrollment-server pid=$ISSUER_PID — waiting for JWKS + NATS config…"
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$ISSUER_PORT/.well-known/jwks.json" >/dev/null 2>&1 \
     && [ -f "$OCH/operator.jwt" ] && [ -f "$OCH/resolver.json" ]; then
    echo "[run-demo] issuer ready (JWKS up, NATS config written)"
    break
  fi
  if ! kill -0 "$ISSUER_PID" 2>/dev/null; then
    echo "[run-demo] enrollment-server died early — log:"; cat "$OCH/issuer.log"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-demo] TIMEOUT waiting for issuer — log:"; cat "$OCH/issuer.log"; exit 2
  fi
done

# ---------------------------------------------------------------------------
# 2. JWT-auth nats-server, built from the SAME trust chain's operator + resolver.
# ---------------------------------------------------------------------------
OCH="$OCH" NATS_TCP="$NATS_TCP" NATS_WS="$NATS_WS" node -e '
  const fs = require("fs");
  const dir = process.env.OCH;
  const operatorJwtPath = dir + "/operator.jwt";
  const resolver = JSON.parse(fs.readFileSync(dir + "/resolver.json", "utf8"));
  const preload = Object.entries(resolver).map(([k, v]) => `  ${k}: "${v}"`).join("\n");
  const conf = [
    `port: ${process.env.NATS_TCP}`,
    `websocket {`,
    `  port: ${process.env.NATS_WS}`,
    `  no_tls: true`,
    `}`,
    `operator: "${operatorJwtPath}"`,
    `resolver: MEMORY`,
    `resolver_preload: {`,
    preload,
    `}`,
    "",
  ].join("\n");
  fs.writeFileSync(dir + "/nats.conf", conf);
'
nats-server -c "$OCH/nats.conf" >"$OCH/nats.log" 2>&1 &
NATS_PID=$!
echo "[run-demo] nats-server pid=$NATS_PID (JWT-auth, ws://127.0.0.1:$NATS_WS) — waiting…"
for i in $(seq 1 120); do
  if grep -q "Server is ready" "$OCH/nats.log" 2>/dev/null; then
    echo "[run-demo] nats-server ready"
    break
  fi
  if ! kill -0 "$NATS_PID" 2>/dev/null; then
    echo "[run-demo] nats-server died early — log:"; cat "$OCH/nats.log"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-demo] TIMEOUT waiting for nats-server — log:"; cat "$OCH/nats.log"; exit 2
  fi
done

# ---------------------------------------------------------------------------
# 3. Echo model server (no real LLM).
# ---------------------------------------------------------------------------
node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_PORT" >"$OCH/echo.log" 2>&1 &
ECHO_PID=$!
echo "[run-demo] echo server pid=$ECHO_PID"

# ---------------------------------------------------------------------------
# 4. Point the webchannel plugin entry at index-nats.ts (restore on exit).
#    Crash recovery: if a prior run was hard-killed mid-swap, $PKG_BAK still holds
#    the ORIGINAL package.json while the tracked one is left swapped. Restore it
#    first, THEN take a fresh backup — so this swap is itself crash-recoverable.
# ---------------------------------------------------------------------------
if [ -f "$PKG_BAK" ]; then
  echo "[run-demo] stale $PKG_BAK found — restoring original package.json before re-swapping"
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
echo "[run-demo] set plugin extensions → ./index-nats.ts"

# ---------------------------------------------------------------------------
# 5. Isolated openclaw config: REAL model providers (inherited from the user's
#    real ~/.openclaw/openclaw.json) + webchannel(jwt). This is the whole point
#    of the DEMO (vs the headless harness): the web peer talks to the user's
#    ACTUAL configured agent/model — NOT the echo stand-in. We copy the real
#    `models` block and the real default agent model verbatim, so provider auth
#    resolves exactly as it does for the real gateway (same env-based API keys).
#    Everything else (isolated HOME/ports/gateway, no real config mutation) keeps
#    this hermetic: we only READ the real config, never write to it.
#    `auth.jwt.jwksUrl` points at the issuer's JWKS so the register-hop JWT verifies.
# ---------------------------------------------------------------------------
# At THIS point $HOME is still the real user home (the gateway subprocess below is
# the only thing run under HOME=$OCH), so this reads the real config to inherit.
REAL_CONFIG="${OPENCLAW_REAL_CONFIG:-$HOME/.openclaw/openclaw.json}"
[ -f "$REAL_CONFIG" ] || { echo "[run-demo] FATAL: real openclaw config not found at $REAL_CONFIG — cannot inherit the real agent/model. Set OPENCLAW_REAL_CONFIG."; exit 3; }
OCH="$OCH" REPO="$REPO" REAL_CONFIG="$REAL_CONFIG" \
ISSUER_PORT="$ISSUER_PORT" SAAS_ISSUER="$SAAS_ISSUER" ACCOUNT_ID="$ACCOUNT_ID" PEER_ID="$PEER_ID" \
node -e '
  const fs = require("fs");
  const real = JSON.parse(fs.readFileSync(process.env.REAL_CONFIG, "utf8"));
  if (!real.models || !real.models.providers || !Object.keys(real.models.providers).length) {
    console.error("[run-demo] FATAL: real config has no models.providers to inherit"); process.exit(3);
  }
  const realDefaults = (real.agents && real.agents.defaults) || {};
  if (!realDefaults.model || !realDefaults.model.primary) {
    console.error("[run-demo] FATAL: real config has no agents.defaults.model.primary"); process.exit(3);
  }
  // Keep the real default model + a compaction floor (tiny-context safety), drop
  // everything else from the real agent defaults to stay minimal/hermetic.
  // WEBCHANNEL_DEMO_MODEL overrides the primary model (e.g. to switch off a
  // quota-exhausted provider onto another configured one like zai/glm-4.7).
  const modelOverride = (process.env.WEBCHANNEL_DEMO_MODEL || "").trim();
  const agentDefaults = {
    model: modelOverride ? { primary: modelOverride } : realDefaults.model,
    compaction: { reserveTokensFloor: (realDefaults.compaction && realDefaults.compaction.reserveTokensFloor) || 20000 },
  };
  const cfg = {
    gateway: { mode: "local", bind: "loopback" },
    models: real.models,                 // <-- REAL providers, verbatim
    agents: { defaults: agentDefaults },  // <-- REAL default model (e.g. xiaomi-token-plan/mimo-v2.5-pro)
    plugins: {
      load: { paths: [process.env.REPO + "/packages/plugin"] },
      allow: ["webchannel"],
      entries: { webchannel: { enabled: true } },
    },
    channels: {
      webchannel: {
        auth: {
          strategy: "jwt",
          jwt: {
            jwksUrl: "http://127.0.0.1:" + process.env.ISSUER_PORT + "/.well-known/jwks.json",
            issuer: process.env.SAAS_ISSUER,
            audience: process.env.ACCOUNT_ID,
          },
        },
        dmSecurity: "allowlist",
        allowFrom: [process.env.PEER_ID],
      },
    },
  };
  fs.writeFileSync(process.env.OCH + "/.openclaw/openclaw.json", JSON.stringify(cfg, null, 2) + "\n");
  console.log("[run-demo] inherited real model:", agentDefaults.model.primary, "| providers:", Object.keys(real.models.providers).join(","));
'
echo "[run-demo] wrote $OCH/.openclaw/openclaw.json (real agent/model inherited)"

# ---------------------------------------------------------------------------
# 5b. Inherit the REAL agent's provider auth. openclaw stores provider API keys
#     NOT in env / openclaw.json but in the per-agent auth store (sqlite) under
#     agents/<id>/agent/. Without it the demo agent fails every model call with
#     "No API key found for provider …". We copy the real "main" agent's auth
#     store (+ its WAL/SHM sidecars + models.json) into the demo's isolated agent
#     dir BEFORE the gateway pre-warms provider auth at boot. READ-only on the
#     real store; the copy lands entirely under the isolated $OCH.
#     ($HOME is still the real user home here — only the gateway subprocess below
#     runs under HOME=$OCH.)
# ---------------------------------------------------------------------------
REAL_AGENT_DIR="${OPENCLAW_REAL_AGENT_DIR:-$HOME/.openclaw/agents/main/agent}"
DEMO_AGENT_DIR="$OCH/.openclaw/agents/main/agent"
if [ -f "$REAL_AGENT_DIR/openclaw-agent.sqlite" ]; then
  mkdir -p "$DEMO_AGENT_DIR"
  cp "$REAL_AGENT_DIR"/openclaw-agent.sqlite* "$DEMO_AGENT_DIR"/ 2>/dev/null || true
  [ -f "$REAL_AGENT_DIR/models.json" ] && cp "$REAL_AGENT_DIR/models.json" "$DEMO_AGENT_DIR"/ 2>/dev/null || true
  echo "[run-demo] copied real agent auth store → $DEMO_AGENT_DIR (provider keys inherited)"
else
  echo "[run-demo] WARNING: real agent auth store not found at $REAL_AGENT_DIR — model calls may fail with missing-provider-auth. Set OPENCLAW_REAL_AGENT_DIR."
fi

# ---------------------------------------------------------------------------
# 6. Boot the isolated gateway. NO WEBCHANNEL_NATS_DEV_OPEN → enrolled path runs.
#    HOME=$OCH isolates the plugin's enrollment credential store under $OCH.
#
#    NOTE: we deliberately do NOT pass WEBCHANNEL_NATS_URL. The SaaS is the
#    rendezvous authority — the enrolled plugin receives the relay URL inside its
#    EnrollmentResult (the issuer was booted with NATS_URL=ws://…:$NATS_WS in
#    step 1) and dials THAT. The only SaaS coordinate the plugin still needs is
#    where the SaaS itself lives (WEBCHANNEL_SAAS_BASE_URL). This is the whole
#    point of the rework: the operator no longer configures the NATS URL.
# ---------------------------------------------------------------------------
HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_SAAS_BASE_URL="http://127.0.0.1:$ISSUER_PORT" \
  WEBCHANNEL_TENANT="$TENANT" WEBCHANNEL_ACCOUNT_ID="$ACCOUNT_ID" \
  WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$GW_PORT" --force \
  >"$OCH/gateway.log" 2>&1 &
GW_PID=$!
echo "[run-demo] gateway pid=$GW_PID — waiting for enrollment user_code…"

# 6a. Auto-approve: scrape the user_code the plugin prints, POST it to /approve.
USER_CODE=""
for i in $(seq 1 240); do
  USER_CODE="$(grep -oE 'User code: [A-Z]{4}-[A-Z]{4}' "$OCH/gateway.log" 2>/dev/null | head -1 | awk '{print $3}' || true)"
  if [ -n "$USER_CODE" ]; then break; fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "[run-demo] gateway died before enrollment — log:"; cat "$OCH/gateway.log"; exit 2
  fi
  sleep 0.25
done
[ -z "$USER_CODE" ] && { echo "[run-demo] TIMEOUT waiting for user_code — gateway log:"; cat "$OCH/gateway.log"; exit 2; }
echo "[run-demo] enrollment user_code=$USER_CODE — approving…"
APPROVE="$(curl -fsS -X POST "http://127.0.0.1:$ISSUER_PORT/approve" \
  -H 'Content-Type: application/json' -d "{\"user_code\":\"$USER_CODE\"}" || true)"
echo "[run-demo] approve response: $APPROVE"

# 6b. Wait for the plugin to poll, receive creds, NKEY-connect, and register.
echo "[run-demo] waiting for plugin registration (enrolled NATS connect)…"
for i in $(seq 1 240); do
  if grep -q "\[webchannel\] ✓ NATS mode plugin registered" "$OCH/gateway.log" 2>/dev/null; then
    echo "[run-demo] gateway ready (enrolled + connected)"
    break
  fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "[run-demo] gateway died early — log:"; cat "$OCH/gateway.log"; exit 2
  fi
  sleep 0.5
  if [ "$i" -eq 240 ]; then
    echo "[run-demo] TIMEOUT waiting for gateway registration — log:"; cat "$OCH/gateway.log"; exit 2
  fi
done

# ---------------------------------------------------------------------------
# 7. Launch the PERSISTENT chat server (NOT a headless one-shot driver) and BLOCK
#    so a human can open the URL and chat. Ctrl+C → EXIT trap tears it all down.
# ---------------------------------------------------------------------------
echo "[run-demo] starting interactive chat server…"
WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
WEBCHANNEL_ISSUER_URL="http://127.0.0.1:$ISSUER_PORT" \
WEBCHANNEL_TENANT="$TENANT" WEBCHANNEL_ACCOUNT_ID="$ACCOUNT_ID" WEBCHANNEL_PEER_ID="$PEER_ID" \
WEBCHANNEL_PAGE_PORT="$PAGE_PORT" \
  node "$REPO/e2e/local/demo-server.mjs" >"$OCH/demo-server.log" 2>&1 &
DEMO_PID=$!
echo "[run-demo] demo-server pid=$DEMO_PID — waiting for it to serve…"

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$PAGE_PORT/" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$DEMO_PID" 2>/dev/null; then
    echo "[run-demo] demo-server died early — log:"; cat "$OCH/demo-server.log"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-demo] TIMEOUT waiting for demo-server — log:"; cat "$OCH/demo-server.log"; exit 2
  fi
done

echo ""
echo "==================================================================="
echo "  WebChannel live chat demo is UP."
echo ""
echo "    Open this in your browser and chat with the agent:"
echo ""
echo "        http://127.0.0.1:$PAGE_PORT/"
echo ""
echo "  Ctrl+C to tear everything down."
echo "==================================================================="
echo ""

# Block until the user Ctrl+C (EXIT trap then cleans up). `wait` on the demo
# server PID keeps us alive and exits if the server itself dies.
wait "$DEMO_PID"
