// One-shot helper: initialize the demo JWT issuer (generates RSA-2048 if
// needed, caches to demo/.cache), mint a JWT for `sub`, and emit both the
// public JWKS and the JWT on stdout as two JSON lines.
//
// Usage: node scripts/jwt-smoke-bootstrap.mjs > /tmp/jwt-smoke.json
//   line 1: { jwks: { keys: [...] }, issuer, audience, kid }
//   line 2: { jwt: "eyJ..." }

import { initDevJwtIssuer } from "/Users/mircorn/workspace/openclaw-webchannel/packages/client/demo/devTicket.jwt.ts";

const ISSUER = "https://demo.local/";
const AUDIENCE = "webchannel-smoke";
const SUB = "smoke-user";

const issuer = await initDevJwtIssuer({ issuer: ISSUER, audience: AUDIENCE });
const jwt = await issuer.signJwt(SUB, 60);

process.stdout.write(
  JSON.stringify({
    jwks: { keys: [issuer.publicJwk] },
    issuer: ISSUER,
    audience: AUDIENCE,
    kid: issuer.kid,
  }) + "\n",
);
process.stdout.write(JSON.stringify({ jwt }) + "\n");