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

  it("reports future credential storage before key probing or publication", () => {
    const credentialLoad = RUNTIME_SOURCE.indexOf(
      "credentialLoad = loadPersistedCredentialDocument(",
    );
    const storageDiagnostic = RUNTIME_SOURCE.indexOf(
      "const diagnostic = credentialStorageFailureDiagnostic(error);",
      credentialLoad,
    );
    const keyStoreProbe = RUNTIME_SOURCE.indexOf(
      "keyStore.assertNoFutureDocuments()",
      storageDiagnostic,
    );
    const publication = RUNTIME_SOURCE.indexOf(
      "commitAccountPublication<AccountRuntime>",
      keyStoreProbe,
    );
    expect(storageDiagnostic).toBeGreaterThan(credentialLoad);
    expect(keyStoreProbe).toBeGreaterThan(storageDiagnostic);
    expect(publication).toBeGreaterThan(keyStoreProbe);
    expect(
      RUNTIME_SOURCE.slice(storageDiagnostic, keyStoreProbe),
    ).toMatch(/reportPermanent\(accountId, diagnostic\.code, diagnostic\.detail\)[\s\S]*?return undefined/);
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

  it("rejects future key state before channel construction, readiness, or publication", () => {
    const store = RUNTIME_SOURCE.lastIndexOf(
      "const keyStore = new ConversationKeyStore({",
    );
    const compatibilityProbe = RUNTIME_SOURCE.lastIndexOf(
      "keyStore.assertNoFutureDocuments()",
    );
    const channel = RUNTIME_SOURCE.lastIndexOf(
      "channel = new NatsChannel(transport, accountId, tenant, {",
    );
    const readiness = RUNTIME_SOURCE.lastIndexOf(
      "const readiness = formatAccountReadiness({",
    );
    const publication = RUNTIME_SOURCE.lastIndexOf(
      "commitAccountPublication<AccountRuntime>",
    );

    expect(store).toBeGreaterThan(-1);
    expect(compatibilityProbe).toBeGreaterThan(store);
    expect(channel).toBeGreaterThan(compatibilityProbe);
    expect(readiness).toBeGreaterThan(channel);
    expect(publication).toBeGreaterThan(readiness);
    expect(RUNTIME_SOURCE).toMatch(
      /isVersionTooNew\(err\)[\s\S]{0,300}?kind: "permanent"[\s\S]{0,300}?code: `\$\{err\.document\}-version-too-new`[\s\S]{0,300}?operatorMessage: err\.message/,
    );
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
  it("self-reports the loaded bundle through the full-registration logger", () => {
    expect(RUNTIME_SOURCE).toContain(
      "const LOADED_PLUGIN_BUNDLE_PATH = fileURLToPath(import.meta.url);",
    );
    expect(RUNTIME_SOURCE).toMatch(
      /api\.logger\.info\(\s*`webchannel: loaded plugin bundle \(plugin=webchannel, source=\$\{LOADED_PLUGIN_BUNDLE_PATH\}\)`\s*,?\s*\)/,
    );
    expect(
      RUNTIME_SOURCE.match(/webchannel: loaded plugin bundle \(plugin=/g),
    ).toHaveLength(1);
    expect(
      RUNTIME_SOURCE.indexOf("accountCoordinator.installFull(api);"),
    ).toBeLessThan(
      RUNTIME_SOURCE.indexOf("`webchannel: loaded plugin bundle (plugin="),
    );
  });

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

describe("nats-account-runtime.ts wiring contract — #238 identity at the delivery act", () => {
  /**
   * The command-gate warning notice is the runtime's ONE durable-text egress
   * site: a real `agent_message` bubble on the client. Since #238 the plugin —
   * never the viewer — names every such bubble, so this `sendText` must pass a
   * `nextMessageId()` as its third argument. An id-less send here hands the
   * client an unnamed durable bubble and it falls back to minting `a-N` from a
   * client-local counter (NOT-list N4/N5).
   *
   * Why a SOURCE guard: this call sits inside the message handler closed over
   * by the module-private `buildNatsAccount`, which the same file already
   * documents as "untestable routing" (see the #99 block above). The mint
   * itself (`nextMessageId`) and the frame assembly (`NatsChannel.sendText`)
   * are covered executably by message-adapter/nats-channel tests; this pins the
   * wiring that joins them.
   */
  // Located by its semantic guard and SLICED, exactly like the #99 block above
  // — not pinned as an exact multi-line literal. An exact literal is
  // indentation- and line-break-sensitive: a semantically identical reformat
  // (hoisting the text into a `const noticeText`, collapsing the call onto one
  // line) turned the first version of this test red and dumped the whole
  // ~1560-line file as an expected/received diff. A misleading red on a correct
  // change is worse than no test.
  //
  // Slicing FIRST is load-bearing, not tidiness: the mint regex alone is
  // satisfied by ANY `channel.sendText(peerId, …, nextMessageId())` in the file,
  // so once a legitimate second egress site exists here, a notice that LOST its
  // id would still go green on that other site's behalf. Bounding the search to
  // this `if` block keeps the assertion about the notice.
  const GATE_GUARD = "if (commandGate.delegated && !commandGate.isListed(peerId)) {";
  const GATE_START = RUNTIME_SOURCE.indexOf(GATE_GUARD);
  // Both bounds must FAIL CLOSED. A `-1` from either `indexOf` fed straight into
  // `slice` is the vacuity this slicing exists to prevent, inverted: a missing
  // `return;` would make the end bound `-1`, i.e. "the rest of the file minus one
  // character", handing the mint regex back the whole-file scope it must not have.
  const GATE_END = RUNTIME_SOURCE.indexOf("return;", GATE_START);
  const NOTICE_BLOCK =
    GATE_START < 0 || GATE_END < 0 ? "" : RUNTIME_SOURCE.slice(GATE_START, GATE_END);
  // `[^;]` bounds the match to a SINGLE statement, so a later `nextMessageId()`
  // can never be borrowed across the end of the notice send.
  const MINTS_THIRD_ARG = /channel\.sendText\(\s*peerId,[^;]*?nextMessageId\(\)\s*,?\s*\)/;

  it("mints the notice's id at the delivery act", () => {
    // Guard first: a missing gate makes the slice empty, which would let the
    // assertions below pass vacuously.
    expect(GATE_START).toBeGreaterThan(-1);
    expect(NOTICE_BLOCK).toContain("commands to an operator allowlist.");
    expect(NOTICE_BLOCK).toMatch(MINTS_THIRD_ARG);
  });

  it("mints it through the ONE canonical minter, imported from the adapter", () => {
    expect(RUNTIME_SOURCE).toContain('import { nextMessageId } from "./message-adapter.js";');
    // The one-shape invariant. NOT a count of `nextMessageId()` calls: a second
    // call is the SAME shape and is exactly what a legitimate future second
    // egress site in this file would have to write. What must never appear is a
    // SECOND id shape — an inline `webchannel-${…}` template minted here instead
    // of through the adapter.
    expect(RUNTIME_SOURCE).not.toMatch(/`webchannel-\$\{/);
  });

  it("keeps the notice best-effort: the boolean return stays ignored", () => {
    // The notice is a hedge for a gate that is deliberately a conservative
    // mirror; a failed send must not become a thrown or logged error here.
    expect(RUNTIME_SOURCE).not.toContain("if (!channel.sendText(");
    expect(RUNTIME_SOURCE).not.toMatch(/=\s*channel\.sendText\(/);
  });
});
