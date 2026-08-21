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
| Packaging / publishing | ✅ **shipped** — plugin `openclaw-webchannel@0.1.0` on ClawHub (`clawhub:mir-stream/openclaw-webchannel`); `@mir-stream/webchannel-{saas,client}` on public npm (zero-auth install, provenance) via tag-triggered CI (`docs/PUBLISHING.md`) |

Full detail, and reconciliation of the conflicting "AC 100% / complete" signals, is in
[`docs/STATUS.md`](docs/STATUS.md).

> **Upgrading: reasoning now streams to browsers by default.** As of #113 the
> agent's reasoning/thinking stream is delivered to widgets unless you turn it
> off. Reasoning can restate file contents, credentials, or the user's own
> prompt, and browser peers are the least trusted surface this plugin serves, so
> decide deliberately. To opt out, set `"capabilities": { "reasoning": false }`
> in the `channels.webchannel` block (or per account under `accounts.<id>`).
> Full note in [the changelog](packages/plugin/CHANGELOG.md).

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
npm test              # component/unit level — see STATUS.md on coverage gaps
```

The CI gate additionally checks that no test file lost tests, by comparing the
collected count per file against `.github/test-inventory.json`. Any change to
the test count — adding, removing or moving tests — makes it red until you
regenerate and commit the snapshot:

```bash
npm run test:inventory         # what the gate checks
npm run test:inventory:update  # regenerate after adding or moving tests
```

**If you deleted tests**, `:update` refuses rather than quietly shrinking the
snapshot, because the usual cause of a shrink is a missing `nats-server` rather
than a real deletion. Confirm the deletion explicitly:

```bash
npm run test:inventory:update -- --accept-deletions
```

Only a **net** loss normally needs that flag: moving tests between files leaves
the total unchanged and goes through without it (the affected files are still
printed). The fail-closed exception is either of the two `nats-server`
real-server files disappearing from the inventory: that needs explicit
acceptance even when new tests elsewhere offset the loss, because a missing
`nats-server` produces the same misleading count-neutral result.

Both commands need `nats-server` — on `PATH`, or in `/usr/local/bin`,
`/usr/bin` or `/opt/homebrew/bin`, which the suites probe unconditionally. It is
not an npm dependency; CI installs it via
[`.github/actions/install-nats-server`](.github/actions/install-nats-server).
Without it the real-server suites do not collect, so on a dev box the check
reports them as deleted (−23) and `:update` refuses; with `CI=true` set they
throw at import instead and collection fails outright.

The snapshot covers everything the root vitest sweep collects; `examples/**` is
excluded from that sweep and is guarded only by each example's own `npm test`.

## License

[MIT](LICENSE) — all three published packages (`openclaw-webchannel`,
`@mir-stream/webchannel-client`, `@mir-stream/webchannel-saas`).
