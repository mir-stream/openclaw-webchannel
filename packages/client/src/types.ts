/**
 * Public types for the headless ClawChannel client.
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
 */
export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  working?: boolean;
};

/** Native HITL approval decision; mirrors the plugin/SDK union. */
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

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
 */
export type ApprovalRequest = {
  id: string;
  kind: "exec" | "plugin";
  title: string;
  description?: string;
  prompt: string;
  options: ApprovalOption[];
  expiresAtMs?: number;
  resolvedDecision?: ApprovalDecision;
};

/** Connection status, richer than a bool (drives the UI status dot). */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting";

/**
 * The full client state, recomputed immutably on every change. A new object is
 * produced per change (the arrays too), so a `subscribe` listener can cheaply
 * detect updates by identity — and a React adapter can feed it straight into
 * `useSyncExternalStore` without tearing.
 */
export type ClawChannelState = {
  messages: ChatMessage[];
  approvals: ApprovalRequest[];
  status: ConnectionStatus;
  /** Convenience mirror of `status === "connected"`. */
  connected: boolean;
};

/** A state-change subscriber. Receives the latest immutable snapshot. */
export type Listener = (state: ClawChannelState) => void;

/**
 * Client options — all optional. A zero-arg construction connects to
 * `/clawchannel/ws` on the current origin with no ticket (the anonymous dev
 * path).
 */
export type ClawChannelOptions = {
  /**
   * Full WebSocket URL (`ws://` or `wss://`), e.g. for a CROSS-ORIGIN gateway.
   * Takes precedence over `path`. Use this when the page and the gateway live on
   * different origins (the same-origin `path` form can't express that).
   */
  url?: string;
  /**
   * WS path on the CURRENT origin (ignored when `url` is set). Defaults to
   * `/clawchannel/ws`.
   */
  path?: string;
  /**
   * Supplies a short-lived signed ticket for the `hmac-ticket` server strategy.
   * Called on EVERY (re)connect so a reconnect always gets a FRESH ticket (the
   * host session is long-lived, the ticket is short-lived — AUTH.md §5/§6).
   * Returning null/empty connects with no ticket (anonymous / cookie /
   * trusted-header auth).
   */
  getTicket?: () => Promise<string | null>;
};

/** Wire envelope sent TO the gateway. Mirrors `src/transport.ts`. */
export type InboundWsMessage =
  | { type: "user_message"; text: string }
  | { type: "approval_decision"; id: string; decision: ApprovalDecision };

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
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision };
