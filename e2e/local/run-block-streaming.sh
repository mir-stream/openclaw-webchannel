#!/usr/bin/env bash
# Hermetic #94/#111 BLOCK-STREAMING multi-assistant-message E2E. Same real
# topology and same driver as run-multi-message.sh — real device-flow
# enrollment-server, JWT-auth nats-server, a real openclaw gateway running the
# real plugin, a NKEY-authenticated driver peer over the real PoP register hop,
# `streaming.mode:"partial"` and an echo provider armed to produce TWO real
# assistant messages in ONE turn — with ONE config difference:
# `agents.defaults.blockStreamingDefault:"on"`.
#
# WHY THAT ONE FLAG NEEDS ITS OWN HARNESS (issue #111): with block streaming off,
# each assistant message reaches this channel exactly once — as the turn's draft
# partials, settled by the lane. With it ON, core ALSO dispatches each completed
# assistant message as its own `kind:"block"` delivery. The channel used to send
# every block down the independent path (fresh wire id), so a two-message turn
# settled as FOUR bubbles — each answer twice, once from the block and once from
# the lane that had already streamed it. run-multi-message.sh cannot see that:
# without the flag no block delivery is ever produced, so the duplicate shape is
# unreachable there. Measured on the pinned core (2026.6.10) before the fix:
#   #02 agent_message id=n34zbj "ISSUE94_MESSAGE_A …"   <- independent block
#   #03 agent_message id=cl4jv9 "ISSUE94_MESSAGE_A …"   <- the lane that streamed it
#   #04 agent_message id=jgqt6u "ZZZ94_SECOND_ANSWER …" <- independent block
#   #05 agent_message id=vne2pu "ZZZ94_SECOND_ANSWER …"
# The driver's assertion is exactly-one-settled-bubble-per-assistant-message, so
# this harness fails on that shape and passes only when each block is attributed
# to the lane that owns its `assistantMessageIndex`.
#
# HOW THE SECOND MESSAGE IS REAL: the only way a provider drives a second
# assistant message inside one turn is a tool call. The echo server answers phase
# 1 with assistant text A PLUS a `tool_calls` entry and `finish_reason:
# "tool_calls"`; core executes the tool and comes back for phase 2, which returns
# assistant text B with `finish_reason:"stop"`. Nothing here fakes a message
# boundary — core's own agent loop produces both, and the plugin sees exactly the
# callback interleaving a production multi-message turn produces.
#
# WHY A LIVE HARNESS: the routing this gate protects is driven by a field
# (`assistantMessageIndex` on the delivery seam's runtime info) that the PUBLIC
# `ChannelDeliveryInfo` type does not even declare — it is present because core
# hands the channel adapter the dispatcher's own `ReplyDispatchRuntimeInfo`
# verbatim (kernel-BROH42tr.js:696/:721 → reply-dispatcher.types-CVYQHGPk.js:12).
# A unit fixture asserting that field is only ever asserting our own mock. Only a
# real gateway running a real agent loop over a real tool call can show that core
# still supplies it, and that the resulting attribution produces one bubble per
# message. The driver logs EVERY inbound frame with its type, id and text before
# asserting — that record is a deliverable in itself.
#
# ECHO_MULTI_MSG_TOOL must name a tool core ACTUALLY advertises to the model in
# this config and can execute. Captured empirically from `body.tools` on a live
# run of run-enrolled-transport.sh (27 tools advertised); `agents_list` is the
# pick — zero parameters, side-effect-free, no filesystem or network state.
#
# Everything runs under an isolated OPENCLAW_HOME=/tmp/oc-block-streaming-e2e
# (and HOME=$OCH so the plugin's enrollment credential store is isolated too);
# your real ~/.openclaw and ~/.openclaw-webchannel-v2 are never touched. Its
# ports, peer id and $OCH are all distinct from run-multi-message.sh's so the two
# can run back to back (or concurrently) without colliding. Self-cleaning (trap
# on EXIT).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OCH=/tmp/oc-block-streaming-e2e
PKG_JSON="$REPO/packages/plugin/package.json"
# Keep the backup OUTSIDE $OCH: $OCH is rm -rf'd at startup, so a backup living
# inside it would be wiped by the NEXT run before we could restore the original —
# permanently stranding the swapped (index-nats.ts) package.json in git.
PKG_BAK=/tmp/oc-block-streaming-e2e.pkgbak.json

GW_PORT=19091
NATS_WS=18591
NATS_TCP=14591
ECHO_PORT=19092
ISSUER_PORT=3891
export ECHO_MULTI_MSG_MARKER="${ECHO_MULTI_MSG_MARKER:-ISSUE94_TWO_MESSAGES}"
export ECHO_MULTI_MSG_TOOL="${ECHO_MULTI_MSG_TOOL:-agents_list}"
ENROLLMENT_ADMIN_TOKEN="${ENROLLMENT_ADMIN_TOKEN:-local-e2e-admin-token}"

TENANT=default-tenant
ACCOUNT_ID=default-agent
PEER_ID=block-streaming-peer
SAAS_ISSUER="https://saas.local/block-streaming-issuer"

NATS_PID=""; ECHO_PID=""; ISSUER_PID=""; GW_PID=""; ADD_PID=""

cleanup() {
  echo "[run-block-streaming] cleanup…"
  [ -n "$ADD_PID" ]    && kill "$ADD_PID"    2>/dev/null || true
  [ -n "$GW_PID" ]     && kill "$GW_PID"     2>/dev/null || true
  [ -n "$ISSUER_PID" ] && kill "$ISSUER_PID" 2>/dev/null || true
  [ -n "$ECHO_PID" ]   && kill "$ECHO_PID"   2>/dev/null || true
  [ -n "$NATS_PID" ]   && kill "$NATS_PID"   2>/dev/null || true
  pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
  pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
  # NOTE: no broad `pkill -f enrollment-server.ts` — the issuer PORT is passed as
  # an env var (not an argv flag) so it can't be matched by port, and a broad
  # match would kill an unrelated enrollment-server (parallel harness/dev run).
  # The ISSUER_PID kill above is sufficient (same as gateway/nats rely on).
  pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
  if [ -f "$PKG_BAK" ]; then
    cp "$PKG_BAK" "$PKG_JSON"
    rm -f "$PKG_BAK"
    echo "[run-block-streaming] restored $PKG_JSON"
  fi
}
trap cleanup EXIT

# Pre-clean leftover procs / dir.
pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
pkill -f "echo-openai-server.mjs $ECHO_PORT" 2>/dev/null || true
# No broad enrollment-server pkill — see cleanup() note (would kill unrelated runs).
pkill -f "gateway --port $GW_PORT" 2>/dev/null || true
rm -rf "$OCH"
mkdir -p "$OCH/.openclaw"

# ---------------------------------------------------------------------------
# 1. REAL device-flow enrollment-server (single trust chain). Writes the public
#    NATS config to $OCH and serves JWKS + test routes.
# ---------------------------------------------------------------------------
PORT="$ISSUER_PORT" \
SAAS_BASE_URL="http://127.0.0.1:$ISSUER_PORT" \
SAAS_ISSUER="$SAAS_ISSUER" \
NATS_URL="ws://127.0.0.1:$NATS_WS" \
NATS_CONFIG_OUT="$OCH" \
ENABLE_TEST_ROUTES=1 \
ENROLLMENT_ADMIN_TOKEN="$ENROLLMENT_ADMIN_TOKEN" \
POLL_INTERVAL_SECONDS=1 \
  node --import tsx "$REPO/packages/saas/reference/enrollment-server.ts" >"$OCH/issuer.log" 2>&1 &
ISSUER_PID=$!
echo "[run-block-streaming] enrollment-server pid=$ISSUER_PID — waiting for JWKS + NATS config…"
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$ISSUER_PORT/.well-known/jwks.json" >/dev/null 2>&1 \
     && [ -f "$OCH/operator.jwt" ] && [ -f "$OCH/resolver.json" ]; then
    echo "[run-block-streaming] issuer ready (JWKS up, NATS config written)"
    break
  fi
  if ! kill -0 "$ISSUER_PID" 2>/dev/null; then
    echo "[run-block-streaming] enrollment-server died early — log:"; cat "$OCH/issuer.log"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-block-streaming] TIMEOUT waiting for issuer — log:"; cat "$OCH/issuer.log"; exit 2
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
echo "[run-block-streaming] nats-server pid=$NATS_PID (JWT-auth, ws://127.0.0.1:$NATS_WS) — waiting…"
for i in $(seq 1 120); do
  if grep -q "Server is ready" "$OCH/nats.log" 2>/dev/null; then
    echo "[run-block-streaming] nats-server ready"
    break
  fi
  if ! kill -0 "$NATS_PID" 2>/dev/null; then
    echo "[run-block-streaming] nats-server died early — log:"; cat "$OCH/nats.log"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-block-streaming] TIMEOUT waiting for nats-server — log:"; cat "$OCH/nats.log"; exit 2
  fi
done

# ---------------------------------------------------------------------------
# 3. Echo model server (no real LLM), armed for the two-phase tool-call turn.
# ---------------------------------------------------------------------------
node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_PORT" >"$OCH/echo.log" 2>&1 &
ECHO_PID=$!
echo "[run-block-streaming] echo server pid=$ECHO_PID (multi-msg marker=$ECHO_MULTI_MSG_MARKER, tool=$ECHO_MULTI_MSG_TOOL)"

# ---------------------------------------------------------------------------
# 4. Build the plugin bundle, THEN point the entry at index-nats.ts.
#
#     The build is not optional here, and it is not what the other harnesses do.
#     MEASURED on the pinned core (2026.6.10): the gateway resolves this plugin's
#     BUILT bundle regardless of the entry swap below —
#       [plugins] channel "webchannel" registered … (plugin=webchannel,
#         source=…/packages/plugin/dist/index-nats.js)
#     Proven by bisection while validating this gate: with the #94 fix reverted in
#     `src/` but a stale FIXED `dist/` on disk the harness PASSED (exit 0); with
#     `dist/` rebuilt from the same reverted `src/` it FAILED (exit 6). A harness
#     that boots against a stale bundle is exactly the "passes without exercising
#     the boundary" gate this is supposed to prevent, so the working tree is built
#     first and the run always reflects `src/`.
#
#     In CI this is redundant (the gate builds the plugin at step 5c before any
#     harness runs) and costs ~20ms of esbuild; locally it is the difference
#     between a real gate and a green light for code that never ran.
# ---------------------------------------------------------------------------
echo "[run-block-streaming] building plugin dist/ from the working tree…"
( cd "$REPO" && npm run build --workspace=packages/plugin ) >"$OCH/plugin-build.log" 2>&1 || {
  echo "[run-block-streaming] plugin build FAILED — log:"; cat "$OCH/plugin-build.log"; exit 2
}

# The entry swap itself is kept for parity with the other five harnesses (and so
# a core that DOES honour a .ts entry loads the same source the build above came
# from) — but per the measurement in the block above it is not what makes this
# harness see the working tree; the build is.
#
# Crash recovery: if a prior run was hard-killed mid-swap, $PKG_BAK still holds
# the ORIGINAL package.json while the tracked one is left swapped. Restore it
# first, THEN take a fresh backup — so this swap is itself crash-recoverable.
if [ -f "$PKG_BAK" ]; then
  echo "[run-block-streaming] stale $PKG_BAK found — restoring original package.json before re-swapping"
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
echo "[run-block-streaming] set plugin extensions → ./index-nats.ts"

# ---------------------------------------------------------------------------
# 5. Isolated openclaw config: echo provider + single agent + webchannel(jwt),
#    with streaming.mode "partial" on the account. That mode is not decoration:
#    it is the ONLY mode that creates a draft lane, and #94 is a draft-lane
#    defect. In "block"/"off" the plugin takes the plain append path and this
#    harness would prove nothing.
#
#    `agents.defaults.blockStreamingDefault:"on"` is what makes this harness
#    different from run-multi-message.sh, and it is the whole point of the file:
#    it is what makes core dispatch each completed assistant message as its own
#    `kind:"block"` delivery ALONGSIDE the partials the lane already streamed.
#    Both settings are re-asserted and verified after `channels add` (step 6b²) —
#    if either one silently disappeared this harness would pass while testing
#    nothing.
# ---------------------------------------------------------------------------
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
      "compaction": { "reserveTokensFloor": 20000 },
      "blockStreamingDefault": "on"
    }
  },
  "plugins": {
    "load": { "paths": ["$REPO/packages/plugin"] },
    "allow": ["webchannel"],
    "entries": { "webchannel": { "enabled": true } }
  },
  "channels": {
    "webchannel": {
      "accounts": {
        "$ACCOUNT_ID": {
          "tenant": "$TENANT",
          "streaming": { "mode": "partial" },
          "auth": {
            "strategy": "jwt",
            "jwt": {
              "jwksUrl": "http://127.0.0.1:$ISSUER_PORT/.well-known/jwks.json",
              "issuer": "$SAAS_ISSUER"
            }
          },
          "dmSecurity": "allowlist",
          "allowFrom": ["$PEER_ID"]
        }
      }
    }
  }
}
JSON
echo "[run-block-streaming] wrote $OCH/.openclaw/openclaw.json (streaming.mode=partial)"

# ---------------------------------------------------------------------------
# 6. CONFIG-TIME credential acquisition via `openclaw channels add` (가-1).
#    After Cycle 1/2 the gateway is CONSUME-ONLY — it no longer enrolls. The
#    device flow runs HERE, at config time, exactly as a production operator runs
#    `openclaw channels add`. HOME=$OCH so creds persist to
#    the tuple-scoped v2 credentials path under $OCH, which the gateway
#    (also HOME=$OCH) consumes. Identity is passed via the generic CLI flags the
#    webchannel setup adapter maps: --base-url→saas.baseUrl, --url→tenant. The
#    wire identity is the --account value itself (no --token→agentId mapping
#    anymore — the handling agent is selected separately via `agents bind`).
# ---------------------------------------------------------------------------
echo "[run-block-streaming] channels add (config-time device-flow enroll)…"
HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  "$REPO/node_modules/.bin/openclaw" channels add --channel webchannel --account "$ACCOUNT_ID" \
    --base-url "http://127.0.0.1:$ISSUER_PORT" --url "$TENANT" \
  >"$OCH/channels-add.log" 2>&1 &
ADD_PID=$!
echo "[run-block-streaming] channels add pid=$ADD_PID — waiting for enrollment user_code…"

# 6a. Auto-approve: scrape the user_code the device flow prints to the
#     channels-add output (NOT gateway.log anymore), POST it to /approve.
USER_CODE=""
for i in $(seq 1 240); do
  USER_CODE="$(grep -oE 'User code: [A-Z]{4}-[A-Z]{4}' "$OCH/channels-add.log" 2>/dev/null | head -1 | awk '{print $3}' || true)"
  if [ -n "$USER_CODE" ]; then break; fi
  if ! kill -0 "$ADD_PID" 2>/dev/null; then
    echo "[run-block-streaming] channels add exited before user_code — log:"; cat "$OCH/channels-add.log"; exit 2
  fi
  sleep 0.25
done
[ -z "$USER_CODE" ] && { echo "[run-block-streaming] TIMEOUT waiting for user_code — channels-add log:"; cat "$OCH/channels-add.log"; exit 2; }
echo "[run-block-streaming] enrollment user_code=$USER_CODE — approving…"
APPROVE="$(curl -fsS -X POST "http://127.0.0.1:$ISSUER_PORT/approve" \
  -H "Authorization: Bearer $ENROLLMENT_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d "{\"user_code\":\"$USER_CODE\"}" || true)"
echo "[run-block-streaming] approve response: $APPROVE"

# 6b. Let `channels add` finish: it polls /poll, receives creds, persists them,
#     and exits 0 (no NATS connect happens here — acquisition only).
set +e; wait "$ADD_PID"; ADD_RC=$?; set -e
ADD_PID=""
if [ "$ADD_RC" -ne 0 ]; then
  echo "[run-block-streaming] channels add failed (rc=$ADD_RC) — log:"; cat "$OCH/channels-add.log"; exit 2
fi
CRED_FILE="$(node --import tsx "$REPO/scripts/resolve-storage-path.ts" \
  credentials "$TENANT" "$ACCOUNT_ID" "$OCH")"
[ -f "$CRED_FILE" ] || { echo "[run-block-streaming] creds NOT persisted at $CRED_FILE — log:"; cat "$OCH/channels-add.log"; exit 2; }
echo "[run-block-streaming] ✓ credentials persisted at $CRED_FILE"

# 6b². Re-assert the register-hop admission shape AND streaming.mode AFTER
#      `channels add`. The setup adapter writes the demo-proven block
#      (`admission: "register-hop"`, `dmSecurity: "open"`) into the account — but
#      "auto" is an EXPLICIT override that disables the account-bound NATS
#      register hop (the live account subject has no prepared verifier/handler),
#      and this harness exists precisely to drive the register hop. Restore the
#      pre-add intent: register-hop admission + allowlist DM security. The
#      streaming re-assert is a hard requirement, not belt-and-braces: if the
#      adapter's patch ever drops `streaming`, this harness would silently fall
#      back to the no-draft path and pass without testing anything, so it is
#      re-written here and VERIFIED below. `blockStreamingDefault` is only
#      VERIFIED (never re-written): it lives under `agents.defaults`, which
#      `channels add` has no business touching — if it ever did, this harness
#      would degenerate into a second copy of run-multi-message.sh, so the run
#      aborts rather than reporting a green light for a shape it never drove.
node -e '
  const fs = require("fs");
  const p = process.argv[1], acct = process.argv[2], peer = process.argv[3];
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  const a = cfg.channels.webchannel.accounts[acct];
  a.nats = { ...(a.nats ?? {}), admission: "register-hop" };
  a.dmSecurity = "allowlist";
  a.allowFrom = [peer];
  a.streaming = { ...(a.streaming ?? {}), mode: "partial" };
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  if (cfg.channels.webchannel.accounts[acct].streaming.mode !== "partial") {
    console.error("streaming.mode is not partial after re-assert");
    process.exit(1);
  }
  if (cfg.agents?.defaults?.blockStreamingDefault !== "on") {
    console.error("agents.defaults.blockStreamingDefault is not \"on\" after channels add");
    process.exit(1);
  }
' "$OCH/.openclaw/openclaw.json" "$ACCOUNT_ID" "$PEER_ID"
echo "[run-block-streaming] ✓ re-asserted admission=register-hop + dmSecurity=allowlist + streaming.mode=partial for account $ACCOUNT_ID (blockStreamingDefault=on verified)"

# ---------------------------------------------------------------------------
# 6c. Boot the isolated gateway — CONSUME-ONLY. No acquisition env
#     (WEBCHANNEL_SAAS_BASE_URL/_TENANT/_ACCOUNT_ID): identity now lives in the
#     config that `channels add` wrote. Only the connection override
#     WEBCHANNEL_NATS_URL is passed. No user_code at gateway boot anymore.
# ---------------------------------------------------------------------------
HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
  WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
  "$REPO/node_modules/.bin/openclaw" gateway --port "$GW_PORT" --force \
  >"$OCH/gateway.log" 2>&1 &
GW_PID=$!
echo "[run-block-streaming] gateway pid=$GW_PID — waiting for structured account readiness (consume persisted creds)…"
for i in $(seq 1 240); do
  LATEST_AGGREGATE="$(grep "event=webchannel\.account_aggregate" "$OCH/gateway.log" 2>/dev/null | tail -n 1 || true)"
  if printf '%s\n' "$LATEST_AGGREGATE" | grep -Eq "event=webchannel\.account_aggregate generation=[^ ]+ state=complete servingCount=1 totalCount=1"; then
    echo "[run-block-streaming] gateway ready (consumed creds + connected)"
    break
  fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "[run-block-streaming] gateway died early — log:"; cat "$OCH/gateway.log"; exit 2
  fi
  sleep 0.5
  if [ "$i" -eq 240 ]; then
    echo "[run-block-streaming] TIMEOUT waiting for structured account readiness — log:"; cat "$OCH/gateway.log"; exit 2
  fi
done

# ---------------------------------------------------------------------------
# 7. Drive the NKEY-authenticated encrypted round-trip.
# ---------------------------------------------------------------------------
echo "[run-block-streaming] driving the multi-assistant-message turn (block streaming ON)…"
set +e
WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
WEBCHANNEL_ISSUER_URL="http://127.0.0.1:$ISSUER_PORT" \
WEBCHANNEL_TENANT="$TENANT" WEBCHANNEL_ACCOUNT_ID="$ACCOUNT_ID" WEBCHANNEL_PEER_ID="$PEER_ID" \
  node --import tsx "$REPO/e2e/local/multi-message-roundtrip.ts"
RC=$?
set -e

# The echo log is the record of what the PROVIDER did (both phases fired, and
# with which tool). Print it next to the driver's frame log so a CI failure can
# be diagnosed without re-running.
echo "[run-block-streaming] echo provider log:"
grep -E '^\[echo\] (multi-msg|WARN)' "$OCH/echo.log" || echo "  (no multi-msg lines — the marker never reached the provider)"

echo "[run-block-streaming] driver exit code = $RC"
exit "$RC"
