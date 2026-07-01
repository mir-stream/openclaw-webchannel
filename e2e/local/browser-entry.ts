import { WebChannelNatsClient } from "../../packages/client/src/nats-client.js";

// Exposed on window for page.evaluate(). Runs the production client IN the browser.
(globalThis as unknown as { runWeb: unknown }).runWeb = async function runWeb(opts: {
  natsUrl: string; jwt: string; accountId: string; tenant: string; peerId: string; text: string;
}): Promise<string> {
  const client = new WebChannelNatsClient({
    url: opts.natsUrl, jwt: opts.jwt, accountId: opts.accountId, tenant: opts.tenant, peerId: opts.peerId,
  });
  const reply = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("browser: timeout")), 25000);
    client.onMessage((m) => {
      if (m.type === "agent_message") { clearTimeout(timer); resolve(m.text ?? ""); }
    });
  });
  client.connect();
  await new Promise((r) => setTimeout(r, 2500));
  client.sendUserMessage(opts.text);
  const out = await reply;
  client.disconnect();
  return out;
};
