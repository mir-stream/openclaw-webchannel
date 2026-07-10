/**
 * WebChannel NATS Client Wrapper — Adapter for existing client.ts.
 *
 * This module wraps the WebChannelNatsClient to provide the same API
 * as the original WebSocket-based WebChannelClient, enabling a drop-in
 * replacement for AC 5's NATS cutover.
 *
 * Changes from gateway-WS:
 * - No WebSocket connection to /webchannel/ws
 * - NATS WebSocket connection with JWT authentication
 * - Per-peer NATS subjects instead of single socket
 * - Message format preserved (compatible with existing UI)
 */

import type {
  WebChannelOptions,
  WebChannelState,
  Listener,
  ApprovalDecision,
  ApprovalOption,
  ChatMessage,
  ApprovalRequest,
} from "./types.js";
import {
  WebChannelNatsClient,
  type NatsClientOptions,
  type InboundMessage,
} from "./nats-client.js";

// ---------------------------------------------------------------------------
// WebChannel NATS Client
// ---------------------------------------------------------------------------

/**
 * NATS-based WebChannel client.
 *
 * Drop-in replacement for WebSocket-based WebChannelClient.
 * Uses NATS subjects for per-peer messaging instead of gateway-WS relay.
 */
export class WebChannelNATSClient {
  private readonly natsOptions: NatsClientOptions;
  private readonly client: WebChannelNatsClient;

  private state: WebChannelState = {
    messages: [],
    approvals: [],
    status: "connecting",
    connected: false,
  };

  private readonly listeners = new Set<Listener>();

  // `url` and `jwt` are supplied through the WebChannelOptions aliases
  // `natsUrl` / `bootstrapJwt`, so they are Omitted from the NatsClientOptions
  // half — otherwise the intersection would require the caller to ALSO pass a
  // raw `url` the wrapper ignores. Everything else (accountId, tenant, peerId,
  // registration, natsCredentials, reconnect tuning) is forwarded as-is.
  constructor(options: WebChannelOptions & Omit<NatsClientOptions, "url" | "jwt">) {
    this.natsOptions = {
      url: options.natsUrl ?? "wss://nats.example.com",
      jwt: options.bootstrapJwt ?? "",
      accountId: options.accountId ?? "default-account",
      tenant: options.tenant ?? "default-tenant",
      peerId: options.peerId ?? "anonymous-peer",
      registration: options.registration,
      // CL1: forward the NATS-layer NKEY credentials + reconnect tuning. A
      // production JWT-auth nats-server REQUIRES `natsCredentials` — without it
      // CONNECT ships only the bootstrap JWT with no signed nonce, the server
      // returns `-ERR Authorization Violation`, and the client enters an
      // unwinnable reconnect loop. Dropping these silently made the public
      // wrapper unusable against any real (non-open) NATS deployment.
      natsCredentials: options.natsCredentials,
      reconnectBaseMs: options.reconnectBaseMs,
      reconnectCapMs: options.reconnectCapMs,
      // CL3: forward the keepalive interval too (same drop-on-the-floor class as
      // the CL1 natsCredentials bug — the wrapper rebuilds the options object, so
      // any NatsClientOptions field it doesn't name is silently lost).
      heartbeatIntervalMs: options.heartbeatIntervalMs,
    };

    this.client = new WebChannelNatsClient(this.natsOptions);

    // Wire up message listener
    this.client.onMessage((msg: InboundMessage) => this.handleMessage(msg));

    // Wire up state listener. Once we are in the terminal `"error"` status
    // (CL2), a trailing `onState(false)` from the connection teardown must NOT
    // downgrade it back to "reconnecting" — the client is not reconnecting.
    this.client.onState((connected: boolean) => {
      if (!connected && this.state.status === "error") return;
      this.setState({
        status: connected ? "connected" : "reconnecting",
        connected,
      });
    });

    // CL2: surface a TERMINAL failure to the embedder. The underlying client
    // fires onError for non-retryable failures — a failed PoP registration or an
    // authoritative NATS auth rejection (`-ERR Authorization Violation`, expired
    // creds) — and has stopped reconnecting. We move to the terminal `"error"`
    // status with a reason so the app can prompt for fresh credentials instead
    // of showing an eternal reconnect spinner.
    this.client.onError((err: Error) => {
      console.error("[nats-wrapper] terminal connection error:", err);
      this.setState({ status: "error", connected: false, error: err.message });
    });
  }

  /** Get current state */
  getState(): WebChannelState {
    return this.state;
  }

  /** Subscribe to state changes */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Connect to NATS */
  connect(): void {
    this.client.connect();
  }

  /** Disconnect from NATS */
  close(): void {
    this.client.disconnect();
  }

  /** Send user message */
  send(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    // P0-7b: capture the wire id so a later `ack` frame can mark this local echo
    // delivered (the SDK correlates by wireId, never the synthetic local id).
    // Known/accepted: sendUserMessage publishes BEFORE appendMessage records the
    // echo, so a SAME-TICK synchronous ack would miss the bubble and `delivered`
    // would never flip. That can only happen on a synchronous fake transport (a
    // test); over a real WS/NATS socket the ack is always a later event-loop turn,
    // so it lands after the echo exists. Not restructured.
    const wireId = this.client.sendUserMessage(trimmed);

    this.appendMessage({
      id: `u-${this.uid()}`,
      role: "user",
      text: trimmed,
      wireId,
    });
  }

  /** Send approval decision */
  decide(id: string, decision: ApprovalDecision): void {
    this.patchApproval(id, (a) =>
      a.resolvedDecision === undefined
        ? { ...a, resolvedDecision: decision }
        : a,
    );
    this.client.sendApprovalDecision(id, decision);
  }

  /** Request history page */
  loadHistory(request?: { before?: string; limit?: number }): void {
    this.client.loadHistory(request?.before, request?.limit);
  }

  /**
   * Request the slash-command discovery catalog (P0-3). The agent answers with
   * a `commands` frame that lands in `state.commands`. UI calls this the first
   * time the user types `/` (lazy discovery); repeat calls are cheap and simply
   * refresh the catalog.
   */
  loadCommands(): void {
    this.client.loadCommands();
  }

  // ---------------------------------------------------------------------------
  // State management
  // ---------------------------------------------------------------------------

  private setState(patch: Partial<WebChannelState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private appendMessage(message: ChatMessage): void {
    this.setState({ messages: [...this.state.messages, message] });
  }

  private upsertMessage(
    id: string,
    update: (prev: ChatMessage) => ChatMessage,
    fallback: ChatMessage,
  ): void {
    const messages = this.state.messages;
    const idx = messages.findIndex((m) => m.id === id);
    if (idx === -1) {
      this.setState({ messages: [...messages, fallback] });
      return;
    }
    const next = messages.slice();
    next[idx] = update(next[idx]);
    this.setState({ messages: next });
  }

  private patchApproval(
    id: string,
    update: (prev: ApprovalRequest) => ApprovalRequest,
  ): void {
    this.setState({
      approvals: this.state.approvals.map((a) => (a.id === id ? update(a) : a)),
    });
  }

  private uid(): string {
    return `${this.seq++}`;
  }

  private seq = 0;

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private handleMessage(msg: InboundMessage): void {
    switch (msg.type) {
      case "history": {
        const incoming = Array.isArray(msg.messages) ? msg.messages : [];
        if (incoming.length === 0) return;

        const existing = this.state.messages;
        const seen = new Set(existing.map((m) => m.id));

        // Phase 6 (stateless register, shared conversation key): a snapshot
        // triggered by ANY device's register — this device's reconnect or a
        // second device joining — arrives at every device mid-session on the
        // shared `.out`. Messages already rendered LIVE on this device sit in
        // state under LOCAL id namespaces while the snapshot carries the core
        // transcript's canonical ids, so plain id-dedup would duplicate them:
        //   - user sends → synthetic local echo ids (`u-<n>`);
        //   - agent replies → the plugin's live-frame ids (`webchannel-…`
        //     from nextMessageId(), or `a-<n>` when a frame had no id) — the
        //     core transcript NEVER stores that platform id, so history ids
        //     can never match live ids for agent messages either.
        // Matching happens in three tiers, in snapshot order:
        //   1. id — a message whose canonical id we already hold (a prior
        //      snapshot placed or adopted it) is a no-op;
        //   2. exact text+role — adopt the server id onto the first
        //      text-matching local bubble (covers user echoes always; covers
        //      agent replies only when live text == stored text);
        //   3. POSITIONAL (agent only) — openclaw's live reply text is NOT
        //      byte-equal to the stored transcript text (core strips metadata
        //      sections from live replies but stores the raw model output), so
        //      tier 2 can miss agent bubbles entirely. Structure saves us: an
        //      agent reply in the snapshot immediately FOLLOWS the message it
        //      answered, and that predecessor matched some local index i via
        //      tier 1/2 — so if the local message at i+1 is a live-id agent
        //      bubble, it IS this reply's live rendering; adopt onto it (and
        //      keep the canonical stored text). Chains across multi-frame
        //      replies because each adoption advances the anchor.
        // PLACEMENT of the unmatched (fresh) messages is ORDERED, not a blanket
        // prepend (#16). We carry an insertion CURSOR = the index into `next`
        // before which the next fresh message lands; every match/adoption walks
        // it to `matchedIndex + 1`. So a mid-session snapshot whose overlapping
        // prefix matches the local tail inserts its unseen suffix chronologically
        // AFTER that prefix (a turn sent from another device, or turns that
        // landed while this tab was disconnected, appear at the bottom — not the
        // top). Pagination and zero-overlap frames match nothing → the cursor
        // stays 0 → the whole page prepends in order (unchanged); initial
        // hydration into empty state inserts everything at 0 in order (unchanged).
        // A `working:true` progress draft is never an adoption target: its
        // live id must survive for the upcoming progress/final upserts.
        // Known cosmetic edge (accepted): if TWO devices send the identical
        // text near-simultaneously, text-only matching can adopt the OTHER
        // device's server id onto this device's bubble — the ids swap between
        // the two bubbles, but the bubble COUNT stays exactly right and every
        // later snapshot still dedups, so nothing duplicates or disappears.
        const isLocalLiveId = (m: ChatMessage): boolean =>
          m.role === "user"
            ? m.id.startsWith("u-")
            : !m.working && (m.id.startsWith("a-") || m.id.startsWith("webchannel-"));
        const adoptKey = (role: string, text: string): string => `${role} ${text}`;

        const next = existing.slice();
        const localIndexById = new Map<string, number>();
        next.forEach((m, i) => localIndexById.set(m.id, i));
        const claimed = new Set<number>();
        const adoptable = new Map<string, number[]>();
        next.forEach((m, i) => {
          if ((m.role === "user" || m.role === "agent") && isLocalLiveId(m)) {
            const key = adoptKey(m.role, m.text);
            const idxs = adoptable.get(key) ?? [];
            idxs.push(i);
            adoptable.set(key, idxs);
          }
        });

        let adopted = false;
        /**
         * Fresh (unmatched) snapshot messages, grouped by the INSERTION CURSOR
         * value in effect when each was seen — the index into `next` BEFORE
         * which they must land. We cannot splice into `next` mid-loop (that
         * invalidates every cached local index in
         * `localIndexById`/`claimed`/`adoptable`), so the placement is deferred
         * to a single rebuild after the loop. Multiple fresh messages sharing a
         * cursor keep their snapshot order (appended to the same array).
         */
        const inserts = new Map<number, ChatMessage[]>();
        /** Local index the PREVIOUS snapshot message resolved to (tier-3 anchor). */
        let anchor: number | null = null;
        /**
         * Index into `next` before which the NEXT fresh message is inserted.
         * Advances to `matchedIndex + 1` past every matched (tier 1) or adopted
         * (tier 2/3) message, so a snapshot's unseen tail lands chronologically
         * AFTER the overlapping matched prefix instead of being prepended (#16).
         */
        let cursor = 0;

        const adoptAt = (idx: number, m: { id: string; text: string; ts?: number }): void => {
          // Keep the canonical stored text on adoption, so this device
          // converges to exactly what a reloading device would render.
          next[idx] = { ...next[idx], id: m.id, text: m.text, ts: m.ts };
          claimed.add(idx);
          localIndexById.set(m.id, idx);
          adopted = true;
          anchor = idx;
          cursor = idx + 1;
        };

        for (const m of incoming) {
          if (!m || typeof m !== "object") continue;
          if (typeof m.id !== "string" || m.id.length === 0) continue;
          if (m.role !== "user" && m.role !== "agent") continue;
          if (typeof m.text !== "string") continue;
          if (seen.has(m.id)) {
            const li = localIndexById.get(m.id);
            anchor = li ?? null;
            // Tier-1 match: walk the cursor past this already-held message so
            // later fresh messages insert after it. An id we can't locate
            // locally (should not happen — `seen` is seeded from `next`) leaves
            // the cursor untouched.
            if (li !== undefined) cursor = li + 1;
            continue;
          }

          seen.add(m.id);
          // Tier 2: exact text+role.
          const idxs = adoptable.get(adoptKey(m.role, m.text));
          while (idxs && idxs.length > 0 && claimed.has(idxs[0])) idxs.shift();
          if (idxs && idxs.length > 0) {
            adoptAt(idxs.shift()!, m);
            continue;
          }
          // Tier 3: positional (agent replies whose live text was reformatted).
          if (m.role === "agent" && anchor !== null) {
            const cand = anchor + 1;
            if (
              cand < next.length &&
              !claimed.has(cand) &&
              next[cand].role === "agent" &&
              isLocalLiveId(next[cand])
            ) {
              adoptAt(cand, m);
              continue;
            }
          }
          const atCursor = inserts.get(cursor) ?? [];
          atCursor.push({
            id: m.id,
            role: m.role,
            text: m.text,
            ts: m.ts,
            working: false,
          });
          inserts.set(cursor, atCursor);
          anchor = null;
        }

        if (inserts.size === 0 && !adopted) return;

        // Rebuild `next` with each fresh group spliced in at its cursor. Slot i
        // holds the messages that must precede `next[i]`; slot `next.length`
        // holds any tail appended after the last local message.
        const merged: ChatMessage[] = [];
        for (let i = 0; i <= next.length; i++) {
          const ins = inserts.get(i);
          if (ins) merged.push(...ins);
          if (i < next.length) merged.push(next[i]);
        }
        this.setState({ messages: merged });
        return;
      }

      case "typing": {
        this.setState({ isTyping: true });
        return;
      }

      case "commands": {
        // P0-3 discovery: replace the catalog wholesale (idempotent — a repeat
        // request just refreshes it). NOT turn activity, so isTyping is left
        // untouched.
        this.setState({ commands: Array.isArray(msg.commands) ? msg.commands : [] });
        return;
      }

      case "ack": {
        // P0-7b: mark the local echoes whose wireId the agent acknowledged at
        // ingress as delivered (state-only — the demo can render a ✓). Ids we
        // don't hold locally are a silent no-op.
        const ids = Array.isArray(msg.ids) ? msg.ids : [];
        if (ids.length === 0) return;
        const acked = new Set(ids);
        let changed = false;
        const messages = this.state.messages.map((m) => {
          if (m.wireId !== undefined && acked.has(m.wireId) && !m.delivered) {
            changed = true;
            return { ...m, delivered: true };
          }
          return m;
        });
        if (changed) this.setState({ messages });
        return;
      }

      case "approval_request": {
        const req: ApprovalRequest = {
          id: msg.id ?? "",
          kind: msg.kind ?? "exec",
          title: msg.title ?? "",
          description: msg.description,
          prompt: msg.prompt ?? "",
          options: (msg.options ?? []) as ApprovalOption[],
          expiresAtMs: msg.expiresAtMs,
        };

        const approvals = this.state.approvals;
        const idx = approvals.findIndex((a) => a.id === req.id);

        if (idx === -1) {
          this.setState({
            approvals: [...approvals, req],
            isTyping: false,
          });
        } else {
          // Upsert-preserve (#15): a re-delivered `approval_request` (stateless
          // register, retry) rebuilds a FRESH entry from the frame, which would
          // otherwise CLOBBER a locally-set resolution and resurrect actionable
          // buttons for an already-decided card. Carry the existing resolution
          // (and its server-confirmed flag) over the refreshed payload.
          const prev = approvals[idx];
          const next = approvals.slice();
          next[idx] =
            prev.resolvedDecision !== undefined
              ? {
                  ...req,
                  resolvedDecision: prev.resolvedDecision,
                  resolutionConfirmed: prev.resolutionConfirmed,
                }
              : req;
          this.setState({ approvals: next, isTyping: false });
        }
        return;
      }

      case "approval_resolved": {
        const id = msg.id ?? "";
        const decision = msg.decision as ApprovalDecision | undefined;
        // Server-confirmed resolution: set the decision AND mark it confirmed, so
        // the snapshot reconciler treats it as authoritative (never re-sends it
        // as a lost decision, never overwrites it with "unknown"). (#15)
        this.patchApproval(id, (a) => ({
          ...a,
          resolvedDecision: decision,
          resolutionConfirmed: true,
        }));
        return;
      }

      case "approval_snapshot": {
        // Authoritative pending-approval reconciliation (#15). The snapshot is
        // the account's COMPLETE still-pending set for this peer at publish time;
        // we reconcile local approval state against it to close three legs:
        //   A (reload lost the card) — a snapshot id with no local entry is
        //     rehydrated as pending;
        //   B (missed approval_resolved) — a local unresolved card ABSENT from
        //     the snapshot was decided/expired elsewhere → mark it non-actionable.
        //     If the snapshot's `resolved` set (#19) carries the actual outcome,
        //     show that decision; otherwise (aged out of the server's resolved
        //     ring) fall back to the "unknown" sentinel. Either way confirmed.
        //   C (lost decision frame) — a locally-decided but NOT server-confirmed
        //     card the snapshot STILL lists as pending → the decision frame was
        //     lost; re-send it and keep the card resolved (every future register
        //     retries until the server confirms, so it converges hands-free).
        const incoming = Array.isArray(msg.approvals) ? msg.approvals : [];
        const snapshotById = new Map<string, ApprovalRequest>();
        for (const p of incoming) {
          if (!p || typeof p.id !== "string" || p.id.length === 0) continue;
          snapshotById.set(p.id, {
            id: p.id,
            kind: p.kind ?? "exec",
            title: p.title ?? "",
            description: p.description,
            prompt: p.prompt ?? "",
            options: (p.options ?? []) as ApprovalOption[],
            expiresAtMs: p.expiresAtMs,
          });
        }
        // #19: the recently-RESOLVED outcomes riding alongside the pending set.
        // A resolved-list id with no local card is NOT rehydrated (it is done —
        // nothing actionable); the map only upgrades Leg B / the optimistic branch.
        const resolvedIncoming = Array.isArray(msg.resolved) ? msg.resolved : [];
        const resolvedById = new Map<string, ApprovalDecision>();
        for (const r of resolvedIncoming) {
          if (!r || typeof r.id !== "string" || r.id.length === 0) continue;
          resolvedById.set(r.id, r.decision as ApprovalDecision);
        }

        const existing = this.state.approvals;
        const seen = new Set<string>();
        const next: ApprovalRequest[] = [];
        let changed = false;
        // Tracks whether a NEW actionable (pending) card was rehydrated (Leg A),
        // so we clear the typing indicator in parity with the live
        // `approval_request` path — a fresh actionable card means the agent is
        // BLOCKED on the user, not still working.
        let rehydratedActionable = false;

        for (const a of existing) {
          seen.add(a.id);
          // Defense in depth: an id in BOTH the pending `approvals` and the
          // `resolved` lists is impossible server-side (finalize deletes the
          // pending entry and records the resolved outcome in ONE synchronous
          // step before publishing), but if it ever happens the TERMINAL outcome
          // must win — never keep/make the card actionable. So a resolved-listed
          // id is routed to the resolved-upgrade branches below, ignoring `snap`.
          const snap = resolvedById.has(a.id) ? undefined : snapshotById.get(a.id);
          if (snap) {
            if (a.resolvedDecision === undefined) {
              // Present + unresolved: already actionable with the full payload
              // (an approval is immutable once minted), so keep the existing
              // entry — a duplicate snapshot stays a no-op.
              next.push(a);
            } else if (!a.resolutionConfirmed && a.resolvedDecision !== "unknown") {
              // Leg C: re-send the lost decision, keep the card resolved. Stays
              // unconfirmed so the next register retries until the server echoes
              // an authoritative `approval_resolved`.
              this.client.sendApprovalDecision(a.id, a.resolvedDecision);
              next.push(a);
            } else {
              // Server-confirmed resolution wins over a stale-by-ms snapshot.
              next.push(a);
            }
          } else if (a.resolvedDecision === undefined) {
            // Leg B: decided/expired while we weren't looking — no longer
            // actionable, server-confirmed (authoritative). #19: show the ACTUAL
            // outcome if the snapshot carried it, else the "unknown" sentinel.
            const outcome = resolvedById.get(a.id);
            next.push({
              ...a,
              resolvedDecision: outcome ?? "unknown",
              resolutionConfirmed: true,
            });
            changed = true;
          } else if (!a.resolutionConfirmed) {
            // Optimistic decision the server no longer has pending — our decision
            // (or another device's) won. #19: if the snapshot's resolved outcome
            // DIFFERS from our optimistic guess, the SERVER decision wins;
            // otherwise just confirm what we already showed.
            const outcome = resolvedById.get(a.id);
            next.push(
              outcome !== undefined && outcome !== a.resolvedDecision
                ? { ...a, resolvedDecision: outcome, resolutionConfirmed: true }
                : { ...a, resolutionConfirmed: true },
            );
            changed = true;
          } else {
            next.push(a);
          }
        }

        // Leg A: snapshot ids with no local entry → rehydrate as pending cards.
        for (const [id, snap] of snapshotById) {
          if (seen.has(id)) continue;
          // Defense in depth (see the loop above): an id present in BOTH lists is
          // terminal, so do NOT rehydrate an actionable card for it.
          if (resolvedById.has(id)) continue;
          next.push(snap);
          changed = true;
          rehydratedActionable = true;
        }

        if (changed) {
          this.setState({
            approvals: next,
            ...(rehydratedActionable ? { isTyping: false } : {}),
          });
        }
        return;
      }

      case "progress": {
        const { id } = msg;
        const text = msg.text ?? "";
        this.upsertMessage(
          id ?? "",
          (prev) => ({ ...prev, text, working: true }),
          { id: id ?? "", role: "agent", text, working: true },
        );
        this.setState({ isTyping: false });
        return;
      }

      case "agent_message": {
        const { text, id } = msg;
        this.setState({ isTyping: false });

        if (id) {
          this.upsertMessage(
            id,
            (prev) => ({ ...prev, text: text ?? "", working: false }),
            { id, role: "agent", text: text ?? "", working: false },
          );
          return;
        }

        this.appendMessage({
          id: `a-${this.uid()}`,
          role: "agent",
          text: text ?? "",
        });
        return;
      }
    }
  }
}

