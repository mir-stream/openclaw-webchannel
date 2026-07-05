/**
 * Delivered-issuer ⇔ minted-issuer single-source guard.
 *
 * `EnrollmentResult.issuer` DECLARES the exact `iss` the SaaS mints into
 * bootstrap JWTs, but the library cannot enforce that promise: minting
 * (`buildBootstrapClaims({ iss })`) and delivery (`DeviceFlowOptions.issuer`)
 * are independent parameters. A server that configures them from two different
 * values re-creates the very split-brain the delivered issuer exists to kill —
 * enrollment then hands the agent a promise the mint breaks, and every
 * register is rejected with an opaque `unauthorized`.
 *
 * The repo's two reference servers make the contract structural by deriving
 * BOTH from the single `SAAS_ISSUER` variable. This static guard pins that
 * pattern so a refactor cannot silently split them again. (The live proof is
 * demo/run.sh itself: it keeps a deliberately fake SAAS_ISSUER and pins no
 * `auth.jwt.issuer` anywhere, so a delivery regression fails every demo boot.)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/saas/src
const REPO_ROOT = join(HERE, "..", "..", "..");

const SERVERS = [
  join(REPO_ROOT, "demo", "saas-server.ts"),
  join(REPO_ROOT, "examples", "webchannel-app", "server", "index.ts"),
];

describe("issuer single-source (delivered == minted)", () => {
  for (const path of SERVERS) {
    const rel = path.slice(REPO_ROOT.length + 1);

    it(`${rel}: mints AND delivers the one SAAS_ISSUER variable`, () => {
      const src = readFileSync(path, "utf-8");

      // Every bootstrap-JWT mint reads the single variable…
      const mints = src.match(/\biss:\s*([A-Za-z_$][\w$]*)/g) ?? [];
      expect(mints.length).toBeGreaterThan(0);
      for (const m of mints) {
        expect(m).toBe("iss: SAAS_ISSUER");
      }

      // …and the enrollment delivery reads the SAME variable.
      expect(src).toMatch(/\bissuer:\s*SAAS_ISSUER\b/);
    });
  }
});
