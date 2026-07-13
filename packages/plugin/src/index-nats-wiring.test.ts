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
