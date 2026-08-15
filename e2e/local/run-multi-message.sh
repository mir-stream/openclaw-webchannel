#!/usr/bin/env bash
# Hermetic #94 multi-assistant-message E2E. Boots the SAME real topology as
# run-enrolled-transport.sh / run-turn-outcome.sh — real device-flow
# enrollment-server, JWT-auth nats-server, a real openclaw gateway running the
# real plugin, and a NKEY-authenticated driver peer that drives the real PoP
# register hop — with `streaming.mode:"partial"` (the mode the defect lives in;
# without it no draft lane is ever created) and an echo provider armed to produce
# TWO real assistant messages in ONE turn.
#
# WHAT IT PROVES (issue #94): in partial mode the channel used to mint ONE draft
# id per TURN and accumulate every assistant message into it; the turn's `final`
# then replaced that merged bubble with the LAST message's text, erasing earlier
# assistant text the user had already watched stream. A multi-assistant-message
# turn must settle as TWO DISTINCT ids on the wire, in model order, with the
# first message's text intact — and the turn must still settle `ok`.
#
# HOW THE SECOND MESSAGE IS REAL: the only way a provider drives a second
# assistant message inside one turn is a tool call. The echo server answers phase
# 1 with assistant text A PLUS a `tool_calls` entry and `finish_reason:
# "tool_calls"`; core executes the tool and comes back for phase 2, which returns
# assistant text B with `finish_reason:"stop"`. Nothing here fakes a message
# boundary — core's own agent loop produces both, and the plugin sees exactly the
# callback interleaving a production multi-message turn produces.
#
# WHY A LIVE HARNESS: both review rounds on the fix caught defects that were unit
# fixtures encoding an ordering core does not actually produce, and the fix's
# remaining residual (plan §12.2(5)) fires exactly as often as core skews a block
# drain relative to the delta stream. No unit test can answer that; this can. The
# driver logs EVERY inbound frame with its type, id and text before asserting —
# that record is a deliverable in itself.
#
# ECHO_MULTI_MSG_TOOL must name a tool core ACTUALLY advertises to the model in
# this config and can execute. Captured empirically from `body.tools` on a live
# run of run-enrolled-transport.sh (27 tools advertised); `agents_list` is the
# pick — zero parameters, side-effect-free, no filesystem or network state.
#
# Everything runs under an isolated OPENCLAW_HOME=/tmp/oc-multi-message-e2e (and
# HOME=$OCH so the plugin's enrollment credential store is isolated too); your
# real ~/.openclaw and ~/.openclaw-webchannel-v2 are never touched. Distinct ports
# avoid colliding with the other harnesses. Self-cleaning (trap on EXIT).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OCH=/tmp/oc-multi-message-e2e
PKG_JSON="$REPO/packages/plugin/package.json"
# Keep the backup OUTSIDE $OCH: $OCH is rm -rf'd at startup, so a backup living
# inside it would be wiped by the NEXT run before we could restore the original —
# permanently stranding the swapped (index-nats.ts) package.json in git.
PKG_BAK=/tmp/oc-multi-message-e2e.pkgbak.json

# Ports (GW_PORT/NATS_WS/NATS_TCP/ECHO_PORT/ISSUER_PORT) come from
# e2e/local/ports.json — the single source of truth for both this harness family
# and the *-realserver.test.ts suites (#118/#119). Never hard-code one here.
. "$REPO/e2e/local/lib/harness.sh"
harness_ports run-multi-message
export ECHO_MULTI_MSG_MARKER="${ECHO_MULTI_MSG_MARKER:-ISSUE94_TWO_MESSAGES}"
export ECHO_MULTI_MSG_TOOL="${ECHO_MULTI_MSG_TOOL:-agents_list}"
# Turn 2's fixture: the same tool loop with a TEXT-LESS first assistant message.
# Both the echo server and the driver read this name, so it must be exported
# here — if it is unset the server never enters tool-first mode and turn 2
# degenerates into a plain echo, which the driver reports as a missing answer.
export ECHO_TOOL_FIRST_MARKER="${ECHO_TOOL_FIRST_MARKER:-ISSUE94_TOOL_FIRST}"
ENROLLMENT_ADMIN_TOKEN="${ENROLLMENT_ADMIN_TOKEN:-local-e2e-admin-token}"

TENANT=default-tenant
ACCOUNT_ID=default-agent
PEER_ID=multi-message-peer
SAAS_ISSUER="https://saas.local/multi-message-issuer"

NATS_PID=""; ECHO_PID=""; ISSUER_PID=""; GW_PID=""; ADD_PID=""

cleanup() {
  echo "[run-multi-message] cleanup…"
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
    echo "[run-multi-message] restored $PKG_JSON"
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
# 0. Build the plugin bundle from the working tree (#125).
#
#    This harness pioneered the build step; as of #125 all six do it here, via
#    the shared helper, so the rationale and the bisection evidence live once in
#    e2e/local/lib/harness.sh. It used to run at step 4, after the issuer,
#    nats-server and echo server were already up; moved here so a broken build
#    fails fast and this gate matches the other five.
# ---------------------------------------------------------------------------
harness_build_plugin run-multi-message "$OCH/plugin-build.log"

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
echo "[run-multi-message] enrollment-server pid=$ISSUER_PID — waiting for JWKS + NATS config…"
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$ISSUER_PORT/.well-known/jwks.json" >/dev/null 2>&1 \
     && [ -f "$OCH/operator.jwt" ] && [ -f "$OCH/resolver.json" ]; then
    echo "[run-multi-message] issuer ready (JWKS up, NATS config written)"
    break
  fi
  if ! kill -0 "$ISSUER_PID" 2>/dev/null; then
    echo "[run-multi-message] enrollment-server died early — log:"; cat "$OCH/issuer.log"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-multi-message] TIMEOUT waiting for issuer — log:"; cat "$OCH/issuer.log"; exit 2
  fi
done

# ---------------------------------------------------------------------------
# 2. JWT-auth nats-server, built from the SAME trust chain's operator + resolver.
# ---------------------------------------------------------------------------
NATS_CONFIG_DIR="$OCH" NATS_TCP="$NATS_TCP" NATS_WS="$NATS_WS" \
  node --import tsx "$REPO/scripts/generate-nats-server-config.mjs"
nats-server -c "$OCH/nats.conf" >"$OCH/nats.log" 2>&1 &
NATS_PID=$!
echo "[run-multi-message] nats-server pid=$NATS_PID (JWT-auth, ws://127.0.0.1:$NATS_WS) — waiting…"
for i in $(seq 1 120); do
  if grep -q "Server is ready" "$OCH/nats.log" 2>/dev/null; then
    echo "[run-multi-message] nats-server ready"
    break
  fi
  if ! kill -0 "$NATS_PID" 2>/dev/null; then
    echo "[run-multi-message] nats-server died early — log:"; cat "$OCH/nats.log"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-multi-message] TIMEOUT waiting for nats-server — log:"; cat "$OCH/nats.log"; exit 2
  fi
done

# ---------------------------------------------------------------------------
# 3. Echo model server (no real LLM), armed for the two-phase tool-call turn.
# ---------------------------------------------------------------------------
node "$REPO/e2e/local/echo-openai-server.mjs" "$ECHO_PORT" >"$OCH/echo.log" 2>&1 &
ECHO_PID=$!
echo "[run-multi-message] echo server pid=$ECHO_PID (multi-msg marker=$ECHO_MULTI_MSG_MARKER, tool=$ECHO_MULTI_MSG_TOOL)"

# ---------------------------------------------------------------------------
# 4. Point the entry at index-nats.ts. (The build moved to step 0 — see there.)
# ---------------------------------------------------------------------------

# The entry swap itself is kept for parity with the other five harnesses (and so
# a core that DOES honour a .ts entry loads the same source the build above came
# from) — but per the measurement in the block above it is not what makes this
# harness see the working tree; the build is.
#
# Crash recovery: if a prior run was hard-killed mid-swap, $PKG_BAK still holds
# the ORIGINAL package.json while the tracked one is left swapped. Restore it
# first, THEN take a fresh backup — so this swap is itself crash-recoverable.
if [ -f "$PKG_BAK" ]; then
  echo "[run-multi-message] stale $PKG_BAK found — restoring original package.json before re-swapping"
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
echo "[run-multi-message] set plugin extensions → ./index-nats.ts"

# ---------------------------------------------------------------------------
# 5. Isolated openclaw config: echo provider + single agent + webchannel(jwt),
#    with streaming.mode "partial" on the account. That mode is not decoration:
#    it is the ONLY mode that creates a draft lane, and #94 is a draft-lane
#    defect. In "block"/"off" the plugin takes the plain append path and this
#    harness would prove nothing.
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
echo "[run-multi-message] wrote $OCH/.openclaw/openclaw.json (streaming.mode=partial)"

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
echo "[run-multi-message] channels add (config-time device-flow enroll)…"
HOME="$OCH" OPENCLAW_HOME="$OCH" OPENCLAW_DISABLE_BONJOUR=1 \
  "$REPO/node_modules/.bin/openclaw" channels add --channel webchannel --account "$ACCOUNT_ID" \
    --base-url "http://127.0.0.1:$ISSUER_PORT" --url "$TENANT" \
  >"$OCH/channels-add.log" 2>&1 &
ADD_PID=$!
echo "[run-multi-message] channels add pid=$ADD_PID — waiting for enrollment user_code…"

# 6a. Auto-approve: scrape the user_code the device flow prints to the
#     channels-add output (NOT gateway.log anymore), POST it to /approve.
USER_CODE=""
for i in $(seq 1 240); do
  USER_CODE="$(grep -oE 'User code: [A-Z]{4}-[A-Z]{4}' "$OCH/channels-add.log" 2>/dev/null | head -1 | awk '{print $3}' || true)"
  if [ -n "$USER_CODE" ]; then break; fi
  if ! kill -0 "$ADD_PID" 2>/dev/null; then
    echo "[run-multi-message] channels add exited before user_code — log:"; cat "$OCH/channels-add.log"; exit 2
  fi
  sleep 0.25
done
[ -z "$USER_CODE" ] && { echo "[run-multi-message] TIMEOUT waiting for user_code — channels-add log:"; cat "$OCH/channels-add.log"; exit 2; }
echo "[run-multi-message] enrollment user_code=$USER_CODE — approving…"
APPROVE="$(curl -fsS -X POST "http://127.0.0.1:$ISSUER_PORT/approve" \
  -H "Authorization: Bearer $ENROLLMENT_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d "{\"user_code\":\"$USER_CODE\"}" || true)"
echo "[run-multi-message] approve response: $APPROVE"

# 6b. Let `channels add` finish: it polls /poll, receives creds, persists them,
#     and exits 0 (no NATS connect happens here — acquisition only).
set +e; wait "$ADD_PID"; ADD_RC=$?; set -e
ADD_PID=""
if [ "$ADD_RC" -ne 0 ]; then
  echo "[run-multi-message] channels add failed (rc=$ADD_RC) — log:"; cat "$OCH/channels-add.log"; exit 2
fi
CRED_FILE="$(node --import tsx "$REPO/scripts/resolve-storage-path.ts" \
  credentials "$TENANT" "$ACCOUNT_ID" "$OCH")"
[ -f "$CRED_FILE" ] || { echo "[run-multi-message] creds NOT persisted at $CRED_FILE — log:"; cat "$OCH/channels-add.log"; exit 2; }
echo "[run-multi-message] ✓ credentials persisted at $CRED_FILE"

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
#      re-written here and VERIFIED below.
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
' "$OCH/.openclaw/openclaw.json" "$ACCOUNT_ID" "$PEER_ID"
echo "[run-multi-message] ✓ re-asserted admission=register-hop + dmSecurity=allowlist + streaming.mode=partial for account $ACCOUNT_ID"

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
echo "[run-multi-message] gateway pid=$GW_PID — waiting for structured account readiness (consume persisted creds)…"
for i in $(seq 1 240); do
  LATEST_AGGREGATE="$(grep "event=webchannel\.account_aggregate" "$OCH/gateway.log" 2>/dev/null | tail -n 1 || true)"
  if printf '%s\n' "$LATEST_AGGREGATE" | grep -Eq "event=webchannel\.account_aggregate generation=[^ ]+ state=complete servingCount=1 totalCount=1"; then
    echo "[run-multi-message] gateway ready (consumed creds + connected)"
    break
  fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "[run-multi-message] gateway died early — log:"; cat "$OCH/gateway.log"; exit 2
  fi
  sleep 0.5
  if [ "$i" -eq 240 ]; then
    echo "[run-multi-message] TIMEOUT waiting for structured account readiness — log:"; cat "$OCH/gateway.log"; exit 2
  fi
done

# ASSERT the gateway loaded the bundle step 0 built (#125). Building the right
# file and the gateway LOADING it are two different claims; the build step only
# ever established the first. Reads core own resolution record from the log.
harness_assert_loaded_dist run-multi-message "$OCH/gateway.log"

# ---------------------------------------------------------------------------
# 7. Drive the NKEY-authenticated encrypted round-trip.
# ---------------------------------------------------------------------------
echo "[run-multi-message] driving the multi-assistant-message turn…"
set +e
WEBCHANNEL_GW_URL="http://127.0.0.1:$GW_PORT" \
WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
WEBCHANNEL_ISSUER_URL="http://127.0.0.1:$ISSUER_PORT" \
WEBCHANNEL_TENANT="$TENANT" WEBCHANNEL_ACCOUNT_ID="$ACCOUNT_ID" WEBCHANNEL_PEER_ID="$PEER_ID" \
  node --import tsx "$REPO/e2e/local/multi-message-roundtrip.ts"
RC=$?
set -e

# The echo log is the record of what the PROVIDER did (which phases fired, and
# with which tool). Print it next to the driver's frame log so a CI failure can
# be diagnosed without re-running.
echo "[run-multi-message] echo provider log:"
grep -E '^\[echo\] (multi|tool-first|WARN|FAIL)' "$OCH/echo.log" || echo "  (none)"

# …and ASSERT on it. The driver can only see frames; it cannot tell "the plugin
# handled two assistant messages correctly" from "the provider never produced a
# second one." Both fixtures are two-phase, so a missing `phase 1` line means
# that turn made no tool call and silently degenerated into an ordinary
# one-message turn — the harness would then pass while testing nothing.
#
# This is not hypothetical: phase detection originally scanned the whole
# transcript, so turn 2 saw turn 1's `role:"tool"` message and skipped straight
# to phase 2. The driver stayed green.
for phase in 'multi phase 1' 'multi phase 2' 'tool-first phase 1' 'tool-first phase 2'; do
  if ! grep -qF "[echo] $phase" "$OCH/echo.log"; then
    echo "[run-multi-message] FAIL: the provider never logged '$phase' — that fixture did not run."
    echo "[run-multi-message] the turn produced fewer assistant messages than the harness asserts on;"
    echo "[run-multi-message] a green driver here would be testing nothing."
    # Never clobber a more specific driver failure: a run that fails an
    # assertion AND misses a phase line must still report the assertion.
    [ "$RC" -eq 0 ] && RC=7
  fi
done

echo "[run-multi-message] driver exit code = $RC"
exit "$RC"
