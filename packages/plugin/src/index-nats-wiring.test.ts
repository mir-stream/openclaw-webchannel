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

describe("index-nats.ts wiring contract — effective auth (P1-6)", () => {
  it("uses the shared resolver and no longer defines a local derivation helper", () => {
    expect(INDEX_NATS_SOURCE).toMatch(/import \{ resolveEffectiveAccountAuth \} from "\.\/src\/account-auth\.js"/);
    expect(INDEX_NATS_SOURCE).toMatch(/const accountAuth = resolveEffectiveAccountAuth\(/);
    expect(INDEX_NATS_SOURCE).not.toMatch(/function deriveAccountAuth\(/);
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
      /if\s*\(message\.id\s*&&\s*!channel\.sendAck\(peerId,\s*\[message\.id\]\)\)/,
    );
    expect(INDEX_NATS_SOURCE.match(/control-lane ack failed/g)).toHaveLength(1);
  });
});

describe("index-nats.ts wiring contract — approval decision account routing", () => {
  it("threads the runtime accountId into handleApprovalDecision", () => {
    expect(INDEX_NATS_SOURCE).toMatch(
      /setApprovalDecisionHandler\(\(peerId, id, decision\) =>[\s\S]*?handleApprovalDecision\(api\.config, id, decision, peerId, accountId\)/,
    );
  });
});

describe("index-nats.ts browser-route absence", () => {
  it("contains no gateway HTTP route registration or socket-upgrade wiring", () => {
    expect(INDEX_NATS_SOURCE).not.toContain("registerHttpRoute");
    expect(INDEX_NATS_SOURCE.toLowerCase()).not.toContain("upgrade route");
  });
});

describe("index-nats.ts source contract — serving-loop skips mirror doctor (P1-6)", () => {
  /**
   * The whole premise of P1-6 is that doctor's C1–C11 finding engine MIRRORS the
   * conditions under which the serving loop refuses to serve an account. Nothing
   * else pins that: `doctor.test.ts` exercises doctor.ts against hand-written
   * fixtures, so a NEW skip added here would leave every test green while doctor
   * silently under-reports — the account is dead and diagnosis says it is fine.
   *
   * The 5 current skips: encryption misconfig, creds missing, NATS connect
   * failed, register-hop without an agent identity key, verifier build failed.
   *
   * IF YOU ADD A SERVING-LOOP SKIP: add the matching check to doctor.ts (C1–C11)
   * FIRST, then bump this number deliberately. Bumping it to make the suite green
   * without the doctor check is the exact drift this guard exists to stop.
   *
   * WHAT THIS COUNTS: the bare word `continue` anywhere in the file — every
   * shape (block, inline `if (x) continue;`, labeled `continue outer;`, and
   * semicolon-less `continue` via ASI) — not serving-loop skips specifically.
   * Today every occurrence IS a serving-loop skip, so the number means both.
   * That can legitimately diverge: an unrelated inner loop with its own
   * `continue` also forces a bump, and from then on this number no longer means
   * "N serving-loop skips". That tradeoff is accepted — an occurrence count is
   * what a text guard can honestly enforce — but it decays silently unmaintained.
   * So whoever bumps it MUST re-state here what the new number counts (e.g. "6 =
   * 5 serving-loop skips + 1 inner-loop continue in <fn>"), and confirm the
   * doctor mirror only for the ones that are actually skips.
   *
   * HONEST LIMITS: this greps text, so it cannot see semantics. The word
   * `continue` in a comment or string literal counts too (today's count of 5 is
   * exactly the 5 statements, so none exist — if you add prose containing the
   * word, this trips and you must reword or re-state the number). An early
   * `return`/`throw` used as a skip is NOT counted. So this catches the drift it
   * is aimed at — a new `continue` skip added silently — not every possible
   * shape of "stop serving this account".
   */
  it("has exactly 5 skip sites, each mirrored by a doctor check", () => {
    // Deliberately the BARE word, not a `continue\s*;` pattern: ASI makes
    // `if (!x) {\n continue \n}` valid TS, and this repo has no formatter and no
    // linter (package.json has only test/typecheck/build), so nothing would ever
    // insert that semicolon. A `;`-requiring or line-anchored regex is blind to
    // the cheapest ways to add a skip. Cost of the bare word is the comment/
    // string false positive documented above — accepted, and it fails LOUD.
    const skips = INDEX_NATS_SOURCE.match(/\bcontinue\b/g) ?? [];
    expect(skips.length).toBe(5);
  });
});
