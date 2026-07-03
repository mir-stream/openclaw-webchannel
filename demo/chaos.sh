#!/usr/bin/env bash
# Scene ③ — "the relay may be hostile". Chaos controls against a LIVE demo
# conversation (run ./demo/run.sh first). All of these target the demo-owned
# nats-server; none of them can read plaintext.
#
#   restart-relay   kill + restart the relay mid-chat. The widget rides it out
#                   (reconnecting → connected); a message typed while it is down
#                   is queued and delivered in order on reconnect — never lost,
#                   only ever ciphertext. Proves AVAILABILITY.
#   tamper          publish a bit-flipped copy of a captured ciphertext frame to
#                   a peer's .out using observer creds. AEAD-open returns null →
#                   the widget silently drops it; the chat stays clean. INTEGRITY.
#   replay-jwt      replay a register challenge/response (reuse a burned nonce).
#                   The gateway returns 401 — the nonce is single-use. AUTH.
#   cross-tenant    mint tenant-b creds and try to subscribe tenant-a's subtree.
#                   The relay answers -ERR Permissions Violation. ISOLATION.
#
# tamper / replay-jwt / cross-tenant delegate to chaos-nats.ts (raw NATS/register
# manipulation with demo-minted creds).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OCH=/tmp/oc-demo
SAAS_URL="http://127.0.0.1:3961"
NATS_WS=18722
DOWN_SECS="${DOWN_SECS:-5}"

CMD="${1:-}"

require_demo() {
  curl -fsS "$SAAS_URL/.well-known/jwks.json" >/dev/null 2>&1 \
    || { echo "[chaos] demo not reachable at $SAAS_URL — start ./demo/run.sh first"; exit 1; }
  [ -f "$OCH/nats.conf" ] || { echo "[chaos] $OCH/nats.conf missing — is the demo running?"; exit 1; }
}

case "$CMD" in
  restart-relay)
    require_demo
    PID="$(pgrep -f "nats-server -c $OCH/nats.conf" | head -1 || true)"
    [ -z "$PID" ] && { echo "[chaos] no nats-server found for $OCH/nats.conf"; exit 1; }
    echo "[chaos] killing relay (pid $PID) — the widget should flip to reconnecting…"
    kill "$PID" 2>/dev/null || true
    for i in $(seq 1 40); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
    echo "[chaos] relay DOWN. Type a message in the widget now — it will be queued."
    echo "[chaos] holding down for ${DOWN_SECS}s…"
    sleep "$DOWN_SECS"
    echo "[chaos] restarting relay…"
    nats-server -c "$OCH/nats.conf" >"$OCH/nats.log" 2>&1 &
    for i in $(seq 1 120); do
      grep -q "Server is ready" "$OCH/nats.log" 2>/dev/null && { echo "[chaos] ✓ relay back UP — widget should reconnect + flush queued messages"; break; }
      sleep 0.25
      [ "$i" -eq 120 ] && { echo "[chaos] relay restart TIMEOUT — log:"; tail -10 "$OCH/nats.log"; exit 2; }
    done
    ;;
  tamper|replay-jwt|cross-tenant)
    require_demo
    if [ -f "$REPO/demo/chaos-nats.ts" ]; then
      node --import tsx "$REPO/demo/chaos-nats.ts" "$CMD"
    else
      echo "[chaos] '$CMD' is not wired yet (needs demo/chaos-nats.ts — raw NATS/register"
      echo "        manipulation). Only 'restart-relay' is implemented so far."
      exit 3
    fi
    ;;
  *)
    echo "usage: $0 {restart-relay|tamper|replay-jwt|cross-tenant}"
    echo "  (run ./demo/run.sh first; open the widget to watch the effect)"
    exit 1
    ;;
esac
