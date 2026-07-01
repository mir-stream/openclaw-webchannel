#!/usr/bin/env bash
# Mac-side HALF of the split demo: SaaS issuer + JWT-auth nats-server + web page.
# The openclaw gateway + webchannel plugin run in the CONTAINER (not here).
#
# Everything the container plugin AND the Mac browser share (NATS + issuer) is
# advertised on the Mac's LAN IP so BOTH can resolve it (host.docker.internal is
# container-only; 127.0.0.1 is Mac-only). The issuer's NATS_URL is what our rework
# hands to the enrolled plugin AND (via /test/nats-user) to the browser.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OCH=/tmp/oc-mac-demo

LAN_IP="${LAN_IP:-192.168.10.5}"

ISSUER_PORT="${ISSUER_PORT:-3942}"
NATS_WS="${NATS_WS:-18722}"
NATS_TCP="${NATS_TCP:-14722}"
PAGE_PORT="${PAGE_PORT:-19394}"

TENANT="${TENANT:-default-tenant}"
ACCOUNT_ID="${ACCOUNT_ID:-default-agent}"
PEER_ID="${PEER_ID:-web-allreal-peer}"
SAAS_ISSUER="${SAAS_ISSUER:-https://saas.local/demo-issuer}"

NATS_URL="ws://${LAN_IP}:${NATS_WS}"
SAAS_BASE_URL="http://${LAN_IP}:${ISSUER_PORT}"

ISSUER_PID=""; NATS_PID=""; WEB_PID=""
cleanup() {
  echo "[mac-demo] cleanup…"
  [ -n "$WEB_PID" ]    && kill "$WEB_PID"    2>/dev/null || true
  [ -n "$NATS_PID" ]   && kill "$NATS_PID"   2>/dev/null || true
  [ -n "$ISSUER_PID" ] && kill "$ISSUER_PID" 2>/dev/null || true
  pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
}
trap cleanup EXIT

pkill -f "nats-server -c $OCH/nats.conf" 2>/dev/null || true
rm -rf "$OCH"; mkdir -p "$OCH"

# ---------------------------------------------------------------------------
# 1. SaaS issuer (real trust chain). NATS_URL points at the LAN IP so the URL it
#    delivers to plugin+browser is resolvable from BOTH the container and the Mac.
#    ENABLE_TEST_ROUTES=1 → /test/nats-user + /test/bootstrap-jwt for the browser.
#    Node http.Server binds 0.0.0.0 by default → reachable from the container.
# ---------------------------------------------------------------------------
PORT="$ISSUER_PORT" \
SAAS_BASE_URL="$SAAS_BASE_URL" \
SAAS_ISSUER="$SAAS_ISSUER" \
NATS_URL="$NATS_URL" \
NATS_CONFIG_OUT="$OCH" \
ENABLE_TEST_ROUTES=1 \
POLL_INTERVAL_SECONDS=1 \
  node --import tsx "$REPO/packages/saas/reference/enrollment-server.ts" >"$OCH/issuer.log" 2>&1 &
ISSUER_PID=$!
echo "[mac-demo] issuer pid=$ISSUER_PID — waiting for JWKS + NATS config…"
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$ISSUER_PORT/.well-known/jwks.json" >/dev/null 2>&1 \
     && [ -f "$OCH/operator.jwt" ] && [ -f "$OCH/resolver.json" ]; then
    echo "[mac-demo] issuer ready"; break; fi
  kill -0 "$ISSUER_PID" 2>/dev/null || { echo "[mac-demo] issuer died:"; cat "$OCH/issuer.log"; exit 2; }
  sleep 0.25
  [ "$i" -eq 120 ] && { echo "[mac-demo] TIMEOUT issuer:"; cat "$OCH/issuer.log"; exit 2; }
done

# ---------------------------------------------------------------------------
# 2. JWT-auth nats-server built from the issuer's operator + resolver. Bind the
#    websocket on 0.0.0.0 so the container can dial ws://<LAN_IP>:<NATS_WS>.
# ---------------------------------------------------------------------------
OCH="$OCH" NATS_TCP="$NATS_TCP" NATS_WS="$NATS_WS" node -e '
  const fs = require("fs"); const dir = process.env.OCH;
  const resolver = JSON.parse(fs.readFileSync(dir + "/resolver.json", "utf8"));
  const preload = Object.entries(resolver).map(([k, v]) => `  ${k}: "${v}"`).join("\n");
  const conf = [
    `port: ${process.env.NATS_TCP}`,
    `websocket {`, `  listen: "0.0.0.0:${process.env.NATS_WS}"`, `  no_tls: true`, `}`,
    `operator: "${dir}/operator.jwt"`,
    `resolver: MEMORY`,
    `resolver_preload: {`, preload, `}`, "",
  ].join("\n");
  fs.writeFileSync(dir + "/nats.conf", conf);
'
nats-server -c "$OCH/nats.conf" >"$OCH/nats.log" 2>&1 &
NATS_PID=$!
echo "[mac-demo] nats-server pid=$NATS_PID (JWT-auth, ws 0.0.0.0:$NATS_WS) — waiting…"
for i in $(seq 1 120); do
  grep -q "Server is ready" "$OCH/nats.log" 2>/dev/null && { echo "[mac-demo] nats ready"; break; }
  kill -0 "$NATS_PID" 2>/dev/null || { echo "[mac-demo] nats died:"; cat "$OCH/nats.log"; exit 2; }
  sleep 0.25
  [ "$i" -eq 120 ] && { echo "[mac-demo] TIMEOUT nats:"; cat "$OCH/nats.log"; exit 2; }
done

# ---------------------------------------------------------------------------
# 3. Web chat page. gwUrl EMPTY → no HTTP register hop (agent stays ingress-free;
#    admission = auto + dmSecurity allowlist on the container gateway). The browser
#    reads the relay URL from /test/nats-user (our rework), so it too dials the LAN IP.
# ---------------------------------------------------------------------------
WEBCHANNEL_GW_URL="" \
WEBCHANNEL_NATS_URL="$NATS_URL" \
WEBCHANNEL_ISSUER_URL="$SAAS_BASE_URL" \
WEBCHANNEL_TENANT="$TENANT" WEBCHANNEL_ACCOUNT_ID="$ACCOUNT_ID" WEBCHANNEL_PEER_ID="$PEER_ID" \
WEBCHANNEL_PAGE_PORT="$PAGE_PORT" \
  node "$REPO/e2e/local/demo-server.mjs" >"$OCH/web.log" 2>&1 &
WEB_PID=$!
echo "[mac-demo] web pid=$WEB_PID — waiting…"
for i in $(seq 1 120); do
  curl -fsS "http://127.0.0.1:$PAGE_PORT/" >/dev/null 2>&1 && { echo "[mac-demo] web ready"; break; }
  kill -0 "$WEB_PID" 2>/dev/null || { echo "[mac-demo] web died:"; cat "$OCH/web.log"; exit 2; }
  sleep 0.25
  [ "$i" -eq 120 ] && { echo "[mac-demo] TIMEOUT web:"; cat "$OCH/web.log"; exit 2; }
done

cat <<EOF

===================================================================
  Mac-side demo UP (issuer + NATS + web). Gateway runs in CONTAINER.

  Browser (open on the Mac):   http://127.0.0.1:${PAGE_PORT}/

  Container must point at (LAN IP, reachable from Docker):
    SaaS baseUrl :  ${SAAS_BASE_URL}
    (plugin gets the NATS URL from the SaaS — do NOT set it by hand)

  channels add (in the container):
    openclaw channels add --channel webchannel \\
      --saas-base-url ${SAAS_BASE_URL} \\
      --tenant ${TENANT} --agent-id ${ACCOUNT_ID}

  Gateway webchannel config must allow the browser peer:
    dmSecurity: allowlist,  allowFrom: ["${PEER_ID}"],  nats.admission: auto

  Approve enrollment at:  ${SAAS_BASE_URL}/enroll?user_code=<CODE>
  Ctrl+C to tear the Mac side down.
===================================================================
EOF

wait "$NATS_PID"
