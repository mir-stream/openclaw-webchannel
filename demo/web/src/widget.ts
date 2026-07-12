/**
 * Chat widget — a single agent "lane" rendered entirely from
 * WebChannelNATSClient (the production wrapper) state. Proves the base layer:
 * login → typing → streaming progress draft → real-LLM answer, HITL approval
 * cards, history hydration, and honest status/terminal-error surfacing.
 *
 * The full connect handshake is production: generate device keys in-page, mint
 * browser NATS creds + a PoP bootstrap JWT from the SaaS, then drive the wrapper
 * with BOTH natsCredentials (NATS-layer NKEY auth) and registration (PoP register
 * hop over NATS request/reply). The Ed25519 PoP private key is non-extractable
 * and never leaves the page.
 *
 * Scene ⑤ (short-lived trust): the "short-lived" control reconnects the lane with
 * a short-TTL NATS credential. When it lapses the relay refuses it, the client
 * classifies `-ERR Authentication Expired` as TERMINAL (no eternal spinner), and
 * the widget shows a distinct "credentials expired" state with a one-click
 * re-authenticate that mints a fresh, normal credential.
 */
import { WebChannelNATSClient, filterCommandCatalog } from "../../../packages/client/src/index.js";
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
  // Multi-device hint (scene ⑥): each tab generates its own device keys and gets
  // its own register-delivered conversation key, so the same user in a second tab
  // is a distinct device that still decrypts the shared backlog. No extra wiring —
  // the capability is inherent; this line just tells the viewer to try it.
  const mdHint = el("div", {
    style: "font-size:11px;color:var(--muted);margin-bottom:8px",
  }, ["↔ multi-device: open another tab as the same user — it syncs (each tab is its own device key)"]);
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
  // P0-3 slash-command typeahead menu — a column of command buttons rendered
  // above the composer while the user is typing a `/command`. Hidden otherwise.
  const cmdMenu = el("div", {
    class: "hidden",
    style:
      "display:flex;flex-direction:column;gap:2px;margin-top:8px;padding:4px;" +
      "border:1px solid var(--border);border-radius:6px;background:#161b22;max-height:180px;overflow:auto",
  });
  const composer = el("div", { style: "display:flex;gap:8px;margin-top:10px" }, [input, sendBtn]);
  bodyEl.append(topBar, mdHint, errBox, list, approvalsBox, cmdMenu, composer);

  let client: WebChannelNATSClient | null = null;
  // P0-3 typeahead state. `commandsRequestedAt` makes catalog discovery LAZY
  // and self-healing: we record WHEN we last asked (reset to null in
  // connectLane, so a re-auth re-requests for the fresh client). If the catalog
  // frame never arrives (server-side build failed), we retry on a cooldown
  // rather than latching dead until reconnect. `menuDismissed` lets Escape hide
  // the menu until the next keystroke.
  let commandsRequestedAt: number | null = null;
  const COMMANDS_REQUEST_COOLDOWN_MS = 3000;
  let menuDismissed = false;

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
        ...(resolved
          ? [
              el("div", { style: "font-size:11px;color:var(--good);margin-top:6px" }, [
                // #15: `"unknown"` means the approval was resolved on another
                // device / while we were away — outcome not known here. Render a
                // neutral label rather than the literal sentinel.
                a.resolvedDecision === "unknown"
                  ? "→ resolved (elsewhere)"
                  : `→ ${a.resolvedDecision}`,
              ]),
            ]
          : []),
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
    // Keep the typeahead in sync when the catalog frame lands mid-typing.
    renderMenu();
  }

  /**
   * P0-3: (re)render the slash-command typeahead from the CURRENT input value
   * and the latest catalog in state. Lazily requests the catalog the first time
   * the user types `/`. Picking an item inserts `/name ` and refocuses the
   * input; Enter then sends it as an ordinary message (no special-casing).
   */
  function renderMenu(): void {
    const value = input.value;
    const isSlash = value.startsWith("/");

    // Lazy discovery: fetch the catalog when the user starts a slash-command
    // (per client — reset on reconnect via connectLane). Gated on `client`
    // existing: a `/` typed during the connect window must NOT record a request
    // with nothing dispatched. We re-request only while NO catalog frame has
    // ever landed — `getState().commands` is undefined until the first
    // `commands` frame, after which it is an array (even empty) and we stop
    // asking. If the server-side build failed and no frame arrives, retry on a
    // cooldown so the typeahead heals without needing a reconnect.
    if (isSlash && client && client.getState().commands === undefined) {
      const now = Date.now();
      if (commandsRequestedAt === null || now - commandsRequestedAt > COMMANDS_REQUEST_COOLDOWN_MS) {
        commandsRequestedAt = now;
        client.loadCommands();
      }
    }

    const matches = menuDismissed
      ? []
      : filterCommandCatalog(client?.getState().commands, value);

    if (matches.length === 0) {
      cmdMenu.classList.add("hidden");
      cmdMenu.replaceChildren();
      return;
    }

    cmdMenu.classList.remove("hidden");
    cmdMenu.replaceChildren(
      ...matches.map((c) => {
        const item = el(
          "button",
          {
            style:
              "text-align:left;font-size:12px;padding:4px 6px;background:transparent;" +
              "border:none;border-radius:4px;cursor:pointer;color:var(--fg)",
          },
          [
            el("span", { style: "font-weight:600" }, [`/${c.name}`]),
            ...(c.description
              ? [el("span", { style: "color:var(--muted)" }, [` — ${c.description}`])]
              : []),
          ],
        ) as HTMLButtonElement;
        item.onclick = () => {
          input.value = `/${c.name} `;
          input.focus();
          renderMenu();
        };
        return item;
      }),
    );
  }

  /**
   * (Re)connect the lane. With `ttlSeconds` the NATS credential is short-lived
   * (scene ⑤); without it, a normal non-expiring credential (the re-auth path).
   * Device keys are regenerated per connect; the prior client is disconnected.
   */
  async function connectLane(ttlSeconds?: number): Promise<void> {
    client?.close();
    client = null;
    // Fresh client → re-request the command catalog on the next `/` (its state
    // starts without a catalog).
    commandsRequestedAt = null;
    menuDismissed = false;
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
    const boot = await api<{ jwt?: string; peerId?: string; natsUrl?: string; agentPublicKey?: string }>(
      "/bootstrap",
      { method: "POST", body: { accountId, deviceX25519PublicKey, devicePopPublicKey } },
    );
    if (!boot.ok || !boot.data.jwt || !boot.data.peerId) {
      throw new Error(`bootstrap failed (HTTP ${boot.status}) ${JSON.stringify(boot.data)}`);
    }
    // F2: the register hop unwraps K against this SaaS-pinned agent key.
    if (!boot.data.agentPublicKey) {
      throw new Error("bootstrap response missing agentPublicKey (register-hop requires it)");
    }

    const natsUrl = boot.data.natsUrl ?? creds.data.natsUrl ?? rv.natsUrl;

    client = new WebChannelNATSClient({
      natsUrl,
      bootstrapJwt: boot.data.jwt,
      accountId,
      tenant: config.tenant,
      peerId: boot.data.peerId,
      natsCredentials: { userJwt: creds.data.userJwt, userSeedRaw: creds.data.userSeedRaw },
      registration: {
        // The register subject is derived from tenant/accountId/peerId; the
        // client drives challenge→register over NATS request/reply (no gateway URL).
        devicePrivateKey: ed25519.privateKey,
        // Phase 6: register-delivered conversation key (no handshake).
        deviceX25519PrivateKey: x25519.privateKey,
        // F2: pin the SaaS-attested agent key for K authentication.
        pinnedAgentPublicKey: boot.data.agentPublicKey,
      },
    });
    client.subscribe(render);
    // Driver/debug hook: the verify-*.mjs drivers read message ids to make
    // dedup assertions stronger than DOM text matching allows.
    (globalThis as unknown as Record<string, unknown>).__webchannelState = () => client?.getState();
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
    renderMenu(); // hide the typeahead once the message is sent
  };
  sendBtn.onclick = submit;
  // Live-filter the typeahead as the user types (fires AFTER the value updates,
  // unlike keydown). A keystroke re-arms a menu the user dismissed with Escape.
  input.oninput = () => {
    menuDismissed = false;
    renderMenu();
  };
  input.onkeydown = (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter") submit();
    else if (key === "Escape") {
      menuDismissed = true;
      renderMenu();
    }
  };

  await connectLane();

  return () => {
    client?.close();
    bodyEl.replaceChildren();
  };
}
