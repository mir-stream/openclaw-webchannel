# openclaw-webchannel

A self-hosted **web chat channel plugin for [OpenClaw](https://openclaw.ai)** — embed a
chat widget on a web page and talk to an OpenClaw agent (Claude) from the browser.

> **Read [`docs/STATUS.md`](docs/STATUS.md) first.** The **NATS E2E** path is the
> production transport and is live-proven end-to-end. The status doc is the single source of truth for what is and isn't done;
> AC scores and seed files elsewhere describe component-level completion, not end-to-end
> functionality.

## Transport

Both browser and agent connect outbound to a shared NATS relay. The agent exposes no inbound
browser route, and the relay sees ChaCha20-Poly1305 ciphertext rather than chat plaintext.

The NATS E2E path is the production default (`packages/plugin/package.json` →
`openclaw.extensions = ["./index-nats.ts"]`) and is **live-proven on real hardware**: a real
browser on a Mac talked to a real OpenClaw gateway + this plugin (running in a container) over a
real JWT-auth `nats-server` and got a real LLM reply — ingress-free, end-to-end encrypted, and
device-flow enrolled. (E2E is confidential AND integrity-protected against the relay: the
authenticated register hop is the sole admission path and the conversation key is delivered wrapped
to the JWT-attested device key, so review finding **C2** — active-relay MITM — is CLOSED (see
[`docs/BACKLOG.md`](docs/BACKLOG.md)); the residual is relay trust for availability/metadata only.)

## Status at a glance

| Area | State |
|---|---|
| **NATS E2E path end-to-end** (browser ↔ NATS ↔ plugin ↔ `inbound.run` ↔ back) | ✅ **production default, live-proven on real hardware** |
| E2E crypto (X25519 + HKDF + ChaCha20-Poly1305), envelope, NATS transport | ✅ done, component-tested |
| Trust chain (`packages/saas`): `setupTrustChain`, device-flow enrollment, NATS user creds | ✅ done, tested on a real nats-server |
| Browser dialing NATS in the production client (`WebChannelNatsClient`) | ✅ live (NKEY-auth + register-delivered conversation key, ciphertext-only) |
| Packaging / publishing | ✅ **shipped** — plugin `openclaw-webchannel@0.1.0` on ClawHub (`clawhub:mir-stream/openclaw-webchannel`); `@mir-stream/webchannel-{saas,client}@0.1.3` on GitHub Packages via tag-triggered CI (`docs/PUBLISHING.md`) |

Full detail, and reconciliation of the conflicting "AC 100% / complete" signals, is in
[`docs/STATUS.md`](docs/STATUS.md).

## Repository layout

```
packages/plugin   The OpenClaw channel plugin (NATS transport)
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
[`docs/SPLIT_DEMO.md`](docs/SPLIT_DEMO.md).

## Develop / test

```bash
npm install
npm run typecheck     # all workspaces
npm test              # 731 tests (component/unit level — see STATUS.md on coverage gaps)
```

## License

See individual package manifests.
