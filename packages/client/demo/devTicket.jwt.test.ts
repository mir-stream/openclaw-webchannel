/**
 * Cross-runtime happy-path smoke: the demo-side `initDevJwtIssuer` mints an
 * RS256 JWT, and the server-side `verifyJwt` accepts it. This guards against
 * drift between the demo's encoding and the server's decoding (base64url,
 * algorithm choice, claim names).
 *
 * Lives in the demo/ directory because the demo is the only legitimate
 * issuer-of-tickets-with-our-format the test fixture needs. The plugin-side
 * verifier is imported from `openclaw-webchannel/src/jwt.js` via relative path
 * since the client package isn't a published module.
 */
import { describe, it, expect, beforeAll } from "vitest";

import { initDevJwtIssuer } from "./devTicket.jwt.js";
import { verifyJwt } from "../../plugin/src/jwt.js";
import { JWKSCache, type JsonWebKeySet } from "../../plugin/src/jwks.js";

const ISSUER = "https://demo.local/";
const AUDIENCE = "webchannel-demo";

describe("demo devTicket.jwt ↔ plugin verifyJwt round-trip", () => {
  let issuer: Awaited<ReturnType<typeof initDevJwtIssuer>>;
  let jwks: ReturnType<typeof JWKSCache.create>;

  beforeAll(async () => {
    // In-memory storage so the test doesn't touch real localStorage.
    const memStorage = {
      _v: null as string | null,
      async read() {
        return this._v;
      },
      async write(v: string) {
        this._v = v;
      },
    };
    issuer = await initDevJwtIssuer({
      issuer: ISSUER,
      audience: AUDIENCE,
      storage: memStorage,
    });
    const inlineJwks: JsonWebKeySet = { keys: [issuer.publicJwk as JsonWebKeySet["keys"][number]] };
    jwks = JWKSCache.create({ jwks: inlineJwks });
  });

  it("mints and verifies a token with sub + displayName", async () => {
    const token = await issuer.signJwt("alice");
    const id = await verifyJwt(token, {
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(id).toEqual({ peerId: "alice" });
  });

  it("rejects a token with a mismatched issuer", async () => {
    const token = await issuer.signJwt("alice");
    const id = await verifyJwt(token, {
      jwks,
      issuer: "https://other/",
      audience: AUDIENCE,
    });
    expect(id).toBeNull();
  });
});
