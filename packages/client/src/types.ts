/**
 * Public types for the headless WebChannel client.
 *
 * Shared state and option types for the NATS-backed browser client. Wire-frame
 * types remain private to the NATS implementation.
 */

export type ChatRole = "user" | "agent";

/**
 * P0-4: the send lifecycle of a user message, as tracked authoritatively by the
 * low-level client's monotonic tracker (`WebChannelNatsClient`).
 *
 *   queued -> sent -> accepted           (+ failed, terminal, from any state)
 *
 * - `queued`   — held locally; not yet written to the socket (pre-key buffer,
 *                P1-9 hold, or awaiting a publish retry).
 * - `sent`     — the encrypted `user_message` frame was written to the socket.
 *                NOT a plugin acceptance.
 * - `accepted` — the plugin acked the frame at ingress (P0-7b `ack`).
 * - `failed`   — terminal; carries a `SendFailure` (reason + retryable +
 *                lastAttemptAt, and a `WebChannelErrorCause` for `terminal`).
 *
 * `completed` is NOT a tracker state — it is a wrapper-level promotion driven by
 * an explicit `turn_settled{outcome:"ok"}` whose `turnId` exactly matches the
 * message wire id (see `ChatMessage.sendState`), so the low-level tracker (which
 * knows nothing about turns) stays the sole authority for
 * queued/sent/accepted/failed.
 */
export type SendState = "queued" | "sent" | "accepted" | "failed";

/**
 * P0-4: the terminal-failure payload accompanying a `failed` send.
 *
 * `reason` distinguishes the cause of the failure; `retryable` means the caller
 * may initiate a fresh send attempt after this terminal outcome. A failed receipt
 * never resumes and the client never automatically retries that receipt:
 * - `closed`      — an explicit `disconnect()`/`close()` retired the instance.
 * - `evicted`     — the P0-7b unacked ledger exceeded its cap; the oldest entry
 *                   was dropped (a fresh send on the ready instance can succeed).
 * - `terminal`    — a non-retryable connection failure (auth/protocol/register);
 *                   `cause` carries the original `WebChannelErrorCause`.
 * - `overloaded`  — plugin rejected ingress due to bounded retained-work pressure;
 *                   caller-directed retry is allowed, but never automatic.
 * - `turn-failed` — the turn was admitted but settled with `outcome:"error"`;
 *                   caller-directed re-sending is allowed when ready.
 * - `cancelled`   — the user intentionally cancelled the send (a `/stop`
 *                   hold-retraction or `retract()`); never retryable.
 *
 * Runtime policy is `true` for `evicted`/`overloaded`/`turn-failed`, and `false`
 * for `closed`/`terminal`/`cancelled`. Readiness is separate: a caller still must not
 * retry until the current instance is ready (and terminal recovery needs a new
 * instance), even where the surrounding application offers a recovery action.
 */
export type SendFailure = {
  reason: "closed" | "evicted" | "terminal" | "overloaded" | "turn-failed" | "cancelled";
  /** For `reason === "terminal"`: the original connection-failure classification. */
  cause?: WebChannelErrorCause;
  retryable: boolean;
  /** Wall-clock ms of the most recent publish attempt (absent if never attempted). */
  lastAttemptAt?: number;
};

/**
 * P0-4: an observable handle for one `send()`. Its `id` is the message's
 * immutable receipt key — stable across history adoption (which rewrites the
 * render bubble's public `id`) and across `retract()` (which removes the render
 * bubble entirely) — so a caller can always correlate a send to its outcome.
 *
 * The handle is a thin view over the wrapper's receipt record: `snapshot()`
 * reads the current state, `subscribe()` fires on every state transition and
 * returns an unsubscribe. Both survive `retract()`: a retracted send reports
 * `failed{reason:"cancelled"}`, never a stuck `queued`.
 */
export type SendReceipt = {
  /** Immutable receipt key — valid across history adoption/release/retract. */
  readonly id: string;
  /**
   * P0-4 (review R5): `NonNullable`, not the optional `ChatMessage["sendState"]`
   * — a receipt record always carries a concrete state (the record's own field is
   * non-optional, and the never-taken missing-record fallback returns `"failed"`),
   * so admitting `undefined` here would force every consumer of this BREAKING API
   * to narrow a value that cannot occur.
   */
  snapshot(): { state: NonNullable<ChatMessage["sendState"]>; failure?: SendFailure };
  subscribe(cb: (s: ReturnType<SendReceipt["snapshot"]>) => void): () => void;
};

/**
 * One transcript bubble. `working: true` marks a live progress draft (the
 * rolling "Working…" bubble); it flips to false when the same id is finalized
 * into the agent's answer.
 *
 * `ts` is hydration metadata: server-recorded millisecond timestamp carried
 * over from the core session transcript. The server uses it to sort the
 * initial snapshot in recency order. Local sends (a user typing in the
 * widget) keep `ts` absent — the server stamps it on receive.
 */
export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  ts?: number;
  working?: boolean;
  /**
   * P0-7b: the stable wire `id` the client stamped on the outbound
   * `user_message` this bubble echoes (user role only). Set at send/release time
   * so an `ack` frame's `accepted` transition can find the bubble. Absent on
   * server-hydrated bubbles, on agent messages, and on a still-`queued` P1-9
   * hold (assigned only at release); not used by the history three-tier adoption.
   */
  wireId?: string;
  /**
   * P0-4: the render mirror of this send's authoritative tracker state (user
   * role only). Replaces the old boolean `delivered` — `accepted`/`completed`
   * are the two "the agent got it" states a ✓ renders; `failed` renders a ⚠
   * with `sendFailure.reason`. Absent on server-hydrated and agent bubbles.
   *
   * `completed` is a wrapper-level promotion over the tracker's `accepted`,
   * applied only when an explicit `turn_settled{outcome:"ok"}` names this exact
   * message (`turnId === wireId`). The current plugin emits one same-outcome
   * frame per coalesced member, in arrival order with the anchor last, so every
   * member is promoted. Older anchor-only v3 plugin builds leave non-anchors at
   * `accepted`; an outcome-less legacy frame
   * leaves even the member it names at `accepted`.
   */
  sendState?: "queued" | "sent" | "accepted" | "completed" | "failed";
  /** P0-4: present only when `sendState === "failed"` — the failure detail. */
  sendFailure?: SendFailure;
  /**
   * P0-4 (internal): immutable receipt key linking this bubble to its
   * `SendReceipt` record. History adoption rewrites `id` in place but keeps this
   * key (it spreads the prior bubble), so the receipt survives id churn. Not a
   * render field. @internal
   */
  receiptKey?: string;
  /** Ephemeral live-turn correlation. History messages intentionally omit it. */
  turnId?: string;
  /**
   * P1-9: true while this user message is HELD locally (a turn was in flight
   * at send time) and not yet published. Local-only — never on the wire,
   * never in history. Flips off (with wireId/turnId assigned) at release.
   */
  pending?: boolean;
  /**
   * P1-9: an explicit /stop converted this held message into a not-sent
   * marker. Local-only. Text preserved; removable via retract(id).
   */
  retracted?: boolean;
};

export type ReasoningItem = {
  id: string;
  turnId: string;
  text: string;
};

/** Native HITL approval decision; mirrors the plugin/SDK union. */
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

/**
 * One positional argument of a slash command (P0-3 discovery). A trimmed subset
 * of the plugin's registry arg shape — just what the typeahead needs. Mirrors
 * `packages/plugin/src/commands-catalog.ts` (re-declared, not imported, so this
 * package stays Node-free).
 */
export type CommandCatalogArg = {
  name: string;
  description?: string;
  required?: boolean;
  /** Static allowed values (absent when the arg takes free text). */
  choices?: string[];
};

/**
 * One slash command in the discovery catalog (P0-3). `name` is WITHOUT a
 * leading slash (the registry's shape); a view renders it as `/${name}`.
 */
export type CommandCatalogEntry = {
  name: string;
  description: string;
  args?: CommandCatalogArg[];
};

/** One offered approval button. */
export type ApprovalOption = {
  decision: ApprovalDecision;
  label: string;
  /** Visual hint (success | primary | danger | …). */
  style: string;
};

/**
 * A pending (or just-resolved) native approval prompt. `resolvedDecision` is set
 * once `approval_resolved` arrives (or the client optimistically records a
 * click), at which point the UI should disable the buttons.
 *
 * `"unknown"` (#15) is a resolution SENTINEL: the approval was decided or expired
 * while this device wasn't looking (a register-time `approval_snapshot` no longer
 * lists it), so the card is no longer actionable but the actual outcome is not
 * known. A view should render it as a neutral "resolved elsewhere" state.
 *
 * `resolutionConfirmed` distinguishes a SERVER-confirmed resolution (an
 * `approval_resolved` frame, or a snapshot marking the card resolved) from
 * `decide()`'s OPTIMISTIC local set. It stays falsy for an optimistic decision
 * so the snapshot reconciler can detect a lost decision frame (Leg C) and
 * re-send it. It is internal-ish plumbing; the demo widget still keys its UI
 * purely off `resolvedDecision !== undefined`.
 */
export type ApprovalRequest = {
  id: string;
  kind: "exec" | "plugin";
  title: string;
  description?: string;
  prompt: string;
  options: ApprovalOption[];
  expiresAtMs?: number;
  resolvedDecision?: ApprovalDecision | "unknown";
  resolutionConfirmed?: boolean;
};

/**
 * Connection status, richer than a bool (drives the UI status dot).
 *
 * `"error"` is TERMINAL (CL2): the connection failed in a way retrying can't fix
 * — an authoritative auth rejection (expired/invalid credentials, `-ERR
 * Authorization Violation`) or a failed PoP registration. The client stops
 * reconnecting and the embedder must re-initialize with fresh credentials; the
 * accompanying `WebChannelState.error` carries a human-readable reason.
 */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "error";

/**
 * Machine-readable cause of a TERMINAL connection failure (status `"error"`).
 * Drives per-cause wording + the recovery affordance in the embedder UI, so a
 * protocol mismatch or an embedder config bug no longer masquerades as the single
 * hardcoded "Credentials expired" heading. Additive/open string union — a future
 * producer can add a member and older UIs fall through to `"unknown"`.
 */
export type WebChannelErrorCause =
  // `-ERR …Authentication Expired`: creds were valid, their TTL lapsed. Benign,
  // expected with short-TTL creds (demo scene ⑤); re-auth mints a fresh one.
  | "auth-expired"
  // `-ERR …Authorization Violation` OR a PoP register 401: this credential was
  // never/no-longer acceptable (possibly revoked). Re-auth. Stays
  // revocation-NEUTRAL — a benign expiry hitting during a reconnect window is
  // rejected at CONNECT as a violation, so this cause can cover that user story too.
  | "auth-rejected"
  // Explicit 426, version mismatch, malformed/missing `protocolVersion`, or a
  // register reply with no `wrappedConversationKey`: the two sides speak
  // incompatible wire contracts.
  // Re-auth CANNOT help — the older side must be upgraded.
  | "protocol-mismatch"
  // Missing SaaS-pinned agent key OR a conversation-key unwrap failure: the E2E
  // session could not be authenticated/established. Re-auth (which refetches the
  // bootstrap, incl. the pin) can genuinely recover it — or it is tampering.
  | "secure-channel-failed"
  // Embedder-side bug: the bootstrap `jwt` is missing. A code fix, not a retry —
  // re-auth provably cannot help.
  | "config"
  // This OpenClaw WebChannel account has admitted its fixed maximum number of
  // distinct peer IDs. Re-auth cannot create room; the operator must route new
  // users to another account.
  | "capacity"
  // PoP register error other than 401, 426, 503, or exact capacity 507
  // (typically 5xx; the reply is deliberately a no-oracle, so another odd 4xx
  // lands here). Retry later.
  | "server"
  // Fallback — any terminal error without a classified cause.
  | "unknown";

/**
 * The full client state, recomputed immutably on every change. A new object is
 * produced per change (the arrays too), so a `subscribe` listener can cheaply
 * detect updates by identity — and a React adapter can feed it straight into
 * `useSyncExternalStore` without tearing.
 */
export type WebChannelState = {
  messages: ChatMessage[];
  /** Ephemeral, non-history reasoning previews, bounded by the clients. */
  reasoning: ReasoningItem[];
  approvals: ApprovalRequest[];
  status: ConnectionStatus;
  /** Convenience mirror of `status === "connected"`. */
  connected: boolean;
  /**
   * Set only when `status === "error"` (CL2): a human-readable reason for the
   * terminal failure (e.g. "authorization rejected by NATS server"). Lets the
   * embedder show a real message instead of an eternal reconnect spinner.
   */
  error?: string;
  /**
   * Set alongside `error` when `status === "error"`: the machine-readable cause
   * of the terminal failure, so the embedder can pick truthful wording + the
   * right recovery affordance (not the single "Credentials expired" heading).
   * P0-4: NEVER cleared on this instance — a CL2 terminal permanently retires
   * the client (status stays "error" even if a manual `connect()` redials);
   * recovery is a fresh client with fresh credentials.
   */
  errorCause?: WebChannelErrorCause;
  /**
   * Native "Bot is typing…" affordance. The server pushes a single `typing`
   * frame at the start of a turn, which flips this to `true`. The first
   * `progress` / `agent_message` (or `approval_*`) frame automatically flips
   * it back to `false`; the field is absent before the first typing frame
   * arrives, and stays `false` once it has settled.
   */
  isTyping?: boolean;
  /**
   * True while at least one turn this client started is still open — i.e. the
   * user message has been published and its `turn_settled` has not arrived yet.
   * Unlike `isTyping` (which the server pushes ONCE per turn and which the first
   * `progress`/`agent_message`/`approval_*` frame clears), this is client-owned
   * and TURN-SCOPED: it stays `true` across the whole turn, including the gaps
   * after a first agent bubble has settled while more tool calls, another
   * assistant message, or an approval wait are still to come. Rendering rule:
   * `isTyping` means "an answer is being composed right now"; `turnActive` means
   * "the agent is still working on this turn" — so a widget can keep an
   * in-flight affordance alive between bubbles instead of showing a silence
   * indistinguishable from completion (#96).
   *
   * Absent until this client starts its first turn. Advisory only: it never
   * gates sending, the held-message FIFO, or reconnect. An abort/`/stop` publish
   * (which rides the server's control lane and never settles) never opens one.
   * Another device sharing this peer id is not tracked. The current plugin emits
   * a settle for every coalesced member, including ours, but if our member frame
   * is lost (or an older plugin emits only the other device's anchor), the
   * remaining settle may name an id this client cannot place.
   *
   * Turns are not 1:1 with sends: the agent coalesces messages that arrive during
   * a running turn into ONE turn keyed by the last of them. The current plugin
   * emits one `turn_settled` per member (same outcome, anchor last), and the
   * client promotes only the exact id each frame names. A settle also closes the
   * turn it names AND every turn published before it; that prefix sweep remains
   * for older anchor-only plugins and for lost/missing earlier member frames.
   * Both outcomes, and an outcome-less legacy settle, sweep alike. A send that
   * fails closes its own turn only for the one failure that is a good PROXY for the
   * agent never having received it — `overloaded`, an ingress rejection (a proxy,
   * not a proof: the agent can also reject a message it already admitted). A
   * lost ack is not one: `evicted` is a client-side ledger drop, so that turn may
   * still be named by a settle and is left to the sweep. Beyond that, a
   * disconnect, a terminal error, and `close()` force-close every open turn. An
   * explicit `/stop` also consumes existing queued turn candidates so their
   * later publication cannot re-open stopped work. The post-reconnect staleness
   * valve force-closes open turns too — though only where it arms at all, i.e.
   * when a `working` draft was live when the session re-established.
   * Force-closing is one-way: no inbound frame re-opens a turn
   * (unlike `isTyping`, which a later `typing` frame re-arms), so a mid-turn
   * reconnect leaves this `false` for the remainder of that turn.
   *
   * The guarantee is therefore BOUNDED, not absolute. Any published turn whose
   * settle never arrives — or arrives naming an id this client cannot place —
   * stays `true` until a later settle sweeps it as part of the prefix or a
   * safety point fires. Known examples (not an exhaustive list): text the agent
   * treats as an abort while this client's pinned abort vocabulary, a deliberate
   * subset, does not; a message denied by the agent's DM allowlist, which is
   * acked at ingress but dispatches no turn; a turn another device's message
   * subsumed; and a post-admission `overloaded` rejection, whose turn is already
   * running. Render it as a soft "still working" hint, never as a hard gate.
   */
  turnActive?: boolean;
  /**
   * Slash-command discovery catalog (P0-3). Absent until the UI calls
   * `client.loadCommands()` and the agent answers with a `commands` frame;
   * then it holds the config-filtered, alias-free, name-sorted command list a
   * typeahead menu renders. Replaced wholesale on each `commands` frame.
   */
  commands?: CommandCatalogEntry[];
  /**
   * The AGENT-plugin's wire-protocol version, learned from the register success
   * reply (NATS path). `null` only until a register completes. Under mandatory
   * protocol v2, an absent, malformed, or mismatched value never lands here: it
   * is a TERMINAL error that moves `status` to `"error"`. Exposed for diagnostics.
   */
  agentProtocolVersion: number | null;
  /**
   * The AGENT-plugin's package version string, reported in the register success
   * reply for diagnosability. `null` until a register completes or against a
   * pre-reporting plugin. Advisory only — never gates behavior.
   */
  agentPluginVersion: string | null;
};

/** A state-change subscriber. Receives the latest immutable snapshot. */
export type Listener = (state: WebChannelState) => void;

/**
 * Public aliases used by `WebChannelNATSClient`. All fields are optional so an
 * embedder can adopt configuration incrementally; production deployments
 * normally provide the identity and relay fields together.
 */
export type WebChannelOptions = {
  /**
   * NATS relay WebSocket URL. Defaults to the wrapper's hosted-relay placeholder
   * when omitted; production callers should supply the enrolled relay URL.
   */
  natsUrl?: string;
  /**
   * SaaS-issued bootstrap JWT used by register-hop admission. It carries the
   * peer identity and device confirmation key.
   */
  bootstrapJwt?: string;
  /**
   * Account/deployment identifier used in the per-account NATS subject prefix.
   */
  accountId?: string;
  /**
   * Tenant identifier used in the NATS subject namespace.
   */
  tenant?: string;
  /**
   * Peer identifier, normally the bootstrap JWT `sub`, used for per-peer routing.
   */
  peerId?: string;
};
