/**
 * Chat widget — a single agent "lane" rendered entirely from
 * WebChannelNATSClient (the production wrapper) state. Proves the base layer:
 * login → typing → streaming progress draft → real-LLM answer, HITL approval
 * cards, history hydration, and honest status/terminal-error surfacing.
 *
 * The full connect registration is production: generate device keys in-page, mint
 * browser NATS creds + a PoP bootstrap JWT from the SaaS, then drive the wrapper
 * with BOTH natsCredentials (NATS-layer NKEY auth) and registration (PoP register
 * hop over NATS request/reply). The Ed25519 PoP private key is non-extractable
 * and never leaves the page.
 *
 * Scene ⑤ (short-lived trust): the "short-lived" control reconnects the lane with
 * a short-TTL NATS credential. When it lapses the relay refuses it, the client
 * classifies `-ERR Authentication Expired` as TERMINAL (no eternal spinner) with
 * cause `auth-expired`. The terminal error box (P1-7) is cause-driven: it maps the
 * `state.errorCause` tag to truthful wording + the right recovery affordance via
 * `terminalErrorCopy`, so scene ⑤ shows "Credentials expired" + re-authenticate,
 * while a protocol mismatch or embedder config error shows its own heading and
 * hides the (useless) re-auth button.
 */
import { WebChannelNATSClient, filterCommandCatalog } from "../../../packages/client/src/index.js";
import type { WebChannelState, ApprovalRequest, ChatMessage } from "../../../packages/client/src/types.js";
import { api, b64url, el, type DemoConfig } from "./config.js";
import { renderMarkdown } from "./markdown.js";
import { terminalErrorCopy } from "./error-copy.js";
import {
  orderConversationPresentation,
  captureOpenReasoningIds,
  buildReasoningDetails,
  buildToolActivityChip,
  composerButtonMode,
  activityHint,
} from "./presentation.js";

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

  // Per-message memo of rendered markdown DOM, keyed by message id + text.
  // render() is subscribed to client state and re-runs on EVERY change (each
  // streaming partial, typing flip, approval, etc.), rebuilding the whole bubble
  // list each pass. renderMarkdown is a synchronous, worst-case O(n²) parse up to
  // the 20k cap, so without a memo every stable agent bubble re-parses on every
  // later partial while it sits in the transcript. Keying by id+text means a
  // `working` draft (whose text grows each partial) naturally misses and
  // re-renders — correct — while unchanged messages hit the cache. Reusing the
  // SAME element instance is fine: the element just moves into the fresh bubble
  // container on re-append. The cache is rebuilt from the prior one each pass
  // (see render()), so departed messages drop out and it stays bounded by the
  // live transcript.
  let mdCache = new Map<string, HTMLElement>();

  /**
   * Stop button (P1-8a): while a turn is in flight — the agent is typing, a
   * working (unfinalized) progress bubble is live, or the turn is still open
   * between bubbles (#96, `turnActive`) — the primary button becomes a Stop
   * button, which sends the literal "/stop" (wire choice (a): the typed command
   * and the button share one server path). It restores to "Send" once the turn
   * settles OR the user types, because `composerButtonMode` reads the draft too:
   * the label must always state exactly what a click does, and a draft is Send
   * intent. That makes the composer TEXT a second input to the label, so this
   * runs on every draft change as well as every state change — render() alone
   * would leave a stale "Stop" on a composer that now sends.
   */
  const applyComposerMode = (state: WebChannelState): void => {
    if (state.status === "error") return; // the error branch disables the button; leave it
    const mode = composerButtonMode(state, input.value);
    sendBtn.dataset.mode = mode;
    sendBtn.textContent = mode === "stop" ? "Stop" : "Send";
  };
  /** Re-apply the button mode after a draft change, outside a state callback. */
  const refreshComposerMode = (): void => {
    const s = client?.getState();
    if (s) applyComposerMode(s);
  };

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

  // P1-9: a HELD (pending) user message — a dimmed chip with the "queued" hint
  // and a ✕ to retract it BEFORE it publishes (the local twin of the server-side
  // coalesce buffer; retracting means the agent never sees the text).
  function renderPendingBubble(m: ChatMessage): HTMLElement {
    const dismiss = el("button", {
      title: "retract",
      style: "background:transparent;border:none;color:inherit;cursor:pointer;font-size:12px;padding:0 2px",
    }, ["✕"]) as HTMLButtonElement;
    dismiss.onclick = () => client?.retract(m.id);
    return el("div", {
      style:
        "align-self:flex-end;max-width:85%;padding:8px 11px;border-radius:10px;" +
        "font-size:13px;white-space:pre-wrap;background:var(--accent);color:#fff;opacity:.55",
    }, [
      el("div", {}, [m.text]),
      el("div", {
        style: "display:flex;align-items:center;gap:6px;margin-top:4px;font-size:11px;opacity:.9",
      }, [
        el("span", { style: "flex:1" }, ["⏳ queued — sends when the agent finishes"]),
        dismiss,
      ]),
    ]);
  }

  // P1-9 §3.4: a RETRACTED user message — an explicit /stop marked it "not sent"
  // instead of destroying it (client-held text exists nowhere else). Struck and
  // dimmed, with a one-tap RESTORE (into the composer, appended so it never
  // clobbers a draft the user is mid-typing) and a ✕ to dismiss it for good.
  function renderRetractedBubble(m: ChatMessage): HTMLElement {
    const restore = el("button", {
      style: "background:transparent;border:none;color:var(--accent);cursor:pointer;font-size:11px;padding:0",
    }, ["restore"]) as HTMLButtonElement;
    restore.onclick = () => {
      input.value = input.value.trim() ? `${input.value} ${m.text}` : m.text;
      input.focus();
      client?.retract(m.id);
      renderMenu();
      // Every writer of `input.value` re-derives the Send/Stop label, because a
      // programmatic write fires no `oninput` (see `applyComposerMode`).
      refreshComposerMode();
    };
    const dismiss = el("button", {
      title: "dismiss",
      style: "background:transparent;border:none;color:inherit;cursor:pointer;font-size:12px;padding:0 2px",
    }, ["✕"]) as HTMLButtonElement;
    dismiss.onclick = () => client?.retract(m.id);
    return el("div", {
      style:
        "align-self:flex-end;max-width:85%;padding:8px 11px;border-radius:10px;" +
        "font-size:13px;white-space:pre-wrap;background:#21262d;border:1px solid var(--border);" +
        "color:var(--muted);opacity:.7",
    }, [
      el("div", { style: "text-decoration:line-through" }, [m.text]),
      el("div", {
        style: "display:flex;align-items:center;gap:8px;margin-top:4px;font-size:11px",
      }, [
        el("span", { style: "flex:1" }, ["not sent — stopped"]),
        restore,
        dismiss,
      ]),
    ]);
  }

  function render(state: WebChannelState): void {
    statusPill.textContent = `● ${STATUS_LABEL[state.status]}`;
    statusPill.style.color =
      state.status === "connected" ? "var(--good)"
      : state.status === "error" ? "var(--bad)"
      : "var(--warn)";

    // Terminal error → cause-driven box (P1-7): the heading/hint and whether a
    // Re-authenticate button is offered come from `terminalErrorCopy(errorCause)`,
    // so a protocol mismatch or embedder config error no longer masquerades as the
    // single hardcoded "Credentials expired" state. The raw `state.error` detail
    // line renders ONLY when present; the copy.hint always renders exactly once
    // (no duplicate). NOT the reconnect spinner.
    if (state.status === "error") {
      const copy = terminalErrorCopy(state.errorCause);
      const children: Node[] = [
        el("div", { style: "font-weight:600;margin-bottom:4px" }, [copy.heading]),
      ];
      if (state.error) children.push(el("div", {}, [state.error]));
      children.push(el("div", { style: "color:var(--muted);margin-top:4px" }, [copy.hint]));
      if (copy.showReauth) {
        const reauth = el("button", { class: "primary", style: "margin-top:8px;font-size:12px" }, ["Re-authenticate"]) as HTMLButtonElement;
        reauth.onclick = () => { connectLaneGuarded(); };
        children.push(reauth);
      }
      errBox.replaceChildren(...children);
      errBox.classList.remove("hidden");
      input.disabled = true;
      sendBtn.disabled = true;
    } else {
      errBox.classList.add("hidden");
      input.disabled = false;
      sendBtn.disabled = false;
    }

    // Send/Stop label for the new state (see `applyComposerMode`). In the error
    // state the button is disabled (above), so it leaves the label alone.
    applyComposerMode(state);

    // Carry markdown hits over from the previous pass; misses re-parse. Assigned
    // to `mdCache` after the list is built so it tracks only the live transcript.
    const nextMdCache = new Map<string, HTMLElement>();
    const openReasoningIds = captureOpenReasoningIds(list);
    const bubbles: HTMLElement[] = [];
    // #242 half 2: `state.reasoning` is no longer passed — reasoning lives in
    // `state.messages` at its own position now, and re-supplying the derived
    // array would ask this function to place the same blocks twice.
    for (const presentation of orderConversationPresentation(
      state.messages,
      state.toolActivity ?? [],
    )) {
      if (presentation.kind === "reasoning") {
        const item = presentation.value;
        const key = `reasoning:${item.id}\n${item.text}`;
        const rendered = mdCache.get(key) ?? renderMarkdown(item.text);
        nextMdCache.set(key, rendered);
        bubbles.push(
          buildReasoningDetails(item, rendered, openReasoningIds.has(item.id)),
        );
        continue;
      }
      // #97: minimal, muted tool-activity chip (structured lane, not history).
      if (presentation.kind === "tool_activity") {
        bubbles.push(buildToolActivityChip(presentation.value));
        continue;
      }
      const m = presentation.value;
      const isUser = m.role === "user";
      // P1-9: held/retracted user messages get their own affordance-bearing
      // bubbles (queued chip / not-sent marker), not the plain send bubble.
      if (isUser && (m.pending || m.retracted)) {
        bubbles.push(m.pending ? renderPendingBubble(m) : renderRetractedBubble(m));
        continue;
      }
      // User bubbles stay plain-text (pre-wrap keeps their line breaks). Agent
      // bubbles — including `working` streaming drafts — render markdown to DOM;
      // the renderer handles line breaks itself, so no pre-wrap (it'd double up).
      let child: Node | string;
      if (isUser) {
        child = m.text;
      } else {
        const key = `${m.id}\n${m.text}`;
        const rendered = mdCache.get(key) ?? renderMarkdown(m.text);
        nextMdCache.set(key, rendered);
        child = rendered;
      }
      bubbles.push(el(
        "div",
        {
          style:
            "align-self:" + (isUser ? "flex-end" : "flex-start") + ";" +
            "max-width:85%;padding:8px 11px;border-radius:10px;font-size:13px;" +
            (isUser ? "white-space:pre-wrap;" : "") +
            (isUser
              ? "background:var(--accent);color:#fff"
              : "background:#21262d;border:1px solid var(--border)") +
            (m.working ? ";opacity:.7;font-style:italic" : ""),
        },
        [child],
      ));
    }

    // Activity hint (#96). `activityHint` owns the decision: the reasoning lane
    // replaces the "agent is typing…" line only (it is that signal in richer
    // form), while the gap hint "still working…" — shown when `turnActive` keeps
    // a turn open between bubbles, so the gap is not a silence indistinguishable
    // from completion — yields to a live `working` draft (it has its own bubble)
    // and to an unresolved approval card (the turn is blocked on the user).
    const hint = activityHint(state);
    if (hint) {
      bubbles.push(
        el("div", { style: "align-self:flex-start;font-size:12px;color:var(--muted)" }, [hint]),
      );
    }
    list.replaceChildren(...bubbles);
    mdCache = nextMdCache;
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
          refreshComposerMode(); // same reason as the retract restore, above
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
        // Phase 6: register-delivered conversation key (no registration).
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

  /**
   * Fire-and-forget lane (re)connect. A failed re-auth (the /nats-user or
   * /bootstrap SaaS fetch) rejects BEFORE any client exists, so no state event
   * renders it — without this catch the errBox stays hidden and the pill sticks
   * on "connecting…". Renders the failure into errBox with a retry that repeats
   * the SAME request (incl. scene ⑤'s short TTL).
   */
  function connectLaneGuarded(ttlSeconds?: number): void {
    connectLane(ttlSeconds).catch((err: unknown) => {
      statusPill.textContent = "● error";
      statusPill.style.color = "var(--bad)";
      const retry = el("button", { class: "primary", style: "margin-top:8px;font-size:12px" }, ["Re-authenticate"]) as HTMLButtonElement;
      retry.onclick = () => { connectLaneGuarded(ttlSeconds); };
      errBox.replaceChildren(
        el("div", { style: "font-weight:600;margin-bottom:4px" }, ["Re-authentication failed"]),
        el("div", {}, [err instanceof Error ? err.message : String(err)]),
        el("div", { style: "color:var(--muted);margin-top:4px" }, ["The auth endpoint could not be reached — try again."]),
        retry,
      );
      errBox.classList.remove("hidden");
      input.disabled = true;
      sendBtn.disabled = true;
    });
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  historyBtn.onclick = () => {
    // P1-9: a local-only id (held pending / retracted) must never be sent as a
    // `before` cursor — exclude them from the oldest-cursor pick.
    //
    // ⚠️ #242 half 2 ADDS A REASONING ROW TO THAT EXCLUSION, and it is the same
    // rule, not a new one: a reasoning block is only in the journal for an
    // account that opted into `capabilities.reasoningDurable` (default OFF), so
    // on a default deployment a LIVE reasoning id is another id the server has
    // never heard of. Sending one as `before` makes `historyPageBefore` answer
    // `[]` — the honest "no more history" contract — and the button would look
    // broken. Reasoning blocks that came FROM history are safely skippable too:
    // the next row is a cursor for the same page.
    const oldest = client?.getState().messages.find(
      (m) => m.kind === undefined && !m.working && !m.pending && !m.retracted,
    );
    client?.loadHistory({ before: oldest?.id, limit: 20 });
  };
  shortBtn.onclick = () => { connectLaneGuarded(SHORT_TTL_SECONDS); };
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    client?.send(text);
    input.value = "";
    renderMenu(); // hide the typeahead once the message is sent
    // Clearing the draft programmatically fires no `oninput`, and send()'s own
    // synchronous re-render ran BEFORE the clear (so it saw the stale draft) —
    // without this the button would stay "Send" through the turn it just opened.
    refreshComposerMode();
  };
  // The primary button is a Send button by default and a Stop button while a
  // turn is in flight AND the composer is empty (`applyComposerMode` flips
  // `dataset.mode`). The mode is the single guard, so the label and this handler
  // can never disagree. Stop sends the literal "/stop" through the SAME send
  // path a typed "/stop" would take.
  sendBtn.onclick = () => {
    if (sendBtn.dataset.mode === "stop") {
      client?.send("/stop");
      return;
    }
    submit();
  };
  // Live-filter the typeahead as the user types (fires AFTER the value updates,
  // unlike keydown). A keystroke re-arms a menu the user dismissed with Escape.
  input.oninput = () => {
    menuDismissed = false;
    renderMenu();
    // The draft is half of the Send/Stop decision, and typing changes no client
    // state — so nothing else would re-run the label.
    refreshComposerMode();
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
