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
 * `ts` is hydration metadata: a server-recorded millisecond timestamp. Local
 * sends (a user typing in the widget) keep `ts` absent — the server stamps it on
 * receive. ⚠️ IT IS NOT AN ORDERING KEY: order is the array's, which comes from
 * the shared reducer. (An earlier version of this docblock said "the server uses
 * it to sort the initial snapshot in recency order"; that was stale — nothing in
 * this package or the widget tree sorts on it, and `journal-history.ts`'s NEVER
 * SORT block carries the measurement.)
 */
export type ChatBubble = {
  /**
   * Never present on a bubble — the discriminant of the `ChatMessage` union,
   * declared as `undefined` here so that (a) tsc narrows the union on it and
   * (b) writing a `kind` onto a bubble is a compile error.
   *
   * ⚠️ IT MUST STAY ABSENT AS AN OWN KEY AT RUNTIME, not merely `undefined`.
   * `nats-client-wrapper.ts`'s `sameChatMessage` compares `Object.keys` COUNTS
   * to decide whether an unchanged bubble can be handed back by reference, and
   * the wrapper's suite asserts that reference identity with `.toBe`. A
   * `kind: undefined` key on every bubble would break the count on the first
   * durable event.
   */
  kind?: undefined;
  id: string;
  role: ChatRole;
  text: string;
  ts?: number;
  working?: boolean;
  /**
   * Observed run/attempt-local ordinal for an authorized block delivery. It can
   * repeat within one user turn after model fallback, is not globally unique,
   * and must not be used as a durable history/hydration key.
   */
  assistantMessageIndex?: number;
  /**
   * P0-7b: the stable wire `id` the client stamped on the outbound
   * `user_message` this bubble echoes (user role only). Set at send/release time
   * so an `ack` frame's `accepted` transition can find the bubble. Absent on
   * server-hydrated bubbles, on agent messages, and on a still-`queued` P1-9
   * hold (assigned only at release); not used by the history adoption tiers.
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
  /**
   * Ephemeral live-turn correlation. History messages omit it because the exact
   * client-generated `user_message.id` is not available on the stored messages
   * returned to the history projection. Raw transcript boundaries may still
   * provide structural grouping evidence, but cannot recover this exact id.
   */
  turnId?: string;
  /**
   * v6 (#251): this bubble has received a `progress` draft but NO durable text
   * yet. Client-local and never on the wire — it is the one bit that keeps the
   * rolling draft distinguishable from authored content once the draft has been
   * written into `text` for rendering.
   *
   * §15.9 classifies the rolling "Working…" draft as a 표시기 (indicator), not a
   * message, so a `draftOnly` bubble contributes `text: ""` to the durable view
   * (`nats-client-wrapper.ts`'s `durableProjection`).
   *
   * CLAIMED, NEVER ADDED — the one invariant to keep. Only an absent bubble, or
   * one that already carries the bit, may take it. Adding it to a bubble that
   * already holds authored durable text would let a single stray `progress`
   * frame turn a delivered answer into a DELETED one at turn end (M212g: a
   * visible duplicate is recoverable where a deletion is not).
   *
   * Three writers CLEAR it: an `agent_message` or `turn_snapshot` that authors
   * durable text for the same id, and `expireStaleDrafts`, which promotes the
   * partial to durable rather than deleting it on a mid-turn guess.
   *
   * It outlives the `working` flip on purpose: that is what lets an unfinalized
   * lane's bubble be dropped at turn end instead of freezing its partial text
   * forever, matching how core's built-in Telegram extension deletes an
   * unfinalized preview (`[core] extensions/telegram/src/bot-message-dispatch.ts:2971-2975`).
   */
  draftOnly?: true;
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

/**
 * ONE COMPLETED REASONING BURST, as a member of the transcript (#242 half 2).
 *
 * ⚠️ NO `role`, AND NO CLIENT-LOCAL SEND STATE. Both absences are deliberate and
 * they have different reasons:
 *  - `role` is absent because the wire carries none and `DurableMessage` refuses
 *    to invent one. Overloading `role` — "reasoning is an agent bubble with a
 *    flag" — was the alternative and is the shape v6 exists to remove: it makes
 *    every renderer decide what a special role means at the point it draws.
 *  - `working`/`draftOnly`/`pending`/`sendState`/`wireId`/`receiptKey` are
 *    absent because none of them can apply. A reasoning block is never sent BY
 *    this client, so it has no receipt; and the lane streams cumulative FULL
 *    text through an upsert rather than a rolling draft, so it has no
 *    draft/finalize state either.
 *
 * `turnId` is REQUIRED, following both the live `reasoning` frame and the wire
 * history row.
 */
type ChatReasoningCore = {
  kind: "reasoning";
  id: string;
  turnId: string;
  text: string;
  /** Hydration metadata, exactly as on a bubble. Absent on a live burst. */
  ts?: number;
};

/**
 * Every `ChatBubble` field a reasoning entry cannot have, pinned to `undefined`.
 *
 * ⚠️ DERIVED FROM `ChatBubble`, NEVER LISTED. Add a field to the bubble and it
 * lands here automatically as "provably absent on a reasoning entry"; a hand-
 * written list would silently stop covering it.
 *
 * WHAT THIS BUYS, AND WHAT IT COSTS — both are real, so the trade is stated
 * rather than implied:
 *  + WRITING one of these onto a reasoning entry stays a COMPILE ERROR. That is
 *    the property that matters most here: `{kind:"reasoning", role:"agent"}` —
 *    the fabricated author `DurableMessage` refuses — cannot be constructed.
 *  + READING one off an unnarrowed `ChatMessage` compiles, and yields
 *    `undefined`, which is the TRUE answer: a reasoning entry is never
 *    `working`, never `pending`, has no receipt and no author. The wrapper's
 *    two dozen transcript predicates (`m.working`, `m.role === "user"`,
 *    `isSpentDraft`, …) therefore keep their exact behaviour, and comparing any
 *    of them against a literal still NARROWS to `ChatBubble`.
 *  − A RENDERER that forgets `kind` entirely does not fail to compile; it draws
 *    a reasoning block as an agent bubble (`role === "user"` is false). That is
 *    the one guarantee a fields-absent union gives up against a strict one.
 *    It is bought back where it is actually needed — at the render boundary —
 *    by `demo/web/src/presentation.ts`'s `ConversationPresentationItem`, whose
 *    `message` member carries a `ChatBubble`, so a widget MUST switch on the
 *    presentation kind before it can draw anything.
 */
type BubbleOnlyFieldsAbsent = {
  [K in Exclude<keyof ChatBubble, keyof ChatReasoningCore>]?: undefined;
};

export type ChatReasoningMessage = ChatReasoningCore & BubbleOnlyFieldsAbsent;

/**
 * One entry in `state.messages` — a chat bubble, or a reasoning block.
 *
 * ⚠️ A TAGGED UNION, MIRRORING THE REDUCER'S `DurableMessage` AND THE WIRE'S
 * `HistoryMessage`. #242 half 2 moved reasoning INTO this array, because a
 * reasoning block's POSITION is the transcript's, and the transcript's order is
 * the array's. The alternative — keeping a side list and re-interleaving it by
 * `turnId` at render time — is a SECOND opinion about ordering held by the
 * renderer, which is what the widget used to do and what half 2 deleted.
 *
 * ⚠️ NARROW ON `kind`, NEVER ON A MISSING FIELD. `m.kind === "reasoning"` is the
 * test. Reading `m.role`/`m.working` off an unnarrowed entry does compile (see
 * `BubbleOnlyFieldsAbsent` for exactly what that does and does not guarantee),
 * but "no role, therefore reasoning" is the inference v6 exists to remove — a
 * future variant would break it silently, where a `kind` test would not.
 */
export type ChatMessage = ChatBubble | ChatReasoningMessage;

/**
 * One live/durable reasoning burst, as `state.reasoning` exposes it.
 *
 * ⚠️ `state.reasoning` IS DERIVED FROM `state.messages` SINCE #242 half 2 — it is
 * no longer independently maintained, and it is no longer capped. See
 * `WebChannelState.reasoning`.
 */
export type ReasoningItem = {
  id: string;
  turnId: string;
  text: string;
};

/**
 * #97: one live, turn-scoped tool-call activity item. Structured per-tool
 * surface (name/phase/status/summary/argKeys) delivered on its own
 * `tool_activity` wire frame — independent of the progress-draft text path, so
 * short tool calls that never flush a draft are still visible. Like
 * `ReasoningItem`, it is ephemeral and NOT durable history. `argKeys` carries
 * ONLY the argument KEY NAMES — never arg values.
 */
export type ToolActivityItem = {
  id: string;
  turnId: string;
  name?: string;
  phase?: string;
  status?: string;
  summary?: string;
  argKeys?: string[];
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
  /**
   * The conversation's reasoning bursts, in transcript order.
   *
   * ⚠️ DERIVED, NOT MAINTAINED (#242 half 2). This is `state.messages`'s
   * reasoning entries, recomputed whenever `messages` changes — there is no
   * second store and nothing writes it directly, so it cannot drift from the
   * transcript. The wrapper's `setState` refuses a `reasoning` patch at the type
   * level for that reason.
   *
   * ⚠️ AND IT IS NO LONGER "EPHEMERAL, BOUNDED BY THE CLIENTS", which is what
   * this comment used to say. Both halves changed:
   *  - the `.slice(-100)` cap is GONE. A live cap over an uncapped durable view
   *    is itself a live≠history divergence (the reducer's `applyReasoning`
   *    carries the argument); retention is #299's, at the store;
   *  - the content is DURABLE for an account that opted into
   *    `capabilities.reasoningDurable` (default OFF), and a reload replays it.
   *    With the opt-in off it is still live-only — the lane renders, nothing is
   *    journaled, and a reload shows none of it.
   *
   * ⚠️ KNOWN LIMITATION, EVEN WITH THE OPT-IN ON — **#304**. A burst is journaled
   * by the ONE frame that closes it, and the plugin's send path refuses a frame
   * outright while the transport is down (a NATS reconnect, or its fail-closed
   * no-session-key window) — above the journaling hook, so a refused frame is
   * never offered to it. If the transport is still refusing when the burst
   * closes, that burst gets NO row while this client is still rendering the text
   * it already received. The user-visible shape is "reasoning I watched vanished
   * on reload". It is deferred, not overlooked: the seam cannot journal a
   * refused send, and a second hook inside the reasoning controller is exactly
   * what the v6 NOT-list forbids, so #304 needs a design round rather than a
   * patch. Do not work around it in a renderer.
   *
   * The ITEM shape is unchanged, so an embedder reading `state.reasoning` needs
   * no edit.
   */
  reasoning: ReasoningItem[];
  /**
   * Ephemeral, non-history tool-call activity, bounded by the clients (#97).
   * Optional so existing `WebChannelState` object literals remain source
   * compatible; current wrapper snapshots always initialize this to an array.
   */
  toolActivity?: ToolActivityItem[];
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
