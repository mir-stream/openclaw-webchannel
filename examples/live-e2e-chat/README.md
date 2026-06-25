# Live E2E chat over NATS — runnable demo

A browser and an agent hold a **real, end-to-end-encrypted conversation** over a
live NATS bus. Type in the browser; the message is encrypted with
ChaCha20-Poly1305, published to NATS as **ciphertext**, decrypted by the agent,
and the reply comes back the same way. The NATS relay only ever sees ciphertext
plus plaintext routing metadata.

This is the piece the pairing/enrollment flow alone can't show: the actual
**data plane** working interactively.

```
 ┌─────────┐   X25519 handshake    ┌──────────┐
 │ browser │◄─────(pubkeys)───────►│  agent   │
 │ (@noble)│                       │ (plugin  │
 │         │   ChaCha20-Poly1305   │  crypto) │
 │         │═════ ciphertext ═════►│          │
 │         │◄════ ciphertext ══════│          │
 └────┬────┘        NATS           └────┬─────┘
      └──────── ws://…:8087 ────────────┘
              (relay sees only ciphertext + routing)
```

## Run it

```bash
cd examples/live-e2e-chat
npm install
npm start            # boots nats-server + agent + web, prints the URL
```

Then open **http://localhost:5273** and chat. The right-hand panel shows the raw
envelope on the wire (ciphertext) next to the decrypted plaintext.

Requires [`nats-server`](https://docs.nats.io) on your PATH
(`brew install nats-server`).

## What's real vs. simplified

| Aspect | This demo |
|---|---|
| E2E crypto | **Real.** X25519 + HKDF-SHA256 + ChaCha20-Poly1305. The agent uses the plugin's actual `e2e-crypto` / `e2e-envelope` (`packages/plugin/src`); the browser uses a byte-compatible `@noble` implementation (`web/e2e-crypto.ts`). Interop is asserted by `npm run interop`. |
| NATS transport | **Real.** The agent dials with the plugin's real `NatsTransport`; the browser speaks the NATS WebSocket wire protocol (`web/nats-ws.ts`). |
| Wire envelope | **Real.** Same `{v,agentId,tenant,sub,messageId,envelopeType,ts,content:{nonce,ciphertext,tag}}` format as the plugin. |
| Key pinning / handshake auth | **Simplified.** Keys are exchanged over a NATS handshake subject (TOFU), not pinned via the SaaS bootstrap `cnf` claim. |
| NATS auth | **Simplified.** Open-auth server (no JWT/account). The full JWT trust chain + tenant isolation is exercised separately in `packages/saas` and the AC6 device-flow E2E test. |
| The agent | A small canned echo bot — the point is the encrypted transport, not the AI. |

## Verify without a browser

```bash
npm run interop      # browser @noble crypto == plugin node:crypto (byte-for-byte)
npm run smoke        # boots nats + agent, plays the browser headlessly, asserts a round-trip
```

## Files

| File | Role |
|---|---|
| `protocol.ts` | Shared subjects + handshake message type |
| `agent/agent.ts` | Agent — **plugin's real** NatsTransport + e2e-crypto + e2e-envelope |
| `web/e2e-crypto.ts` | Browser crypto (`@noble`), wire-compatible with the plugin |
| `web/e2e-envelope.ts` | Browser envelope codec (mirrors the plugin format) |
| `web/nats-ws.ts` | Minimal NATS-over-WebSocket client (browser + Node) |
| `web/main.ts` | Chat UI + the "on the wire" ciphertext panel |
| `nats.conf` | nats-server: open auth + WebSocket on :8087 |
| `run.mjs` | One-command orchestrator (`npm start`) |
| `smoke.ts` / `interop-check.ts` | Headless verification |
