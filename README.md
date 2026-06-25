# openclaw-webchannel

A self-hosted **web chat channel plugin for [OpenClaw](https://openclaw.ai)** — embed a
chat widget on a web page and talk to an OpenClaw agent (Claude) from the browser.

> **Read [`docs/STATUS.md`](docs/STATUS.md) first.** This project has two transports — one
> that works today and one that is still being built. The status doc is the single source of
> truth for what is and isn't done; AC scores and seed files elsewhere describe component-level
> completion, not end-to-end functionality.

## Two transports

| | **A. Gateway-WS** (`packages/plugin/index.ts`) | **B. NATS E2E** (`packages/plugin/index-nats.ts`) |
|---|---|---|
| How the browser reaches the agent | Direct WebSocket to the gateway port | Both sides connect to a shared NATS bus |
| Agent-side ingress | Yes (gateway exposes a port) | **No** (the goal of this rework) |
| Content visible to the relay | n/a (gateway is the endpoint) | **No — ChaCha20-Poly1305 ciphertext only** |
| **Status** | ✅ **Works end-to-end today** | 🚧 **Not live yet** (see STATUS.md) |

The whole point of Phase A/B is to move from **A → B**: remove agent-side ingress and route
browser↔agent traffic over an untrusted NATS relay with end-to-end encryption, anchored by a
SaaS trust chain. That migration is **partially built** — the data plane, crypto, and trust
chain are done and component-tested, but the NATS plugin entry was only just wired to the agent
loop and has **not been run live**.

## Status at a glance

| Area | State |
|---|---|
| Gateway-WS channel (browser ↔ OpenClaw ↔ Claude) | ✅ works |
| E2E crypto (X25519 + HKDF + ChaCha20-Poly1305), envelope, NATS transport | ✅ done, component-tested |
| Trust chain (`packages/saas`): `setupTrustChain`, device-flow enrollment, NATS user creds | ✅ done, tested on a real nats-server |
| NATS plugin entry → OpenClaw agent bridge (`index-nats.ts`) | 🟡 seams implemented (`22133b5`), **not run live** |
| Browser dialing NATS in the live client | ❌ not wired |
| Live NATS path end-to-end (browser ↔ Claude over NATS) | ❌ **never worked yet** |
| Packaging / publish to ClawHub | ❌ incomplete (`docs/PACKAGING.md`) |

Full detail, and reconciliation of the conflicting "AC 100% / complete" signals, is in
[`docs/STATUS.md`](docs/STATUS.md).

## Repository layout

```
packages/plugin   The OpenClaw channel plugin (index.ts = WS mode, index-nats.ts = NATS mode)
packages/client   Framework-agnostic browser client (headless connection + protocol + state)
packages/saas     Trust-chain core + reference enrollment/bootstrap servers (reference, NOT prod)
docs/             Design + status docs (start with STATUS.md and TRUST_AND_ONBOARDING.md)
.ouroboros/       Ouroboros seeds / handoffs that drove the build (historical record)
```

## Run the working path (Gateway-WS)

This is the path that works today. It needs an OpenClaw gateway with this plugin loaded.

1. Install: `npm install`
2. Configure the gateway (`~/.openclaw/openclaw.json`) to load this plugin and a model:
   - `plugins.load.paths`: `["<abs path>/packages/plugin"]`, `plugins.entries.webchannel.enabled: true`
   - `agents.defaults.model.primary`: a Claude model (e.g. `anthropic/claude-opus-4-8`), or reuse
     the Claude Code CLI login via `agentRuntime: { id: "claude-cli" }` (no API key needed)
3. Build the chat UI: `npm run build:demo`
4. Start the gateway: `openclaw gateway run` (defaults to `ws://127.0.0.1:18789`)
5. Open the served chat UI in the browser.

## Develop / test

```bash
npm install
npm run typecheck     # all workspaces
npm test              # 731 tests (component/unit level — see STATUS.md on coverage gaps)
```

## License

See individual package manifests.
