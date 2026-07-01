# Split demo — real browser (Mac) ↔ agent (container), live over NATS

This is the reproducible walkthrough for the **split** live demo: the SaaS side + web page run
on the **host** (a Mac), the OpenClaw agent + this plugin run in a **container**, and a real
browser talks to the real agent over a real JWT-auth `nats-server` — ingress-free, end-to-end
encrypted, device-flow enrolled. This is the run that proved the NATS E2E path live on real
hardware (a real LLM reply came back).

For the single-host interactive demo (everything on one machine), use
[`e2e/local/run-demo.sh`](../e2e/local/README.md) instead. This doc is the harder,
more-realistic split topology.

```
  ┌─────────────────────── Mac (host) ───────────────────────┐        ┌──── container ────┐
  │  docker/mac-demo.sh:                                      │        │  node:24-bookworm │
  │   • SaaS issuer (real trust chain)   http://<LAN_IP>:PORT │◄───────┤  openclaw gateway │
  │   • JWT-auth nats-server (ws 0.0.0.0) ws://<LAN_IP>:NATS  │◄───────┤  + this plugin    │
  │   • web chat page                    http://127.0.0.1:PAGE│        │  (index-nats)     │
  │        browser ─────────────► ws://<LAN_IP>:NATS ◄────────┼────────┘                   │
  └──────────────────────────────────────────────────────────┘        └───────────────────┘
        relay sees ciphertext only · agent has NO inbound port (outbound dial only)
```

## Why the LAN IP (not 127.0.0.1 / host.docker.internal)

The NATS relay URL is **SaaS-delivered**: the issuer hands the same `natsUrl` to BOTH the
enrolled plugin (inside its device-flow `EnrollmentResult`) and the browser (via the page's
config). That one URL must resolve from **both** sides:

- `127.0.0.1` → Mac-only (the container can't reach it).
- `host.docker.internal` → container-only (the Mac browser can't reach it).
- **the Mac's LAN IP** (e.g. `192.168.10.5`) → resolves from both. This is why `mac-demo.sh`
  advertises the issuer + NATS on the LAN IP and binds the host services to `0.0.0.0`.

Because the agent is **ingress-free** (it only dials OUT to NATS), the container needs **no port
forwarding** (`-p …`) at all — only container→host reachability over the LAN IP, plus the host
services bound `0.0.0.0`.

## Host side (Mac)

```bash
LAN_IP=192.168.10.5 ./docker/mac-demo.sh      # set LAN_IP to your Mac's LAN address
```

This boots (all under `/tmp/oc-mac-demo`, self-cleaning on Ctrl+C):

1. the **real** reference SaaS issuer (`packages/saas/reference/enrollment-server.ts`) with a
   real `setupTrustChain()`, serving JWKS + the enrollment `/api/enroll` + `/api/poll` routes,
   booted with `NATS_URL=ws://<LAN_IP>:<NATS_WS>` so the URL it *delivers* is LAN-resolvable;
2. a **JWT-auth `nats-server`** built from that trust chain's operator + resolver, websocket
   listener bound `0.0.0.0:<NATS_WS>`;
3. the **web chat page** (`e2e/local/demo-server.mjs`), which reads the relay URL from the issuer
   (so it too dials the LAN IP) and connects with `WEBCHANNEL_GW_URL=""` → no HTTP register hop
   (`auto` admission + `dmSecurity` allowlist do the gating).

It prints the values the container needs (SaaS base URL, tenant, account, peer id, browser URL).
Defaults: issuer port `3942`, NATS ws `18722`, page `19394`, tenant `default-tenant`, account
`default-agent`, peer `web-allreal-peer`.

## Container side (agent)

Run `node:24-bookworm` with **no `-p` flags** (ingress-free). Inside it, install the plugin from
a standalone copy (`docker/plugin/`) and enroll:

```bash
# 1. install this plugin (linked, from the standalone copy)
openclaw plugins install /plugin --link

# 2. add the webchannel account. NOTE the flag mapping on `channels add`:
#      --base-url  → saasBaseUrl   (the SaaS issuer)
#      --url       → tenant
#      --account   → accountId  (the ON-WIRE identity; 가-2)
#    The plugin-specific --saas-base-url / --tenant are NOT registered on
#    `channels add`; use the generic mapped flags above.
openclaw channels add --channel webchannel \
  --account default-agent \
  --base-url http://192.168.10.5:3942 \
  --url default-tenant

# 3. approve the enrollment (on the host) at the URL the plugin logs:
#      http://<host>:3942/enroll?user_code=<CODE>

# 4. bind an OpenClaw agent to this account (the handling agent is decoupled
#    from the wire identity — telegram-like):
openclaw agents bind --agent <your-agent> --bind webchannel:default-agent

# 5. run the gateway (it consumes the cached enrollment; the plugin dials the
#    SaaS-delivered NATS URL — you do NOT configure a NATS URL here):
openclaw gateway run
```

**No `channels.webchannel.auth` block is needed** — static/enrolled creds resolve admission to
`auto`, and the ConnectionVerifier is only built for the `register-hop` mode. Browser admission =
NATS subject permissions + X25519 handshake + the `dmSecurity` allowlist (`allowFrom` must
include the browser's `peerId`).

## The one gotcha that breaks everything

**The browser's `accountId` (host web-page config) MUST equal the container's `--account`.** The
NATS subjects are `webchannel.{tenant}.{accountId}.{peerId}.{in,out}` — if the two `accountId`
values differ, the browser publishes to a subject the agent never subscribes to and **nothing
round-trips** (silent, no error). Same goes for `tenant` and the browser `peerId` ∈ the agent's
`allowFrom`. In the defaults above they already match (`default-agent` / `default-tenant` /
`web-allreal-peer`); if you change one, change it on **both** sides.

## Verify

Open the browser URL the host script printed (e.g. `http://127.0.0.1:19394/`), send a message,
and you should get the agent's reply back — ciphertext-only on the wire, the agent reachable with
no inbound port.
