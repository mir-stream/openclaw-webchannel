# openclaw-webchannel

A self-hosted **web chat channel plugin for [OpenClaw](https://openclaw.ai)** — embed a
chat widget on a web page and talk to an OpenClaw agent (Claude) from the browser.

> **Read [`docs/STATUS.md`](docs/STATUS.md) first.** This project has two transports — the
> **NATS E2E** path (production default, live-proven end-to-end) and a **legacy dev-only**
> Gateway-WS fallback. The status doc is the single source of truth for what is and isn't done;
> AC scores and seed files elsewhere describe component-level completion, not end-to-end
> functionality.

## Two transports

| | **B. NATS E2E** (`packages/plugin/index-nats.ts`) | **A. Gateway-WS** (`packages/plugin/index.ts`) |
|---|---|---|
| How the browser reaches the agent | Both sides connect to a shared NATS bus | Direct WebSocket to the gateway port |
| Agent-side ingress | **No** (outbound dial only) | Yes (gateway exposes a port) |
| Content visible to the relay | **No — ChaCha20-Poly1305 ciphertext only** | n/a (gateway is the endpoint) |
| **Status** | ✅ **Production default — live end-to-end** | 🔧 **Legacy / dev-only** zero-infra WS round-trip |

The NATS E2E path is the production default (`packages/plugin/package.json` →
`openclaw.extensions = ["./index-nats.ts"]`) and is **live-proven on real hardware**: a real
browser on a Mac talked to a real OpenClaw gateway + this plugin (running in a container) over a
real JWT-auth `nats-server` and got a real LLM reply — ingress-free, end-to-end encrypted, and
device-flow enrolled. The Gateway-WS entry (`index.ts`) is a **legacy, dev-only** zero-infra WS
round-trip (exercised by `smoke/*.mjs`); it still exists but has no production role. Its full
removal is a separate backlog item ([`docs/BACKLOG.md`](docs/BACKLOG.md)).

## Status at a glance

| Area | State |
|---|---|
| **NATS E2E path end-to-end** (browser ↔ NATS ↔ plugin ↔ `inbound.run` ↔ back) | ✅ **production default, live-proven on real hardware** |
| E2E crypto (X25519 + HKDF + ChaCha20-Poly1305), envelope, NATS transport | ✅ done, component-tested |
| Trust chain (`packages/saas`): `setupTrustChain`, device-flow enrollment, NATS user creds | ✅ done, tested on a real nats-server |
| Browser dialing NATS in the production client (`WebChannelNatsClient`) | ✅ live (NKEY-auth + X25519 handshake, ciphertext-only) |
| Gateway-WS channel (`index.ts`, `jwt` upgrade) | 🔧 legacy / dev-only zero-infra WS round-trip |
| Packaging / publish to ClawHub | ❌ incomplete (`docs/PACKAGING.md`) |

Full detail, and reconciliation of the conflicting "AC 100% / complete" signals, is in
[`docs/STATUS.md`](docs/STATUS.md).

## Repository layout

```
packages/plugin   The OpenClaw channel plugin (index-nats.ts = NATS mode [default], index.ts = legacy WS)
packages/client   Framework-agnostic browser client (headless connection + protocol + state)
packages/saas     Trust-chain core + reference enrollment/bootstrap servers (reference, NOT prod)
docs/             Design + status docs (start with STATUS.md and TRUST_AND_ONBOARDING.md)
.ouroboros/       Ouroboros seeds / handoffs that drove the build (historical record)
```

## Run it (the production NATS path)

The single interactive demo boots the full production topology — SaaS issuer + JWT-auth
`nats-server` + the real enrolled `index-nats` plugin in a real gateway — and lets you chat with
a live agent in your browser:

```bash
npm install
./e2e/local/run-demo.sh    # prints a URL; open it and chat. Ctrl+C tears it all down.
```

It reuses your real `~/.openclaw` model/provider config (so the agent answers with a real LLM)
while keeping everything else under an isolated `OPENCLAW_HOME`. For the split host/container
walkthrough (real browser on the Mac ↔ agent in a container over the LAN), see
[`docs/SPLIT_DEMO.md`](docs/SPLIT_DEMO.md). The legacy Gateway-WS round-trip lives in
`smoke/*.mjs` (dev-only; `smoke/jwt.mjs` is the `jwt`-auth WS smoke).

## Develop / test

```bash
npm install
npm run typecheck     # all workspaces
npm test              # 731 tests (component/unit level — see STATUS.md on coverage gaps)
```

## License

See individual package manifests.
