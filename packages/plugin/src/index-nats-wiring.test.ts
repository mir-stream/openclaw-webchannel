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
/** The channel itself — read only by the #239 durability contract below. */
const CHANNEL_SOURCE = readFileSync(
  fileURLToPath(new URL("./nats-channel.ts", import.meta.url)),
  "utf8",
);

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

describe("nats-account-runtime.ts wiring contract — v6 delivery journal (#239)", () => {
  /**
   * `NatsChannelDurability.deliveryJournal` is OPTIONAL for the reason its own
   * docblock gives: the plaintext/test construction has no tuple directory to
   * open a journal in. That optionality is exactly
   * what could turn into an UNJOURNALED PRODUCTION without a single test going
   * red. (The original reason was "the journal is a shadow store until #240, so
   * nothing reads it and nothing else would notice" — #240 half 2 ended that,
   * and the guard got MORE load-bearing, not less: an unwired journal is now an
   * account that serves empty history forever.) These assertions are the only
   * thing standing between "optional" and "absent where it matters".
   *
   * Same house rule as the guards above: they pin WIRING SHAPE, not behavior. If
   * a line legitimately changes, update the assertion DELIBERATELY.
   */
  it("opens the journal from the same tuple as the key store and injects it into the channel", () => {
    // Same (tenant, accountId, storageRoot) triple as the ConversationKeyStore
    // two lines up — a second, differently-derived path would put the journal in
    // a directory nothing else protects.
    // One regex, not two: a free-floating `.deliveryJournalPath,` match would
    // stay green while the call above read `.credentialPath`. `[^;]*?` spans the
    // optional-storageRoot spread without escaping the statement.
    //
    // ⚠️ THE ASSIGNMENT TARGET IS A `const journal`, NOT `deliveryJournal`,
    // SINCE #240 HALF 2. Two bindings for one handle: `deliveryJournal` stays
    // `| undefined` because the failed-start close and the dispose chain both
    // run where the open never happened, while the `const` is what
    // `createHistoryServer` receives.
    //
    // (The `\b` is belt-and-braces, NOT what separates the two names — an
    // earlier comment claimed it was. `deliveryJournal` contains no lowercase
    // `journal`, so case alone already distinguishes them. The regex is right;
    // that justification for it was not.)
    //
    // ⚠️ AN EARLIER REVISION CLAIMED THE `const` MADE "a failed open fails the
    // account start" A COMPILE-TIME FACT VIA DEFINITE-ASSIGNMENT ANALYSIS. That
    // was FALSE and was mutation-proven so: a `let x: T` never assigned on any
    // path typechecks clean when its only reads are inside closures, which is
    // every read here. What actually carries the property is
    // `HistoryServerDeps.journal` being NON-OPTIONAL plus the server being
    // constructed in direct flow beside the open — asserted below.
    //
    // The alias is asserted right after, because dropping it is what would
    // silently disarm both closes.
    expect(RUNTIME_SOURCE).toMatch(
      /\bjournal = openDeliveryJournal\(\{\s*databasePath: tupleStoragePaths\(\{\s*tenant,\s*accountId,[^;]*?\}\)\.deliveryJournalPath,/,
    );
    expect(RUNTIME_SOURCE).toContain("deliveryJournal = journal;");
    // The channel must actually RECEIVE it. `undefined` is the defaulted
    // NatsChannelLimits in the 5th position.
    //
    // ⚠️ THE DURABILITY OBJECT NOW CARRIES A SECOND FIELD (#242 half 1), and it
    // is asserted here rather than in a guard of its own because the failure it
    // prevents is the same one: a value resolved and then never handed over.
    // `reasoningDurable` is resolved from account config a few lines up; if the
    // wiring dropped it the channel would default it OFF, every reasoning row
    // would silently stop being written for accounts that opted IN, and no
    // behavioural test would notice — the channel-level tests construct their
    // own durability object and never traverse this line.
    expect(RUNTIME_SOURCE).toMatch(
      /\}, undefined, \{ deliveryJournal, reasoningDurable \}\);/,
    );
    // And it must be the RESOLVER's answer, not a literal or a re-read of
    // `capabilities.reasoning` — the two switches are deliberately separate.
    expect(RUNTIME_SOURCE).toMatch(
      /const reasoningDurable = resolveReasoningDurable\(account\);/,
    );
    // Constructor-only: a late/mutable attachment would mean frames published
    // before it landed were never journaled. Asserted against the CHANNEL, which
    // is the only file such a setter could live in — the earlier version of this
    // line searched the runtime, where the symbol could never have appeared.
    // Method-shaped match (`setDeliveryJournal(`), because the bare name also
    // appears in `NatsChannelDurability`'s docblock stating the prohibition.
    expect(CHANNEL_SOURCE).not.toMatch(/setDeliveryJournal\s*\(/);
  });

  it("passes the SAME handle to the inbound accept seam", () => {
    // #239 half 3. `IngressOnFlushDeps.deliveryJournal` is optional for the same
    // compile-only reason as the channel's, and it is MORE dangerous absent:
    // doc §15.7 makes the journal write part of ACCEPTING a user message, so an
    // unwired seam silently reverts user messages to best-effort durability —
    // which no test outside this file can see while the store has no readers.
    //
    // CONTAINMENT, not an ordinal or a bare-name match: `deliveryJournal` occurs
    // several times in this file (the declaration, the open, the channel
    // injection, two closes), so slice the real `createIngressOnFlush({ ... })`
    // call and require the key inside it. Verified to go red when the line is
    // deleted.
    const callStart = RUNTIME_SOURCE.indexOf(
      "const onIngressFlush = createIngressOnFlush<DebounceItem>({",
    );
    expect(callStart).toBeGreaterThan(-1);
    const callEnd = RUNTIME_SOURCE.indexOf("\n      });", callStart);
    expect(callEnd).toBeGreaterThan(callStart);
    const call = RUNTIME_SOURCE.slice(callStart, callEnd);

    // Shorthand only: the handle must be the one opened above, not a second
    // `openDeliveryJournal(...)` giving this seam its own connection.
    expect(call).toMatch(/^\s*deliveryJournal,$/m);
    expect(call).not.toContain("openDeliveryJournal(");
  });

  /** The `try` whose `catch` converts an account-start throw into a failed start. */
  const START_TRY = "try {\n        const keyStore = new ConversationKeyStore({";
  /** The exact failed-start close, tail included — see the anchoring note below. */
  const FAILED_START_CLOSE =
    "try { deliveryJournal?.close(); } catch { /* the failed start owns no further cleanup */ }";

  it("opens the journal INSIDE the try whose catch converts a throw into a failed start", () => {
    // D3 — no degrade-to-unjournaled path.
    //
    // ⚠️ ORDINAL CHECKS ARE NOT ENOUGH, which is what the first version of this
    // test got wrong: `open > probe` and `channel > open` both stay green if the
    // open is HOISTED OUT into a bare statement between two separate `try`
    // blocks. That breaks D3 concretely — a failed open would then throw past the
    // attempt classifier, skipping the catch's `transport.closeGracefully()` and
    // `attemptAbort.dispose()` and leaking a transport per retry. So assert
    // CONTAINMENT: slice the real block and require the statements inside it.
    const tryStart = RUNTIME_SOURCE.lastIndexOf(START_TRY);
    expect(tryStart).toBeGreaterThan(-1);
    const catchStart = RUNTIME_SOURCE.indexOf("} catch (err) {", tryStart);
    expect(catchStart).toBeGreaterThan(tryStart);
    const block = RUNTIME_SOURCE.slice(tryStart, catchStart);

    const OPEN = "\n        const journal = openDeliveryJournal({";
    expect(block).toContain("keyStore.assertNoFutureDocuments()");
    expect(block).toContain(OPEN);
    // The `| undefined` alias the two close paths use must be assigned INSIDE
    // the try as well, immediately after the open — hoisting it out, or setting
    // it only after `new NatsChannel(...)`, re-opens the leak the failed-start
    // close exists to prevent (the channel constructor is fail-closed and throws
    // after the journal is already open).
    expect(block).toContain("deliveryJournal = journal;");
    expect(block).toContain(
      "channel = new NatsChannel(transport, accountId, tenant, {",
    );
    // ⚠️ AND THE HISTORY SERVER IS BUILT HERE TOO, FROM THE SAME `const`. That
    // placement is what carries "a failed journal open fails the account start"
    // — `HistoryServerDeps.journal` is non-optional, so the server cannot be
    // constructed without a real handle, and it is constructed in DIRECT FLOW
    // where the open just succeeded.
    //
    // ⚠️ THIS ASSERTION IS THE ONLY THING THAT CATCHES AN UNWIRED SERVER, and
    // tsc is not a second one: an earlier revision claimed definite-assignment
    // analysis proved the handle set, which is FALSE — a `let x: T` never
    // assigned on any path typechecks clean when its only reads are inside
    // closures, which is every read there. MEASURED: delete the
    // `createHistoryServer({…})` block and only THIS file goes red;
    // `history-serve.test.ts` builds its own server and never reads
    // `nats-account-runtime.ts` at all, so it stays green.
    expect(block).toContain("historyServer = createHistoryServer({");
    expect(block).toMatch(/historyServer = createHistoryServer\(\{\s*journal,/);
    // No nested try/catch inside the slice, so the `} catch (err) {` we sliced to
    // is genuinely the handler covering the open.
    expect(block).not.toMatch(/\}\s*catch\b/);
    // Order WITHIN the block still matters.
    expect(block.indexOf(OPEN)).toBeGreaterThan(
      block.indexOf("keyStore.assertNoFutureDocuments()"),
    );
    expect(block.indexOf("deliveryJournal = journal;")).toBeGreaterThan(
      block.indexOf(OPEN),
    );
    expect(
      block.indexOf("channel = new NatsChannel(transport, accountId, tenant, {"),
    ).toBeGreaterThan(block.indexOf("deliveryJournal = journal;"));
    // The server needs the channel it publishes on, so it must come last.
    expect(block.indexOf("historyServer = createHistoryServer({")).toBeGreaterThan(
      block.indexOf("channel = new NatsChannel(transport, accountId, tenant, {"),
    );
  });

  it("closes the journal on the FAILED-START path, ahead of the transport teardown", () => {
    // `new NatsChannel(...)` is fail-closed and can throw AFTER the open, and the
    // startup loop RETRIES — so without this close every attempt leaks two
    // descriptors and a live WAL-checkpoint timer. PR #270 spent a whole commit
    // (`5f2b4d9`) pinning the identical leak on the store's side of the seam.
    //
    // ⚠️ ANCHORED ON THE TAIL, NOT THE PREFIX. `try { deliveryJournal?.close(); }`
    // on its own is a PREFIX OF BOTH close sites, so an earlier version of this
    // assertion stayed green with the failed-start close deleted — the dispose-
    // chain close kept satisfying it.
    expect(RUNTIME_SOURCE).toContain(FAILED_START_CLOSE);
    const catchStart = RUNTIME_SOURCE.indexOf(
      "} catch (err) {",
      RUNTIME_SOURCE.lastIndexOf(START_TRY),
    );
    const failedStartClose = RUNTIME_SOURCE.indexOf(
      FAILED_START_CLOSE,
      catchStart,
    );
    const transportClose = RUNTIME_SOURCE.indexOf(
      "await transport.closeGracefully()",
      catchStart,
    );
    expect(failedStartClose).toBeGreaterThan(catchStart);
    expect(transportClose).toBeGreaterThan(failedStartClose);
  });

  it("closes the journal AFTER the channel in the dispose chain", () => {
    // Ordering is load-bearing: the channel journals on its egress path, so
    // closing the handle first leaves a window where a send writes to a closed
    // database.
    const channelDispose = RUNTIME_SOURCE.lastIndexOf(
      'errors.push({ phase: "channel", error })',
    );
    const journalClose = RUNTIME_SOURCE.lastIndexOf(
      'errors.push({ phase: "delivery-journal", error })',
    );
    expect(channelDispose).toBeGreaterThan(-1);
    expect(journalClose).toBeGreaterThan(channelDispose);
    // Tail-anchored for the same reason as the failed-start close above.
    expect(RUNTIME_SOURCE).toContain(
      'try { deliveryJournal?.close(); } catch (error) { errors.push({ phase: "delivery-journal", error }); }',
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
    // #243 half 2a: the factory's sendAck forwards `committed` (the server-id echo)
    // through to the channel alongside the ids.
    expect(RUNTIME_SOURCE).toMatch(
      /sendAck:\s*\(peerId,\s*ids,\s*committed\)\s*=>\s*channel\.sendAck\(peerId,\s*ids,\s*committed\)/,
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
   * receipts settle with this turn", and the decode path does not stop it:
   * #246 half A's `decodeInboundWsMessage` (nats-channel.ts) validates the
   * KNOWN fields of a `user_message` and deliberately passes UNKNOWN ones
   * through — the wire is additive — after which the `user_message` case
   * forwards the object as it stands. So the ONLY thing standing between a
   * peer-supplied member list and the turn handler is still this normalization
   * — and its position: it must run before the control lane, before the ack,
   * and before the debouncer.
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
   * The command-gate warning notice is this runtime's one durable-text egress
   * site: a real `agent_message` bubble on the client. Since #238 the plugin —
   * never the viewer — names every such bubble, so this send must pass a
   * `nextMessageId()` as `sendText`'s THIRD argument. An id-less send hands the
   * client an unnamed durable bubble and it falls back to minting `a-N` from a
   * client-local counter (NOT-list N4/N5).
   *
   * Why a SOURCE guard: the call sits inside the message handler closed over by
   * the module-private `buildNatsAccount`, which this file already documents as
   * untestable routing (see the #99 block above). The mint (`nextMessageId`) and
   * the frame assembly (`NatsChannel.sendText`) are covered executably by the
   * message-adapter and nats-channel tests; this pins the wiring joining them.
   */
  // Comments are stripped naively — BOTH kinds — and whitespace collapsed, so
  // this guard is line-break- and indentation-blind. Both kinds matter: strip
  // only `//` and a `/* … */` comment quoting the notice send satisfies the
  // positive assertion below all by itself, which is a false green (measured).
  // A naive strip is sound in the positive direction because it can only ever
  // delete real code — i.e. only ever turn a positive assertion RED. It is not
  // sound in the other direction, which is why the negative guards are
  // explicitly best-effort.
  const RUNTIME_FLAT = RUNTIME_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ");

  it("mints the notice's id at the delivery act", () => {
    // ADJACENCY IS THE ASSERTION — the one non-obvious thing here.
    // `sendText(peerId, text, id?, turnId?, …)` turns argument 3, and only
    // argument 3, into `payload.id` on the wire. Requiring the mint to follow
    // the text argument IMMEDIATELY is sufficient for every realistic edit to
    // this call: an `undefined` wedged into the id slot — or anything else
    // between the two — breaks the adjacency and reds this. It is NOT a formal
    // equivalence; text and mint can be made adjacent somewhere other than an
    // argument list (a destructured array literal, say). Those are deliberate
    // rewrites, not drift, and this is a drift guard.
    //
    // Hoisting the text or the mint into a `const` reds this too, and that is
    // intended: per this file's header, a deliberate wiring change gets a
    // deliberate one-line update here.
    expect(RUNTIME_FLAT).toMatch(/"commands to an operator allowlist\.", nextMessageId\(\)/);
  });

  it("mints it through the ONE canonical minter, imported from the adapter", () => {
    expect(RUNTIME_FLAT).toContain('import { nextMessageId } from "./message-adapter.js";');
    // Best-effort defense-in-depth, NOT a sound guarantee: the naive strip is
    // not regex-aware, so a regex literal containing an escaped `//` can hide a
    // second id shape from it. Making this sound is not worth the machinery.
    expect(RUNTIME_FLAT).not.toMatch(/`webchannel-\$\{/);
  });

  it("keeps the notice best-effort: the boolean return stays ignored", () => {
    // The notice hedges a gate that is deliberately a conservative mirror, so a
    // failed send must not become a thrown or logged error here.
    expect(RUNTIME_FLAT).not.toContain("if (!channel.sendText(");
    expect(RUNTIME_FLAT).not.toMatch(/=\s*channel\.sendText\(/);
  });
});

describe("nats-account-runtime.ts wiring contract — the reasoning opt-in diagnostic (#242 half 2)", () => {
  /**
   * ⚠️ WHY THIS IS A SOURCE GUARD AND NOT A BEHAVIOURAL TEST — stated so the
   * next reader does not "upgrade" it and find out the hard way. The warning
   * lives inside `startAccount`'s per-account body, past a live NATS dial and a
   * real `openDeliveryJournal`; reaching it in a unit test means standing up the
   * whole account lifecycle. What the warning DECIDES is pure and is covered
   * where it belongs: `account-config.test.ts` pins that `resolveReasoningDurable`
   * and `resolveReasoningEnabled` disagree exactly on the combination below, and
   * `log-interpolation-audit.test.ts` pins that the line exists, is
   * `webchannel:`-prefixed, and interpolates nothing raw (its
   * `nats-account-runtime.ts` floor moved 19→20 / 37→38 for this statement).
   * What is left for this file is the WIRING: that the emission is gated on the
   * two resolvers and not on something else.
   */
  it("gates the warning on `reasoningDurable && !resolveReasoningEnabled(account)`", () => {
    expect(RUNTIME_SOURCE).toMatch(
      /if \(reasoningDurable && !resolveReasoningEnabled\(account\)\) \{/,
    );
    // The SAME `account` binding the durability resolver reads — not a fresh
    // `resolveWebchannelAccountConfig(...)`, which could disagree with what
    // `inbound.ts` will read for the lane.
    expect(RUNTIME_SOURCE).not.toMatch(
      /resolveReasoningEnabled\(\s*resolveWebchannelAccountConfig\(/,
    );
  });

  it("stays a DIAGNOSTIC — `reasoningDurable` never implies the lane", () => {
    // The one edit this guard exists to stop. `capabilities.reasoning: false` is
    // an explicit privacy opt-OUT for a live surface; letting a storage key
    // silently reverse it defeats the reason the two keys were split (#113's
    // default-ON is about RENDERING a volatile lane, not about RECORDING
    // plaintext at rest). So the durable switch may never appear in the LANE's
    // resolution — and that resolution lives in `inbound.ts`, which must not
    // read the durable key at all.
    const INBOUND_SOURCE = readFileSync(
      fileURLToPath(new URL("./inbound.ts", import.meta.url)),
      "utf8",
    );
    expect(INBOUND_SOURCE).not.toMatch(/resolveReasoningDurable/);
    expect(INBOUND_SOURCE).not.toMatch(/reasoningDurable\s*\|\|/);
  });
});
