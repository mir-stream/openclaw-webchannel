/**
 * Wiretap pane — a second NATS connection on demo-minted observer creds that
 * subscribes the whole tenant subject tree and renders every raw frame as hex.
 * Side-by-side with the chat pane (plaintext), it shows the relay only ever
 * carries CIPHERTEXT: confidentiality vs a passive relay (scene ③, passive leg).
 *
 * Reuses the production low-level NatsClient (NKEY-auth + SUB + raw frames), so
 * the observer authenticates to the JWT-auth relay exactly as any peer would.
 */
import { NatsClient } from "../../../packages/client/src/nats-client.js";
import { api, el, type DemoConfig } from "./config.js";

/** Render bytes of a payload string as spaced hex (first N bytes). */
function toHex(payload: string, maxBytes = 64): string {
  const bytes = new TextEncoder().encode(payload);
  const shown = bytes.subarray(0, maxBytes);
  let out = "";
  for (let i = 0; i < shown.length; i++) out += shown[i].toString(16).padStart(2, "0") + " ";
  return out.trim() + (bytes.length > maxBytes ? ` … (+${bytes.length - maxBytes}B)` : "");
}

export async function createWiretap(
  bodyEl: HTMLElement,
  config: DemoConfig,
  accountId: string,
): Promise<() => void> {
  bodyEl.replaceChildren();

  const rv = config.accounts[accountId];
  if (!rv) throw new Error(`no rendezvous entry for account "${accountId}"`);

  const statusLine = el("div", { style: "font-size:11px;color:var(--muted);margin-bottom:8px" }, ["connecting observer…"]);
  const note = el("div", {
    style: "font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.4",
  }, ["Observer creds subscribe the entire tenant subtree. The routing envelope is plaintext (the relay must route it), but every message body is ciphertext — decode the hex and you never find what was typed."]);
  const frames = el("div", { style: "display:flex;flex-direction:column;gap:6px;font-family:var(--mono)" });
  bodyEl.append(statusLine, note, frames);

  // Observer creds: a browser-role NATS user (pub/sub webchannel.{tenant}.>).
  const creds = await api<{ userJwt?: string; userSeedRaw?: string; natsUrl?: string }>(
    "/nats-user",
    { method: "POST", body: { role: "browser" } },
  );
  if (!creds.ok || !creds.data.userJwt || !creds.data.userSeedRaw) {
    statusLine.textContent = `observer creds failed (HTTP ${creds.status})`;
    statusLine.style.color = "var(--bad)";
    return () => bodyEl.replaceChildren();
  }
  const natsUrl = creds.data.natsUrl ?? rv.natsUrl;

  const client = new NatsClient({
    url: natsUrl,
    accountId,
    tenant: config.tenant,
    peerId: "wiretap-observer",
    natsCredentials: { userJwt: creds.data.userJwt, userSeedRaw: creds.data.userSeedRaw },
  });

  let subscribed = false;
  const wildcard = `webchannel.${config.tenant}.>`;

  client.onState((connected) => {
    if (connected) {
      statusLine.textContent = `● observing ${wildcard}`;
      statusLine.style.color = "var(--good)";
      if (!subscribed) {
        client.subscribe(wildcard);
        subscribed = true;
      }
    } else {
      statusLine.textContent = "● observer disconnected";
      statusLine.style.color = "var(--warn)";
      subscribed = false;
    }
  });

  client.onRawMessage((subject: string, payload: string) => {
    const leaf = subject.split(".").slice(-2).join(".");
    const row = el("div", {
      style: "border:1px solid var(--border);border-radius:5px;padding:6px 8px;font-size:11px",
    }, [
      el("div", { style: "color:var(--accent);margin-bottom:3px" }, [leaf]),
      el("div", { style: "color:var(--muted);word-break:break-all;line-height:1.5" }, [toHex(payload)]),
    ]);
    frames.prepend(row);
    // Cap the rendered frame list so a long session doesn't grow unbounded.
    while (frames.childElementCount > 60) frames.lastElementChild?.remove();
  });

  client.connect();

  return () => {
    client.disconnect();
    bodyEl.replaceChildren();
  };
}
