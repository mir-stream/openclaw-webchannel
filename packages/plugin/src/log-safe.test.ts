import { describe, it, expect } from "vitest";

import { logSafe } from "./log-safe.js";

/**
 * #123 — the property under test is RECORD INTEGRITY, not "does not crash".
 * Every assertion here is about what the emitted text is, so the guard cannot
 * go green by merely surviving hostile input.
 */
describe("logSafe (#123)", () => {
  it("keeps an ordinary id readable and grep-able, just quoted", () => {
    expect(logSafe("turn-42")).toBe('"turn-42"');
    // The point of quoting rather than stripping: the id itself is still there
    // verbatim, so operator muscle memory (`grep turn-42`) keeps working.
    expect(logSafe("turn-42")).toContain("turn-42");
  });

  it("a newline-bearing value cannot become a second record", () => {
    const forged = logSafe("turn-42\nwebchannel: turn_settled was not delivered");
    expect(forged.split("\n")).toHaveLength(1);
    expect(forged).toContain("\\n");
    expect(forged).not.toContain("\n");
  });

  for (const [label, raw] of [
    ["LF", "a\nb"],
    ["CR", "a\rb"],
    ["CRLF", "a\r\nb"],
    ["NUL", "a\u0000b"],
    ["ANSI escape", "a\u001bb"],
    ["vertical tab", "a\u000bb"],
    ["form feed", "a\u000cb"],
    ["NEL (C1)", "a\u0085b"],
    ["DEL", "a\u007fb"],
    ["LINE SEPARATOR", "a\u2028b"],
    ["PARAGRAPH SEPARATOR", "a\u2029b"],
  ] as const) {
    it(`neutralises ${label}`, () => {
      const out = logSafe(raw);
      // No raw C0, DEL/C1, or Unicode line terminator survives into the record.
      expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
      expect(out.split(/[\n\r\u2028\u2029]/)).toHaveLength(1);
      // And the surrounding letters are still legible evidence.
      expect(out).toContain("a");
      expect(out).toContain("b");
    });
  }

  it("delimits the value so a peer cannot forge FIELDS inside a real record", () => {
    // Without quoting, this id would render as
    //   turn=x outcome=ok peer=trusted
    // which every key=value log parser reads as three genuine fields.
    const out = logSafe("x outcome=ok peer=trusted");
    expect(out.startsWith('"')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
    expect(out).toBe('"x outcome=ok peer=trusted"');
  });

  it("escapes an embedded quote so the delimiting cannot be closed early", () => {
    expect(logSafe('x" outcome=ok')).toBe('"x\\" outcome=ok"');
  });

  it("does not double-escape an already-escaped-looking value", () => {
    // A literal backslash-n in the id is data, not a newline; one pass only.
    expect(logSafe("turn\\n42")).toBe('"turn\\\\n42"');
  });

  it("renders non-string peer input without throwing", () => {
    // `turnId` traces to `message.id` off the wire and is not schema-validated
    // at the warn sites, so a non-string can arrive.
    expect(logSafe(undefined)).toBe('"undefined"');
    expect(logSafe(null)).toBe('"null"');
    expect(logSafe(42)).toBe('"42"');
    expect(logSafe({ id: "x" })).toBe('"[object Object]"');
  });

  it("never throws, even on a value whose toString throws", () => {
    // Several call sites are inside the settle loop's `finally`; a throw there
    // escapes into the dispatcher's `.catch(() => {})` and strands the turn.
    const hostile = {
      toString() {
        throw new Error("nope");
      },
    };
    expect(logSafe(hostile)).toBe('"<unprintable>"');
    // A Symbol is safe under explicit `String()` (only implicit coercion
    // throws), so it renders rather than falling back.
    expect(logSafe(Symbol("s"))).toBe('"Symbol(s)"');
  });
});
