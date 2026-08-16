#!/usr/bin/env node
/**
 * Reference CLI harness for setupTrustChain.
 *
 * This script demonstrates how to run setupTrustChain and persist its
 * artifacts. It's intended as a reference implementation, not a production CLI.
 *
 * USAGE:
 *   node dist/reference/setup-trust-chain.js
 *
 * OUTPUTS:
 *   - ./saas-private.json  (SaaS private key material — KEEP SECRET)
 *   - ./nats-config.json    (nats-server configuration)
 *   - ./jwks.json          (JWKS document for publishing)
 *
 * SECURITY NOTES:
 *   - saas-private.json contains the RSA private key and NKEY seed.
 *     Store this securely (e.g., env vars, secret manager, HSM).
 *   - nats-config.json contains operator/account JWTs and resolver config.
 *     Load this into nats-server at startup.
 *   - jwks.json contains only public keys and can be published openly.
 */

import { setupTrustChain } from "../src/setup-trust-chain.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  console.log("🔐 Generating SaaS trust chain...\n");

  const trustChain = await setupTrustChain({
    operatorName: "openclaw-webchannel-operator",
    accountName: "openclaw-webchannel-account",
    rsaKeySize: 2048,
  });

  // -----------------------------------------------------------------------
  // Persist private artifacts (SaaS-only)
  // -----------------------------------------------------------------------

  const privatePath = join(__dirname, "saas-private.json");
  await writeFile(privatePath, JSON.stringify(trustChain.private, null, 2), {
    mode: 0o600, // Read/write for owner only
  });
  console.log(`✅ Private keys written to: ${privatePath}`);
  console.log(`   ⚠️  KEEP THIS FILE SECRET — contains RSA private key + NKEY seed\n`);

  // -----------------------------------------------------------------------
  // Persist NATS configuration (nats-server)
  // -----------------------------------------------------------------------

  const natsConfigPath = join(__dirname, "nats-config.json");
  await writeFile(
    natsConfigPath,
    JSON.stringify(trustChain.natsConfig, null, 2),
    { mode: 0o644 },
  );
  console.log(`✅ NATS config written to: ${natsConfigPath}`);
  console.log(`   📋 Load this into nats-server at startup\n`);

  // -----------------------------------------------------------------------
  // Persist JWKS document (public endpoint)
  // -----------------------------------------------------------------------

  const jwksPath = join(__dirname, "jwks.json");
  await writeFile(jwksPath, JSON.stringify(trustChain.jwks, null, 2), {
    mode: 0o644,
  });
  console.log(`✅ JWKS document written to: ${jwksPath}`);
  console.log(`   🌐 Publish this at https://your-saas.com/.well-known/jwks.json\n`);

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------

  console.log("📝 Summary:\n");
  console.log(`   Key ID (kid):           ${trustChain.kid}`);
  console.log(
    `   Account public NKEY:   ${trustChain.natsConfig.accountPublicKey}`,
  );
  console.log(`   Operator JWT:           ${trustChain.natsConfig.operatorJwt.slice(0, 50)}...`);
  console.log(
    `   Account JWT:            ${trustChain.natsConfig.accountJwt.slice(0, 50)}...`,
  );
  console.log("\n🚀 Trust chain ready!");
  console.log("\nNext steps:");
  console.log("  1. Store saas-private.json securely (env var, secret manager, HSM)");
  console.log("  2. Seed a nats-server full/Dir resolver from nats-config.json");
  console.log("  3. Publish jwks.json at your SaaS JWKS endpoint");
  console.log("  4. Verify nats-server starts with the new config");
  console.log("  5. Test plugin enrollment with the new trust chain\n");
}

main().catch((err) => {
  console.error("❌ Failed to generate trust chain:", err);
  process.exit(1);
});
