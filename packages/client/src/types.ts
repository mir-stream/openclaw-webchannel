/**
 * Public types for the headless WebChannel client.
 *
 * The wire envelopes (`InboundWsMessage` / `OutboundWsMessage`) mirror the
 * plugin side declared in `src/transport.ts`. They are re-declared here (not
 * imported) so this package stays framework- and Node-free; the plugin's
 * contract test guards against drift (PACKAGING.md §3).
 */

export type ChatRole = "user" | "agent";

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
   * `user_message` this bubble echoes (user role only). Set at send time so an
   * `ack` frame can mark the bubble delivered. Absent on server-hydrated bubbles
   * and on agent messages; not used by the history three-tier adoption.
   */
  wireId?: string;
  /**
   * P0-7b: flips true once the agent acks this message's `wireId` at ingress
   * (state-only — a view can render a ✓). Absent until then.
   */
  delivered?: boolean;
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
 * The full client state, recomputed immutably on every change. A new object is
 * produced per change (the arrays too), so a `subscribe` listener can cheaply
 * detect updates by identity — and a React adapter can feed it straight into
 * `useSyncExternalStore` without tearing.
 */
export type WebChannelState = {
  messages: ChatMessage[];
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
   * Native "Bot is typing…" affordance. The server pushes a single `typing`
   * frame at the start of a turn, which flips this to `true`. The first
   * `progress` / `agent_message` (or `approval_*`) frame automatically flips
   * it back to `false`; the field is absent before the first typing frame
   * arrives, and stays `false` once it has settled.
   */
  isTyping?: boolean;
  /**
   * Slash-command discovery catalog (P0-3). Absent until the UI calls
   * `client.loadCommands()` and the agent answers with a `commands` frame;
   * then it holds the config-filtered, alias-free, name-sorted command list a
   * typeahead menu renders. Replaced wholesale on each `commands` frame.
   */
  commands?: CommandCatalogEntry[];
  /**
   * The AGENT-plugin's wire-protocol version, learned from the register success
   * reply (NATS path). `null` until a register completes, and STAYS null against
   * a pre-v1 plugin whose reply omits the field (non-fatal — see the register
   * policy in nats-client.ts). A value that DISAGREES with the client's
   * `WEBCHANNEL_PROTOCOL_VERSION` never lands here: it is a TERMINAL error that
   * moves `status` to `"error"` instead. Exposed for diagnostics (admin screen).
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
 * Client options — all optional. A zero-arg construction connects to
 * `/webchannel/ws` on the current origin with no ticket (the anonymous dev
 * path).
 */
export type WebChannelOptions = {
  /**
   * Full WebSocket URL (`ws://` or `wss://`), e.g. for a CROSS-ORIGIN gateway.
   * Takes precedence over `path`. Use this when the page and the gateway live on
   * different origins (the same-origin `path` form can't express that).
   */
  url?: string;
  /**
   * WS path on the CURRENT origin (ignored when `url` is set). Defaults to
   * `/webchannel/ws`.
   */
  path?: string;
  /**
   * Supplies a short-lived token for the `jwt` server strategy (delivered on the
   * WS upgrade URL as `?ticket=<jwt>`). Called on EVERY (re)connect so a
   * reconnect always gets a FRESH token (the host session is long-lived, the
   * token is short-lived — AUTH.md §5). Returning null/empty connects with no
   * token (cookie / trusted-header auth).
   */
  getTicket?: () => Promise<string | null>;
  // -----------------------------------------------------------------------
  // NATS mode options (AC 5: NATS cutover)
  // -----------------------------------------------------------------------
  /**
   * NATS WebSocket URL. When provided, client connects directly to NATS
   * instead of gateway-WS. Requires bootstrapJwt, accountId, tenant, and peerId.
   */
  natsUrl?: string;
  /**
   * Bootstrap JWT (RS256-signed) from SaaS. Required for NATS mode.
   * Contains cnf.jwk claim with device public key.
   */
  bootstrapJwt?: string;
  /**
   * Account (deployment) id — the wire identity (from JWT claims). Required for
   * NATS mode.
   */
  accountId?: string;
  /**
   * Tenant ID (from JWT claims). Required for NATS mode.
   */
  tenant?: string;
  /**
   * Peer ID (JWT sub claim). Required for NATS mode.
   */
  peerId?: string;
};

/** Wire envelope sent TO the gateway. Mirrors `src/transport.ts`. */
export type InboundWsMessage =
  // P0-7a: `id` is a stable, client-minted unique id per logical send, used for
  // server-side ingress idempotency (a rapid double-submit or a future replay is
  // deduped). OPTIONAL for back-compat: an older client omits it and the frame
  // is not deduped.
  | { type: "user_message"; text: string; id?: string }
  | { type: "approval_decision"; id: string; decision: ApprovalDecision }
  /**
   * History pagination request. The widget emits this when the user scrolls
   * up past the hydrated bubble list and asks for more. `before` is the
   * oldest message id currently visible in the widget; `limit` is the page
   * size (the server falls back to its configured `pageSize` when omitted).
   * The SDK does NOT auto-fire this on the client's behalf — UI code calls
   * `client.loadHistory(...)` on user action (e.g. scroll-to-top button).
   */
  | { type: "load_history"; before?: string; limit?: number }
  /**
   * Slash-command discovery request (P0-3). The widget emits this the first
   * time the user types `/`; the agent answers with a `commands` frame. No
   * params — the catalog is not paged. Fired by UI code via
   * `client.loadCommands()`, never automatically by the SDK.
   */
  | { type: "load_commands" };

/** Wire envelope received FROM the gateway. Mirrors `src/transport.ts`. */
export type OutboundWsMessage =
  | { type: "agent_message"; text: string; id?: string }
  | { type: "progress"; id: string; text: string }
  | {
      type: "approval_request";
      id: string;
      kind: "exec" | "plugin";
      title: string;
      description?: string;
      prompt: string;
      options: ApprovalOption[];
      expiresAtMs?: number;
    }
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision }
  /**
   * Authoritative pending-approval snapshot (#15). Emitted on every successful
   * register (NATS path) carrying the peer's COMPLETE still-pending set for the
   * account. The client reconciles its approval state against it: rehydrate lost
   * cards, retire cards resolved elsewhere, and re-send a lost decision. An
   * empty `approvals` array is meaningful (nothing pending → retire stale cards).
   *
   * `resolved` (#19, OPTIONAL) carries recently-RESOLVED outcomes so the client's
   * Leg B can render the actual decision instead of a neutral "resolved
   * (elsewhere)". Optional for back-compat with an older plugin that never sends
   * it (the client falls back to "unknown").
   */
  | { type: "approval_snapshot"; approvals: Array<{
      id: string;
      kind: "exec" | "plugin";
      title: string;
      description?: string;
      prompt: string;
      options: ApprovalOption[];
      expiresAtMs?: number;
    }>; resolved?: Array<{ id: string; decision: ApprovalDecision }> }
  /** Native typing affordance; see `WebChannelState.isTyping`. */
  | { type: "typing" }
  /**
   * History snapshot / pagination response. Emitted exactly ONCE per
   * connection after the first heartbeat (initial snapshot) AND in response
   * to `load_history` requests (older pages). The widget prepends `messages`
   * to its transcript, deduplicating by id.
   */
  | { type: "history"; messages: ChatMessage[] }
  /**
   * Slash-command discovery catalog (P0-3), sent in reply to `load_commands`.
   * Config-filtered, alias-free, name-sorted. The client replaces
   * `WebChannelState.commands` wholesale with it.
   */
  | { type: "commands"; commands: CommandCatalogEntry[] };
