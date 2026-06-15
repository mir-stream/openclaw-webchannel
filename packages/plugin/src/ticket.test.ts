import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";

import { issueWebChannelTicket, verifyTicket } from "./ticket.js";

const SECRET = "test-shared-secret";

describe("webchannel ticket sign/verify", () => {
  it("round-trips issue -> verify and returns the sub", () => {
    const token = issueWebChannelTicket({
      sub: "user-42",
      secret: SECRET,
      ttlSeconds: 60,
    });
    const identity = verifyTicket(token, SECRET);
    expect(identity).toEqual({ sub: "user-42" });
  });

  it("carries an optional display name as the `name` claim", () => {
    const token = issueWebChannelTicket({
      sub: "user-42",
      secret: SECRET,
      ttlSeconds: 60,
      displayName: "Ada",
    });
    expect(verifyTicket(token, SECRET)).toEqual({ sub: "user-42", name: "Ada" });
  });

  it("rejects an expired ticket", () => {
    const token = issueWebChannelTicket({
      sub: "user-42",
      secret: SECRET,
      ttlSeconds: -1, // already expired
    });
    expect(verifyTicket(token, SECRET)).toBeNull();
  });

  it("accepts a just-expired ticket within clock-skew leeway", () => {
    const token = issueWebChannelTicket({
      sub: "user-42",
      secret: SECRET,
      ttlSeconds: -1,
    });
    expect(verifyTicket(token, SECRET, { clockSkewSeconds: 5 })).toEqual({
      sub: "user-42",
    });
  });

  it("rejects a tampered signature", () => {
    const token = issueWebChannelTicket({
      sub: "user-42",
      secret: SECRET,
      ttlSeconds: 60,
    });
    const [h, p] = token.split(".");
    const tampered = `${h}.${p}.${"A".repeat(43)}`;
    expect(verifyTicket(tampered, SECRET)).toBeNull();
  });

  it("rejects a tampered payload (signature no longer matches)", () => {
    const token = issueWebChannelTicket({
      sub: "user-42",
      secret: SECRET,
      ttlSeconds: 60,
    });
    const [h, , sig] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: "attacker", iat: 0, exp: 9999999999 }),
      "utf8",
    ).toString("base64url");
    expect(verifyTicket(`${h}.${forgedPayload}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects a ticket signed with a different secret", () => {
    const token = issueWebChannelTicket({
      sub: "user-42",
      secret: "other-secret",
      ttlSeconds: 60,
    });
    expect(verifyTicket(token, SECRET)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyTicket("", SECRET)).toBeNull();
    expect(verifyTicket("not-a-jwt", SECRET)).toBeNull();
    expect(verifyTicket("only.two", SECRET)).toBeNull();
    expect(verifyTicket("a.b.c.d", SECRET)).toBeNull();
    expect(verifyTicket(undefined, SECRET)).toBeNull();
    expect(verifyTicket(123 as unknown, SECRET)).toBeNull();
  });

  it("rejects a token whose payload is missing sub", () => {
    // Hand-build a validly-signed token with no `sub`.
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
      "utf8",
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iat: 0, exp: 9999999999 }),
      "utf8",
    ).toString("base64url");
    // Sign it correctly so only the missing-sub check can reject it.
    const sig = createHmac("sha256", SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(verifyTicket(`${header}.${payload}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects a forged token whose header declares alg:none", () => {
    // Forge a header that pins no real algorithm, with an otherwise-valid
    // payload (good sub, far-future exp). The explicit HS256 pinning must
    // reject it regardless of signature.
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
      "utf8",
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "attacker", iat: 0, exp: 9999999999 }),
      "utf8",
    ).toString("base64url");
    // Sign it with a CORRECT HS256 HMAC over `header.payload`. With a valid
    // signature, the HMAC check cannot reject this token, so the ONLY thing
    // left that can return null is the alg-pin -- this isolates and locks in
    // the alg-pinning behavior rather than accidentally exercising the
    // signature check.
    const sig = createHmac("sha256", SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    const forged = `${header}.${payload}.${sig}`;
    expect(verifyTicket(forged, SECRET)).toBeNull();
  });
});
