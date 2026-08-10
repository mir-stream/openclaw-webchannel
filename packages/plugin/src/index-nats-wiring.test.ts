import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

/**
 * Narrow source-contract guard for stable adapter wiring. Lifecycle behavior is
 * covered through the executable seams in nats-account-runtime.test.ts.
 *
 * The root entry is deliberately a thin re-export. The runtime is part of the
 * TypeScript closure and executable lifecycle tests cover ownership; the few
 * source checks below retain only older adapter-wiring contracts.
 *
 * IMPORTANT: these assertions pin WIRING SHAPE, not behavior — the behavior of
 * `resolveTypingEnabled` is covered by account-config's own tests. If a wiring
 * line legitimately changes, update the matching assertion DELIBERATELY (that is
 * the point of the guard: the change should be a conscious edit here, not a
 * silent drift). Keep the assertions few and load-bearing.
 */

/** Read the entry source exactly once; every contract asserts against this text. */
const RUNTIME_SOURCE = readFileSync(
  fileURLToPath(new URL("./nats-account-runtime.ts", import.meta.url)),
  "utf8",
);
const ENTRY_SOURCE = readFileSync(fileURLToPath(new URL("../index-nats.ts", import.meta.url)), "utf8");

describe("index-nats.ts entry boundary", () => {
  it("is a thin re-export with no lifecycle ownership", () => {
    expect(ENTRY_SOURCE.trim()).toBe(
      '/** Thin NATS entry: all account lifecycle ownership lives in the typed runtime. */\nexport { default } from "./src/nats-account-runtime.js";',
    );
  });
});

describe("index-nats.ts wiring contract — typing gate (P0-6)", () => {
  it("wires the channel typing gate via resolveTypingEnabled", () => {
    // `channel.setTypingEnabled( ... resolveTypingEnabled( ... ) ... )` — the
    // gate must be pushed onto the channel FROM the resolver, not hard-coded.
    expect(RUNTIME_SOURCE).toMatch(
      /channel\.setTypingEnabled\(\s*resolveTypingEnabled\(/,
    );
  });

  it("passes the resolved per-account `account` binding (no redundant re-resolution)", () => {
    // The resolver must be fed the already-resolved per-account config binding
    // (`account`, from the serving plan), NOT a fresh
    // resolveWebchannelAccountConfig(api.config, accountId) call at the site.
    expect(RUNTIME_SOURCE).toMatch(
      /channel\.setTypingEnabled\(\s*resolveTypingEnabled\(\s*account\s*\)\s*\)/,
    );
    // Guard the anti-pattern explicitly: no re-resolution inside the typing wire.
    expect(RUNTIME_SOURCE).not.toMatch(
      /setTypingEnabled\(\s*resolveTypingEnabled\(\s*resolveWebchannelAccountConfig\(/,
    );
  });
});

describe("index-nats.ts wiring contract — account-bound auth and startup", () => {
  it("validates the full credential document before verifier or connector use", () => {
    expect(RUNTIME_SOURCE).toContain("createMemoizedPersistedAccessor(");
    expect(RUNTIME_SOURCE).toContain("accountAuth = prepareAccountAuth(");
    expect(RUNTIME_SOURCE).not.toContain("resolveEffectiveAccountAuth");
    expect(RUNTIME_SOURCE).not.toContain("reportSharedAudiences");
    expect(RUNTIME_SOURCE).not.toContain("registerHopAudClaims");
    expect(
      RUNTIME_SOURCE.indexOf("credentialLoad = loadPersistedCredentialDocument("),
    ).toBeLessThan(
      RUNTIME_SOURCE.indexOf("accountAuth = prepareAccountAuth("),
    );
    expect(RUNTIME_SOURCE.indexOf("accountAuth = prepareAccountAuth(")).toBeLessThan(
      RUNTIME_SOURCE.indexOf("consumeCredentialSource(source, {"),
    );
    expect(RUNTIME_SOURCE).toMatch(
      /loadPersisted:\s*\(\)\s*=>\s*credentialLoad/,
    );
  });

  it("wires the prepared token-only verifier and strict PoP policy", () => {
    expect(RUNTIME_SOURCE).toMatch(/verifyIdentity:\s*accountAuth\.verifyIdentity/);
    expect(RUNTIME_SOURCE).toMatch(/requirePoP:\s*accountAuth\.requirePoP/);
  });

  it("confirms the register subscription before readiness or publication", () => {
    const gateB = RUNTIME_SOURCE.indexOf("accountAuth.warmJwks(signal)");
    const subscribe = RUNTIME_SOURCE.lastIndexOf("channel.subscribeRegister()");
    const flush = RUNTIME_SOURCE.lastIndexOf("transport.flush(attemptAbort.signal)");
    const readiness = RUNTIME_SOURCE.lastIndexOf(
      "const readiness = formatAccountReadiness({",
    );
    const publication = RUNTIME_SOURCE.lastIndexOf(
      "commitAccountPublication<AccountRuntime>",
    );
    expect(gateB).toBeGreaterThan(-1);
    expect(subscribe).toBeGreaterThan(gateB);
    expect(flush).toBeGreaterThan(subscribe);
    expect(readiness).toBeGreaterThan(flush);
    expect(publication).toBeGreaterThan(readiness);
    expect(RUNTIME_SOURCE).toContain("if (!published) return;");
  });
});

describe("nats-account-runtime.ts wiring contract — capacity diagnostics", () => {
  it("creates one diagnostics composition site and passes both callbacks by reference", () => {
    expect(RUNTIME_SOURCE.match(/const capacityDiagnostics = createCapacityDiagnostics\(\{/g)).toHaveLength(1);
    expect(RUNTIME_SOURCE).toMatch(
      /onCapacityWarning:\s*capacityDiagnostics\.onCapacityWarning/,
    );
    expect(RUNTIME_SOURCE).toMatch(
      /onCapacityReject:\s*capacityDiagnostics\.onCapacityReject/,
    );
    expect(RUNTIME_SOURCE).not.toMatch(
      /onCapacity(?:Warning|Reject):\s*capacityDiagnostics\.onCapacity(?:Warning|Reject)\(/,
    );
  });
});

describe("index-nats.ts wiring contract — command catalog (P0-3)", () => {
  it("serves load_commands from the MEMOIZED provider, not a per-request build", () => {
    // The handler must call the memoized provider (`catalogProvider()`), never
    // rebuild the catalog inline per request. Pin the provider is created and
    // that the handler serves from it.
    expect(RUNTIME_SOURCE).toMatch(/createCommandCatalogProvider\(\s*api\.config\s*\)/);
    expect(RUNTIME_SOURCE).toMatch(/channel\.sendCommands\(\s*peerId\s*,\s*catalogProvider\(\)\s*\)/);
    // Guard the anti-pattern: no bare per-request `buildCommandCatalog(api.config)`
    // inside the send. (buildCommandCatalog now lives behind the provider only.)
    expect(RUNTIME_SOURCE).not.toMatch(
      /sendCommands\(\s*peerId\s*,\s*buildCommandCatalog\(/,
    );
  });
});

describe("index-nats.ts wiring contract — ingress dedupe onFlush (P0-7a)", () => {
  it("wires the debouncer onFlush from the extracted createIngressOnFlush factory", () => {
    // The onFlush must be the tested factory, not an inlined closure (which could
    // silently drift — e.g. dispatch `items` instead of the deduped survivors, or
    // drop the accountId namespace). The typed factory is constructed once and
    // passed directly to the bounded debouncer.
    expect(RUNTIME_SOURCE).toMatch(/const onIngressFlush = createIngressOnFlush</);
    expect(RUNTIME_SOURCE).toMatch(/onFlush:\s*onIngressFlush/);
  });

  it("uses one module-scope process budget/outcome store and the bounded debouncer", () => {
    expect(RUNTIME_SOURCE.match(/new InboundRetentionBudget\(/g)).toHaveLength(1);
    expect(RUNTIME_SOURCE).toMatch(/const processInboundRetention/);
    expect(RUNTIME_SOURCE).toMatch(/const processIngressOutcomes/);
    expect(RUNTIME_SOURCE).toMatch(/createBoundedInboundDebouncer/);
    expect(RUNTIME_SOURCE).not.toMatch(/createInboundDebouncer</);
    expect(RUNTIME_SOURCE).not.toContain("createPersistentDedupe");
    expect(RUNTIME_SOURCE).toMatch(/isOverflowClaimed:/);
    expect(RUNTIME_SOURCE).toMatch(/processOverflowResolver\.hasActiveClaim/);
    expect(RUNTIME_SOURCE).toMatch(/isCancelledFallback:/);
    expect(RUNTIME_SOURCE).toMatch(/recoverCancelled/);
    expect(RUNTIME_SOURCE).toMatch(/onCancelledRecovered:/);
  });

  it("charges only the wire message, excluding the peer routing wrapper", () => {
    expect(RUNTIME_SOURCE).toMatch(
      /estimateRetainedMessageBytes,[\s\S]*?from "\.\/inbound-retention\.js"/,
    );
    expect(RUNTIME_SOURCE).toMatch(
      /measure:\s*\(item\)\s*=>\s*estimateRetainedMessageBytes\(item\.message\)/,
    );
    expect(RUNTIME_SOURCE).not.toMatch(
      /measure:\s*\(item\)\s*=>\s*estimateRetainedMessageBytes\(item\)(?!\.message)/,
    );
  });
});

describe("index-nats.ts wiring contract — ingress ack (P0-7b)", () => {
  it("wires sendAck into the onFlush factory, the debouncer onCancel, and the control-lane branch", () => {
    // The onFlush factory must be handed a sendAck so admitted (fresh + duplicate)
    // ids drain the client's replay ledger.
    expect(RUNTIME_SOURCE).toMatch(
      /sendAck:\s*\(peerId,\s*ids\)\s*=>\s*channel\.sendAck\(peerId,\s*ids\)/,
    );
    // The debouncer's onCancel must record+ack /stop-cancelled buffered items via
    // the tested helper (else a reconnect replays text the user aborted).
    expect(RUNTIME_SOURCE).toMatch(/onCancel:/);
    expect(RUNTIME_SOURCE).toMatch(/recordCancelledInboundItems\(/);
    // The control-lane branch bypasses the debouncer/onFlush, so it acks its own
    // id-carrying frame directly (else its ledger entry never drains).
    expect(RUNTIME_SOURCE).toMatch(
      /if\s*\(message\.id\s*&&\s*!channel\.sendAck\(peerId,\s*\[message\.id\]\)\)/,
    );
    expect(RUNTIME_SOURCE.match(/control-lane ack failed/g)).toHaveLength(1);
  });
});

describe("index-nats.ts wiring contract — approval decision account routing", () => {
  it("threads the runtime accountId into handleApprovalDecision", () => {
    expect(RUNTIME_SOURCE).toMatch(
      /setApprovalDecisionHandler\(\(peerId, id, decision\) =>[\s\S]*?handleApprovalDecision\(api\.config, id, decision, peerId, accountId\)/,
    );
  });
});

describe("index-nats.ts browser-route absence", () => {
  it("contains no gateway HTTP route registration or socket-upgrade wiring", () => {
    expect(RUNTIME_SOURCE).not.toContain("registerHttpRoute");
    expect(RUNTIME_SOURCE.toLowerCase()).not.toContain("upgrade route");
  });
});

describe("index-nats.ts account lifecycle ownership", () => {
  it("keeps registerFull synchronous and network-free", () => {
    // The guard clause still comes first, and account work is still delegated
    // wholesale to the coordinator. Registration-time hooks may sit between the
    // two — that is what `registerFull` is for — provided they stay synchronous.
    expect(RUNTIME_SOURCE).toMatch(/registerFull\(api\)\s*\{\s*if \(api\.registrationMode !== "full"\) return;/);
    expect(RUNTIME_SOURCE).toMatch(/accountCoordinator\.installFull\(api\)/);
    expect(RUNTIME_SOURCE).not.toMatch(/async\s+registerFull/);
    expect(RUNTIME_SOURCE).not.toMatch(/registerFull\(api\)[\s\S]{0,800}?\bawait\b/);
    expect(RUNTIME_SOURCE).not.toContain("accountsBuildStarted");

    // #87: the lifecycle subscription is registered HERE, once per plugin
    // generation, and must hand the host a cleanup. `onAgentEvent` registers on
    // a process-global listener set, so a subscription without teardown would
    // stack one listener per reload for the life of the process.
    expect(RUNTIME_SOURCE).toContain("startAgentLifecycleSubscription(api)");
    expect(RUNTIME_SOURCE).toMatch(
      /registerRuntimeLifecycle[\s\S]{0,400}?stopAgentLifecycleSubscription\(\)/,
    );
  });

  it("builds only the host-selected account and publishes after the flushed register subscription", () => {
    expect(RUNTIME_SOURCE).toContain("planWebchannelAccount(api.config, ctx.accountId");
    expect(RUNTIME_SOURCE).not.toMatch(/for\s*\(const plan of plans\)/);
    expect(
      RUNTIME_SOURCE.indexOf("credentialLoad = loadPersistedCredentialDocument("),
    ).toBeLessThan(
      RUNTIME_SOURCE.indexOf("accountAuth = prepareAccountAuth("),
    );
    expect(RUNTIME_SOURCE.indexOf("accountAuth = prepareAccountAuth(")).toBeLessThan(
      RUNTIME_SOURCE.indexOf("consumeCredentialSource(source, {"),
    );
    expect(RUNTIME_SOURCE.indexOf("accountAuth.warmJwks(signal)")).toBeLessThan(
      RUNTIME_SOURCE.lastIndexOf("channel.subscribeRegister()"),
    );
    expect(RUNTIME_SOURCE.lastIndexOf("channel.subscribeRegister()")).toBeLessThan(
      RUNTIME_SOURCE.lastIndexOf("transport.flush(attemptAbort.signal)"),
    );
    expect(
      RUNTIME_SOURCE.lastIndexOf("transport.flush(attemptAbort.signal)"),
    ).toBeLessThan(
      RUNTIME_SOURCE.lastIndexOf("commitAccountPublication<AccountRuntime>"),
    );
  });
});

describe("nats-account-runtime.ts wiring contract — #99 inbound frame normalization", () => {
  /**
   * Layer (a) of #99. `coalescedIds` is plugin-internal state meaning "these
   * receipts settle with this turn", and the decode path is a cast, not a
   * validation (`JSON.parse(...) as InboundWsMessage` in nats-channel.ts, whose
   * `user_message` case forwards the object with no field checks). So the ONLY
   * thing standing between a peer-supplied member list and the turn handler is
   * this normalization — and its position: it must run before the control lane,
   * before the ack, and before the debouncer.
   *
   * The handler body itself is untestable routing (it is closed over inside
   * `buildNatsAccount`); the normalization is a tested pure function
   * (`inbound-queue.test.ts`). This guard pins the wiring that connects them.
   */
  const HANDLER_START = RUNTIME_SOURCE.indexOf("channel.setMessageHandler((peerId, rawMessage)");
  const NORMALIZE_STATEMENT =
    "const message: WebchannelUserMessage = normalizeInboundUserMessage(rawMessage);";
  const NORMALIZE = RUNTIME_SOURCE.indexOf(NORMALIZE_STATEMENT);

  it("normalizes the raw frame through the tested helper", () => {
    expect(HANDLER_START).toBeGreaterThan(-1);
    expect(NORMALIZE).toBeGreaterThan(HANDLER_START);
  });

  it("normalizes BEFORE the control lane, the ack and the debouncer see the frame", () => {
    // Guard first: a missing statement makes `indexOf` -1, which is "before"
    // everything and would let this ordering check pass vacuously.
    expect(NORMALIZE).toBeGreaterThan(HANDLER_START);
    expect(NORMALIZE).toBeLessThan(RUNTIME_SOURCE.indexOf("isControlLaneMessage(message)"));
    expect(NORMALIZE).toBeLessThan(RUNTIME_SOURCE.indexOf("channel.sendAck(peerId, [message.id])"));
    expect(NORMALIZE).toBeLessThan(RUNTIME_SOURCE.indexOf(".enqueue({ peerId, message })"));
  });

  it("lets NOTHING downstream reach the raw frame", () => {
    // Everything after the normalization, up to the next wiring block, must
    // speak only of `message`. A single surviving `rawMessage` read would hand
    // peer-supplied fields back to the pipeline.
    const downstream = RUNTIME_SOURCE.slice(
      NORMALIZE + NORMALIZE_STATEMENT.length,
      RUNTIME_SOURCE.indexOf("channel.setApprovalDecisionHandler("),
    );
    expect(downstream).not.toContain("rawMessage");
  });

  it("lets NOTHING before the strip read the raw frame either", () => {
    // The ordering assertions above catch a REPLACED normalization, but not an
    // ADDED early read: an `isControlLaneMessage(rawMessage)` or a
    // `sendAck(peerId, [rawMessage.id])` inserted ABOVE the strip leaves every
    // pinned literal intact and every other assertion green, while handing a
    // peer-supplied field straight to the control lane.
    //
    // So pin the pre-strip region exactly. `rawMessage` may appear there TWICE
    // and only twice: the destructured handler parameter, and the
    // `rawMessage.type !== "user_message"` early return (which reads the one
    // field the router must know before it can normalize). A third occurrence
    // is a new pre-strip read and has to be justified deliberately here.
    const preStrip = RUNTIME_SOURCE.slice(HANDLER_START, NORMALIZE);
    expect(preStrip.match(/rawMessage/g)).toHaveLength(2);
    expect(preStrip).toContain("channel.setMessageHandler((peerId, rawMessage)");
    expect(preStrip).toContain('if (rawMessage.type !== "user_message") return;');
  });

  it("#99 cap premise: the process retention budget keeps the DEFAULT limits", () => {
    // Both #99 caps (`readCoalescedMemberIds` and `coalesceUserMessages`'s
    // `addId`, inbound-queue.ts) bound a member list at
    // `DEFAULT_BUSY_TURN_LIMITS.maxMessagesPerSession`. That is safe ONLY
    // because the one production budget is argument-less, so a real coalesced
    // group can never exceed it and the cap can only ever bind on a hostile
    // list.
    //
    // Raising it here — `new InboundRetentionBudget({ maxMessagesPerSession: 64
    // })` for throughput — would silently truncate members 33-64 of a real
    // burst: ACKed, at `accepted`, never settled. That is #99 verbatim, so the
    // premise is pinned at the line someone would change. If the budget is
    // raised deliberately, the two caps must move with it.
    expect(RUNTIME_SOURCE).toContain("new InboundRetentionBudget()");
    expect(RUNTIME_SOURCE.match(/new InboundRetentionBudget\(/g)).toHaveLength(1);
    // Belt and braces: no argument-ful construction anywhere in the runtime.
    expect(RUNTIME_SOURCE).not.toMatch(/new InboundRetentionBudget\((?!\))/);
  });
});
