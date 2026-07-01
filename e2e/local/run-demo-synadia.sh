#!/usr/bin/env bash
# GUIDED REFERENCE demo — the Synadia/NGS sibling of run-demo.sh.
#
# Unlike run-demo.sh (a turnkey, self-contained stack against a LOCAL JWT-auth
# nats-server), this script targets a REAL external NATS account (Synadia Cloud /
# NGS). It is deliberately a *reference*, not one-click automation: it only
# automates the host-side pieces (the reference SaaS issuer in external+demo mode,
# and a clean plugin sandbox container). The actual OpenClaw operator steps
# (install openclaw, plugins install --link, config patch, channels add/enroll,
# agents bind, gateway run) are done BY THE USER, following the printed guidance —
# because they need the user's Synadia connectivity + their own model/provider.
#
# Coexists with run-demo.sh: this uses the Synadia issuer PORT (3951 by default)
# and a NAMED container; run-demo.sh's ports (issuer 3942 / gw 19299 / nats 18722)
# are untouched. Kills are PORT/PID/name-scoped only — never a broad pkill.
#
# Secrets: the Synadia account signing seed lives in ~/.openclaw-webchannel-saas/
# synadia.env (chmod 600). This script sources it but NEVER prints its value.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SYNADIA_ENV="$HOME/.openclaw-webchannel-saas/synadia.env"
CONTAINER=oc-webchannel-synadia-lab
ISSUER_LOG="$(mktemp -t oc-synadia-issuer.XXXXXX)"
ISSUER_PID=""

cleanup() {
  echo "[run-demo-synadia] cleanup…"
  [ -n "$ISSUER_PID" ] && kill "$ISSUER_PID" 2>/dev/null || true
  # Removing the container cascades to the user's in-container gateway.
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  # NOTE: we deliberately do NOT delete ~/.openclaw-webchannel-saas/* — the
  # persisted trust chain + synadia.env must survive across runs. We also do NOT
  # touch the self-contained demo (disjoint ports/container name).
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Preflight (no writes)
# ---------------------------------------------------------------------------
if [ ! -f "$SYNADIA_ENV" ]; then
  echo "[run-demo-synadia] FATAL: $SYNADIA_ENV not found."
  echo "  Create it (chmod 600) as described in docs/ONBOARDING_GUIDE.md §2."
  exit 1
fi
# Source the Synadia secrets/config into the environment (exports for the issuer).
set -a
# shellcheck disable=SC1090
. "$SYNADIA_ENV"
set +a

# Assert the required externals are present — WITHOUT ever echoing the seed value.
missing=""
[ -n "${NATS_ACCOUNT_SIGNING_SEED:-}" ] || missing="$missing NATS_ACCOUNT_SIGNING_SEED"
[ -n "${NATS_ACCOUNT_ID:-}" ]           || missing="$missing NATS_ACCOUNT_ID"
[ -n "${NATS_URL:-}" ]                  || missing="$missing NATS_URL"
if [ -n "$missing" ]; then
  echo "[run-demo-synadia] FATAL: $SYNADIA_ENV is missing:$missing"
  echo "  See docs/ONBOARDING_GUIDE.md §2 for the external-NATS issuer env."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[run-demo-synadia] FATAL: docker not found on PATH — a container sandbox is required."
  exit 1
fi

# The host SaaS port. From synadia.env (expected 3951); default 3951 if unset.
PORT="${PORT:-3951}"
port_busy() {
  # True (0) if something already accepts a connection on 127.0.0.1:$1. The fd is
  # opened inside a subshell, so it is closed automatically when the subshell exits.
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}
if port_busy "$PORT"; then
  echo "[run-demo-synadia] FATAL: host port $PORT is already in use — is another SaaS issuer running?"
  echo "  Free it, or set a different PORT in $SYNADIA_ENV."
  exit 1
fi

# Resolve the JWT `iss` claim (defaulting to SAAS_BASE_URL, then the doc default)
# and the base URL ONCE, here in the shell. Both are passed EXPLICITLY into node's
# env below (inline, so they win), so the minted JWT's `iss`, the issuer's listen
# PORT, the readiness poll, and the printed config guidance all use the IDENTICAL
# resolved values — a synadia.env that omits PORT/SAAS_ISSUER can't make the printed
# `issuer`/port diverge from what the process actually mints/binds.
SAAS_ISSUER="${SAAS_ISSUER:-${SAAS_BASE_URL:-http://127.0.0.1:$PORT}}"
SAAS_BASE_URL="${SAAS_BASE_URL:-http://127.0.0.1:$PORT}"

# ---------------------------------------------------------------------------
# 1. Boot the reference SaaS in EXTERNAL + DEMO mode.
#
#    External mode is auto-selected because NATS_ACCOUNT_SIGNING_SEED +
#    NATS_ACCOUNT_ID are set (sourced above): the issuer mints Synadia-valid user
#    creds and writes NO operator/account/resolver config. So there is no local
#    nats-server to launch (run-demo.sh's step 2 is dropped entirely).
#
#    The INLINE env below wins over anything in synadia.env: PORT/SAAS_ISSUER/
#    SAAS_BASE_URL are the shell-resolved values (no divergence), the demo web
#    surface is forced ON, the unauthenticated /test/* routes OFF (also suppresses
#    the misleading test-routes boot banner), and the register hop is skipped
#    (DEMO_GW_URL='', admission auto). We do NOT pass NATS_CONFIG_OUT (nothing to
#    write in external mode).
# ---------------------------------------------------------------------------
PORT="$PORT" \
SAAS_ISSUER="$SAAS_ISSUER" \
SAAS_BASE_URL="$SAAS_BASE_URL" \
ENABLE_DEMO_UI=1 \
ENABLE_TEST_ROUTES=0 \
DEMO_APP_HTML="$REPO/e2e/local/demo-app.html" \
DEMO_CLIENT_ENTRY="$REPO/packages/client/src/browser-demo-entry.ts" \
DEMO_GW_URL='' \
DEMO_ACCOUNT_ID=default-agent \
DEMO_TENANT=default-tenant \
DEMO_PEER_ID=web-synadia-peer \
  node --import tsx "$REPO/packages/saas/reference/enrollment-server.ts" >"$ISSUER_LOG" 2>&1 &
ISSUER_PID=$!
echo "[run-demo-synadia] enrollment-server (external+demo) pid=$ISSUER_PID — waiting for JWKS…"
# Readiness gate: JWKS ONLY. External mode writes no operator.jwt/resolver.json,
# so waiting on those would hang forever.
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$PORT/.well-known/jwks.json" >/dev/null 2>&1; then
    echo "[run-demo-synadia] issuer ready (JWKS up, external Synadia mode)"
    break
  fi
  if ! kill -0 "$ISSUER_PID" 2>/dev/null; then
    echo "[run-demo-synadia] enrollment-server died early — log:"; cat "$ISSUER_LOG"; exit 2
  fi
  sleep 0.25
  if [ "$i" -eq 120 ]; then
    echo "[run-demo-synadia] TIMEOUT waiting for issuer JWKS — log:"; cat "$ISSUER_LOG"; exit 2
  fi
done

# ---------------------------------------------------------------------------
# 2. One clean plugin sandbox container. We ONLY stage the plugin source (+ fix
#    ownership so openclaw does not reject it). Installing openclaw, its deps, and
#    running the gateway are USER steps (printed below) — the script does not do
#    them, and does NOT copy the host ~/.openclaw (model/provider is the user's).
# ---------------------------------------------------------------------------
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --add-host=host.docker.internal:host-gateway \
  node:22 sleep infinity >/dev/null
docker cp "$REPO/packages/plugin" "$CONTAINER:/root/plugin"
# openclaw rejects a plugin dir with "suspicious ownership" unless uid=0 owns it.
docker exec "$CONTAINER" sh -c "chown -R 0:0 /root/plugin"
echo "[run-demo-synadia] container $CONTAINER up; plugin staged at /root/plugin"

# ---------------------------------------------------------------------------
# 3. Printed GUIDED next steps (the operator runs these by hand).
# ---------------------------------------------------------------------------
cat <<EOF

===================================================================
  WebChannel Synadia GUIDED demo — host side is UP.

  SaaS issuer (external+demo):  http://127.0.0.1:$PORT/
  From INSIDE the container:    http://host.docker.internal:$PORT
  Plugin sandbox container:     $CONTAINER  (plugin at /root/plugin)

  Now run these OPERATOR steps yourself (each is a separate command):

  1) Install OpenClaw + the plugin's runtime dep (ws), then link the plugin:
     docker exec -it $CONTAINER npm install -g openclaw@2026.6.10
     docker exec -it $CONTAINER sh -c "cd /root/plugin && npm install --omit=dev"
     docker exec -it $CONTAINER openclaw plugins install --link /root/plugin

  2) Configure the webchannel channel (LOGIN flow, admission auto — no register hop):
     docker exec -i $CONTAINER openclaw config patch --stdin <<'JSON'
{
  "channels": {
    "webchannel": {
      "accounts": {
        "default-agent": {
          "tenant": "default-tenant",
          "saas": { "baseUrl": "http://host.docker.internal:$PORT" },
          "auth": {
            "strategy": "jwt",
            "jwt": {
              "jwksUrl": "http://host.docker.internal:$PORT/.well-known/jwks.json",
              "issuer": "$SAAS_ISSUER",
              "audience": "default-agent"
            }
          },
          "dmSecurity": "open",
          "nats": {
            "url": "wss://connect.ngs.global:443",
            "admission": "auto",
            "credentials": { "mode": "enrolled" }
          }
        }
      }
    }
  }
}
JSON

  3) Enroll (device flow). Prints a user_code and BLOCKS until you approve it in
     the browser (step 6, LEFT panel):
     docker exec -it $CONTAINER openclaw channels add --channel webchannel --account default-agent

  4) Bind YOUR handling agent to the account (configure its model/provider inside
     the container first — this script does NOT copy your host ~/.openclaw):
     docker exec -it $CONTAINER openclaw agents bind --bind webchannel:default-agent --agent <your-agent>

  5) Run the gateway (consumes the cached creds, connects to Synadia):
     docker exec -it $CONTAINER openclaw gateway run

  6) In your browser, open:  http://127.0.0.1:$PORT/
       - LEFT panel:  Approve the pending code from step 3.
                      (Also try the "User access (aud)" sub-panel to grant/revoke
                       which accounts a login may reach.)
       - RIGHT panel: LOG IN as  alice  or  bob  (password: demo), then chat.

  Connectivity: BOTH the container and your browser need outbound access to
  wss://connect.ngs.global:443. On Linux the container reaches the host issuer via
  the --add-host gateway (host.docker.internal).

  Ctrl+C here tears down the issuer + the $CONTAINER container.
===================================================================

EOF

echo "[run-demo-synadia] blocking — Ctrl+C to tear everything down."
# Block on the issuer; if it dies, we exit and the trap cleans up.
wait "$ISSUER_PID"
