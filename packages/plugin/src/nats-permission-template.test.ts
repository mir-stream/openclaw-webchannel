/**
 * Permission-template parity + subject-coverage (P0-3 D3).
 *
 *  - PARITY: `requiredNatsPermissions("t1")` equals the shared repo-root fixture
 *    `contracts/nats-permissions.v1.json` (minus `_meta`). The saas side decodes
 *    minted JWT claims against the SAME fixture, so the fixture transitively locks
 *    template == mint.
 *  - COVERAGE: every subject the RUNTIME actually builds (from `subjects.ts` — the
 *    same functions the channel uses) falls within a role grant. A subject that
 *    drifts outside the template breaks this even if the fixture still agrees.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  requiredNatsPermissions,
  subjectMatchesNatsGrant,
  formatPermissionTemplate,
  type SubjectPermissionSet,
} from "./nats-permission-template.js";
import {
  registerWildcard,
  registerSubject,
  inboundSubject,
  outboundSubject,
  reginboxPrefix,
  preflightSubject,
} from "./subjects.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../contracts/nats-permissions.v1.json", import.meta.url),
);

type Fixture = {
  _meta: unknown;
  agent: SubjectPermissionSet;
  browser: SubjectPermissionSet;
  observer: SubjectPermissionSet;
};

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
}

describe("requiredNatsPermissions ↔ contracts/nats-permissions.v1.json (parity)", () => {
  const fixture = loadFixture();
  const perms = requiredNatsPermissions("t1");

  it("agent grant equals the fixture (allow + deny, both pub and sub)", () => {
    expect(perms.agent).toEqual(fixture.agent);
  });

  it("browser grant (peerId=p1) equals the fixture", () => {
    expect(perms.browser("p1")).toEqual(fixture.browser);
  });

  it("observer grant equals the fixture — with the EXPLICIT pub.deny [\">\"]", () => {
    expect(perms.observer).toEqual(fixture.observer);
    // Guard the load-bearing detail directly: an empty pub.allow is NOT deny-all.
    expect(perms.observer.pub.allow).toEqual([]);
    expect(perms.observer.pub.deny).toEqual([">"]);
  });

  it("the fixture carries governance _meta (stripped from every parity compare)", () => {
    expect((fixture._meta as { version?: string }).version).toBe("v1");
  });
});

describe("subject-coverage — runtime subjects fall within the role grants", () => {
  const perms = requiredNatsPermissions("t1");
  const T = "t1";
  const A = "a1";
  const P = "p1";

  // Every subject the agent's channel builds must be covered by the AGENT grant.
  const agentSubjects = [
    registerWildcard(T, A),
    registerSubject(T, A, P),
    inboundSubject(T, A, P),
    outboundSubject(T, A, P),
    `${reginboxPrefix(T, A, P)}sometoken`,
    preflightSubject(T, A),
  ];

  it("every runtime subject matches the agent tenant-wide grant", () => {
    for (const subject of agentSubjects) {
      const allowed = perms.agent.pub.allow.some((g) => subjectMatchesNatsGrant(subject, g));
      expect(allowed, `agent grant must cover ${subject}`).toBe(true);
    }
  });

  it("the browser-facing subjects fall within the per-peer browser grant", () => {
    const browser = perms.browser(P);
    const browserSubjects = [
      inboundSubject(T, A, P),
      outboundSubject(T, A, P),
      registerSubject(T, A, P),
      `${reginboxPrefix(T, A, P)}sometoken`,
    ];
    for (const subject of browserSubjects) {
      const allowed = browser.pub.allow.some((g) => subjectMatchesNatsGrant(subject, g));
      expect(allowed, `browser grant must cover ${subject}`).toBe(true);
    }
  });

  it("a DIFFERENT peer's subject is NOT covered by a browser's own grant (isolation)", () => {
    const browser = perms.browser(P);
    const foreign = inboundSubject(T, A, "someone-else");
    const allowed = browser.pub.allow.some((g) => subjectMatchesNatsGrant(foreign, g));
    expect(allowed).toBe(false);
  });
});

describe("subjectMatchesNatsGrant — NATS wildcard semantics", () => {
  it("* matches exactly one token", () => {
    expect(subjectMatchesNatsGrant("webchannel.t1.a1.register", "webchannel.t1.*.register")).toBe(true);
    expect(subjectMatchesNatsGrant("webchannel.t1.a1.b1.register", "webchannel.t1.*.register")).toBe(false);
  });
  it("> matches one-or-more trailing tokens (last only)", () => {
    expect(subjectMatchesNatsGrant("webchannel.t1.a1.p1.in", "webchannel.t1.>")).toBe(true);
    // `>` requires at least one trailing token.
    expect(subjectMatchesNatsGrant("webchannel.t1", "webchannel.t1.>")).toBe(false);
  });
  it("literal tokens must match exactly", () => {
    expect(subjectMatchesNatsGrant("webchannel.t2.a1.p1.in", "webchannel.t1.>")).toBe(false);
  });
});

describe("formatPermissionTemplate", () => {
  it("renders all three roles with the observer deny-all visible", () => {
    const out = formatPermissionTemplate("t1");
    expect(out).toContain("webchannel.t1.>");
    expect(out).toContain("webchannel.t1.*.{peerId}.>");
    // The observer's explicit deny-all publish must be visible in the human output.
    expect(out).toMatch(/pub deny:\s*>/);
  });
});
