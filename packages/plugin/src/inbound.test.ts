import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #87: core marks a NON-terminal tool-error warning through WeakMap-backed
// payload metadata, which a test cannot attach (the setter is not part of the
// plugin SDK surface). Mock the reader so both branches are exercised: any
// payload whose text carries this sentinel reads as a non-terminal warning.
const WARNING_SENTINEL = "__NON_TERMINAL_TOOL_WARNING__";
vi.mock("openclaw/plugin-sdk/reply-payload", () => ({
  isReplyPayloadNonTerminalToolErrorWarning: (payload: { text?: string }) =>
    typeof payload?.text === "string" && payload.text.includes(WARNING_SENTINEL),
}));

import { AsyncLocalStorage } from "node:async_hooks";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

import {
  deliverDraftFinalPayload,
  handleInboundMessage as handleInboundMessageForServingTenant,
  isResyncKeyframeRequired,
  KEYFRAME_HISTORY_READ_TIMEOUT_MS,
  startAgentLifecycleSubscription,
  stopAgentLifecycleSubscription,
  type FinalReconciliationState,
} from "./inbound.js";
import type { WebChannelPeerChannel } from "./channel-contract.js";
import type { ProgressDraftController } from "./message-adapter.js";
import {
  APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY,
  ApprovalOriginLeaseRegistry,
} from "./approval-origin.js";
import { resolveWebchannelSessionRoute } from "./session-route.js";
import { recent as historyRecent } from "./history.js";
import {
  MAX_COALESCED_MEMBER_ID_LENGTH,
  normalizeInboundUserMessage,
} from "./inbound-queue.js";
import { DEFAULT_BUSY_TURN_LIMITS } from "./inbound-retention.js";

const TEST_SERVING_TENANT = "fixture-tenant";

/** Bind direct inbound unit tests to the same kind of startup-frozen tenant. */
function handleInboundMessage(
  api: Parameters<typeof handleInboundMessageForServingTenant>[0],
  transport: Parameters<typeof handleInboundMessageForServingTenant>[1],
  peerId: string,
  message: Parameters<typeof handleInboundMessageForServingTenant>[3],
  accountId = "default",
  options?: Parameters<typeof handleInboundMessageForServingTenant>[6],
) {
  return handleInboundMessageForServingTenant(
    api,
    transport,
    peerId,
    message,
    accountId,
    TEST_SERVING_TENANT,
    options,
  );
}

/**
 * P1-8a — `handleInboundMessage` control-lane behaviour.
 *
 * Two invariants:
 *  - The abort authorization stamp (`access.commands.authorized`) is passed into
 *    core's `buildContext` ONLY for control-lane turns — never for ordinary
 *    turns (we must not broadly authorize text commands for every peer).
 *  - Terminal draft drain: when core aborts the RUNNING turn its `inbound.run`
 *    resolves WITHOUT delivering a final. The controller settles real lane
 *    text in generation order, or a lone visible tool scaffold for the
 *    no-delete case, without manufacturing a stop-marker bubble. A turn that
 *    DID deliver its final still finalizes exactly once with that payload.
 *
 * The fake `api.runtime.channel` captures the `buildContext` params and lets each
 * test drive the assembled turn (invoke replyOptions callbacks / delivery) via a
 * per-test `runImpl`.
 */

type BuildContextParams = {
  access?: { commands?: { authorized?: boolean } };
  [k: string]: unknown;
};

type AssembledTurnLike = {
  replyOptions?: {
    onAgentRunStart?: (runId: string) => void;
    onToolStart?: (p: unknown) => void;
    onItemEvent?: (p: unknown) => void;
    onCommandOutput?: (p: unknown) => void;
    onPatchSummary?: (p: unknown) => void;
    onPartialReply?: (p: { text?: string }) => void;
    onAssistantMessageStart?: () => void;
  };
  delivery: {
    deliver: (
      payload: {
        text?: string;
        isError?: boolean;
        isStatusNotice?: boolean;
        isFallbackNotice?: boolean;
        isCompactionNotice?: boolean;
      },
      info?: { kind?: string; assistantMessageIndex?: number },
    ) => Promise<{ visibleReplySent: boolean }>;
  };
};

type LifecycleEvent = { stream?: string; runId?: string; data?: unknown };
type LifecycleListener = (evt: LifecycleEvent) => void;

function makeFakeApi(params: {
  streamingMode: "off" | "partial" | "progress";
  runImpl: (turn: AssembledTurnLike) => Promise<void>;
  /** Expose the host's agent-events surface (#87 lifecycle verdict). */
  withAgentEvents?: boolean;
  /** Extra `channels.webchannel` keys, e.g. the DM allowlist (#99 denial case). */
  channelConfig?: Record<string, unknown>;
  /**
   * #173: the raw transcript rows `runtime.subagent.getSessionMessages` returns,
   * so a settlement keyframe has something to read. Omitted → no subagent seam,
   * and `history.recent` yields [] (no keyframe sent).
   */
  sessionMessages?: unknown[];
  /**
   * #173: invoked at the start of every `getSessionMessages` read. Throwing
   * models the gateway rejecting `sessions.get` for the caller's ambient
   * operator client — the failure mode `runDetachedHistoryRead` exists to avoid.
   */
  onSessionMessagesRead?: () => void;
  /**
   * #173: make `getSessionMessages` NEVER settle. The gateway session read
   * carries no deadline of its own, which is why the awaited keyframe read
   * needs one — without a bound this wedges the peer's inbound FIFO forever.
   */
  sessionMessagesNeverSettle?: boolean;
}): {
  api: OpenClawPluginApi;
  captured: { buildContext?: BuildContextParams };
  /** Every `logger.warn` record this api emitted, in order. */
  warnings: string[];
  /** Push a lifecycle event to whatever the plugin subscribed. */
  emitLifecycle: (evt: LifecycleEvent) => void;
} {
  const captured: { buildContext?: BuildContextParams } = {};
  const warnings: string[] = [];

  const config = {
    channels: {
      webchannel: { streaming: { mode: params.streamingMode }, ...params.channelConfig },
    },
  };

  const channel = {
    routing: {
      resolveAgentRoute: () => ({
        agentId: "agent1",
        channel: "webchannel",
        accountId: "default",
        mainSessionKey: "agent:agent1:main",
        sessionKey: "agent:agent1:seed",
        lastRoutePolicy: "session",
      }),
    },
    inbound: {
      buildContext: (p: BuildContextParams) => {
        captured.buildContext = p;
        return { ctx: p };
      },
      run: async (runParams: {
        raw: { text: string };
        adapter: {
          ingest: (raw: unknown) => unknown;
          resolveTurn: (input: unknown) => AssembledTurnLike;
        };
      }) => {
        const input = runParams.adapter.ingest(runParams.raw);
        const turn = runParams.adapter.resolveTurn(input);
        await params.runImpl(turn);
      },
    },
    session: {
      recordInboundSession: () => undefined,
      resolveStorePath: () => "store-path",
    },
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: () => undefined,
    },
  };

  const listeners: LifecycleListener[] = [];
  const events = params.withAgentEvents
    ? {
        onAgentEvent: (l: LifecycleListener) => {
          listeners.push(l);
          return () => {};
        },
      }
    : undefined;

  const subagent =
    params.sessionMessages || params.sessionMessagesNeverSettle
      ? {
          getSessionMessages: async () => {
            params.onSessionMessagesRead?.();
            if (params.sessionMessagesNeverSettle) return new Promise<never>(() => {});
            return { messages: params.sessionMessages };
          },
        }
      : undefined;

  const api = {
    config,
    logger: {
      info: () => {},
      warn: (message: string) => {
        warnings.push(message);
      },
      error: () => {},
    },
    runtime: { channel, ...(events ? { events } : {}), ...(subagent ? { subagent } : {}) },
  } as unknown as OpenClawPluginApi;

  const emitLifecycle = (evt: LifecycleEvent): void => {
    for (const l of [...listeners]) l(evt);
  };

  return { api, captured, warnings, emitLifecycle };
}

/** A transport that records finalize frames and accepts progress/typing/text. */
function makeFakeTransport(options?: {
  /** #99: return false from `sendTurnSettled` for these turnIds (delivery failure). */
  failSettleFor?: readonly string[];
  /** #99: THROW from `sendTurnSettled` for these turnIds (hostile implementation). */
  throwSettleFor?: readonly string[];
}): {
  transport: WebChannelPeerChannel;
  finalizes: Array<{ id: string; text: string; assistantMessageIndex?: number }>;
  texts: Array<{ text: string; assistantMessageIndex?: number }>;
  progress: Array<{ id: string; text: string }>;
  /** #97: the structured tool-activity frames, in emission order. */
  toolActivities: Array<{
    sessionKey: string;
    id: string;
    turnId: string;
    name?: string;
    phase?: string;
    status?: string;
    summary?: string;
    argKeys?: string[];
  }>;
  typing: string[];
  settles: Array<"ok" | "error">;
  /** #99: the full settle frames, in emission order — turnId matters per member. */
  settleFrames: Array<{ turnId: string; outcome: "ok" | "error" }>;
  /** #173: authoritative-replace keyframe frames, in emission order. */
  keyframes: Array<{
    peerId: string;
    messages: Array<{ id: string; role: string; text: string; ts?: number }>;
  }>;
} {
  const finalizes: Array<{
    id: string;
    text: string;
    assistantMessageIndex?: number;
  }> = [];
  const texts: Array<{ text: string; assistantMessageIndex?: number }> = [];
  const progress: Array<{ id: string; text: string }> = [];
  const typing: string[] = [];
  const settles: Array<"ok" | "error"> = [];
  const settleFrames: Array<{ turnId: string; outcome: "ok" | "error" }> = [];
  const keyframes: Array<{
    peerId: string;
    messages: Array<{ id: string; role: string; text: string; ts?: number }>;
  }> = [];
  const toolActivities: Array<{
    sessionKey: string;
    id: string;
    turnId: string;
    name?: string;
    phase?: string;
    status?: string;
    summary?: string;
    argKeys?: string[];
  }> = [];
  const transport = {
    sendTyping: (sessionKey: string) => {
      typing.push(sessionKey);
      return true;
    },
    sendText: (
      _sessionKey: string,
      text: string,
      _id?: string,
      _turnId?: string,
      assistantMessageIndex?: number,
    ) => {
      texts.push({
        text,
        ...(assistantMessageIndex !== undefined ? { assistantMessageIndex } : {}),
      });
      return true;
    },
    sendReasoning: () => true,
    sendToolActivity: (
      sessionKey: string,
      activity: {
        id: string;
        turnId: string;
        name?: string;
        phase?: string;
        status?: string;
        summary?: string;
        argKeys?: string[];
      },
    ) => {
      toolActivities.push({ sessionKey, ...activity });
      return true;
    },
    sendTurnSettled: (_sessionKey: string, turnId: string, outcome: "ok" | "error") => {
      settles.push(outcome);
      settleFrames.push({ turnId, outcome });
      if (options?.throwSettleFor?.includes(turnId)) {
        throw new Error(`settle blew up for ${turnId}`);
      }
      return !options?.failSettleFor?.includes(turnId);
    },
    sendProgress: (_sessionKey: string, id: string, text: string) => {
      progress.push({ id, text });
      return true;
    },
    finalizeDraft: (
      _sessionKey: string,
      id: string,
      text: string,
      _turnId?: string,
      assistantMessageIndex?: number,
    ) => {
      finalizes.push({
        id,
        text,
        ...(assistantMessageIndex !== undefined ? { assistantMessageIndex } : {}),
      });
      return true;
    },
    sendHistory: () => true,
    sendKeyframe: (
      peerId: string,
      messages: Array<{ id: string; role: string; text: string; ts?: number }>,
    ) => {
      keyframes.push({ peerId, messages });
      return true;
    },
    sendApprovalRequest: () => true,
    sendApprovalResolved: () => true,
    sendApprovalSnapshot: () => true,
  } as WebChannelPeerChannel;
  return { transport, finalizes, texts, progress, toolActivities, typing, settles, settleFrames, keyframes };
}

const userMessage = { type: "user_message" as const, text: "/stop" };

describe("handleInboundMessage — control-lane authorization stamp", () => {
  it("stamps access.commands.authorized=true ONLY for controlLane turns", async () => {
    const { api, captured } = makeFakeApi({
      streamingMode: "off",
      runImpl: async () => {},
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", userMessage, "default", {
      controlLane: true,
    });

    expect(captured.buildContext?.access?.commands?.authorized).toBe(true);
  });

  it("does NOT stamp authorization for ordinary (non-control-lane) turns", async () => {
    const { api, captured } = makeFakeApi({
      streamingMode: "off",
      runImpl: async () => {},
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message",
      text: "hello there",
    });

    // No `access` key at all — the ordinary path must not touch command authz.
    expect(captured.buildContext?.access).toBeUndefined();
  });
});

describe("handleInboundMessage — typing indicator gating", () => {
  it("sends a typing frame for an ordinary turn", async () => {
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const { transport, typing } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message",
      text: "hello there",
    });

    // The ordinary path flashes "agent is typing…" keyed by the peer's wsKey.
    expect(typing).toEqual(["peer-1"]);
  });

  it("does NOT send a typing frame for a control-lane abort turn", async () => {
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const { transport, typing } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", userMessage, "default", {
      controlLane: true,
    });

    // An abort must never flash typing: it winds the turn DOWN, and on the
    // unauthorized-sender path (core returns handled:false) no settling frame
    // ever follows, which would otherwise leave the widget's Stop button armed
    // with nothing to release it.
    expect(typing).toEqual([]);
  });
});

describe("handleInboundMessage — terminal draft drain", () => {
  it("reports visibleReplySent=false when draft finalization returns false", async () => {
    let visible: boolean | undefined;
    const { api } = makeFakeApi({
      streamingMode: "partial",
      runImpl: async (turn) => {
        visible = (await turn.delivery.deliver({ text: "answer" }, { kind: "final" })).visibleReplySent;
      },
    });
    const { transport } = makeFakeTransport();
    transport.finalizeDraft = () => false;
    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message", text: "answer me", id: "turn-dv",
    });
    expect(visible).toBe(false);
  });
  it("settles a hung draft with the streamed snapshot (no marker) when the run resolves without delivering a final", async () => {
    const { api } = makeFakeApi({
      streamingMode: "partial",
      // Simulate an aborted turn: stream some answer text (starts the draft),
      // then resolve WITHOUT ever calling delivery.deliver(kind:"final").
      runImpl: async (turn) => {
        turn.replyOptions?.onPartialReply?.({ text: "Here is my answ" });
      },
    });
    const { transport, finalizes } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message",
      text: "do a long thing",
    });

    // The bubble settles with EXACTLY the streamed content — no "Stopped"
    // marker (an abort gets its own "⚙️ Agent was aborted." from core; a silent
    // completion must not be mislabeled).
    expect(finalizes).toHaveLength(1);
    expect(finalizes[0]!.text).toBe("Here is my answ");
    expect(finalizes[0]!.text).not.toContain("Stopped");
  });

  it("settles a hung TOOL-ONLY draft with the scaffold text (no marker) on a silent completion", async () => {
    const { api } = makeFakeApi({
      streamingMode: "progress",
      // A silent/tool-only turn: tool + item events start the draft, then the run
      // resolves without any deliver and without any answer text streamed.
      runImpl: async (turn) => {
        turn.replyOptions?.onToolStart?.({
          itemId: "i1",
          toolCallId: "t1",
          name: "bash",
          phase: "start",
          args: {},
        });
        turn.replyOptions?.onItemEvent?.({
          itemId: "i1",
          kind: "tool",
          name: "bash",
          phase: "start",
          status: "running",
        });
      },
    });
    const { transport, finalizes } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message",
      text: "run a tool",
    });

    expect(finalizes).toHaveLength(1);
    // Settled with the rendered scaffold (contains the tool line), never marked.
    expect(finalizes[0]!.text).toContain("Bash");
    expect(finalizes[0]!.text).not.toContain("Stopped");
  });

  it("finalizes exactly once with the delivered text when the run DOES deliver a final (no marker)", async () => {
    const { api } = makeFakeApi({
      streamingMode: "partial",
      runImpl: async (turn) => {
        turn.replyOptions?.onPartialReply?.({ text: "Final answer" });
        await turn.delivery.deliver({ text: "Final answer complete" }, { kind: "final" });
      },
    });
    const { transport, finalizes } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message",
      text: "answer me",
    });

    // The delivered final wins; terminal drain is an idempotent no-op here.
    expect(finalizes).toHaveLength(1);
    expect(finalizes[0]!.text).toBe("Final answer complete");
    expect(finalizes[0]!.text).not.toContain("Stopped");
  });
});

describe("handleInboundMessage — #97 structured tool activity", () => {
  type EmitAgentEvent = (event: LifecycleEvent) => void;

  function makeActivityApi(
    runImpl: (turn: AssembledTurnLike, emit: EmitAgentEvent) => Promise<void>,
    streamingMode: "off" | "partial" | "progress" = "progress",
  ) {
    const holder: { emit?: EmitAgentEvent } = {};
    const made = makeFakeApi({
      streamingMode,
      withAgentEvents: true,
      runImpl: async (turn) => runImpl(turn, (event) => holder.emit?.(event)),
    });
    holder.emit = made.emitLifecycle;
    startAgentLifecycleSubscription(made.api);
    return made;
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  afterEach(() => stopAgentLifecycleSubscription());

  it("uses run-scoped global tool events as the sole structured source while preserving reply draft callbacks", async () => {
    const made = makeActivityApi(async (turn, emit) => {
      // Pinned ordering: the global lifecycle start precedes the local callback
      // that publishes the run id; only later tool events can reach this turn.
      emit({ stream: "lifecycle", runId: "run-cli", data: { phase: "start" } });
      emit({
        stream: "tool",
        runId: "run-cli",
        data: { phase: "start", name: "too-early", toolCallId: "early" },
      });
      turn.replyOptions?.onAgentRunStart?.("run-cli");

      // These callbacks still drive draft.pushEvent, but no longer duplicate
      // structured activity.
      turn.replyOptions?.onToolStart?.({
        toolCallId: "cli-1",
        name: "bash",
        phase: "start",
        args: { command: "printf callback-secret" },
      });
      turn.replyOptions?.onItemEvent?.({
        itemId: "tool:cli-1",
        toolCallId: "cli-1",
        kind: "tool",
        name: "bash",
        phase: "start",
        status: "running",
      });

      emit({
        stream: "tool",
        runId: "run-cli",
        data: {
          phase: "start",
          name: "bash",
          toolCallId: "cli-1",
          args: { command: "printf global-secret", cwd: "/secret/path" },
        },
      });
      emit({
        stream: "tool",
        runId: "run-cli",
        data: {
          phase: "result",
          name: "bash",
          toolCallId: "cli-1",
          isError: false,
          result: { output: "global-secret output" },
        },
      });
    });
    const { transport, toolActivities, settleFrames } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", {
      type: "user_message",
      text: "run it",
      id: "turn-cli",
    });

    expect(toolActivities).toEqual([
      {
        sessionKey: "peer-1",
        turnId: "turn-cli",
        id: "cli-1",
        name: "bash",
        phase: "start",
        argKeys: ["command", "cwd"],
      },
      {
        sessionKey: "peer-1",
        turnId: "turn-cli",
        id: "cli-1",
        name: "bash",
        phase: "result",
        status: "completed",
      },
    ]);
    expect(settleFrames).toContainEqual({ turnId: "turn-cli", outcome: "ok" });
    const wire = JSON.stringify(toolActivities);
    expect(wire).not.toContain("callback-secret");
    expect(wire).not.toContain("global-secret");
    expect(wire).not.toContain("/secret/path");
  });

  it("drops suppressed Codex items while retaining their normalized native and dynamic tool events", async () => {
    const nativeCalls = [
      {
        id: "native-file",
        kind: "patch",
        name: "apply_patch",
        args: { changes: [{ path: "secret-file.ts", kind: "update" }] },
        status: "completed",
        isError: false,
      },
      {
        id: "native-search",
        kind: "search",
        name: "web_search",
        args: { query: "secret query" },
        status: "completed",
        isError: false,
      },
      {
        id: "native-mcp",
        kind: "tool",
        name: "server.lookup",
        args: { token: "secret token" },
        status: "blocked",
        isError: true,
      },
    ] as const;
    const made = makeActivityApi(async (turn, emit) => {
      turn.replyOptions?.onAgentRunStart?.("run-codex");
      for (const call of nativeCalls) {
        emit({
          stream: "item",
          runId: "run-codex",
          data: {
            itemId: call.id,
            phase: "start",
            kind: call.kind,
            status: "running",
            name: call.name,
            suppressChannelProgress: true,
          },
        });
        emit({
          stream: "tool",
          runId: "run-codex",
          data: {
            phase: "start",
            name: call.name,
            itemId: call.id,
            toolCallId: call.id,
            args: call.args,
          },
        });
        emit({
          stream: "item",
          runId: "run-codex",
          data: {
            itemId: call.id,
            phase: "end",
            kind: call.kind,
            status: call.status,
            name: call.name,
            suppressChannelProgress: true,
          },
        });
        emit({
          stream: "tool",
          runId: "run-codex",
          data: {
            phase: "result",
            name: call.name,
            itemId: call.id,
            toolCallId: call.id,
            status: call.status,
            isError: call.isError,
            result: { body: "secret result" },
          },
        });
      }
      // The pinned app-server projector emits the suppressed standard item;
      // the dynamic bridge/runner emits a normalized companion with only its
      // tool-call identity.
      emit({
        stream: "item",
        runId: "run-codex",
        data: {
          itemId: "dynamic-1",
          phase: "start",
          kind: "tool",
          status: "running",
          name: "dynamic_action",
          suppressChannelProgress: true,
        },
      });
      emit({
        stream: "tool",
        runId: "run-codex",
        data: {
          phase: "start",
          name: "dynamic_action",
          toolCallId: "dynamic-1",
          args: { token: "dynamic secret" },
        },
      });
      emit({
        stream: "item",
        runId: "run-codex",
        data: {
          itemId: "dynamic-1",
          phase: "end",
          kind: "tool",
          status: "completed",
          name: "dynamic_action",
          suppressChannelProgress: true,
        },
      });
      emit({
        stream: "tool",
        runId: "run-codex",
        data: {
          phase: "result",
          name: "dynamic_action",
          toolCallId: "dynamic-1",
          status: "completed",
          isError: false,
          result: { body: "dynamic result secret" },
        },
      });
    });
    const { transport, toolActivities } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", {
      type: "user_message",
      text: "native tools",
      id: "turn-codex",
    });

    for (const call of nativeCalls) {
      const frames = toolActivities.filter((frame) => frame.name === call.name);
      expect(frames).toHaveLength(2);
      expect(new Set(frames.map((frame) => frame.id)).size).toBe(1);
      expect(frames.at(-1)?.status).toBe(call.status);
      expect(frames.find((frame) => frame.argKeys)?.argKeys).toEqual(
        Object.keys(call.args),
      );
    }
    const dynamic = toolActivities.filter((frame) => frame.name === "dynamic_action");
    expect(dynamic).toHaveLength(2);
    expect(dynamic[0]!.id).toBe(dynamic[1]!.id);
    expect(dynamic[1]!.status).toBe("completed");
    expect(new Set(toolActivities.map((frame) => frame.id)).size).toBe(4);
    const wire = JSON.stringify(toolActivities);
    expect(wire).not.toContain("secret-file.ts");
    expect(wire).not.toContain("secret query");
    expect(wire).not.toContain("secret token");
    expect(wire).not.toContain("secret result");
    expect(wire).not.toContain("dynamic secret");
    expect(wire).not.toContain("dynamic result secret");
  });

  it("drops exact suppressed messaging items that have no companion tool stream", async () => {
    const messagingNames = [
      "message",
      "messages",
      "reply",
      "send",
      "reaction",
      "react",
      "typing",
    ];
    const made = makeActivityApi(async (turn, emit) => {
      turn.replyOptions?.onAgentRunStart?.("run-messaging");

      // A normal dynamic tool proves the run sink is live: the projector emits
      // its suppressed standard item and the dynamic bridge/runner emits this
      // toolCallId-only companion pair.
      emit({
        stream: "item",
        runId: "run-messaging",
        data: {
          itemId: "visible-dynamic",
          phase: "start",
          kind: "tool",
          status: "running",
          name: "normal_action",
          suppressChannelProgress: true,
        },
      });
      emit({
        stream: "tool",
        runId: "run-messaging",
        data: {
          toolCallId: "visible-dynamic",
          phase: "start",
          name: "normal_action",
          args: { value: "secret" },
        },
      });
      emit({
        stream: "item",
        runId: "run-messaging",
        data: {
          itemId: "visible-dynamic",
          phase: "end",
          kind: "tool",
          status: "completed",
          name: "normal_action",
          suppressChannelProgress: true,
        },
      });
      emit({
        stream: "tool",
        runId: "run-messaging",
        data: {
          toolCallId: "visible-dynamic",
          phase: "result",
          name: "normal_action",
          status: "completed",
        },
      });

      // These exact names intentionally receive no normalized tool companion.
      for (const name of messagingNames) {
        for (const phase of ["start", "end"] as const) {
          emit({
            stream: "item",
            runId: "run-messaging",
            data: {
              itemId: `messaging-${name}`,
              phase,
              kind: "tool",
              status: phase === "start" ? "running" : "completed",
              name,
              suppressChannelProgress: true,
            },
          });
        }
      }
    });
    const { transport, toolActivities } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", {
      type: "user_message",
      text: "send privately",
      id: "turn-messaging",
    });

    expect(toolActivities).toHaveLength(2);
    expect(toolActivities.map((frame) => frame.name)).toEqual([
      "normal_action",
      "normal_action",
    ]);
    expect(toolActivities[0]).toMatchObject({
      id: "visible-dynamic",
      phase: "start",
      argKeys: ["value"],
    });
    expect(toolActivities[1]).toMatchObject({
      id: "visible-dynamic",
      phase: "result",
      status: "completed",
    });
    expect(JSON.stringify(toolActivities)).not.toContain("secret");
  });

  it.each([
    { toolName: "exec", derivedKind: "command", specialized: "command_output" },
    { toolName: "bash", derivedKind: "command", specialized: "command_output" },
    { toolName: "apply_patch", derivedKind: "patch", specialized: "patch" },
  ] as const)(
    "keeps hidden $toolName companions private and permits later visible id reuse",
    async ({ toolName, derivedKind, specialized }) => {
      const recorded = makeFakeTransport();
      const runId = `run-hidden-${toolName}`;
      const toolCallId = "reused-call";
      const toolItemId = `tool:${toolCallId}`;
      const derivedItemId = `${derivedKind}:${toolCallId}`;
      let hiddenFrameCountAtReuse = -1;
      const made = makeActivityApi(async (turn, emit) => {
        turn.replyOptions?.onAgentRunStart?.(runId);

        // Pinned embedded order: primary tool/tool-item events retain the hide
        // flag, while derived command/patch companions do not.
        emit({
          stream: "tool",
          runId,
          data: {
            toolCallId,
            name: toolName,
            phase: "start",
            args: { payload: "hidden-start-secret" },
            hideFromChannelProgress: true,
          },
        });
        emit({
          stream: "item",
          runId,
          data: {
            itemId: toolItemId,
            toolCallId,
            kind: "tool",
            name: toolName,
            phase: "start",
            status: "running",
            hideFromChannelProgress: true,
          },
        });
        emit({
          stream: "item",
          runId,
          data: {
            itemId: derivedItemId,
            toolCallId,
            kind: derivedKind,
            name: toolName,
            phase: "start",
            status: "running",
          },
        });
        emit({
          stream: "tool",
          runId,
          data: {
            toolCallId,
            name: toolName,
            phase: "update",
            partialResult: "hidden-update-secret",
            hideFromChannelProgress: true,
          },
        });
        emit({
          stream: "item",
          runId,
          data: {
            itemId: toolItemId,
            toolCallId,
            kind: "tool",
            name: toolName,
            phase: "update",
            status: "running",
            hideFromChannelProgress: true,
          },
        });
        if (specialized === "command_output") {
          emit({
            stream: "item",
            runId,
            data: {
              itemId: derivedItemId,
              toolCallId,
              kind: "command",
              name: toolName,
              phase: "update",
              status: "running",
              progressText: "hidden-command-secret",
            },
          });
          emit({
            stream: "command_output",
            runId,
            data: {
              itemId: derivedItemId,
              toolCallId,
              name: toolName,
              phase: "delta",
              status: "running",
              output: "hidden-command-secret",
            },
          });
        }
        emit({
          stream: "tool",
          runId,
          data: {
            toolCallId,
            name: toolName,
            phase: "result",
            isError: false,
            result: { output: "hidden-result-secret" },
            hideFromChannelProgress: true,
          },
        });
        emit({
          stream: "item",
          runId,
          data: {
            itemId: toolItemId,
            toolCallId,
            kind: "tool",
            name: toolName,
            phase: "end",
            status: "completed",
            hideFromChannelProgress: true,
          },
        });
        emit({
          stream: "item",
          runId,
          data: {
            itemId: derivedItemId,
            toolCallId,
            kind: derivedKind,
            name: toolName,
            phase: "end",
            status: "completed",
            summary: "hidden-derived-secret",
          },
        });
        if (specialized === "command_output") {
          emit({
            stream: "command_output",
            runId,
            data: {
              itemId: derivedItemId,
              toolCallId,
              name: toolName,
              phase: "end",
              status: "completed",
              output: "hidden-command-secret",
            },
          });
        } else {
          emit({
            stream: "patch",
            runId,
            data: {
              itemId: derivedItemId,
              toolCallId,
              name: toolName,
              phase: "end",
              modified: ["hidden/path.ts"],
              summary: "hidden-patch-secret",
            },
          });
        }

        hiddenFrameCountAtReuse = recorded.toolActivities.length;

        // A canonical visible start definitively begins a new invocation even
        // when the upstream id is reused. The alias-only derived update proves
        // retirement removed `command:<id>` / `patch:<id>` as well as `<id>`.
        emit({
          stream: "tool",
          runId,
          data: {
            toolCallId,
            name: toolName,
            phase: "start",
            args: { payload: "visible-value-secret" },
          },
        });
        emit({
          stream: "item",
          runId,
          data: {
            itemId: derivedItemId,
            kind: derivedKind,
            name: toolName,
            phase: "update",
            status: "running",
          },
        });
        emit({
          stream: "tool",
          runId,
          data: {
            toolCallId,
            name: toolName,
            phase: "result",
            isError: false,
            result: { output: "visible-result-secret" },
          },
        });
      });

      await handleInboundMessage(made.api, recorded.transport, "peer-1", {
        type: "user_message",
        text: `hide then reuse ${toolName}`,
        id: `turn-hidden-${toolName}`,
      });

      expect(hiddenFrameCountAtReuse).toBe(0);
      expect(recorded.toolActivities).toHaveLength(3);
      expect(recorded.toolActivities.map((frame) => frame.phase)).toEqual([
        "start",
        "update",
        "result",
      ]);
      expect(new Set(recorded.toolActivities.map((frame) => frame.id))).toEqual(
        new Set([toolCallId]),
      );
      expect(recorded.toolActivities[0]).toMatchObject({
        name: toolName,
        argKeys: ["payload"],
      });
      expect(recorded.toolActivities[2]).toMatchObject({
        name: toolName,
        status: "completed",
      });
      const wire = JSON.stringify(recorded.toolActivities);
      expect(wire).not.toContain("hidden-start-secret");
      expect(wire).not.toContain("hidden-update-secret");
      expect(wire).not.toContain("hidden-command-secret");
      expect(wire).not.toContain("hidden-result-secret");
      expect(wire).not.toContain("hidden-derived-secret");
      expect(wire).not.toContain("hidden-patch-secret");
      expect(wire).not.toContain("hidden/path.ts");
      expect(wire).not.toContain("visible-value-secret");
      expect(wire).not.toContain("visible-result-secret");
    },
  );

  it("filters non-tool and hidden events, malformed data, and unsupported phases", async () => {
    const made = makeActivityApi(async (turn, emit) => {
      turn.replyOptions?.onAgentRunStart?.("run-filter");
      for (const kind of ["preamble", "analysis", "status"]) {
        emit({
          stream: "item",
          runId: "run-filter",
          data: { itemId: kind, kind, phase: "update", summary: "not a tool" },
        });
      }
      emit({
        stream: "tool",
        runId: "run-filter",
        data: {
          toolCallId: "hidden-tool",
          name: "hidden",
          phase: "start",
          hideFromChannelProgress: true,
        },
      });
      emit({
        stream: "item",
        runId: "run-filter",
        data: {
          itemId: "hidden-item",
          kind: "tool",
          name: "hidden",
          phase: "end",
          hideFromChannelProgress: true,
        },
      });
      emit({ stream: "tool", runId: "run-filter", data: "not-an-object" });
      emit({
        stream: "tool",
        runId: "run-filter",
        data: { toolCallId: "delta", name: "nope", phase: "delta" },
      });
    });
    const { transport, toolActivities } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", {
      type: "user_message",
      text: "filter",
      id: "turn-filter",
    });

    expect(toolActivities).toEqual([]);
  });

  it("uses command_output and patch only as safe terminal refinements", async () => {
    const made = makeActivityApi(async (turn, emit) => {
      turn.replyOptions?.onAgentRunStart?.("run-specialized");
      emit({
        stream: "tool",
        runId: "run-specialized",
        data: {
          toolCallId: "command-call",
          name: "bash",
          phase: "start",
          args: { command: "printf command-secret" },
        },
      });
      emit({
        stream: "command_output",
        runId: "run-specialized",
        data: {
          itemId: "command:command-call",
          toolCallId: "command-call",
          name: "bash",
          phase: "delta",
          status: "running",
          output: "command-secret delta",
        },
      });
      emit({
        stream: "command_output",
        runId: "run-specialized",
        data: {
          itemId: "command:command-call",
          toolCallId: "command-call",
          name: "bash",
          phase: "end",
          status: "failed",
          output: "command-secret output",
        },
      });
      emit({
        stream: "tool",
        runId: "run-specialized",
        data: {
          toolCallId: "patch-call",
          name: "apply_patch",
          phase: "start",
          args: { patch: "secret patch body" },
        },
      });
      emit({
        stream: "item",
        runId: "run-specialized",
        data: {
          itemId: "patch:patch-call",
          toolCallId: "patch-call",
          kind: "patch",
          name: "apply_patch",
          phase: "end",
          status: "failed",
          summary: "modified secret/item.ts; output=item-secret",
        },
      });
      emit({
        stream: "patch",
        runId: "run-specialized",
        data: {
          itemId: "patch:patch-call",
          toolCallId: "patch-call",
          name: "apply_patch",
          phase: "end",
          added: ["secret/added.ts"],
          modified: ["secret/one.ts", "secret/two.ts"],
          deleted: ["secret/deleted.ts"],
          summary: "modified secret/a.ts; output=patch-secret",
        },
      });
      emit({
        stream: "item",
        runId: "run-specialized",
        data: {
          itemId: "patch:count-only",
          toolCallId: "count-only",
          kind: "patch",
          name: "apply_patch",
          phase: "end",
          status: "completed",
          summary: "2 modified, 1 deleted",
        },
      });
      emit({
        stream: "patch",
        runId: "run-specialized",
        data: {
          itemId: "patch:zero-counts",
          toolCallId: "zero-counts",
          name: "apply_patch",
          phase: "end",
          added: [],
          modified: [],
          deleted: [],
          summary: "output=zero-count-secret",
        },
      });
    });
    const { transport, toolActivities } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", {
      type: "user_message",
      text: "run and patch",
      id: "turn-specialized",
    });

    expect(toolActivities.filter((frame) => frame.id === "command-call")).toHaveLength(2);
    expect(toolActivities.find(
      (frame) => frame.id === "command-call" && frame.phase === "end",
    )?.status).toBe("failed");
    const patch = toolActivities.filter((frame) => frame.id === "patch-call");
    expect(patch).toHaveLength(3);
    expect(patch[1]).toMatchObject({ phase: "end", status: "failed" });
    expect(patch[1]!.summary).toBeUndefined();
    expect(patch[2]).toMatchObject({
      phase: "end",
      summary: "1 added, 2 modified, 1 deleted",
    });
    // Pinned patch summaries have no status/isError. The sparse refinement must
    // not overwrite the preceding failed item status with a guessed success.
    expect(patch[2]!.status).toBeUndefined();
    expect(toolActivities.find((frame) => frame.id === "count-only")).toMatchObject({
      status: "completed",
      summary: "2 modified, 1 deleted",
    });
    expect(toolActivities.find((frame) => frame.id === "zero-counts")).toMatchObject({
      summary: "no file changes recorded",
    });
    expect(toolActivities.find((frame) => frame.id === "zero-counts")!.status)
      .toBeUndefined();
    const wire = JSON.stringify(toolActivities);
    expect(wire).not.toContain("command-secret");
    expect(wire).not.toContain("secret patch body");
    expect(wire).not.toContain("secret/item.ts");
    expect(wire).not.toContain("secret/added.ts");
    expect(wire).not.toContain("secret/one.ts");
    expect(wire).not.toContain("secret/two.ts");
    expect(wire).not.toContain("secret/deleted.ts");
    expect(wire).not.toContain("secret/a.ts");
    expect(wire).not.toContain("item-secret");
    expect(wire).not.toContain("patch-secret");
    expect(wire).not.toContain("zero-count-secret");
  });

  it("gives repeated same-name and unnamed id-less starts distinct ids and correlates sequential terminals", async () => {
    const made = makeActivityApi(async (turn, emit) => {
      turn.replyOptions?.onAgentRunStart?.("run-idless");
      emit({ stream: "tool", runId: "run-idless", data: { name: "bash", phase: "start" } });
      emit({ stream: "tool", runId: "run-idless", data: { name: "bash", phase: "result" } });
      emit({ stream: "tool", runId: "run-idless", data: { name: "bash", phase: "start" } });
      emit({ stream: "tool", runId: "run-idless", data: { name: "bash", phase: "result", isError: true } });
      emit({ stream: "tool", runId: "run-idless", data: { phase: "start" } });
      emit({ stream: "tool", runId: "run-idless", data: { phase: "result" } });
      emit({ stream: "tool", runId: "run-idless", data: { phase: "start" } });
      emit({ stream: "tool", runId: "run-idless", data: { phase: "result" } });
      // Concurrent id-less starts are distinct, and an ambiguous terminal must
      // become its own record rather than completing an arbitrary invocation.
      emit({ stream: "tool", runId: "run-idless", data: { name: "grep", phase: "start" } });
      emit({ stream: "tool", runId: "run-idless", data: { name: "grep", phase: "start" } });
      emit({ stream: "tool", runId: "run-idless", data: { phase: "start" } });
      emit({ stream: "tool", runId: "run-idless", data: { phase: "start" } });
      emit({ stream: "tool", runId: "run-idless", data: { name: "grep", phase: "result" } });
    });
    const { transport, toolActivities } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", {
      type: "user_message",
      text: "repeat",
      id: "turn-idless",
    });

    expect(toolActivities).toHaveLength(13);
    for (let index = 0; index < 8; index += 2) {
      expect(toolActivities[index]!.id).toBe(toolActivities[index + 1]!.id);
    }
    expect(new Set(toolActivities.slice(0, 8).filter((_, i) => i % 2 === 0).map((frame) => frame.id)).size).toBe(4);
    expect(new Set(toolActivities.slice(8).map((frame) => frame.id)).size).toBe(5);
    expect(toolActivities[3]!.status).toBe("failed");
    expect(toolActivities.map((frame) => frame.id)).not.toContain("bash");
    expect(toolActivities.map((frame) => frame.id)).not.toContain("tool");
  });

  it("prefers the sole active alias when an upstream id is reused", async () => {
    const made = makeActivityApi(async (turn, emit) => {
      turn.replyOptions?.onAgentRunStart?.("run-alias");
      emit({
        stream: "tool",
        runId: "run-alias",
        data: { toolCallId: "X", name: "bash", phase: "start" },
      });
      emit({
        stream: "item",
        runId: "run-alias",
        data: {
          itemId: "tool:X",
          toolCallId: "X",
          kind: "tool",
          name: "bash",
          phase: "start",
          status: "running",
        },
      });
      emit({
        stream: "tool",
        runId: "run-alias",
        data: { toolCallId: "X", name: "bash", phase: "result" },
      });
      // X now points at the new active call while tool:X still points at the
      // completed predecessor. The mixed-alias replay must choose the active.
      emit({
        stream: "tool",
        runId: "run-alias",
        data: { toolCallId: "X", name: "bash", phase: "start" },
      });
      emit({
        stream: "item",
        runId: "run-alias",
        data: {
          itemId: "tool:X",
          toolCallId: "X",
          kind: "tool",
          name: "bash",
          phase: "start",
          status: "running",
        },
      });
      emit({
        stream: "item",
        runId: "run-alias",
        data: {
          itemId: "tool:X",
          kind: "tool",
          name: "bash",
          phase: "end",
          status: "completed",
        },
      });
    });
    const { transport, toolActivities } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", {
      type: "user_message",
      text: "reuse",
      id: "turn-alias",
    });

    expect(new Set(toolActivities.slice(0, 3).map((frame) => frame.id)).size).toBe(1);
    expect(new Set(toolActivities.slice(3).map((frame) => frame.id)).size).toBe(1);
    expect(toolActivities[0]!.id).not.toBe(toolActivities[3]!.id);
  });

  it("namespaces reused upstream ids across fallback run ids and cleans every run at turn settlement", async () => {
    let emitAfterSettlement!: EmitAgentEvent;
    const made = makeActivityApi(async (turn, emit) => {
      emitAfterSettlement = emit;
      for (const runId of ["fallback-a", "fallback-b"]) {
        emit({ stream: "lifecycle", runId, data: { phase: "start" } });
        turn.replyOptions?.onAgentRunStart?.(runId);
        emit({
          stream: "tool",
          runId,
          data: { toolCallId: "same-id", name: "bash", phase: "start" },
        });
        emit({
          stream: "tool",
          runId,
          data: { toolCallId: "same-id", name: "bash", phase: "result" },
        });
      }
    });
    const { transport, toolActivities } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", {
      type: "user_message",
      text: "fallback",
      id: "turn-fallback",
    });

    expect(toolActivities).toHaveLength(4);
    expect(toolActivities[0]!.id).toBe(toolActivities[1]!.id);
    expect(toolActivities[2]!.id).toBe(toolActivities[3]!.id);
    expect(toolActivities[0]!.id).not.toBe(toolActivities[2]!.id);
    emitAfterSettlement({
      stream: "tool",
      runId: "fallback-a",
      data: { toolCallId: "late", name: "late", phase: "start" },
    });
    expect(toolActivities).toHaveLength(4);
  });

  it("isolates concurrent turns by run id", async () => {
    const started = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    const holder: { emit?: EmitAgentEvent } = {};
    let index = 0;
    const made = makeFakeApi({
      streamingMode: "progress",
      withAgentEvents: true,
      runImpl: async (turn) => {
        const own = index++;
        const runId = `concurrent-${own}`;
        holder.emit?.({ stream: "lifecycle", runId, data: { phase: "start" } });
        turn.replyOptions?.onAgentRunStart?.(runId);
        started[own]!.resolve();
        await release[own]!.promise;
      },
    });
    holder.emit = made.emitLifecycle;
    startAgentLifecycleSubscription(made.api);
    const { transport, toolActivities } = makeFakeTransport();

    const first = handleInboundMessage(made.api, transport, "peer-a", {
      type: "user_message",
      text: "first",
      id: "turn-a",
    });
    await started[0]!.promise;
    const second = handleInboundMessage(made.api, transport, "peer-b", {
      type: "user_message",
      text: "second",
      id: "turn-b",
    });
    await started[1]!.promise;
    holder.emit({
      stream: "tool",
      runId: "concurrent-1",
      data: { toolCallId: "shared", name: "second-tool", phase: "start" },
    });
    holder.emit({
      stream: "tool",
      runId: "concurrent-0",
      data: { toolCallId: "shared", name: "first-tool", phase: "start" },
    });
    release[0]!.resolve();
    release[1]!.resolve();
    await Promise.all([first, second]);

    expect(toolActivities).toEqual([
      expect.objectContaining({ sessionKey: "peer-b", turnId: "turn-b", name: "second-tool" }),
      expect.objectContaining({ sessionKey: "peer-a", turnId: "turn-a", name: "first-tool" }),
    ]);
    // Public identity is turn-scoped; the same upstream id may be reused safely.
    expect(toolActivities[0]!.id).toBe("shared");
    expect(toolActivities[1]!.id).toBe("shared");
  });

  it("preserves active run sinks across listener replacement and rejects stale listener callbacks", async () => {
    const started = deferred();
    const release = deferred();
    const original = makeActivityApi(async (turn) => {
      turn.replyOptions?.onAgentRunStart?.("replace-run");
      started.resolve();
      await release.promise;
    });
    const { transport, toolActivities } = makeFakeTransport();
    const pending = handleInboundMessage(original.api, transport, "peer-1", {
      type: "user_message",
      text: "replace",
      id: "turn-replace",
    });
    await started.promise;

    const replacement = makeFakeApi({
      streamingMode: "progress",
      withAgentEvents: true,
      runImpl: async () => {},
    });
    startAgentLifecycleSubscription(replacement.api);
    // The fake host intentionally retains the old callback after unsubscribe.
    // The generation fence must reject it.
    original.emitLifecycle({
      stream: "tool",
      runId: "replace-run",
      data: { toolCallId: "old", name: "stale", phase: "start" },
    });
    replacement.emitLifecycle({
      stream: "tool",
      runId: "replace-run",
      data: { toolCallId: "new", name: "current", phase: "start" },
    });
    release.resolve();
    await pending;

    expect(toolActivities).toEqual([
      expect.objectContaining({ turnId: "turn-replace", id: "new", name: "current" }),
    ]);
  });

  it("teardown drops active sinks and a stale finally cannot delete a newer same-run owner", async () => {
    const started = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    let index = 0;
    let newerTurn: AssembledTurnLike | undefined;
    const holder: { emit?: EmitAgentEvent } = {};
    const made = makeFakeApi({
      streamingMode: "progress",
      withAgentEvents: true,
      runImpl: async (turn) => {
        const own = index++;
        if (own === 1) newerTurn = turn;
        turn.replyOptions?.onAgentRunStart?.("reused-run");
        started[own]!.resolve();
        await release[own]!.promise;
      },
    });
    holder.emit = made.emitLifecycle;
    startAgentLifecycleSubscription(made.api);
    const { transport, toolActivities } = makeFakeTransport();

    const oldTurn = handleInboundMessage(made.api, transport, "peer-old", {
      type: "user_message",
      text: "old",
      id: "turn-old",
    });
    await started[0]!.promise;
    const newTurn = handleInboundMessage(made.api, transport, "peer-new", {
      type: "user_message",
      text: "new",
      id: "turn-new",
    });
    await started[1]!.promise;
    holder.emit({
      stream: "tool",
      runId: "reused-run",
      data: { toolCallId: "same-run-call", name: "owned-by-new", phase: "start" },
    });
    release[0]!.resolve();
    await oldTurn;
    holder.emit({
      stream: "tool",
      runId: "reused-run",
      data: { toolCallId: "same-run-call", name: "owned-by-new", phase: "result" },
    });
    expect(toolActivities.map((frame) => frame.turnId)).toEqual(["turn-new", "turn-new"]);

    stopAgentLifecycleSubscription();
    startAgentLifecycleSubscription(made.api);
    // A fallback callback from the pre-teardown turn must not republish its
    // sink into the new subscription generation.
    newerTurn?.replyOptions?.onAgentRunStart?.("post-stop-fallback");
    holder.emit({
      stream: "tool",
      runId: "post-stop-fallback",
      data: { toolCallId: "after-stop", name: "hidden", phase: "start" },
    });
    expect(toolActivities).toHaveLength(2);
    release[1]!.resolve();
    await newTurn;
  });

  it("does not create structured activity in off or control-lane turns", async () => {
    for (const testCase of [
      { mode: "off" as const, controlLane: false, turnId: "turn-off" },
      { mode: "progress" as const, controlLane: true, turnId: "turn-control" },
    ]) {
      const made = makeActivityApi(async (turn, emit) => {
        turn.replyOptions?.onAgentRunStart?.(`run-${testCase.turnId}`);
        emit({
          stream: "tool",
          runId: `run-${testCase.turnId}`,
          data: { toolCallId: "call", name: "bash", phase: "start" },
        });
      }, testCase.mode);
      const { transport, toolActivities } = makeFakeTransport();

      await handleInboundMessage(
        made.api,
        transport,
        "peer-1",
        { type: "user_message", text: "no activity", id: testCase.turnId },
        "default",
        { controlLane: testCase.controlLane },
      );

      expect(toolActivities).toEqual([]);
    }
  });
});

describe("handleInboundMessage — #111 live block ordinal", () => {
  it("stamps only a valid block ordinal and preserves the compatibility path", async () => {
    for (const streamingMode of ["partial", "off"] as const) {
      for (const testCase of [
        { label: "valid", info: { kind: "block", assistantMessageIndex: 1 }, expected: 1 },
        { label: "missing", info: { kind: "block" }, expected: undefined },
        {
          label: "malformed",
          info: {
            kind: "block",
            assistantMessageIndex: "1" as unknown as number,
          },
          expected: undefined,
        },
      ]) {
        const { api } = makeFakeApi({
          streamingMode,
          runImpl: async (turn) => {
            await turn.delivery.deliver(
              { text: `${testCase.label} block` },
              testCase.info,
            );
          },
        });
        const { transport, finalizes, texts } = makeFakeTransport();

        await handleInboundMessage(api, transport, "peer-1", {
          type: "user_message",
          text: "answer in blocks",
          id: `turn-${streamingMode}-${testCase.label}`,
        });

        const frames = streamingMode === "partial" ? finalizes : texts;
        expect(frames).toHaveLength(1);
        if (testCase.expected === undefined) {
          expect(frames[0]).not.toHaveProperty("assistantMessageIndex");
        } else {
          expect(frames[0]).toHaveProperty(
            "assistantMessageIndex",
            testCase.expected,
          );
        }
      }
    }
  });

  it("never stamps the ordinal on finals, notices, or errors", async () => {
    for (const streamingMode of ["partial", "off"] as const) {
      for (const testCase of [
        {
          label: "final",
          payload: { text: "ordinary final" },
          info: { kind: "final", assistantMessageIndex: 2 },
        },
        {
          label: "notice",
          payload: { text: "status notice", isStatusNotice: true },
          info: { kind: "block", assistantMessageIndex: 2 },
        },
        {
          label: "error",
          payload: { text: "block error", isError: true },
          info: { kind: "block", assistantMessageIndex: 2 },
        },
      ] as const) {
        const { api } = makeFakeApi({
          streamingMode,
          runImpl: async (turn) => {
            await turn.delivery.deliver(testCase.payload, testCase.info);
          },
        });
        const { transport, finalizes, texts } = makeFakeTransport();

        await handleInboundMessage(api, transport, "peer-1", {
          type: "user_message",
          text: `produce ${testCase.label}`,
          id: `turn-${streamingMode}-${testCase.label}`,
        });

        const frames = streamingMode === "partial" ? finalizes : texts;
        expect(frames).toHaveLength(1);
        expect(frames[0]).not.toHaveProperty("assistantMessageIndex");
      }
    }
  });
});

describe("deliverDraftFinalPayload — independent routing policy", () => {
  const makeDraft = () => {
    const finalize = vi.fn(async () => true);
    const deliverIndependentFinal = vi.fn(async () => true);
    const noteLeadingTerminalError = vi.fn();
    const draft = {
      finalize,
      deliverIndependentFinal,
      noteLeadingTerminalError,
    } as unknown as ProgressDraftController;
    return { draft, finalize, deliverIndependentFinal, noteLeadingTerminalError };
  };

  it.each([
    {
      reason: "isNotice",
      payload: { text: "notice", isFallbackNotice: true },
      state: {
        leadingTerminalErrorSeen: false,
        ordinaryAnswerFinalSeen: false,
        ordinaryNonErrorFinalCount: 0,
        firstOrdinaryNonErrorFinalNonIndependent: false,
      },
    },
    {
      reason: "payload.isError",
      payload: { text: WARNING_SENTINEL, isError: true },
      state: {
        leadingTerminalErrorSeen: false,
        ordinaryAnswerFinalSeen: false,
        ordinaryNonErrorFinalCount: 0,
        firstOrdinaryNonErrorFinalNonIndependent: false,
      },
    },
    {
      reason: "leadingTerminalErrorSeen",
      payload: { text: "retained answer" },
      state: {
        leadingTerminalErrorSeen: true,
        ordinaryAnswerFinalSeen: false,
        ordinaryNonErrorFinalCount: 0,
        firstOrdinaryNonErrorFinalNonIndependent: false,
      },
    },
    {
      reason: "ordinaryAnswerFinalSeen",
      payload: { text: "extra answer" },
      state: {
        leadingTerminalErrorSeen: false,
        ordinaryAnswerFinalSeen: true,
        ordinaryNonErrorFinalCount: 1,
        firstOrdinaryNonErrorFinalNonIndependent: true,
      },
    },
  ] satisfies Array<{
    reason: string;
    payload: {
      text: string;
      isError?: boolean;
      isFallbackNotice?: boolean;
    };
    state: FinalReconciliationState;
  }>)("F1: $reason alone selects the independent final route", async ({ payload, state }) => {
    const h = makeDraft();

    await expect(
      deliverDraftFinalPayload(h.draft, payload, payload.text, { ...state }),
    ).resolves.toEqual({ sent: true, independent: true });

    expect(h.deliverIndependentFinal).toHaveBeenCalledOnce();
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it("F7: a first terminal error records the adapter reconciliation guard", async () => {
    const h = makeDraft();
    const state: FinalReconciliationState = {
      leadingTerminalErrorSeen: false,
      ordinaryAnswerFinalSeen: false,
      ordinaryNonErrorFinalCount: 0,
      firstOrdinaryNonErrorFinalNonIndependent: false,
    };

    await deliverDraftFinalPayload(
      h.draft,
      { text: "terminal error", isError: true },
      "terminal error",
      state,
    );

    expect(state.leadingTerminalErrorSeen).toBe(true);
    expect(h.noteLeadingTerminalError).toHaveBeenCalledOnce();
  });
});

/**
 * #173 — the tool-only-turn overwrite SIGNATURE.
 *
 * When the last assistant message of a turn is tool-only, core emits >=2
 * ordinary non-error finals [A,B]; the first routes through `draft.finalize`
 * (non-independent) and overwrites the live lane's streamed bubble, so the LIVE
 * view renders [A,A,B]. The signature is exactly that routing shape — a first
 * ordinary non-error final delivered non-independent, followed by at least one
 * more ordinary non-error final — with NO text/body comparison. Anything else
 * (single final, leading terminal error, notices) must not trip it.
 */
describe("#173 keyframe resync — signature detection", () => {
  const makeDraft = () => {
    const finalize = vi.fn(async () => true);
    const deliverIndependentFinal = vi.fn(async () => true);
    const noteLeadingTerminalError = vi.fn();
    const draft = {
      finalize,
      deliverIndependentFinal,
      noteLeadingTerminalError,
    } as unknown as ProgressDraftController;
    return { draft };
  };
  const freshState = (): FinalReconciliationState => ({
    ordinaryAnswerFinalSeen: false,
    leadingTerminalErrorSeen: false,
    ordinaryNonErrorFinalCount: 0,
    firstOrdinaryNonErrorFinalNonIndependent: false,
  });

  it("sets the flag ONLY once a SECOND ordinary final follows a non-independent first", async () => {
    const { draft } = makeDraft();
    const state = freshState();

    await deliverDraftFinalPayload(draft, { text: "A" }, "A", state);
    // First ordinary final took the finalize (overwrite) path, but one final
    // alone is not the [A,A,B] signature yet.
    expect(state.firstOrdinaryNonErrorFinalNonIndependent).toBe(true);
    expect(isResyncKeyframeRequired(state)).toBe(false);

    await deliverDraftFinalPayload(draft, { text: "B" }, "B", state);
    expect(state.ordinaryNonErrorFinalCount).toBe(2);
    expect(isResyncKeyframeRequired(state)).toBe(true);
  });

  it("does NOT set the flag for a single ordinary final turn", async () => {
    const { draft } = makeDraft();
    const state = freshState();

    await deliverDraftFinalPayload(draft, { text: "A" }, "A", state);

    expect(isResyncKeyframeRequired(state)).toBe(false);
  });

  it("does NOT set the flag for a leading terminal error then ordinary finals", async () => {
    const { draft } = makeDraft();
    const state = freshState();

    // A leading terminal error makes EVERY later ordinary final independent, so
    // the first ordinary final never takes the overwrite path.
    await deliverDraftFinalPayload(draft, { text: "boom", isError: true }, "boom", state);
    await deliverDraftFinalPayload(draft, { text: "A" }, "A", state);
    await deliverDraftFinalPayload(draft, { text: "B" }, "B", state);

    expect(state.ordinaryNonErrorFinalCount).toBe(2);
    expect(state.firstOrdinaryNonErrorFinalNonIndependent).toBe(false);
    expect(isResyncKeyframeRequired(state)).toBe(false);
  });

  it("does NOT count a final the controller refused to send", async () => {
    // `finalize` returns false on the re-entrant-settle, already-settled and
    // empty-text paths: nothing reached the wire and no lane was overwritten,
    // so that payload is not part of the signature at all.
    const finalize = vi.fn(async () => false);
    const draft = {
      finalize,
      deliverIndependentFinal: vi.fn(async () => true),
      noteLeadingTerminalError: vi.fn(),
    } as unknown as ProgressDraftController;
    const state = freshState();

    const first = await deliverDraftFinalPayload(draft, { text: "A" }, "A", state);
    expect(first.sent).toBe(false);
    expect(state.ordinaryNonErrorFinalCount).toBe(0);
    expect(state.firstOrdinaryNonErrorFinalNonIndependent).toBe(false);

    // The next ordinary final is the first one actually DELIVERED — and it goes
    // out independent (the lane is spent), so there is no overwrite to repair.
    await deliverDraftFinalPayload(draft, { text: "B" }, "B", state);
    expect(state.ordinaryNonErrorFinalCount).toBe(1);
    expect(state.firstOrdinaryNonErrorFinalNonIndependent).toBe(false);
    expect(isResyncKeyframeRequired(state)).toBe(false);
  });

  it("does NOT set the flag for notice-only finals", async () => {
    const { draft } = makeDraft();
    const state = freshState();

    await deliverDraftFinalPayload(
      draft,
      { text: "status", isStatusNotice: true },
      "status",
      state,
    );
    await deliverDraftFinalPayload(
      draft,
      { text: "fallback", isFallbackNotice: true },
      "fallback",
      state,
    );

    expect(state.ordinaryNonErrorFinalCount).toBe(0);
    expect(isResyncKeyframeRequired(state)).toBe(false);
  });
});

/**
 * #173 — the keyframe is emitted at settlement IFF the signature fired, and it
 * carries the transcript projection (the same read the register-time history
 * snapshot uses), so the client can re-establish ground truth.
 */
describe("handleInboundMessage — #173 keyframe resync at settlement", () => {
  const ordinary = { type: "user_message" as const, text: "do the thing" };

  /**
   * A fixture helper found its callback missing.
   *
   * Recorded rather than only thrown: a `runImpl` throw is swallowed by
   * `handleInboundMessage`'s own catch (it becomes an `error` turn outcome), so
   * a broken fixture would otherwise surface as an unexplained zero-keyframe
   * result — a fixture bug wearing the costume of a passing negative test. The
   * `afterEach` below re-raises it with the actual reason.
   */
  let fixtureFailure: string | undefined;
  beforeEach(() => {
    fixtureFailure = undefined;
  });
  afterEach(() => {
    if (fixtureFailure !== undefined) throw new Error(fixtureFailure);
  });
  const requireCallback = <T>(callback: T | undefined, what: string): T => {
    if (typeof callback !== "function") {
      fixtureFailure = `fixture: ${what} is not wired — this turn cannot exercise answer lanes`;
      throw new Error(fixtureFailure);
    }
    return callback;
  };

  /** Stream answer text for the CURRENT assistant lane. */
  const streamAnswerLane = (turn: AssembledTurnLike, text: string) => {
    requireCallback(turn.replyOptions?.onPartialReply, "onPartialReply")({ text });
  };
  /** Open the NEXT assistant lane (core fires this before its first chunk). */
  const openNextAnswerLane = (turn: AssembledTurnLike) => {
    requireCallback(turn.replyOptions?.onAssistantMessageStart, "onAssistantMessageStart")();
  };

  const twoStreamedLanesThenTwoFinals = async (turn: AssembledTurnLike) => {
    // The real #173 shape: the turn's last assistant message is tool-only, so
    // core retains finals [A,B] for two assistant messages that BOTH already
    // streamed their text. The first final routes through finalize and
    // overwrites lane 2's streamed bubble with A; the second delivers
    // independent → the LIVE view is [A,A,B] while the transcript is [A,B].
    streamAnswerLane(turn, "first ans");
    openNextAnswerLane(turn);
    streamAnswerLane(turn, "second ans");
    await turn.delivery.deliver({ text: "first answer" }, { kind: "final" });
    await turn.delivery.deliver({ text: "second answer" }, { kind: "final" });
  };
  const transcriptRows = [
    { role: "assistant", text: "first answer", __openclaw: { id: "A" } },
    { role: "assistant", text: "second answer", __openclaw: { id: "B" } },
  ];

  it("emits a keyframe carrying the transcript for the overwrite signature (partial mode)", async () => {
    const { api } = makeFakeApi({
      streamingMode: "partial",
      sessionMessages: transcriptRows,
      runImpl: twoStreamedLanesThenTwoFinals,
    });
    const { transport, keyframes } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(keyframes).toHaveLength(1);
    expect(keyframes[0].peerId).toBe("peer-1");
    expect(keyframes[0].messages.map((m) => m.id)).toEqual(["A", "B"]);
  });

  it("does NOT emit a keyframe for the SAME two finals in progress mode (no answer lane streams at all)", async () => {
    // `progress` mode never wires answer-text streaming — that is the mode
    // distinction — so no lane can stream, [A,A,B] cannot occur, and the
    // signature (which still fires on the routing shape) must not resync.
    const { api } = makeFakeApi({
      streamingMode: "progress",
      sessionMessages: transcriptRows,
      runImpl: async (turn) => {
        expect(turn.replyOptions?.onPartialReply).toBeUndefined();
        await turn.delivery.deliver({ text: "first answer" }, { kind: "final" });
        await turn.delivery.deliver({ text: "second answer" }, { kind: "final" });
      },
    });
    const { transport, keyframes } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(keyframes).toHaveLength(0);
  });

  it("does NOT emit a keyframe for a single-final turn", async () => {
    const { api } = makeFakeApi({
      streamingMode: "partial",
      sessionMessages: [{ role: "assistant", text: "only answer", __openclaw: { id: "A" } }],
      runImpl: async (turn) => {
        streamAnswerLane(turn, "only ans");
        await turn.delivery.deliver({ text: "only answer" }, { kind: "final" });
      },
    });
    const { transport, keyframes } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(keyframes).toHaveLength(0);
  });

  it("does NOT emit a keyframe in partial mode when NO answer text ever streamed", async () => {
    // Partial mode is only the PERMISSION to stream answer text; a provider that
    // emitted none (tool lines only) left no live answer bubble, so the same two
    // finals render [A,B] correctly and a keyframe would be an unnecessary full
    // replace of a correctly-rendered region.
    const { api } = makeFakeApi({
      streamingMode: "partial",
      sessionMessages: transcriptRows,
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "first answer" }, { kind: "final" });
        await turn.delivery.deliver({ text: "second answer" }, { kind: "final" });
      },
    });
    const { transport, keyframes } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(keyframes).toHaveLength(0);
  });

  it("does NOT emit a keyframe when only ONE answer lane streamed (benign extra final)", async () => {
    // The shape a keyframe must never touch. Core's final-payload array
    // reachably carries an extra plain payload that is neither a notice nor an
    // error — a trailing plugin-status / raw-trace line under `/trace` or
    // verbose, or a leading per-messaging-tool source-reply mirror. Only ONE
    // lane streamed, so `[answer, status]` routes exactly like the glitch
    // (finalize, then independent) yet renders CORRECTLY. A keyframe here would
    // delete the status bubble the operator switched on, because the client's
    // reducer rebuilds the covered region from transcript rows and keeps only
    // `role === "user"` bubbles.
    const { api } = makeFakeApi({
      streamingMode: "partial",
      sessionMessages: transcriptRows,
      runImpl: async (turn) => {
        streamAnswerLane(turn, "the ans");
        await turn.delivery.deliver({ text: "the answer" }, { kind: "final" });
        await turn.delivery.deliver({ text: "plugin status: trace on" }, { kind: "final" });
      },
    });
    const { transport, keyframes } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(keyframes).toHaveLength(0);
  });

  it("does NOT emit a keyframe when the first ordinary final was never actually sent", async () => {
    // The controller refuses the finalize (here: its terminal frame fails to
    // leave), so no lane was overwritten — the second final is simply the first
    // one the reader saw. The signature must follow the DELIVERY, not the
    // payload sequence.
    const { api } = makeFakeApi({
      streamingMode: "partial",
      sessionMessages: transcriptRows,
      runImpl: twoStreamedLanesThenTwoFinals,
    });
    const { transport, keyframes } = makeFakeTransport();
    transport.finalizeDraft = () => false;

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(keyframes).toHaveLength(0);
  });

  it("does not hang and sends no keyframe when the transcript read never settles", async () => {
    // The read is awaited on purpose (it holds the per-session FIFO so the next
    // turn cannot overtake the keyframe), which puts it on that queue's critical
    // path. The underlying session read has no deadline, so an unbounded await
    // would wedge this peer permanently — AFTER `turn_settled` already went out,
    // so the widget would look idle while everything behind it buffered.
    const { api, warnings } = makeFakeApi({
      streamingMode: "partial",
      sessionMessagesNeverSettle: true,
      runImpl: twoStreamedLanesThenTwoFinals,
    });
    const { transport, keyframes, settles } = makeFakeTransport();

    vi.useFakeTimers();
    try {
      const pending = handleInboundMessage(api, transport, "peer-1", ordinary);
      // Reaches the race, then the deadline fires. Without the bound this await
      // never returns and the test times out.
      await vi.advanceTimersByTimeAsync(KEYFRAME_HISTORY_READ_TIMEOUT_MS);
      await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(keyframes).toHaveLength(0);
    // The turn itself still settled normally — only the cosmetic resync is lost.
    expect(settles).toEqual(["ok"]);
    expect(warnings.some((w) => w.includes("keyframe resync history read timed out"))).toBe(true);
  });

  it("warns instead of going silently inert when the projection comes back empty", async () => {
    // A successful-but-EMPTY read logs nothing of its own, and the `length > 0`
    // guard then skips the send. Silence there is the same invisible-failure
    // mode this whole change exists to remove.
    const { api, warnings } = makeFakeApi({
      streamingMode: "partial",
      // Present (so the read seam exists) but projecting to nothing: neither row
      // survives normalization, so `history.recent` succeeds with [].
      sessionMessages: [{ role: "assistant", text: "" }, { role: "tool", text: "x" }],
      runImpl: twoStreamedLanesThenTwoFinals,
    });
    const { transport, keyframes } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(keyframes).toHaveLength(0);
    expect(
      warnings.some((w) => w.includes("keyframe resync skipped — history projection was empty")),
    ).toBe(true);
  });

  it("reads the transcript in a DETACHED async scope, so the inbound request scope cannot reject it", async () => {
    // Models the gateway seam this workaround exists for: `sessions.get`
    // authorizes against whatever operator client is ambient in the CALLING
    // context, and the inbound dispatch's client has no `operator.read`. The
    // read must therefore run in the module-level detached scope, where no
    // request client is ambient at all.
    const ambientOperatorClient = new AsyncLocalStorage<{ scopes: readonly string[] }>();
    const { api } = makeFakeApi({
      streamingMode: "partial",
      sessionMessages: transcriptRows,
      runImpl: twoStreamedLanesThenTwoFinals,
      onSessionMessagesRead: () => {
        const client = ambientOperatorClient.getStore();
        if (client && !client.scopes.includes("operator.read")) {
          throw new Error("missing scope: operator.read");
        }
      },
    });
    const { transport, keyframes } = makeFakeTransport();

    await ambientOperatorClient.run({ scopes: [] }, async () => {
      await handleInboundMessage(api, transport, "peer-1", ordinary);
    });

    expect(keyframes).toHaveLength(1);
    expect(keyframes[0].messages.map((m) => m.id)).toEqual(["A", "B"]);

    // Control — proves the rejection above is real and this test can fail: the
    // SAME read made directly from that scope is rejected, and `history.recent`
    // swallows the rejection into `[]` (which would silently skip the keyframe).
    const undetached = await ambientOperatorClient.run({ scopes: [] }, () =>
      historyRecent(api, "agent:agent1:seed", 50, api.logger),
    );
    expect(undetached).toEqual([]);
  });

  // Finding 1 (false negative): the controller can open a NEW visible lane
  // WITHOUT an `onAssistantMessageStart` boundary — the divergence fail-safe
  // `closeAndRotate` fires when the cumulative partial diverges. The old raw-
  // callback counter reset only on the boundary callback, so it stayed at 1 for
  // this shape and no keyframe fired. Sourcing the count from the controller's
  // lane state (which rotates on BOTH paths) counts both lanes.
  it("emits a keyframe when the second lane opened via the divergence fail-safe (no boundary callback)", async () => {
    const { api } = makeFakeApi({
      streamingMode: "partial",
      sessionMessages: transcriptRows,
      runImpl: async (turn) => {
        // Lane 1 streams its text.
        streamAnswerLane(turn, "Lane one is present");
        // A DIVERGENT cumulative partial — not a prefix-extension of lane 1 and
        // no `replace` flag — makes the adapter rotate defensively via
        // `closeAndRotate`, opening lane 2 with NO `onAssistantMessageStart`.
        streamAnswerLane(turn, "Wholly different second lane");
        // Lane 2 keeps streaming (a faithful prefix-extension, so it does not
        // re-rotate).
        streamAnswerLane(turn, "Wholly different second lane, extended");
        // The [A,A,B] routing: first final finalizes lane 2 (non-independent),
        // second delivers independent.
        await turn.delivery.deliver({ text: "first answer" }, { kind: "final" });
        await turn.delivery.deliver({ text: "second answer" }, { kind: "final" });
      },
    });
    const { transport, keyframes } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(keyframes).toHaveLength(1);
    expect(keyframes[0].messages.map((m) => m.id)).toEqual(["A", "B"]);
  });

  // Finding 1 (false positive): the old counter incremented in `onPartialReply`
  // BEFORE the adapter filters reasoning partials, so a `Reasoning:\n` partial
  // followed by a boundary and one real answer inflated the count to 2 — and the
  // benign `[answer, status]` routing shape then wrongly fired a keyframe,
  // deleting the covered status/trace bubble. Sourcing the count past the
  // reasoning filter keeps it at 1 (the one lane that streamed VISIBLE text).
  it("does NOT emit a keyframe when a filtered reasoning partial precedes the single visible answer lane", async () => {
    const { api } = makeFakeApi({
      streamingMode: "partial",
      sessionMessages: transcriptRows,
      runImpl: async (turn) => {
        // A reasoning-prefixed partial the adapter drops (never sets a lane's
        // visible-answer flag).
        streamAnswerLane(turn, "Reasoning:\nthinking hard about the request");
        // The boundary the old inbound counter reset on — it is what let the
        // real answer inflate the raw count to 2.
        openNextAnswerLane(turn);
        // Exactly ONE lane streams visible answer text.
        streamAnswerLane(turn, "the real answer");
        // The benign `[answer, status]` shape: same finalize-then-independent
        // routing as the glitch, but only one lane streamed, so it renders
        // correctly and must not be keyframed.
        await turn.delivery.deliver({ text: "the real answer" }, { kind: "final" });
        await turn.delivery.deliver({ text: "plugin status: trace on" }, { kind: "final" });
      },
    });
    const { transport, keyframes } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(keyframes).toHaveLength(0);
  });

  // Finding 2: the client requires the anchor `turn_settled` BEFORE the keyframe
  // for the settling turn; if the settle frame failed but the keyframe still
  // went out, the settling turn's own user row is duplicated. An otherwise
  // glitch-shaped turn whose anchor settle fails must skip the keyframe.
  it("does NOT emit a keyframe when the anchor turn_settled failed to deliver", async () => {
    const glitchTurn = { type: "user_message" as const, text: "do the thing", id: "turn-anchor-fail" };
    const { api } = makeFakeApi({
      streamingMode: "partial",
      sessionMessages: transcriptRows,
      runImpl: twoStreamedLanesThenTwoFinals,
    });
    const { transport, keyframes, settles } = makeFakeTransport({
      failSettleFor: ["turn-anchor-fail"],
    });

    await handleInboundMessage(api, transport, "peer-1", glitchTurn);

    // The settle frame was attempted (and reported failed); the keyframe is
    // skipped so it cannot overtake the missing settle.
    expect(settles).toEqual(["ok"]);
    expect(keyframes).toHaveLength(0);
  });
});

/**
 * #87 — a provider-rejected turn must settle `error`, not `ok`.
 *
 * Core does NOT throw when the provider rejects: it absorbs the failure and
 * returns its terminal message as an ordinary reply payload carrying
 * `isError: true`. The turn therefore resolves cleanly and — before this fix —
 * settled `ok`, so the widget rendered the user's bubble as `completed` (a ✓)
 * with no retry affordance, for a turn that produced no answer at all.
 *
 * Measured against a real gateway + real plugin + a provider stubbed to reject
 * (openclaw 2026.6.10): the terminal payload reaches this seam as
 * `kind:"final"`, `isError:true`, with no notice flags, ~3ms before the settle.
 *
 * The outcome keys off THE ANSWER, not off `isError` alone — core also flags a
 * NON-terminal tool-error warning, and only ever does so on a turn that DID
 * produce a user-facing reply. Keying off `isError` alone would flip those
 * successful turns to `failed`.
 */
describe("handleInboundMessage — #87 turn outcome", () => {
  const ordinary = { type: "user_message" as const, text: "hello there" };

  it("settles `error` when the only final payload is a terminal error", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver(
          { text: "⚠️ Something went wrong while processing your request.", isError: true },
          { kind: "final" },
        );
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });

  it("settles `ok` for an ordinary answered turn", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "here is your answer" }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("settles `ok` when a non-terminal tool warning trails a delivered answer", async () => {
    // The regression this fix must NOT introduce: core marks a tool-error
    // warning `isError` ONLY when the turn also produced a user-facing reply.
    // Keying the outcome off `isError` alone would report this success as a
    // failure and hand the user a retry for a turn that already answered.
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "here is your answer" }, { kind: "final" });
        await turn.delivery.deliver(
          { text: "⚠️ a tool failed but the turn recovered", isError: true },
          { kind: "final" },
        );
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("settles `error` when only core's own notices accompany the terminal error", async () => {
    // Status/fallback/compaction notices are core chatter, never the answer —
    // they must not satisfy "this turn answered".
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver(
          { text: "↩️ switched model", isFallbackNotice: true },
          { kind: "final" },
        );
        await turn.delivery.deliver({ text: "🧹 Compacting context...", isCompactionNotice: true }, { kind: "final" });
        await turn.delivery.deliver({ text: "⚠️ Request failed.", isError: true }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });

  it("does not count a TOOL payload as the turn's answer", async () => {
    // Tool payloads are tool chatter, never the turn's answer. If they counted,
    // a turn that emitted tool progress and THEN failed terminally would settle
    // `ok` — #87 all over again for that shape. (Block payloads DO count; see
    // the block-streaming case below.)
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "🛠️ read_file" }, { kind: "tool" });
        await turn.delivery.deliver({ text: "⚠️ Request failed.", isError: true }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });

  it("settles `ok` for a silent completion (tool-only turn, no final payload)", async () => {
    // A turn that answers nothing but never errored is a legitimate clean
    // completion — it must not be reported as a failure.
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("still settles `error` when the turn throws (pre-existing path)", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async () => {
        throw new Error("dispatch blew up");
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });

  it("does not settle a control-lane turn at all", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "⚠️ failed", isError: true }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", { type: "user_message", text: "/stop" }, "default", {
      controlLane: true,
    });

    expect(settles).toEqual([]);
  });
});

/**
 * #99 — every accepted send must reach a terminal receipt state.
 *
 * P1-8b layer (b) merges N buffered user messages into ONE turn keyed by the
 * LAST id. Each of those messages was ACKed and holds its own P0-4 receipt, and
 * the client's `promoteAnchor` matches strictly on `turnId === wireId`, so a
 * single settle frame stranded the other N-1 receipts at `accepted` forever.
 * The turn now settles every member wireId with the same outcome.
 *
 * NOTE (test trap): `handleInboundMessage` swallows its own errors — a failed
 * `expect` inside a transport/dispatcher fake would be caught and logged, and
 * the test would pass vacuously. Every assertion below runs AFTER the awaited
 * turn, over recorded observations.
 */
describe("handleInboundMessage — #99 coalesced-group settlement", () => {
  /** What the coalescer hands down for the burst A, B, C (anchor = id-3). */
  const coalescedTurn = {
    type: "user_message" as const,
    text: "a\n\nb\n\nc",
    id: "id-3",
    coalescedIds: ["id-1", "id-2", "id-3"],
  };

  it("settles EVERY member wireId with the turn's outcome, each once, anchor last", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "here is your answer" }, { kind: "final" });
      },
    });
    const { transport, settleFrames } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", coalescedTurn);

    // Order is load-bearing: the anchor is the id the drafts and `agent_message`
    // frames carry, so it is what ends the turn for the UI and must go last.
    expect(settleFrames).toEqual([
      { turnId: "id-1", outcome: "ok" },
      { turnId: "id-2", outcome: "ok" },
      { turnId: "id-3", outcome: "ok" },
    ]);
  });

  it("settles every member `error` when the turn fails (no member is left `ok`)", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver(
          { text: "⚠️ Something went wrong while processing your request.", isError: true },
          { kind: "final" },
        );
      },
    });
    const { transport, settleFrames } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", coalescedTurn);

    // The group ran as one turn, so it fails as one: every receipt resolves to
    // `failed{turn-failed}`, none is left waiting.
    expect(settleFrames).toEqual([
      { turnId: "id-1", outcome: "error" },
      { turnId: "id-2", outcome: "error" },
      { turnId: "id-3", outcome: "error" },
    ]);
  });

  it("settles each member exactly once when the member list repeats the anchor", async () => {
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const { transport, settleFrames } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message",
      text: "a\n\nb",
      id: "id-2",
      // The anchor appears mid-list AND a member repeats: a duplicate settle is
      // harmless on the client but is noise on the wire, and the anchor must
      // still be emitted last.
      coalescedIds: ["id-1", "id-2", "id-1"],
    });

    expect(settleFrames).toEqual([
      { turnId: "id-1", outcome: "ok" },
      { turnId: "id-2", outcome: "ok" },
    ]);
  });

  it("emits EXACTLY ONE settle for a non-coalesced turn (no member list)", async () => {
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const { transport, settleFrames } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message",
      text: "hello there",
      id: "solo-1",
    });

    expect(settleFrames).toEqual([{ turnId: "solo-1", outcome: "ok" }]);
  });

  it("emits NO settle for an admission-denied coalesced turn", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async () => {},
      channelConfig: { dmSecurity: "allowlist", allowFrom: ["alice"] },
    });
    const { transport, settleFrames } = makeFakeTransport();

    await handleInboundMessage(api, transport, "mallory", coalescedTurn);

    // `settlementEligible` gates the whole group, not just the anchor: no agent
    // turn was admitted, so nothing settles (ingress owns those receipts).
    expect(settleFrames).toEqual([]);
  });

  /**
   * The settle loop reads `coalescedIds` off the turn message, and that message
   * used to be reachable from the wire verbatim (the decode path casts instead
   * of validating). Layer (a) strips the field at ingress; these pin layer (b),
   * the read-site guard, so a path that ever forgets to strip degrades to "only
   * the anchor settles" instead of stranding the whole turn.
   *
   * The failure this prevents is severe and silent: the member loop runs BEFORE
   * the anchor is pushed, so a throw here emits ZERO settle frames, the
   * dispatcher swallows the rejection, and every receipt in the turn — anchor
   * included — is stuck at `accepted` with the draft never finalized.
   */
  describe("hostile `coalescedIds` still settles the anchor", () => {
    const hostile: Array<[string, unknown]> = [
      ["a number (not iterable — would throw)", 5],
      ["a string (would iterate as characters)", "abc"],
      ["null", null],
      ["an object", { length: 2 }],
      ["non-string members", [{}, 7]],
      ["empty-string members", ["", ""]],
    ];

    for (const [label, value] of hostile) {
      it(`settles exactly once for ${label}`, async () => {
        const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
        const { transport, settleFrames } = makeFakeTransport();

        await handleInboundMessage(api, transport, "peer-1", {
          type: "user_message",
          text: "hi",
          id: "anchor-1",
          coalescedIds: value as never,
        });

        expect(settleFrames).toEqual([{ turnId: "anchor-1", outcome: "ok" }]);
      });
    }

    it("drops an over-long member id and caps a flooded member list", async () => {
      const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
      const { transport, settleFrames } = makeFakeTransport();
      const overLong = "x".repeat(MAX_COALESCED_MEMBER_ID_LENGTH + 1);

      await handleInboundMessage(api, transport, "peer-1", {
        type: "user_message",
        text: "hi",
        id: "anchor-1",
        // A frame can hold far more ids than a real group ever has while
        // staying inside the payload/session byte budgets; each one costs a
        // seal+publish in the turn's `finally`.
        coalescedIds: [
          overLong,
          ...Array.from({ length: DEFAULT_BUSY_TURN_LIMITS.maxMessagesPerSession * 50 }, (_, i) => `flood-${i}`),
        ],
      });

      // Capped at the bound the honest producer obeys, plus the anchor.
      expect(settleFrames).toHaveLength(DEFAULT_BUSY_TURN_LIMITS.maxMessagesPerSession + 1);
      expect(settleFrames.map((f) => f.turnId)).not.toContain(overLong);
      expect(settleFrames.at(-1)).toEqual({ turnId: "anchor-1", outcome: "ok" });
    });

    it("a NORMALIZED wire frame settles only its own id — a peer cannot name others", async () => {
      // The end-to-end property of layer (a): what a peer actually sends is
      // `{…, coalescedIds:[victim ids]}`; ingress rebuilds the frame from its
      // known wire fields, and the turn then speaks only for the sender's own
      // wireId. Without the strip, this peer would make the agent settle two
      // receipts belonging to messages it never sent.
      const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
      const { transport, settleFrames } = makeFakeTransport();
      const wireFrame = {
        type: "user_message" as const,
        text: "hi",
        id: "mine-1",
        coalescedIds: ["victim-1", "victim-2"],
      };

      await handleInboundMessage(
        api,
        transport,
        "peer-1",
        normalizeInboundUserMessage(wireFrame),
      );

      expect(settleFrames).toEqual([{ turnId: "mine-1", outcome: "ok" }]);
    });
  });

  it("a THROWING member send cannot take the group — or the anchor — down", async () => {
    // `transport` is an interface; the shipped channel returns a boolean, but a
    // throwing implementation here would skip every id still queued. The anchor
    // is emitted LAST, so it is the one that would be lost — and the throw would
    // escape from a `finally` into the dispatcher's `.catch(() => {})`, leaving
    // the whole turn unsettled and the draft hanging.
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const { transport, settleFrames } = makeFakeTransport({ throwSettleFor: ["id-1"] });
    const warn = vi.fn();
    (api as unknown as { logger: { warn: (m: string) => void } }).logger.warn = warn;

    await expect(
      handleInboundMessage(api, transport, "peer-1", coalescedTurn),
    ).resolves.toBeUndefined();

    expect(settleFrames.map((f) => f.turnId)).toEqual(["id-1", "id-2", "id-3"]);
    // Treated exactly like a `false` return: same warn shape, then keep going.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("turn_settled was not delivered");
    // #123: peer-controlled ids are quoted in log records. The id is still
    // verbatim inside the quotes, so scraping for it keeps working.
    expect(warn.mock.calls[0]?.[0]).toContain('turn="id-1"');
  });

  it("warns per undelivered member and still settles the rest", async () => {
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const { transport, settleFrames } = makeFakeTransport({ failSettleFor: ["id-2"] });
    const warn = vi.fn();
    (api as unknown as { logger: { warn: (m: string) => void } }).logger.warn = warn;

    await handleInboundMessage(api, transport, "peer-1", coalescedTurn);

    // A member whose frame does not ship must not abort the group — the anchor
    // and the other members still settle — and it warns in the same shape the
    // anchor always has.
    expect(settleFrames.map((f) => f.turnId)).toEqual(["id-1", "id-2", "id-3"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("turn_settled was not delivered");
    expect(warn.mock.calls[0]?.[0]).toContain('turn="id-2"');
  });

  /**
   * #123 — a peer must not be able to write into the log stream.
   *
   * `turnId` is just the browser's `message.id` and `wsKey` is the peer key, so
   * before this both were raw-interpolated into warn records and a newline
   * forged a second, fully-formed line. These assert on the EMITTED RECORD:
   * one line out, with the injected text visibly escaped inside it. A test that
   * only checked "did not throw" would have passed on the vulnerable code.
   */
  it("a newline-bearing turn id cannot forge a second log record", async () => {
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const forgedId = 'evil-1\nwebchannel: turn_settled was not delivered for peer="admin" turn="x"';
    const { transport } = makeFakeTransport({ failSettleFor: [forgedId] });
    const warn = vi.fn();
    (api as unknown as { logger: { warn: (m: string) => void } }).logger.warn = warn;

    await handleInboundMessage(api, transport, "peer-1", {
      type: "user_message",
      text: "hi",
      id: forgedId,
    });

    const settleWarnings = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((text) => text.includes("turn_settled was not delivered"));
    expect(settleWarnings).toHaveLength(1);
    const record = settleWarnings[0]!;
    // ONE record. This is the whole property.
    expect(record.split("\n")).toHaveLength(1);
    expect(record).not.toContain("\n");
    // The injected payload survives as inert, escaped evidence — not as syntax.
    expect(record).toContain("\\n");
    expect(record).toContain("evil-1");
  });

  it("a newline-bearing peer key cannot forge a second log record", async () => {
    const { api } = makeFakeApi({ streamingMode: "off", runImpl: async () => {} });
    const { transport } = makeFakeTransport({ failSettleFor: ["id-1"] });
    const warn = vi.fn();
    (api as unknown as { logger: { warn: (m: string) => void } }).logger.warn = warn;
    const forgedPeer = "peer-1\nwebchannel: inbound denied for peer admin";

    await handleInboundMessage(api, transport, forgedPeer, {
      type: "user_message",
      text: "hi",
      id: "id-1",
    });

    const settleWarnings = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((text) => text.includes("turn_settled was not delivered"));
    expect(settleWarnings).toHaveLength(1);
    const record = settleWarnings[0]!;
    expect(record.split("\n")).toHaveLength(1);
    expect(record).not.toContain("\n");
    expect(record).toContain("\\n");
    expect(record).toContain("peer-1");
  });
});

/**
 * #87 follow-up — trust core's own terminal-vs-warning classification.
 *
 * `isError` marks BOTH a terminal failure and a merely non-terminal tool-error
 * warning. Inferring the difference from "did an answer arrive" is not enough:
 * a warning can ride a turn whose answer never reached this seam as a `final`,
 * and a terminal error can precede partial answer text. Core distinguishes the
 * two and exposes it through `isReplyPayloadNonTerminalToolErrorWarning`.
 */
describe("handleInboundMessage — #87 terminal vs non-terminal error", () => {
  const ordinary = { type: "user_message" as const, text: "hello there" };

  it("settles `ok` for a marked tool warning when NO answer reached this seam", async () => {
    // The marker is what carries this case: the turn answered on a lane this
    // seam never sees (a message-tool / source-reply delivery), so there is no
    // block or final answer payload to infer from. Without core's marker the
    // trailing warning reads as a terminal failure and the widget would offer a
    // retry for a possibly mutating turn that succeeded.
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver(
          { text: `⚠️ read_file failed ${WARNING_SENTINEL}`, isError: true },
          { kind: "final" },
        );
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("settles `error` when a terminal error precedes partial answer text", async () => {
    // Core builds the payload array as [terminal error, …, answers…], so an
    // unmarked error BEFORE any answer is a real failure — the trailing text is
    // partial output, not a completed answer.
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "⚠️ The model errored.", isError: true }, { kind: "final" });
        await turn.delivery.deliver({ text: "here is half an answer" }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });

  it("settles `ok` for an unmarked error AFTER an answer (marker-unreadable fail-safe)", async () => {
    // Ordering fail-safe: if plugin and host ever resolve different copies of
    // the openclaw module the WeakMap marker silently reads false. An error
    // arriving after a delivered answer must still be treated as a warning,
    // so that break degrades to the old behavior instead of failing successes.
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "here is your answer" }, { kind: "final" });
        await turn.delivery.deliver({ text: "⚠️ a tool failed (marker unreadable)", isError: true }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });
});

/**
 * #87 follow-up 2 — block-streamed answers.
 *
 * Core can deliver the assistant's answer as `kind:"block"` payloads
 * (dispatch-*.js:1885 routes them through this same seam). At 2026.6.10 core
 * marks a non-terminal tool warning ONLY for middleware errors
 * (payloads-*.js:77), so an ordinary tool warning arrives `isError` with no
 * marker. If blocks did not count as answer output, that warning would be the
 * only `final` on an answered turn and would read as a terminal failure —
 * reporting a success as failed and offering a retry for a turn that may
 * already have mutated state.
 */
describe("handleInboundMessage — #87 block-streamed answers", () => {
  const ordinary = { type: "user_message" as const, text: "hello there" };

  it("settles `ok` when the answer streamed as blocks and an UNMARKED tool warning trails it", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "First half of the answer." }, { kind: "block" });
        await turn.delivery.deliver({ text: "Second half of the answer." }, { kind: "block" });
        // No marker: core only marks middleware tool errors.
        await turn.delivery.deliver({ text: "⚠️ write_file failed", isError: true }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("still settles `error` when a terminal error precedes any block output", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "⚠️ The model errored.", isError: true }, { kind: "final" });
        await turn.delivery.deliver({ text: "late block output" }, { kind: "block" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });

  it("does not let a block-level error settle the turn", async () => {
    // A block-level `isError` is interim streamed content, not a verdict.
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "⚠️ interim trouble", isError: true }, { kind: "block" });
        await turn.delivery.deliver({ text: "the answer arrived anyway" }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });
});

/**
 * #87 follow-up 3 — core's lifecycle verdict is authoritative.
 *
 * The payload heuristics cannot separate "answered, then a failed mutating
 * tool" (a success) from "answered, then timed out" (a failure): both arrive as
 * an answer followed by an unmarked `isError` final. Core knows which it was
 * and publishes it as the run's lifecycle terminal, so when a verdict exists it
 * decides the outcome and the heuristics are not consulted.
 */
describe("handleInboundMessage — #87 lifecycle verdict", () => {
  const ordinary = { type: "user_message" as const, text: "hello there" };
  const RUN = "run-abc";

  /** Drives a turn that starts run `RUN`, runs `body`, then emits `phase`. */
  function turnWithVerdict(
    phase: "end" | "error" | undefined,
    body: (turn: AssembledTurnLike) => Promise<void>,
  ) {
    const holder: { emit?: (e: LifecycleEvent) => void } = {};
    const made = makeFakeApi({
      streamingMode: "off",
      withAgentEvents: true,
      runImpl: async (turn) => {
        turn.replyOptions?.onAgentRunStart?.(RUN);
        await body(turn);
        if (phase) {
          holder.emit?.({ stream: "lifecycle", runId: RUN, data: { phase } });
        }
      },
    });
    holder.emit = made.emitLifecycle;
    startAgentLifecycleSubscription(made.api);
    return made;
  }

  it("settles `error` on a lifecycle error even though an answer was delivered", async () => {
    // The timeout shape: core appends its terminal error after retained answer
    // payloads. The heuristic alone reads this as a success.
    const { api } = turnWithVerdict("error", async (turn) => {
      await turn.delivery.deliver({ text: "partial answer text" }, { kind: "final" });
      await turn.delivery.deliver({ text: "⚠️ timed out", isError: true }, { kind: "final" });
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });

  it("settles `ok` on a lifecycle end even though an unmarked isError final arrived", async () => {
    // The failed-mutating-tool shape: the turn answered and core warned about a
    // failed write. Reading that warning as terminal would fail a successful
    // turn and offer a retry that could repeat the write.
    const { api } = turnWithVerdict("end", async (turn) => {
      await turn.delivery.deliver({ text: "done — I updated the file" }, { kind: "final" });
      await turn.delivery.deliver({ text: "⚠️ write_file failed", isError: true }, { kind: "final" });
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("settles `ok` on a lifecycle end for a turn with no answer at all", async () => {
    const { api } = turnWithVerdict("end", async (turn) => {
      await turn.delivery.deliver({ text: "⚠️ something failed", isError: true }, { kind: "final" });
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("takes the LAST terminal for a run (model fallback emits several attempts)", async () => {
    const holder: { emit?: (e: LifecycleEvent) => void } = {};
    const made = makeFakeApi({
      streamingMode: "off",
      withAgentEvents: true,
      runImpl: async (turn) => {
        turn.replyOptions?.onAgentRunStart?.(RUN);
        holder.emit?.({ stream: "lifecycle", runId: RUN, data: { phase: "error" } });
        // A later attempt on the same run succeeds.
        holder.emit?.({ stream: "lifecycle", runId: RUN, data: { phase: "end" } });
        await turn.delivery.deliver({ text: "the answer" }, { kind: "final" });
      },
    });
    holder.emit = made.emitLifecycle;
    startAgentLifecycleSubscription(made.api);
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("ignores a terminal belonging to a DIFFERENT run", async () => {
    // The event stream is process-global; concurrent turns must not read each
    // other's verdicts.
    const holder: { emit?: (e: LifecycleEvent) => void } = {};
    const made = makeFakeApi({
      streamingMode: "off",
      withAgentEvents: true,
      runImpl: async (turn) => {
        turn.replyOptions?.onAgentRunStart?.(RUN);
        holder.emit?.({ stream: "lifecycle", runId: "some-other-run", data: { phase: "error" } });
        await turn.delivery.deliver({ text: "the answer" }, { kind: "final" });
      },
    });
    holder.emit = made.emitLifecycle;
    startAgentLifecycleSubscription(made.api);
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["ok"]);
  });

  it("ignores non-lifecycle streams and non-terminal phases", async () => {
    const holder: { emit?: (e: LifecycleEvent) => void } = {};
    const made = makeFakeApi({
      streamingMode: "off",
      withAgentEvents: true,
      runImpl: async (turn) => {
        turn.replyOptions?.onAgentRunStart?.(RUN);
        // A terminal-looking phase on a NON-lifecycle stream must be ignored;
        // if it leaked through it would read as a success and mask the failure.
        holder.emit?.({ stream: "assistant", runId: RUN, data: { phase: "end" } });
        // `finishing` is not terminal — it carries an error even on attempts
        // that later succeed.
        holder.emit?.({ stream: "lifecycle", runId: RUN, data: { phase: "finishing", error: "x" } });
        await turn.delivery.deliver({ text: "⚠️ failed", isError: true }, { kind: "final" });
      },
    });
    holder.emit = made.emitLifecycle;
    startAgentLifecycleSubscription(made.api);
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);

    // No terminal ⇒ the payload fallback decides, and it reads this as a failure.
    expect(settles).toEqual(["error"]);
  });

  it("falls back to the payload reading when the host exposes no events surface", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        await turn.delivery.deliver({ text: "⚠️ Request failed.", isError: true }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });
});

/**
 * #89 boundary — a user abort must not be reported as a turn failure.
 *
 * Core stamps `aborted` on the run's lifecycle terminal, and depending on how
 * the abort surfaces the phase can be `end` or `error`. Measured live for a
 * /stop during a provider call at 2026.6.10: `phase:"end"` with
 * `aborted:true, stopReason:"aborted"`. The `error` form must not be read as a
 * failure either — that would settle a deliberately cancelled turn as
 * `failed{reason:"turn-failed", retryable:true}` and offer to re-run work the
 * user just stopped. `cancelled` is the correct outcome; it needs a wire value
 * that does not exist yet (#89), so an aborted run keeps the pre-existing `ok`.
 */
describe("handleInboundMessage — #89 aborted runs are not failures", () => {
  const ordinary = { type: "user_message" as const, text: "hello there" };
  const RUN = "run-aborted";

  function abortedTurn(phase: "end" | "error") {
    const holder: { emit?: (e: LifecycleEvent) => void } = {};
    const made = makeFakeApi({
      streamingMode: "off",
      withAgentEvents: true,
      runImpl: async (turn) => {
        turn.replyOptions?.onAgentRunStart?.(RUN);
        holder.emit?.({
          stream: "lifecycle",
          runId: RUN,
          data: { phase, aborted: true, stopReason: "aborted" },
        });
      },
    });
    holder.emit = made.emitLifecycle;
    startAgentLifecycleSubscription(made.api);
    return made;
  }

  it.each(["end", "error"] as const)(
    "settles `ok` for an aborted run (phase=%s), never a retryable failure",
    async (phase) => {
      const { api } = abortedTurn(phase);
      const { transport, settles } = makeFakeTransport();

      await handleInboundMessage(api, transport, "peer-1", ordinary);

      expect(settles).toEqual(["ok"]);
    },
  );

  it("still settles `error` for a NON-aborted lifecycle error", async () => {
    const holder: { emit?: (e: LifecycleEvent) => void } = {};
    const made = makeFakeApi({
      streamingMode: "off",
      withAgentEvents: true,
      runImpl: async (turn) => {
        turn.replyOptions?.onAgentRunStart?.(RUN);
        holder.emit?.({ stream: "lifecycle", runId: RUN, data: { phase: "error", aborted: false } });
      },
    });
    holder.emit = made.emitLifecycle;
    startAgentLifecycleSubscription(made.api);
    const { transport, settles } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);

    expect(settles).toEqual(["error"]);
  });
});

/**
 * #87 — the lifecycle subscription's lifetime.
 *
 * `onAgentEvent` registers on a PROCESS-GLOBAL listener set, while a plugin
 * reload hands out a fresh `runtime.events` facade. Subscribing per facade
 * would stack one listener per reload for the life of the process, so the
 * subscription keeps its unsubscribe handle: re-starting replaces, and teardown
 * releases.
 */
describe("agent lifecycle subscription lifetime", () => {
  function makeEventsHost() {
    const listeners: LifecycleListener[] = [];
    let unsubscribes = 0;
    const api = {
      runtime: {
        events: {
          onAgentEvent: (l: LifecycleListener) => {
            listeners.push(l);
            return () => {
              unsubscribes += 1;
              const i = listeners.indexOf(l);
              if (i >= 0) listeners.splice(i, 1);
            };
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    return { api, listeners, count: () => listeners.length, unsubscribes: () => unsubscribes };
  }

  it("replaces rather than stacks when re-started (a reload)", () => {
    const host = makeEventsHost();
    startAgentLifecycleSubscription(host.api);
    startAgentLifecycleSubscription(host.api);
    startAgentLifecycleSubscription(host.api);

    expect(host.count()).toBe(1);
    expect(host.unsubscribes()).toBe(2);
    stopAgentLifecycleSubscription();
    expect(host.count()).toBe(0);
  });

  it("replaces across a FRESH events facade, which a reload hands out", () => {
    // The previous guard keyed on facade identity, so a new facade defeated it.
    const first = makeEventsHost();
    startAgentLifecycleSubscription(first.api);
    const second = makeEventsHost();
    startAgentLifecycleSubscription(second.api);

    expect(first.count()).toBe(0);
    expect(second.count()).toBe(1);
    stopAgentLifecycleSubscription();
    expect(second.count()).toBe(0);
  });

  it("is a no-op on a host with no events surface", () => {
    const host = makeEventsHost();
    startAgentLifecycleSubscription(host.api);
    const api = { runtime: {} } as unknown as OpenClawPluginApi;
    expect(() => startAgentLifecycleSubscription(api)).not.toThrow();
    expect(host.count()).toBe(1);
    expect(host.unsubscribes()).toBe(0);
    expect(() => stopAgentLifecycleSubscription()).not.toThrow();
    expect(host.count()).toBe(0);
  });
});

/**
 * #93 — the approval-origin lease window (plan §4.3 / §6.2).
 *
 * The lease must exist for EXACTLY the window in which the agent run can emit a
 * tool approval: from `onAgentRunStart` to the outer `finally`. Both boundaries
 * are safety boundaries, in opposite directions — claiming before the run starts
 * lets a denied or failed-setup turn absorb someone else's approval, and failing
 * to release on any exit path leaves a claim that poisons the tuple for every
 * later origin on the same key.
 *
 * The production registry runs on `Date.now` and compares request times
 * STRICTLY, so these tests plant their own registry with an injected clock in
 * the versioned global slot. The getter validates structurally, which is what
 * makes that possible — and `handleInboundMessage` re-reads the slot per turn,
 * which is what makes it take effect.
 */
describe("handleInboundMessage — approval-origin lease", () => {
  const slots = globalThis as unknown as Record<symbol, unknown>;
  const ordinary = { type: "user_message" as const, text: "please write the file" };

  let saved: unknown;
  let nowMs: number;
  let registry: ApprovalOriginLeaseRegistry;

  beforeEach(() => {
    saved = slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY];
    nowMs = 1_000;
    registry = new ApprovalOriginLeaseRegistry({ now: () => nowMs });
    slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY] = registry;
  });

  afterEach(() => {
    if (saved === undefined) delete slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY];
    else slots[APPROVAL_ORIGIN_REGISTRY_GLOBAL_KEY] = saved;
  });

  /**
   * Ask the registry exactly what the approval resolver will ask it, deriving
   * the session key through the SAME helper the inbound path uses so the key is
   * byte-identical rather than hand-copied.
   */
  function resolveOrigin(
    api: OpenClawPluginApi,
    requestCreatedAtMs: number,
    peerId = "peer-1",
    accountId = "default",
  ): ReturnType<ApprovalOriginLeaseRegistry["resolve"]> {
    return registry.resolve({
      rawAccountId: accountId,
      sessionKey: resolveWebchannelSessionRoute(
        api,
        accountId,
        peerId,
        TEST_SERVING_TENANT,
      ).sessionKey,
      requestCreatedAtMs,
    });
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("claims nothing until onAgentRunStart, then resolves the exact peer", async () => {
    // NOTE: observations are recorded and asserted AFTER the turn.
    // `handleInboundMessage` catches everything the dispatcher throws, so an
    // `expect` inside `runImpl` would be swallowed and the test would pass
    // whatever happened.
    let beforeStart: unknown;
    let afterStart: unknown;
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        // Dispatched, route resolved, handle created — but the run has not
        // started, so a request arriving now belongs to nobody.
        nowMs = 1_030;
        beforeStart = resolveOrigin(made.api, 1_020);

        nowMs = 1_040;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        nowMs = 1_060;
        afterStart = resolveOrigin(made.api, 1_050);
      },
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);

    expect(beforeStart).toEqual({ kind: "no_match" });
    expect(afterStart).toEqual({ kind: "resolved", peerId: "peer-1" });
  });

  it("is observable to an approval lookup while the run is paused mid-turn", async () => {
    // The shape the real bug takes: the approval arrives from OUTSIDE this
    // turn's call stack while the run is still awaiting a tool decision.
    const started = deferred();
    const finish = deferred();
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        started.resolve();
        await finish.promise;
      },
    });
    const { transport } = makeFakeTransport();

    const turnPromise = handleInboundMessage(made.api, transport, "peer-1", ordinary);
    await started.promise;

    nowMs = 1_060;
    expect(resolveOrigin(made.api, 1_050)).toEqual({
      kind: "resolved",
      peerId: "peer-1",
    });

    finish.resolve();
    await turnPromise;
    expect(resolveOrigin(made.api, 1_050)).toEqual({ kind: "no_match" });
  });

  it("releases on a normal completion", async () => {
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        await turn.delivery.deliver({ text: "done" }, { kind: "final" });
      },
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);
    nowMs = 1_060;
    expect(resolveOrigin(made.api, 1_050)).toEqual({ kind: "no_match" });
  });

  it("releases when the turn throws", async () => {
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        throw new Error("provider exploded");
      },
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);
    nowMs = 1_060;
    expect(resolveOrigin(made.api, 1_050)).toEqual({ kind: "no_match" });
  });

  it("releases on an abort (run resolves with no final delivered)", async () => {
    const made = makeFakeApi({
      streamingMode: "partial",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        turn.replyOptions?.onPartialReply?.({ text: "half an ans" });
        // Core aborted the run: it resolves without ever delivering a final.
      },
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);
    nowMs = 1_060;
    expect(resolveOrigin(made.api, 1_050)).toEqual({ kind: "no_match" });
  });

  it("claims once when onAgentRunStart repeats (model fallback)", async () => {
    let duringRun: unknown;
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        // A second start must neither add a claim nor re-capture the time: a
        // re-captured 1_100 would make the 1_050 request ineligible.
        nowMs = 1_100;
        turn.replyOptions?.onAgentRunStart?.("run-2");
        nowMs = 1_120;
        duringRun = resolveOrigin(made.api, 1_050);
      },
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", ordinary);

    expect(duringRun).toEqual({ kind: "resolved", peerId: "peer-1" });
    // One release ends the turn's ownership. A duplicated claim would have
    // survived it, because release removes exactly one claim by id.
    nowMs = 1_140;
    expect(resolveOrigin(made.api, 1_130)).toEqual({ kind: "no_match" });
  });

  it("claims on the control lane but is never selectable there", async () => {
    // A `/stop` whose fast-abort finds nothing to consume falls through to an
    // ordinary agent turn that can call tools and request approvals. It is
    // exempt from being ANSWERED with, not from being recorded — see the
    // cross-peer test below for what being unrecorded would cost.
    let callbackType: string | undefined;
    let duringRun: unknown;
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        // Record that the callback really is wired for this turn — otherwise
        // the assertion below would pass for the wrong reason.
        callbackType = typeof turn.replyOptions?.onAgentRunStart;
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        nowMs = 1_060;
        duringRun = resolveOrigin(made.api, 1_050);
      },
    });
    const { transport } = makeFakeTransport();

    await handleInboundMessage(made.api, transport, "peer-1", userMessage, "default", {
      controlLane: true,
    });

    expect(callbackType).toBe("function");
    expect(duringRun).toEqual({ kind: "no_match" });
    nowMs = 1_080;
    expect(resolveOrigin(made.api, 1_070)).toEqual({ kind: "no_match" });
  });

  it("a control-lane run over another peer's claim yields ambiguous, not that peer", async () => {
    // Two peers collapsed onto ONE session key by `session.identityLinks` — the
    // collision that makes a stored `lastTo` insufficient on its own.
    //
    // peer-2 holds an ordinary claim. peer-1's control-lane message falls
    // through to a real agent run and requests an approval. If that run were
    // unrecorded, the registry would find exactly one eligible claim — peer-2's
    // — and peer-1's permission prompt would land in peer-2's browser.
    const identityLinks = { "shared-user": ["peer-1", "peer-2"] };
    const started = deferred();
    const finish = deferred();
    const ordinaryRun = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-peer-2");
        started.resolve();
        await finish.promise;
      },
    });
    (ordinaryRun.api.config as { session?: unknown }).session = { identityLinks };
    const { transport: transport2 } = makeFakeTransport();
    const ordinaryTurn = handleInboundMessage(
      ordinaryRun.api,
      transport2,
      "peer-2",
      ordinary,
    );
    await started.promise;

    // Both peers now share one session key, so this is the same canonical tuple.
    const linkedKey = resolveWebchannelSessionRoute(
      ordinaryRun.api,
      "default",
      "peer-2",
      TEST_SERVING_TENANT,
    ).sessionKey;
    expect(
      resolveWebchannelSessionRoute(
        ordinaryRun.api,
        "default",
        "peer-1",
        TEST_SERVING_TENANT,
      ).sessionKey,
    ).toBe(linkedKey);

    let duringControlRun: unknown;
    const controlRun = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        // The fast-abort found nothing; this is a real agent run now.
        nowMs = 1_020;
        turn.replyOptions?.onAgentRunStart?.("run-peer-1");
        nowMs = 1_040;
        // peer-1's own request must NOT be answered with peer-2.
        duringControlRun = registry.resolve({
          rawAccountId: "default",
          sessionKey: linkedKey,
          requestCreatedAtMs: 1_030,
        });
      },
    });
    (controlRun.api.config as { session?: unknown }).session = { identityLinks };
    const { transport: transport1 } = makeFakeTransport();
    await handleInboundMessage(controlRun.api, transport1, "peer-1", userMessage, "default", {
      controlLane: true,
    });

    expect(duringControlRun).toEqual({ kind: "ambiguous" });

    finish.resolve();
    await ordinaryTurn;
  });

  it("rotates the epoch on teardown, refusing requests stamped before it", async () => {
    const started = deferred();
    const finish = deferred();
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        started.resolve();
        await finish.promise;
      },
    });
    const { transport } = makeFakeTransport();

    const turnPromise = handleInboundMessage(made.api, transport, "peer-1", ordinary);
    await started.promise;
    nowMs = 1_030;
    expect(resolveOrigin(made.api, 1_020)).toEqual({
      kind: "resolved",
      peerId: "peer-1",
    });

    stopAgentLifecycleSubscription(); // draws a new barrier at 1_030
    // The same request the registry answered a moment ago is now unattributable:
    // it predates the barrier, so a gateway replay of it cannot be delivered.
    expect(resolveOrigin(made.api, 1_020)).toEqual({ kind: "invalid_request_time" });

    finish.resolve();
    await turnPromise;
  });

  it("never resolves a handle left dormant across the rotation", async () => {
    let afterLateStart: unknown;
    const started = deferred();
    const finish = deferred();
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        // The handle exists (the route resolved) but the run has NOT started.
        started.resolve();
        await finish.promise;
        nowMs = 1_040;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        nowMs = 1_060;
        afterLateStart = resolveOrigin(made.api, 1_050);
      },
    });
    const { transport } = makeFakeTransport();

    const turnPromise = handleInboundMessage(made.api, transport, "peer-1", ordinary);
    await started.promise;
    nowMs = 1_030;
    stopAgentLifecycleSubscription(); // barrier 1_030, epoch rotated

    finish.resolve();
    await turnPromise;

    expect(afterLateStart).toEqual({ kind: "no_match" });
    nowMs = 1_080;
    expect(resolveOrigin(made.api, 1_070)).toEqual({ kind: "no_match" });
  });

  it("keeps a run active across the rotation, post-barrier only, released by its own finally", async () => {
    const started = deferred();
    const finish = deferred();
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        started.resolve();
        await finish.promise;
      },
    });
    const { transport } = makeFakeTransport();

    const turnPromise = handleInboundMessage(made.api, transport, "peer-1", ordinary);
    await started.promise;
    nowMs = 1_030;
    stopAgentLifecycleSubscription(); // barrier 1_030; the claim is NOT cleared

    nowMs = 1_060;
    // A replayed pre-barrier request stays refused …
    expect(resolveOrigin(made.api, 1_020)).toEqual({ kind: "invalid_request_time" });
    // … but a request this still-running run genuinely creates afterwards is
    // deliverable to its exact peer.
    expect(resolveOrigin(made.api, 1_050)).toEqual({
      kind: "resolved",
      peerId: "peer-1",
    });

    finish.resolve();
    await turnPromise;
    expect(resolveOrigin(made.api, 1_050)).toEqual({ kind: "no_match" });
  });

  it("lets a handler that was in flight at teardown settle and release itself", async () => {
    // The dispatcher fake holds the handler in flight across the rotation,
    // which is what the queue really does — dispose settles running handlers
    // rather than aborting them.
    const started = deferred();
    const finish = deferred();
    const made = makeFakeApi({
      streamingMode: "off",
      runImpl: async (turn) => {
        nowMs = 1_010;
        turn.replyOptions?.onAgentRunStart?.("run-1");
        started.resolve();
        await finish.promise;
        await turn.delivery.deliver({ text: "finished after teardown" }, { kind: "final" });
      },
    });
    const { transport, settles } = makeFakeTransport();

    const turnPromise = handleInboundMessage(made.api, transport, "peer-1", ordinary);
    await started.promise;
    nowMs = 1_030;
    stopAgentLifecycleSubscription();

    finish.resolve();
    await turnPromise;

    // The handler ran to completion after the rotation …
    expect(settles).toEqual(["ok"]);
    // … and its own `finally` released its own claim.
    nowMs = 1_080;
    expect(resolveOrigin(made.api, 1_070)).toEqual({ kind: "no_match" });
  });
});

/**
 * #123 — `logSafe` must be handed the RAW value, never `logSafe(String(err))`.
 *
 * Coercing outside the helper defeats its no-throw guarantee, and that
 * guarantee is load-bearing here: this warn site sits in the dispatch `catch`,
 * one statement above the error-fallback reply. `String(Object.create(null))`
 * throws `TypeError: Cannot convert object to primitive value`, so the old
 * form turned "a turn threw" into "a turn threw AND the user got no apology
 * and the turn never settled".
 */
describe("dispatch-failure logging cannot itself throw (#123)", () => {
  it("still delivers the error-fallback reply when String(err) would throw", async () => {
    const { api } = makeFakeApi({
      streamingMode: "off",
      runImpl: async () => {
        // A null-prototype object has no `toString`/`valueOf`, so ANY coercion
        // of it throws. Nothing stops a dependency throwing one.
        throw Object.create(null);
      },
    });
    const { transport, settleFrames } = makeFakeTransport();
    const sendText = vi.spyOn(transport, "sendText");
    const error = vi.fn();
    (api as unknown as { logger: { error: (m: string) => void } }).logger.error = error;

    await expect(
      handleInboundMessage(api, transport, "peer-1", {
        type: "user_message",
        text: "hi",
        id: "id-1",
      }),
    ).resolves.toBeUndefined();

    // The apology still ships — the logging statement did not eat the turn.
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[1]).toContain("something went wrong");
    // And the turn still settles, as `error`.
    expect(settleFrames).toEqual([{ turnId: "id-1", outcome: "error" }]);
    // The record is still emitted, and is still one line.
    const records = error.mock.calls
      .map((call) => String(call[0]))
      .filter((text) => text.includes("inbound dispatch failed"));
    expect(records).toHaveLength(1);
    expect(records[0]!.split("\n")).toHaveLength(1);
  });
});
