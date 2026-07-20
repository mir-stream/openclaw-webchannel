import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

/**
 * SOURCE-CONTRACT guard for `index-nats.ts` wiring — a deliberate STOPGAP.
 *
 * `index-nats.ts` is the gateway plugin entry. It is OUTSIDE tsconfig (tsc-blind)
 * AND cannot be imported by a unit test — evaluating it runs side-effectful
 * gateway setup. So the whole class of bug where a capability GATE exists on the
 * channel but is never wired (or is wired against the wrong config) recurs
 * silently: nothing type-checks it and nothing exercises it. Until the tsconfig
 * closure lands (issue #32), this test reads the entry file AS TEXT and pins the
 * shape of the load-bearing wiring lines with formatting-tolerant regexes.
 *
 * IMPORTANT: these assertions pin WIRING SHAPE, not behavior — the behavior of
 * `resolveTypingEnabled` is covered by account-config's own tests. If a wiring
 * line legitimately changes, update the matching assertion DELIBERATELY (that is
 * the point of the guard: the change should be a conscious edit here, not a
 * silent drift). Keep the assertions few and load-bearing.
 */

/** Read the entry source exactly once; every contract asserts against this text. */
const INDEX_NATS_SOURCE = readFileSync(
  fileURLToPath(new URL("../index-nats.ts", import.meta.url)),
  "utf8",
);

describe("index-nats.ts wiring contract — typing gate (P0-6)", () => {
  it("wires the channel typing gate via resolveTypingEnabled", () => {
    // `channel.setTypingEnabled( ... resolveTypingEnabled( ... ) ... )` — the
    // gate must be pushed onto the channel FROM the resolver, not hard-coded.
    expect(INDEX_NATS_SOURCE).toMatch(
      /channel\.setTypingEnabled\(\s*resolveTypingEnabled\(/,
    );
  });

  it("passes the resolved per-account `account` binding (no redundant re-resolution)", () => {
    // The resolver must be fed the already-resolved per-account config binding
    // (`account`, from the serving plan), NOT a fresh
    // resolveWebchannelAccountConfig(api.config, accountId) call at the site.
    expect(INDEX_NATS_SOURCE).toMatch(
      /channel\.setTypingEnabled\(\s*resolveTypingEnabled\(\s*account\s*\)\s*\)/,
    );
    // Guard the anti-pattern explicitly: no re-resolution inside the typing wire.
    expect(INDEX_NATS_SOURCE).not.toMatch(
      /setTypingEnabled\(\s*resolveTypingEnabled\(\s*resolveWebchannelAccountConfig\(/,
    );
  });
});

describe("index-nats.ts wiring contract — command catalog (P0-3)", () => {
  it("serves load_commands from the MEMOIZED provider, not a per-request build", () => {
    // The handler must call the memoized provider (`catalogProvider()`), never
    // rebuild the catalog inline per request. Pin the provider is created and
    // that the handler serves from it.
    expect(INDEX_NATS_SOURCE).toMatch(/createCommandCatalogProvider\(\s*api\.config\s*\)/);
    expect(INDEX_NATS_SOURCE).toMatch(/channel\.sendCommands\(\s*peerId\s*,\s*catalogProvider\(\)\s*\)/);
    // Guard the anti-pattern: no bare per-request `buildCommandCatalog(api.config)`
    // inside the send. (buildCommandCatalog now lives behind the provider only.)
    expect(INDEX_NATS_SOURCE).not.toMatch(
      /sendCommands\(\s*peerId\s*,\s*buildCommandCatalog\(/,
    );
  });
});

describe("index-nats.ts wiring contract — ingress dedupe onFlush (P0-7a)", () => {
  it("wires the debouncer onFlush from the extracted createIngressOnFlush factory", () => {
    // The onFlush must be the tested factory, not an inlined closure (which could
    // silently drift — e.g. dispatch `items` instead of the deduped survivors, or
    // drop the accountId namespace). Pin `onFlush: createIngressOnFlush(`.
    expect(INDEX_NATS_SOURCE).toMatch(/onFlush:\s*createIngressOnFlush</);
  });
});

describe("index-nats.ts wiring contract — ingress ack (P0-7b)", () => {
  it("wires sendAck into the onFlush factory, the debouncer onCancel, and the control-lane branch", () => {
    // The onFlush factory must be handed a sendAck so admitted (fresh + duplicate)
    // ids drain the client's replay ledger.
    expect(INDEX_NATS_SOURCE).toMatch(
      /sendAck:\s*\(peerId,\s*ids\)\s*=>\s*channel\.sendAck\(peerId,\s*ids\)/,
    );
    // The debouncer's onCancel must record+ack /stop-cancelled buffered items via
    // the tested helper (else a reconnect replays text the user aborted).
    expect(INDEX_NATS_SOURCE).toMatch(/onCancel:/);
    expect(INDEX_NATS_SOURCE).toMatch(/recordCancelledInboundItems\(/);
    // The control-lane branch bypasses the debouncer/onFlush, so it acks its own
    // id-carrying frame directly (else its ledger entry never drains).
    expect(INDEX_NATS_SOURCE).toMatch(
      /if\s*\(message\.id\)\s*channel\.sendAck\(peerId,\s*\[message\.id\]\)/,
    );
  });
});

describe("index-nats.ts wiring contract — approval decision account routing", () => {
  it("threads the runtime accountId into handleApprovalDecision", () => {
    expect(INDEX_NATS_SOURCE).toMatch(
      /setApprovalDecisionHandler\(\(peerId, id, decision\) =>[\s\S]*?handleApprovalDecision\(api\.config, id, decision, peerId, accountId\)/,
    );
  });
});

describe("index-nats.ts wiring contract — shared-audience fail-closed pre-pass (P0-3 D6-1)", () => {
  it("detects collisions in a PRE-PASS via the extracted detector, before the serving loop", () => {
    // Collision detection must run through the tested pure module, keyed by the
    // per-plan derived auth built in the pre-pass — not an inline heuristic.
    expect(INDEX_NATS_SOURCE).toMatch(/const\s+sharedAudienceCollisions\s*=\s*detectSharedAudienceCollisions\(/);
    expect(INDEX_NATS_SOURCE).toMatch(/const\s+accountAuthByPlan\s*=\s*new Map/);
  });

  it("skips EVERY colliding account with a `continue` before any transport opens", () => {
    // The skip reads the pre-pass result and continues out of the loop iteration
    // (fail-closed), so a colliding account never reaches the Step 1 consume/connect.
    expect(INDEX_NATS_SOURCE).toMatch(
      /const\s+collision\s*=\s*sharedAudienceCollisions\.get\(accountId\);[\s\S]*?if\s*\(collision\)\s*\{[\s\S]*?continue;/,
    );
  });

  it("no longer carries the old post-connect `registerHopAudClaims` warn-only map", () => {
    // The P0-2-era "warn on the second claimant" map is replaced by the fail-closed
    // pre-pass; its presence would mean a colliding account could still serve.
    expect(INDEX_NATS_SOURCE).not.toContain("registerHopAudClaims");
  });

  it("derives the register-hop issuer from the ISSUER-ONLY accessor (gated on neither transport creds nor identityKey)", () => {
    // The issuer feeds the shared-audience collision pre-pass, so it must be read
    // through an accessor that NEITHER of the other two loaders' gates can suppress:
    //   - `loadPersistedEnrolledCreds` gates on userJwt+userSeed → a static/BYO
    //     account (which persists none) would lose its issuer.
    //   - `loadPersistedAgentIdentity` gates on a parseable identityKey → a CORRUPT
    //     key would demote the account to the DERIVED issuer, un-pairing it from a
    //     twin that shares its explicit aud and letting that twin serve. A broken
    //     key must fail its OWN account closed (the F2 backstop), never hide a
    //     collision from another account.
    expect(INDEX_NATS_SOURCE).toMatch(/loadPersistedIssuer\(plan\.accountId\)/);
    expect(INDEX_NATS_SOURCE).not.toContain("loadPersistedEnrolledCreds");
    // The identity accessor must not be what feeds the issuer argument.
    expect(INDEX_NATS_SOURCE).not.toMatch(/loadPersistedAgentIdentity\(plan\.accountId\)\?\.issuer/);
  });

  it("validates JWT auth before the serving loop can open a NATS transport", () => {
    const validationAt = INDEX_NATS_SOURCE.indexOf("assertJwtAuthConfig(accountAuth);");
    const servingLoopAt = INDEX_NATS_SOURCE.indexOf("for (const plan of plans) {", validationAt);
    const consumeAt = INDEX_NATS_SOURCE.indexOf("consumeCredentialSource(source, accountId)");

    expect(validationAt).toBeGreaterThan(-1);
    expect(servingLoopAt).toBeGreaterThan(validationAt);
    expect(consumeAt).toBeGreaterThan(servingLoopAt);
    // Keep a single validation site: reintroducing a post-connect assertion can
    // recreate the rejected-transport leak this ordering contract prevents.
    expect(INDEX_NATS_SOURCE.match(/assertJwtAuthConfig\(accountAuth\);/g)).toHaveLength(1);
  });

  it("preserves structured Gate B diagnostics for pre-pass auth failures", () => {
    expect(INDEX_NATS_SOURCE).toMatch(
      /const\s+prepassError\s*=\s*accountPrepassErrors\.get\(accountId\);[\s\S]*?formatAccountReadiness\(\{[\s\S]*?buildError:\s*prepassError\.message/,
    );
    expect(INDEX_NATS_SOURCE).toMatch(/issuer:\s*failedJwt\.issuer/);
    expect(INDEX_NATS_SOURCE).toMatch(/audience:\s*failedJwt\.audience/);
  });
});

describe("index-nats.ts wiring contract — static identity-missing skip + readiness source (P0-3 D1/S2)", () => {
  it("skips a static account with no attested identity (identity-missing) account-scoped", () => {
    expect(INDEX_NATS_SOURCE).toMatch(/if\s*\(consumed\.status === "identity-missing"\)\s*\{[\s\S]*?continue;/);
  });

  it("surfaces the credential source mode + effective dialed URL in the readiness line", () => {
    // Both the build-fail and healthy readiness calls thread the run-time source
    // facts through formatAccountReadiness (Gate B).
    expect(INDEX_NATS_SOURCE).toMatch(/credentialSource:\s*credentialSourceMode/);
    expect(INDEX_NATS_SOURCE).toMatch(/dialedUrl\s*=\s*consumed\.dialedUrl/);
  });

  it("disconnects an enrolled transport rejected by the identity-key backstop", () => {
    expect(INDEX_NATS_SOURCE).toMatch(
      /if\s*\(!identityKey\)\s*\{[\s\S]*?transport\.disconnect\(\);[\s\S]*?continue;/,
    );
  });
});

describe("index-nats.ts browser-route absence", () => {
  it("contains no gateway HTTP route registration or socket-upgrade wiring", () => {
    expect(INDEX_NATS_SOURCE).not.toContain("registerHttpRoute");
    expect(INDEX_NATS_SOURCE.toLowerCase()).not.toContain("upgrade route");
  });
});
