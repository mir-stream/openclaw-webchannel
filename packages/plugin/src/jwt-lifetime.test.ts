import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { verifyJwt } from "./jwt.js";
import { buildBootstrapClaims } from "../../saas/src/bootstrap-claims.js";
import { createBootstrapIssuer } from "../../saas/src/bootstrap-issuer.js";

const now = 1_800_000_000;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { getKey: async () => ({ ...keys.publicKey.export({ format: "jwk" }), kid: "lifetime" }) };
const claims = { iss: "https://issuer.test", aud: "account", sub: "peer", iat: now, exp: now + 300 };
function token(payload: Record<string, unknown> | string) {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "lifetime" })).toString("base64url");
  const body = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)).toString("base64url");
  const input = `${head}.${body}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
}
function verify(payload: Record<string, unknown> | string, clockSkewSec = 60) {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  return verifyJwt(token(payload), { jwks, issuer: claims.iss, audience: claims.aud, clockSkewSec });
}
afterEach(() => vi.restoreAllMocks());

it.each([undefined, null, "1800000000", true, [], {}].map(iat => ({ iat })))(
  "E7 rejects missing/malformed iat=$iat", async ({ iat }) => {
    expect(await verify({ ...claims, iat })).toBeNull();
  },
);
it.each(["1e400", "-1e400"])("E7 rejects a non-finite signed iat (%s)", async iat => {
  expect(await verify(JSON.stringify(claims).replace(`"iat":${now}`, `"iat":${iat}`))).toBeNull();
});
it.each([0, -1, 3600.001, 3601])("E7 refuses lifetime %s even with clock skew", async lifetime => {
  expect(await verify({ ...claims, exp: now + lifetime }, 120)).toBeNull();
});
it("E7 admits exactly one hour and applies leeway only to the clock", async () => {
  expect(await verify({ ...claims, iat: now + 60, exp: now + 3660 })).toEqual({ peerId: "peer" });
  expect(await verify({ ...claims, iat: now - 3659, exp: now - 59 })).toEqual({ peerId: "peer" });
});
it("E7 refuses future issuance beyond leeway", async () => {
  expect(await verify({ ...claims, iat: now + 61 })).toBeNull();
  expect(await verify({ ...claims, iat: now + 0.5 }, 0)).toBeNull();
});

const input = { iss: claims.iss, peerId: claims.sub, accountId: claims.aud, tenant: "tenant", deviceX25519PublicKey: Buffer.alloc(32, 1).toString("base64url"), nowSeconds: now };
it.each([0, -1, 3601, Infinity, NaN])("E7 SaaS refuses invalid/overlong ttl %s", ttlSeconds => {
  expect(() => buildBootstrapClaims({ ...input, ttlSeconds })).toThrow(/lifetime/i);
});
it("E7 issuer cannot bypass the claim builder's lifetime limit", async () => {
  const issuer = await createBootstrapIssuer({ kid: "lifetime", rsaPrivateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  const base = buildBootstrapClaims(input);
  for (const invalid of [{ iat: undefined }, { iat: NaN }, { exp: Infinity }, { exp: now }, { exp: now + 3601 }]) {
    await expect(issuer.sign({ ...base, ...invalid } as typeof base)).rejects.toThrow(/lifetime/i);
  }
});
it.each([undefined, 3600])("E7 SaaS JWT with ttl=%s passes the real plugin verifier", async ttlSeconds => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  const issuer = await createBootstrapIssuer({ kid: "lifetime", rsaPrivateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  const payload = buildBootstrapClaims({ ...input, ttlSeconds });
  const jwt = await issuer.sign(payload);
  expect(payload.exp - payload.iat).toBe(ttlSeconds ?? 300);
  expect(await verifyJwt(jwt, { jwks, issuer: claims.iss, audience: claims.aud })).toMatchObject({ peerId: "peer" });
});
