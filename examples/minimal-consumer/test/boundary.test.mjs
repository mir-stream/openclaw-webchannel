/**
 * Encapsulation boundary test (plain node, no framework).
 *
 * Asserts BOTH directions of the package boundary:
 *   1. PUBLIC works  — the barrel exports the expected operator/widget symbols.
 *   2. INTERNALS blocked — deep-importing an internal module (raw NATS-creds
 *      mint, subject-token guard, raw client transport) REJECTS with
 *      ERR_PACKAGE_PATH_NOT_EXPORTED, i.e. the exports map is the only door in.
 *
 * Exits non-zero on the first failed assertion.
 */

import assert from "node:assert/strict";

let failed = 0;
function ok(name, fn) {
  return fn().then(
    () => console.log(`ok - ${name}`),
    (err) => {
      failed++;
      console.error(`not ok - ${name}\n    ${err.stack || err}`);
    },
  );
}

// ---------------------------------------------------------------------------
// 1. PUBLIC surface is importable and exposes the expected symbols.
// ---------------------------------------------------------------------------
await ok("saas barrel exposes operator symbols", async () => {
  const saas = await import("@mir-stream/webchannel-saas");
  for (const sym of [
    "setupTrustChain",
    "loadOrCreateTrustChain",
    "generateRsaKeypair",
    "DeviceFlowEnrollment",
    "MemoryEnrollmentStore",
    "buildBootstrapClaims",
  ]) {
    assert.equal(typeof saas[sym], "function", `expected ${sym} to be exported`);
  }
});

await ok("saas barrel does NOT leak raw mint / subject-token guards", async () => {
  const saas = await import("@mir-stream/webchannel-saas");
  for (const sym of ["mintNatsUserCreds", "assertValidSubjectToken"]) {
    assert.equal(saas[sym], undefined, `${sym} must NOT be re-exported by the barrel`);
  }
});

await ok("client barrel exposes the widget client", async () => {
  const client = await import("@mir-stream/webchannel-client");
  assert.equal(typeof client.WebChannelNATSClient, "function");
});

// ---------------------------------------------------------------------------
// 2. INTERNAL modules are unreachable through the exports map.
// ---------------------------------------------------------------------------
async function assertNotExported(specifier) {
  try {
    await import(specifier);
    assert.fail(`expected ${specifier} to be blocked by the exports map`);
  } catch (err) {
    assert.equal(
      err.code,
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
      `expected ERR_PACKAGE_PATH_NOT_EXPORTED for ${specifier}, got ${err.code}: ${err.message}`,
    );
  }
}

await ok("saas internal nats-user-creds is not exported", () =>
  assertNotExported("@mir-stream/webchannel-saas/nats-user-creds"),
);
await ok("saas internal subject-token is not exported", () =>
  assertNotExported("@mir-stream/webchannel-saas/subject-token"),
);
await ok("client internal nats-client is not exported", () =>
  assertNotExported("@mir-stream/webchannel-client/nats-client"),
);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall boundary assertions passed");
