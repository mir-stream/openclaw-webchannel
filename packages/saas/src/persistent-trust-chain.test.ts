import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
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

  it("round-trips the opt-in operatorSeed across reload (issue #7)", async () => {
    const a = await loadOrCreateTrustChain(path, { returnOperatorSeed: true });
    expect(a.private.operatorSeed).toMatch(/^SO/);
    // A second load reads it back off disk (private is JSON-serialized wholesale).
    const b = await loadOrCreateTrustChain(path, { returnOperatorSeed: true });
    expect(b.private.operatorSeed).toBe(a.private.operatorSeed);
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

  // A3: a corrupt (non-JSON) file must fail with an actionable message, not a
  // raw JSON SyntaxError — and must NOT be silently regenerated.
  it("throws a legible, recovery-guiding error on a corrupt (non-JSON) file", async () => {
    const flat = join(dir, "trust-chain.json");
    writeFileSync(flat, "{ this is not json"); // e.g. a half-written file
    await expect(loadOrCreateTrustChain(flat)).rejects.toThrow(
      /corrupt \(not valid JSON\)[\s\S]*delete the file/,
    );
  });

  // A3: the write is atomic — after a successful create, only the real file
  // exists (no leftover *.tmp partial that a later boot could trip over).
  it("writes atomically, leaving no leftover temp file", async () => {
    await loadOrCreateTrustChain(path);
    const nestedDir = join(dir, "nested");
    const entries = readdirSync(nestedDir);
    expect(entries).toEqual(["trust-chain.json"]);
    expect(entries.some((f) => f.includes(".tmp"))).toBe(false);
  });
});
