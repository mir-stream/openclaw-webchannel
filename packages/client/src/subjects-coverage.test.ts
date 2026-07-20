/**
 * Client subject-coverage (P0-3 D3, option B).
 *
 * The client package is zero-dependency by design and cannot import the plugin's
 * `nats-permission-template` / `subjects` modules (there is no shared package —
 * see nats-client.ts subject helpers + protocol.ts). So instead of a shared
 * canonical module, this test pins the CLIENT's own subject builders against the
 * SAME repo-root fixture the plugin/saas parity tests use
 * (`contracts/nats-permissions.v1.json`). If a client subject drifts outside the
 * browser grant — especially the security-sensitive reginbox reply channel — this
 * breaks even though the plugin coverage test would stay green.
 *
 * The NATS wildcard matcher is inlined here (test-only, ~10 lines) because the
 * client cannot import the plugin's `subjectMatchesNatsGrant`; it mirrors the same
 * nats-server semantics.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  inboundSubject,
  outboundSubject,
  registerSubject,
  reginboxPrefix,
} from "./nats-client.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../contracts/nats-permissions.v1.json", import.meta.url),
);

type Grant = { allow: string[]; deny: string[] };
type Fixture = { browser: { pub: Grant; sub: Grant } };

/** NATS subject match: `*` = one token, `>` = one-or-more trailing tokens (last only). */
function subjectMatchesNatsGrant(subject: string, pattern: string): boolean {
  const s = subject.split(".");
  const p = pattern.split(".");
  for (let i = 0; i < p.length; i++) {
    const pt = p[i];
    if (pt === ">") return i === p.length - 1 && s.length > i;
    if (i >= s.length) return false;
    if (pt === "*") continue;
    if (pt !== s[i]) return false;
  }
  return s.length === p.length;
}

describe("client subject-coverage — builders fall within the browser grant", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
  // Fixture sample values: tenant=t1, peerId=p1, accountId=a1.
  const T = "t1";
  const A = "a1";
  const P = "p1";
  const browserGrant = fixture.browser.pub.allow; // ["webchannel.t1.*.p1.>"]

  const clientSubjects: Array<[string, string]> = [
    ["inbound", inboundSubject(T, A, P)],
    ["outbound", outboundSubject(T, A, P)],
    ["register", registerSubject(T, A, P)],
    // The reginbox reply channel: the low-level client appends `.{token}`, so the
    // real reply subject is `…reginbox.{token}` — check that exact shape.
    ["reginbox reply", `${reginboxPrefix(T, A, P)}.sometoken`],
  ];

  for (const [label, subject] of clientSubjects) {
    it(`${label} (${subject}) is covered by the browser grant`, () => {
      const allowed = browserGrant.some((g) => subjectMatchesNatsGrant(subject, g));
      expect(allowed, `browser grant ${JSON.stringify(browserGrant)} must cover ${subject}`).toBe(true);
    });
  }

  it("a DIFFERENT peer's reginbox is NOT covered (reply-channel isolation)", () => {
    const foreign = `${reginboxPrefix(T, A, "victim-99")}.token`;
    const allowed = browserGrant.some((g) => subjectMatchesNatsGrant(foreign, g));
    expect(allowed).toBe(false);
  });
});
