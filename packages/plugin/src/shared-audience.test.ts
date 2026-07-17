import { describe, it, expect } from "vitest";

import { detectSharedAudienceCollisions } from "./shared-audience.js";
import type { AuthConfig } from "./auth.js";

/** Build a jwt AuthConfig with the given issuer/audience. */
function jwtAuth(issuer: string | undefined, audience: string | undefined): AuthConfig {
  return {
    strategy: "jwt",
    jwt: {
      jwksUrl: "https://idp/.well-known/jwks.json",
      ...(issuer !== undefined ? { issuer } : {}),
      ...(audience !== undefined ? { audience } : {}),
    },
  } as AuthConfig;
}

describe("detectSharedAudienceCollisions (P0-3 D6-1)", () => {
  it("skips EVERY member of a collision set (not just the second claimant)", () => {
    const collisions = detectSharedAudienceCollisions([
      { accountId: "a", auth: jwtAuth("https://idp", "shared") },
      { accountId: "b", auth: jwtAuth("https://idp", "shared") },
      { accountId: "c", auth: jwtAuth("https://idp", "shared") },
    ]);
    expect([...collisions.keys()].sort()).toEqual(["a", "b", "c"]);
    // Each skipped account names its OTHER colliding peers (never itself).
    expect(collisions.get("a")!.peers.sort()).toEqual(["b", "c"]);
    expect(collisions.get("b")!.peers.sort()).toEqual(["a", "c"]);
    expect(collisions.get("a")!.audience).toBe("shared");
  });

  it("leaves a non-colliding account (unique issuer,audience) out of the skip map", () => {
    const collisions = detectSharedAudienceCollisions([
      { accountId: "a", auth: jwtAuth("https://idp", "shared") },
      { accountId: "b", auth: jwtAuth("https://idp", "shared") },
      { accountId: "solo", auth: jwtAuth("https://idp", "solo-aud") },
    ]);
    expect(collisions.has("solo")).toBe(false);
    expect(collisions.has("a")).toBe(true);
    expect(collisions.has("b")).toBe(true);
  });

  it("normalizes the issuer the way verifyJwt compares it (trailing slash collapsed)", () => {
    // A config-pinned "https://idp/" and a derived "https://idp" cross-verify at
    // runtime, so they MUST be treated as the same collision key.
    const collisions = detectSharedAudienceCollisions([
      { accountId: "a", auth: jwtAuth("https://idp/", "shared") },
      { accountId: "b", auth: jwtAuth("https://idp", "shared") },
    ]);
    expect(collisions.has("a")).toBe(true);
    expect(collisions.has("b")).toBe(true);
  });

  it("ignores accounts without a jwt issuer/audience or a non-jwt strategy", () => {
    const collisions = detectSharedAudienceCollisions([
      { accountId: "no-aud", auth: jwtAuth("https://idp", undefined) },
      { accountId: "no-iss", auth: jwtAuth(undefined, "shared") },
      { accountId: "undef", auth: undefined },
    ]);
    expect(collisions.size).toBe(0);
  });

  it("a single account with a unique audience is not a collision", () => {
    const collisions = detectSharedAudienceCollisions([
      { accountId: "only", auth: jwtAuth("https://idp", "only-aud") },
    ]);
    expect(collisions.size).toBe(0);
  });
});
