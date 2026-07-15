# openclaw-webchannel-client

Framework-agnostic browser client for the OpenClaw web chat channel.

The public `WebChannelNATSClient` connects to a shared NATS relay, performs the
configured enrollment/register flow, and exchanges end-to-end encrypted messages
with the agent over per-peer subjects. It owns transcript, progress, reasoning,
approval, typing, command-catalog, and connection state without imposing a UI
framework.

## Usage

```ts
import { WebChannelNATSClient } from "@mir-stream/webchannel-client";

const client = new WebChannelNATSClient({
  natsUrl: "wss://relay.example.com",
  bootstrapJwt,
  accountId: "account-1",
  tenant: "tenant-1",
  peerId: "user-1",
  natsCredentials,
  registration,
});

const unsubscribe = client.subscribe((state) => {
  if (state.connected) console.log(state.messages);
});

client.connect();
client.send("Hello");
// Later: client.close(); unsubscribe();
```

The wrapper also exposes `decide`, `loadHistory`, `loadCommands`, `getState`, and
the reconnect/heartbeat tuning fields defined by `NatsClientOptions`.

Public state types include `ChatMessage`, `ApprovalRequest`, `ReasoningItem`,
`WebChannelState`, `WebChannelErrorCause`, and `WebChannelOptions`.

See [`../../docs/STATUS.md`](../../docs/STATUS.md) for current deployment status
and [`../../docs/TRUST_AND_ONBOARDING.md`](../../docs/TRUST_AND_ONBOARDING.md) for
the enrollment and trust model.

## Build / test

```bash
npm run build
npm run typecheck
npm test
```
