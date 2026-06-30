import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadOrCreateTrustChain } from "./persistent-trust-chain.js";

describe("loadOrCreateTrustChain", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oc-tc-"));
    path = join(dir, "nested", "trust-chain.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates + persists a new chain on first call (parent dir made)", async () => {
    expect(existsSync(path)).toBe(false);
    const chain = await loadOrCreateTrustChain(path);
    expect(existsSync(path)).toBe(true);
    expect(chain.private.rsaPrivateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(chain.private.natsAccountSeed).toBeTruthy();
    expect(chain.natsConfig.operatorJwt).toBeTruthy();
    expect(chain.kid).toBeTruthy();
  });

  it("writes the secret file with 0600 permissions", async () => {
    await loadOrCreateTrustChain(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("returns the IDENTICAL chain on reload (stable across restarts)", async () => {
    const a = await loadOrCreateTrustChain(path);
    const b = await loadOrCreateTrustChain(path);
    expect(b.kid).toBe(a.kid);
    expect(b.natsConfig.accountPublicKey).toBe(a.natsConfig.accountPublicKey);
    expect(b.private.natsAccountSeed).toBe(a.private.natsAccountSeed);
    expect(b.private.rsaPrivateKeyPem).toBe(a.private.rsaPrivateKeyPem);
  });

  it("does NOT regenerate when a file already exists", async () => {
    const a = await loadOrCreateTrustChain(path);
    const b = await loadOrCreateTrustChain(path);
    // A fresh setupTrustChain() would produce different operator/account keys.
    expect(b.natsConfig.operatorJwt).toBe(a.natsConfig.operatorJwt);
    expect(b.natsConfig.accountJwt).toBe(a.natsConfig.accountJwt);
  });

  it("throws loudly on a truncated/invalid persisted file", async () => {
    const flat = join(dir, "trust-chain.json"); // dir already exists (mkdtemp)
    writeFileSync(flat, JSON.stringify({ private: {} }));
    await expect(loadOrCreateTrustChain(flat)).rejects.toThrow(/missing required fields/);
  });
});
