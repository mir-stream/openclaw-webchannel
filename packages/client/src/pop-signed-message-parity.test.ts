/**
 * Cross-package BYTE-IDENTITY contract for the PoP signed message.
 *
 * The agent (`packages/plugin/src/pop-signed-message.ts`) and the browser
 * (`packages/client/src/pop-register.ts`) each declare their own
 * `popSignedMessage` — there is no shared package between them. Drift of a single
 * byte means every PoP registration fails signature verification, presenting as a
 * key or crypto bug rather than a contract break.
 *
 * Same seam pattern as `wrap-aad-parity.test.ts`: both implementations imported by
 * relative source path and compared directly. The agent half is deliberately kept
 * free of `node:` imports so it typechecks under this package's browser-only libs.
 */

import { describe, it, expect } from "vitest";

import {
  popSignedMessage as agentPopSignedMessage,
  type PopOp as AgentPopOp,
} from "../../plugin/src/pop-signed-message.js";
import { popSignedMessage as browserPopSignedMessage, type PopOp } from "./pop-register.js";

/** Every op in the closed vocabulary. Widening `PopOp` without widening this is a compile error. */
const ALL_OPS: readonly PopOp[] = ["register", "unregister"];

describe("popSignedMessage byte-identity (agent ↔ browser)", () => {
  it("the two PopOp vocabularies are assignable in both directions", () => {
    // A purely type-level assertion: if either side adds or renames an op without
    // the other, this stops compiling.
    const toAgent: AgentPopOp[] = [...ALL_OPS];
    const toBrowser: PopOp[] = [...toAgent];
    expect(toBrowser).toEqual(["register", "unregister"]);
  });

  it.each([
    ["user-42", "Y2hhbGxlbmdlLW5vbmNlLXZhbHVlLTAx"],
    ["a", "n"],
    ["A-Za-z0-9_-", "-_09azAZ".repeat(8)],
    ["x".repeat(128), "Q".repeat(43)],
  ])("agrees byte-for-byte for every op with peerId=%s", (peerId, nonce) => {
    for (const op of ALL_OPS) {
      expect(browserPopSignedMessage(op, peerId, nonce)).toBe(
        agentPopSignedMessage(op, peerId, nonce),
      );
    }
  });

  it("matches the hand-written golden encoding", () => {
    // A third, independent spelling — so a matching edit to BOTH implementations
    // still trips this.
    expect(agentPopSignedMessage("register", "user-42", "abc")).toBe(
      "webchannel-pop:register:user-42:abc",
    );
    expect(browserPopSignedMessage("unregister", "user-42", "abc")).toBe(
      "webchannel-pop:unregister:user-42:abc",
    );
  });

  it("binds the op: the two ops never produce the same message", () => {
    // The property the P1 fix rests on. Without it a register proof authorizes a
    // teardown, because both ops verify against the same per-peer nonce bucket.
    expect(agentPopSignedMessage("register", "p", "n")).not.toBe(
      agentPopSignedMessage("unregister", "p", "n"),
    );
  });

  it("is INJECTIVE even for a peerId full of colons (no reliance on the caller)", () => {
    // Injectivity must NOT depend on `assertValidSubjectToken` running at every
    // call site — that assumption already failed once (the unregister branch
    // returned before register's copy of the check). It holds from the two fields
    // the encoding controls: `op` is a closed vocabulary of colon-free literals
    // where neither value is a prefix of the other, fixing the front; `nonce` is
    // agent-issued base64url and colon-free, fixing the back. Everything between
    // is the peerId, whatever it contains.
    const nonce = "Y2hhbGxlbmdlLW5vbmNl"; // colon-free by construction
    const hostile = ["a:b", ":", "::", "register:x", "unregister:x", "a:b:c:d"];
    const seen = new Map<string, string>();
    for (const op of ALL_OPS) {
      for (const peerId of hostile) {
        const key = `${op}|${peerId}`;
        const msg = agentPopSignedMessage(op, peerId, nonce);
        expect(seen.has(msg), `collision: ${seen.get(msg)} vs ${key}`).toBe(false);
        seen.set(msg, key);
        // Recoverable: split off the fixed prefix, then take the LAST colon.
        expect(msg.startsWith(`webchannel-pop:${op}:`)).toBe(true);
        expect(msg.slice(msg.lastIndexOf(":") + 1)).toBe(nonce);
        expect(msg.slice(`webchannel-pop:${op}:`.length, msg.lastIndexOf(":"))).toBe(peerId);
      }
    }
  });

  it("is INJECTIVE — no two distinct field triples collide", () => {
    // `:` occurs nowhere in any field (closed op vocabulary, subject-token peerId,
    // base64url nonce), so the delimiters cannot be forged across a boundary.
    const seen = new Map<string, string>();
    for (const op of ALL_OPS) {
      for (const peerId of ["a", "ab", "abc", "a-b", "register", "unregister"]) {
        for (const nonce of ["n", "nn", "b-n", "abc"]) {
          const key = `${op}|${peerId}|${nonce}`;
          const msg = agentPopSignedMessage(op, peerId, nonce);
          expect(seen.has(msg), `collision: ${seen.get(msg)} vs ${key}`).toBe(false);
          seen.set(msg, key);
        }
      }
    }
  });

  it("is unambiguous against the v2 (op-less) encoding it replaces", () => {
    // v2 was `webchannel-pop:{peerId}:{nonce}` — three colon-separated fields
    // where v3 has four. A collision would need a v2 peerId containing `:`, and
    // `assertValidSubjectToken` (SAFE_SUBJECT_TOKEN) forbids exactly that, so
    // over LEGAL inputs the two message spaces are disjoint.
    const SAFE_SUBJECT_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
    const v2 = (peerId: string, nonce: string) => `webchannel-pop:${peerId}:${nonce}`;

    const legalPeerIds = ["user-42", "register", "unregister", "a", "A-Za-z0-9_-"];
    const nonces = ["abc", "Y2hhbGxlbmdlLW5vbmNl", "n"];
    for (const peerId of legalPeerIds) {
      expect(SAFE_SUBJECT_TOKEN.test(peerId)).toBe(true);
      for (const nonce of nonces) {
        for (const op of ALL_OPS) {
          expect(v2(peerId, nonce)).not.toBe(agentPopSignedMessage(op, peerId, nonce));
        }
      }
    }

    // And the only string that WOULD collide is an illegal peerId, which never
    // reaches a verify: the handler rejects it before any subject or PoP use.
    expect(SAFE_SUBJECT_TOKEN.test("register:user-42")).toBe(false);
    expect(v2("register:user-42", "abc")).toBe(
      agentPopSignedMessage("register", "user-42", "abc"),
    );
  });
});
