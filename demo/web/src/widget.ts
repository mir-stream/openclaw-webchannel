/**
 * Chat widget — a single agent "lane" rendered entirely from
 * WebChannelNATSClient (the production wrapper) state. Proves the base layer:
 * login → typing → streaming progress draft → real-LLM answer, HITL approval
 * cards, history hydration, and honest status/terminal-error surfacing.
 *
 * The full connect handshake is production: generate device keys in-page, mint
 * browser NATS creds + a PoP bootstrap JWT from the SaaS, then drive the wrapper
 * with BOTH natsCredentials (NATS-layer NKEY auth) and registration (HTTP PoP
 * register hop). The Ed25519 PoP private key is non-extractable and never leaves
 * the page.
 *
 * Scene ⑤ (short-lived trust): the "short-lived" control reconnects the lane with
 * a short-TTL NATS credential. When it lapses the relay refuses it, the client
 * classifies `-ERR Authentication Expired` as TERMINAL (no eternal spinner), and
 * the widget shows a distinct "credentials expired" state with a one-click
 * re-authenticate that mints a fresh, normal credential.
 */
import { WebChannelNATSClient } from "../../../packages/client/src/index.js";
import type { WebChannelState, ApprovalRequest } from "../../../packages/client/src/types.js";
import { api, b64url, el, type DemoConfig } from "./config.js";

const STATUS_LABEL: Record<WebChannelState["status"], string> = {
  connecting: "connecting…",
  connected: "connected",
  reconnecting: "reconnecting…",
  error: "error",
};

// The demo's short-lived-credential TTL (seconds) for the scene ⑤ control.
const SHORT_TTL_SECONDS = 12;

/**
 * Mount a chat lane for `accountId` into `bodyEl`. Returns a teardown fn that
 * disconnects the client and clears the DOM.
 */
export async function createWidget(
  bodyEl: HTMLElement,
  config: DemoConfig,
  accountId: string,
): Promise<() => void> {
  bodyEl.replaceChildren();

  const rv = config.accounts[accountId];
  if (!rv) throw new Error(`no rendezvous entry for account "${accountId}"`);

  // ── UI scaffold ─────────────────────────────────────────────────────────
  const statusPill = el("span", { class: "status-pill", style: "font-size:11px;color:var(--muted)" });
  const historyBtn = el("button", { style: "font-size:11px;padding:3px 8px" }, ["Load older"]);
  const shortBtn = el("button", { style: "font-size:11px;padding:3px 8px" }, ["⏱ short-lived"]) as HTMLButtonElement;
  const topBar = el("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:8px" }, [
    el("strong", { style: "font-size:12px" }, [accountId]),
    statusPill,
    el("span", { style: "flex:1" }),
    shortBtn,
    historyBtn,
  ]);
  const list = el("div", { style: "display:flex;flex-direction:column;gap:8px;min-height:120px" });
  const approvalsBox = el("div", { style: "display:flex;flex-direction:column;gap:8px" });
  const errBox = el("div", {
    class: "hidden",
    style:
      "padding:10px;border:1px solid var(--bad);border-radius:6px;color:var(--bad);" +
      "font-size:12px;background:rgba(248,81,73,.08)",
  });
  const input = el("input", { placeholder: "Type a message…", style: "flex:1" }) as HTMLInputElement;
  const sendBtn = el("button", { class: "primary" }, ["Send"]) as HTMLButtonElement;
  const composer = el("div", { style: "display:flex;gap:8px;margin-top:10px" }, [input, sendBtn]);
  bodyEl.append(topBar, errBox, list, approvalsBox, composer);

  let client: WebChannelNATSClient | null = null;

  // ── Render ───────────────────────────────────────────────────────────────
  function renderApproval(a: ApprovalRequest): HTMLElement {
    const resolved = a.resolvedDecision !== undefined;
    const buttons = a.options.map((opt) => {
      const bt = el("button", {}, [opt.label]) as HTMLButtonElement;
      if (opt.style === "danger") bt.style.borderColor = "var(--bad)";
      if (opt.style === "success" || opt.style === "primary") bt.className = "primary";
      bt.disabled = resolved;
      bt.onclick = () => client?.decide(a.id, opt.decision);
      return bt;
    });
    return el(
      "div",
      {
        style:
          "border:1px solid var(--accent);border-radius:8px;padding:10px;" +
          "background:rgba(47,129,247,.06)",
      },
      [
        el("div", { style: "font-weight:600;font-size:13px;margin-bottom:4px" }, [a.title || "Approval required"]),
        el("div", { style: "font-size:12px;color:var(--muted);margin-bottom:8px;white-space:pre-wrap" }, [a.prompt || a.description || ""]),
        el("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }, buttons),
        ...(resolved ? [el("div", { style: "font-size:11px;color:var(--good);margin-top:6px" }, [`→ ${a.resolvedDecision}`])] : []),
      ],
    );
  }

  function render(state: WebChannelState): void {
    statusPill.textContent = `● ${STATUS_LABEL[state.status]}`;
    statusPill.style.color =
      state.status === "connected" ? "var(--good)"
      : state.status === "error" ? "var(--bad)"
      : "var(--warn)";

    // Terminal error → distinct "credentials expired" box with a re-auth button
    // (scene ⑤ honest terminal-error UX — NOT the reconnect spinner).
    if (state.status === "error") {
      const reauth = el("button", { class: "primary", style: "margin-top:8px;font-size:12px" }, ["Re-authenticate"]) as HTMLButtonElement;
      reauth.onclick = () => { void connectLane(); };
      errBox.replaceChildren(
        el("div", { style: "font-weight:600;margin-bottom:4px" }, ["Credentials expired"]),
        el("div", {}, [state.error ?? "the relay rejected the credential — re-authenticate to continue"]),
        reauth,
      );
      errBox.classList.remove("hidden");
      input.disabled = true;
      sendBtn.disabled = true;
    } else {
      errBox.classList.add("hidden");
      input.disabled = false;
      sendBtn.disabled = false;
    }

    const bubbles = state.messages.map((m) =>
      el(
        "div",
        {
          style:
            "align-self:" + (m.role === "user" ? "flex-end" : "flex-start") + ";" +
            "max-width:85%;padding:8px 11px;border-radius:10px;font-size:13px;white-space:pre-wrap;" +
            (m.role === "user"
              ? "background:var(--accent);color:#fff"
              : "background:#21262d;border:1px solid var(--border)") +
            (m.working ? ";opacity:.7;font-style:italic" : ""),
        },
        [m.text],
      ),
    );
    if (state.isTyping) {
      bubbles.push(
        el("div", { style: "align-self:flex-start;font-size:12px;color:var(--muted)" }, ["agent is typing…"]),
      );
    }
    list.replaceChildren(...bubbles);
    approvalsBox.replaceChildren(...state.approvals.map(renderApproval));
  }

  /**
   * (Re)connect the lane. With `ttlSeconds` the NATS credential is short-lived
   * (scene ⑤); without it, a normal non-expiring credential (the re-auth path).
   * Device keys are regenerated per connect; the prior client is disconnected.
   */
  async function connectLane(ttlSeconds?: number): Promise<void> {
    client?.close();
    client = null;
    statusPill.textContent = "● connecting…";
    statusPill.style.color = "var(--warn)";
    errBox.classList.add("hidden");

    // Device keys (PoP private key non-extractable).
    const x25519 = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    const deviceX25519PublicKey = b64url(await crypto.subtle.exportKey("raw", x25519.publicKey));
    const ed25519 = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const edPubJwk = (await crypto.subtle.exportKey("jwk", ed25519.publicKey)) as { x?: string };
    if (!edPubJwk.x) throw new Error("Ed25519 public JWK missing 'x'");
    const devicePopPublicKey = edPubJwk.x;

    const creds = await api<{ userJwt?: string; userSeedRaw?: string; natsUrl?: string }>(
      "/nats-user",
      { method: "POST", body: ttlSeconds ? { role: "browser", ttlSeconds } : { role: "browser" } },
    );
    if (!creds.ok || !creds.data.userJwt || !creds.data.userSeedRaw) {
      throw new Error(`nats-user failed (HTTP ${creds.status})`);
    }
    const boot = await api<{ jwt?: string; peerId?: string; natsUrl?: string; registerBaseUrl?: string }>(
      "/bootstrap",
      { method: "POST", body: { accountId, deviceX25519PublicKey, devicePopPublicKey } },
    );
    if (!boot.ok || !boot.data.jwt || !boot.data.peerId) {
      throw new Error(`bootstrap failed (HTTP ${boot.status}) ${JSON.stringify(boot.data)}`);
    }

    const natsUrl = boot.data.natsUrl ?? creds.data.natsUrl ?? rv.natsUrl;
    const registerBaseUrl = boot.data.registerBaseUrl ?? rv.registerBaseUrl;

    client = new WebChannelNATSClient({
      natsUrl,
      bootstrapJwt: boot.data.jwt,
      accountId,
      tenant: config.tenant,
      peerId: boot.data.peerId,
      natsCredentials: { userJwt: creds.data.userJwt, userSeedRaw: creds.data.userSeedRaw },
      registration: { registerBaseUrl, devicePrivateKey: ed25519.privateKey },
    });
    client.subscribe(render);
    render(client.getState());
    client.connect();
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  historyBtn.onclick = () => {
    const oldest = client?.getState().messages.find((m) => !m.working);
    client?.loadHistory({ before: oldest?.id, limit: 20 });
  };
  shortBtn.onclick = () => { void connectLane(SHORT_TTL_SECONDS); };
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    client?.send(text);
    input.value = "";
  };
  sendBtn.onclick = submit;
  input.onkeydown = (e) => {
    if ((e as KeyboardEvent).key === "Enter") submit();
  };

  await connectLane();

  return () => {
    client?.close();
    bodyEl.replaceChildren();
  };
}
