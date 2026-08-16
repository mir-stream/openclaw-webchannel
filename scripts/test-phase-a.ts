#!/usr/bin/env node
/**
 * Phase A Regression Test Runner.
 *
 * This script runs all Phase A tests to verify they still pass
 * after AC 6 implementation.
 *
 * Phase A includes:
 *  - E2E crypto primitives (X25519+HKDF-SHA256+ChaCha20-Poly1305)
 *  - NATS transport layer
 *  - Envelope encryption/decryption
 *  - Multi-device support
 *  - Late-join decryption
 *  - History management
 *  - Approval workflows
 *  - Typing indicators
 *  - All 596 existing tests
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Phase A test files (from packages/plugin and packages/client)
const PHASE_A_TEST_PATTERNS = [
  "packages/plugin/src/e2e-crypto.test.ts",
  "packages/plugin/src/e2e-envelope.test.ts",
  "packages/plugin/src/nats-transport.test.ts",
  "packages/plugin/src/nats-transport-integration.test.ts",
  "packages/plugin/src/nats-transport-realserver.test.ts",
  "packages/plugin/src/crypto-nats-channel-integration.test.ts",
  "packages/plugin/src/multidevice-broadcast.test.ts",
  "packages/plugin/src/late-join-decryptor.test.ts",
  "packages/plugin/src/history.test.ts",
  "packages/plugin/src/approvals.test.ts",
  "packages/plugin/src/approval-broadcast-integration.test.ts",
  "packages/plugin/src/approval-e2e-crypto.test.ts",
  "packages/plugin/src/inbound-queue.test.ts",
  "packages/plugin/src/typing.test.ts",
  "packages/client/src/*.test.ts",
];

console.log("Phase A Regression Test Runner");
console.log("===============================");
console.log("");
console.log("Running all Phase A tests to verify brownfield compatibility...");
console.log("");

// Run vitest with Phase A test patterns
const vitestArgs = [
  "run",
  ...PHASE_A_TEST_PATTERNS.flatMap(pattern => ["--test", pattern]),
  "--reporter=verbose",
];

const vitest = spawn("npx", ["vitest", ...vitestArgs], {
  cwd: join(__dirname, ".."),
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "test",
  },
});

vitest.on("close", (code) => {
  console.log("");
  if (code === 0) {
    console.log("✅ All Phase A tests passed!");
  } else {
    console.log(`❌ Some Phase A tests failed (exit code: ${code})`);
    process.exit(code || 1);
  }
});

vitest.on("error", (err) => {
  console.error("Failed to run vitest:", err);
  process.exit(1);
});
