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
  }, [
    "Observer creds subscribe the entire tenant subtree. The routing envelope is plaintext (the relay must route it), but every message body is ciphertext — decode the hex and you never find what was typed. ",
    // Register/admission now rides the relay too — so the observer SEES it happen
    // and still can't break in: the bootstrap JWT is single-use (PoP: signed over a
    // one-time nonce) + short-TTL, and the delivered conversation key is wrapped to
    // the device key. Tagged ✦admission frames below.
    el("span", { style: "color:var(--warn)" }, ["✦admission"]),
    " frames (register / reginbox) are the enrollment exchange on the relay — visible, but replaying the JWT fails (single-use nonce) and the wrapped key is useless without the device key.",
  ]);
  const frames = el("div", { style: "display:flex;flex-direction:column;gap:6px;font-family:var(--mono)" });
  bodyEl.append(statusLine, note, frames);

  // Observer creds: a SUB-only NATS user (sub webchannel.{tenant}.>, NO pub). The
  // wiretap must never publish — observer is strictly weaker than a browser (which
  // is now pinned to its own peer subtree), so it can read every frame but can't
  // inject one. Tenant-wide observer creds are an OPERATOR capability: they come
  // from the admin-gated /admin/nats-user route, NOT the browser-facing /nats-user
  // (which only ever mints per-peer browser creds). This pane therefore mounts for
  // admin sessions only (see app.ts).
  const creds = await api<{ userJwt?: string; userSeedRaw?: string; natsUrl?: string }>(
    "/admin/nats-user",
    { method: "POST", body: { role: "observer" } },
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
    // The admission exchange (register request + reginbox reply) rides the relay
    // now — tag it so a viewer notices the JWT/PoP handshake is visible yet safe.
    // Match BOTH the request (`…{peerId}.register`) and the reply, whose subject
    // is `…{peerId}.reginbox.{token}` (ends in the token, not `.reginbox`), via a
    // segment check rather than an end-anchored test.
    const isAdmission = subject.split(".").some((s) => s === "register" || s === "reginbox");
    const row = el("div", {
      style:
        "border:1px solid " + (isAdmission ? "var(--warn)" : "var(--border)") +
        ";border-radius:5px;padding:6px 8px;font-size:11px",
    }, [
      el("div", { style: "color:var(--accent);margin-bottom:3px" }, [
        ...(isAdmission ? [el("span", { style: "color:var(--warn)" }, ["✦admission "])] : []),
        leaf,
      ]),
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
