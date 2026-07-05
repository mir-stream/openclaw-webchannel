#!/usr/bin/env bash
# Reference WebChannel app — boot the SaaS backend + a local nats-server, then
# print how to attach an openclaw agent. Everything the app uses from the library
# goes through the PUBLIC @mir-stream/webchannel-{saas,client} package names.
#
# Build MUST precede run: the package exports point at dist/ (gitignored), so a
# stale/absent dist would resolve to nothing. We rebuild both packages first.
#
# Requires: node >= 22, and `nats-server` on PATH.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

PORT="${PORT:-4000}"
NATS_WS="${NATS_WS:-18790}"
RELAY="${RELAY:-self-contained}"

echo "[app] building @mir-stream/webchannel-saas + -client (dist is gitignored — always rebuild)…"
( cd "$REPO" && npm run build -w packages/saas -w packages/client )

echo ""
if [ "$RELAY" = "synadia" ]; then
  # External NGS relay: no local nats-server, so it need not be on PATH. The three
  # NATS_* vars are REQUIRED — index.ts throws a clear error if any are missing.
  echo "[app] relay mode: synadia (Synadia Cloud / NGS — no local nats-server booted)."
  echo "[app] browser + agent both connect OUTBOUND to \$NATS_URL; nothing listens for inbound."
  echo "[app] requires: RELAY=synadia NATS_URL=… NATS_ACCOUNT_ID=A… NATS_ACCOUNT_SIGNING_SEED=SA…"
  echo "[app]   NATS_URL=${NATS_URL:-<unset!>}  NATS_ACCOUNT_ID=${NATS_ACCOUNT_ID:-<unset!>}  (signing seed is SECRET, not echoed)"
  echo "[app] starting SaaS backend on http://127.0.0.1:$PORT…"
else
  command -v nats-server >/dev/null 2>&1 || {
    echo "[app] nats-server not found on PATH — install it (brew install nats-server) and retry." >&2
    echo "[app] (or run against Synadia/NGS instead: RELAY=synadia NATS_URL=… NATS_ACCOUNT_ID=… NATS_ACCOUNT_SIGNING_SEED=… ./run.sh)" >&2
    exit 1
  }
  echo "[app] relay mode: self-contained (boots a local nats-server on ws://127.0.0.1:$NATS_WS)."
  echo "[app]   external NGS instead: RELAY=synadia NATS_URL=… NATS_ACCOUNT_ID=… NATS_ACCOUNT_SIGNING_SEED=… ./run.sh"
  echo "[app] starting SaaS backend on http://127.0.0.1:$PORT (it boots nats-server on ws://127.0.0.1:$NATS_WS)…"
fi
echo "[app] open http://127.0.0.1:$PORT and log in as alice / password."
echo ""
echo "──────────────────────────────────────────────────────────────────────────"
echo " Attach an openclaw agent (YOUR domain — this app does NOT boot openclaw):"
echo ""
echo "   1. Point the webchannel plugin's SaaS URL at http://127.0.0.1:$PORT"
echo "   2. Enroll the gateway (device flow):"
echo "        openclaw channels add webchannel     # prints a user code"
echo "      then approve it (the approve route returns tenant-wide agent creds, so"
echo "      it is ADMIN-GATED — use the admin token the server prints at boot,"
echo "      '[app] admin token …', or set ADMIN_TOKEN yourself):"
echo "        curl -X POST -H 'x-admin-token: <ADMIN_TOKEN>' http://127.0.0.1:$PORT/admin/enrollments/<USER_CODE>/approve"
echo "   3. Run the gateway:"
echo "        openclaw gateway"
echo ""
echo " Until an agent is attached, the browser reaches 'connected' then shows"
echo " '⏳ waiting for agent' (the PoP register has no responder). That is the"
echo " expected no-agent end state — attach openclaw and hit Retry."
echo "──────────────────────────────────────────────────────────────────────────"
echo ""

cd "$HERE"
exec npx tsx server/index.ts
