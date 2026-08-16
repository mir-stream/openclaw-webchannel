import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { loadOrCreateTrustChain } from "./persistent-trust-chain.js";
import type { NatsSelfContainedAccountConfig } from "./types.js";

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
    expect(chain.private.systemAccountCredentials).toContain("BEGIN USER NKEY SEED");
    expect(chain.natsConfig.operatorJwt).toBeTruthy();
    expect(chain.natsConfig.systemAccountPublicKey).toMatch(/^A/);
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
    expect(b.private.systemAccountCredentials).toBe(a.private.systemAccountCredentials);
  });

  it("round-trips the opt-in operatorSeed across reload (issue #7)", async () => {
    const a = await loadOrCreateTrustChain(path, { returnOperatorSeed: true });
    expect(a.private.operatorSeed).toMatch(/^SO/);
    // A second load reads it back off disk (private is JSON-serialized wholesale).
    const b = await loadOrCreateTrustChain(path, { returnOperatorSeed: true });
    expect(b.private.operatorSeed).toBe(a.private.operatorSeed);
  });

  it("does not follow the legacy predictable temp symlink when persisting authority secrets", async () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fixedNow = 1_700_000_000_000;
    const legacyTempPath = `${path}.tmp.${process.pid}.${fixedNow}`;
    const sentinelPath = join(dir, "sentinel");
    writeFileSync(sentinelPath, "sentinel unchanged");
    symlinkSync(sentinelPath, legacyTempPath);
    const now = vi.spyOn(Date, "now").mockReturnValue(fixedNow);

    const created = await (async () => {
      try {
        return await loadOrCreateTrustChain(path, { returnOperatorSeed: true });
      } finally {
        now.mockRestore();
      }
    })();

    expect(readFileSync(sentinelPath, "utf8")).toBe("sentinel unchanged");
    const persistedEntry = lstatSync(path);
    expect(persistedEntry.isFile()).toBe(true);
    expect(persistedEntry.isSymbolicLink()).toBe(false);
    expect(persistedEntry.mode & 0o777).toBe(0o600);
    expect(created.private.operatorSeed).toMatch(/^SO/);
    expect(created.private.systemAccountCredentials).toContain("BEGIN USER NKEY SEED");

    const reloaded = await loadOrCreateTrustChain(path, { returnOperatorSeed: true });
    expect(reloaded.private.operatorSeed).toBe(created.private.operatorSeed);
    expect(reloaded.private.systemAccountCredentials).toBe(
      created.private.systemAccountCredentials,
    );
  });

  it("refuses to load a persisted trust chain through a symlink", async () => {
    const realPath = join(dir, "real", "trust-chain.json");
    await loadOrCreateTrustChain(realPath, { returnOperatorSeed: true });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    symlinkSync(realPath, path);

    await expect(loadOrCreateTrustChain(path, { returnOperatorSeed: true })).rejects.toThrow(
      new RegExp(`real regular file: ${escapeRegExp(path)}`),
    );
  });

  it("refuses unsafe parent permissions and loose persisted-file permissions", async () => {
    const unsafeParent = join(dir, "unsafe-parent");
    mkdirSync(unsafeParent, { mode: 0o700 });
    chmodSync(unsafeParent, 0o777);
    const unsafePath = join(unsafeParent, "trust-chain.json");
    await expect(loadOrCreateTrustChain(unsafePath)).rejects.toThrow(
      /must not be writable by group or others/,
    );
    expect(existsSync(unsafePath)).toBe(false);

    const looseParent = join(dir, "loose-parent");
    mkdirSync(looseParent, { mode: 0o700 });
    const loosePath = join(looseParent, "trust-chain.json");
    writeFileSync(loosePath, JSON.stringify({ private: {} }), { mode: 0o644 });
    await expect(loadOrCreateTrustChain(loosePath)).rejects.toThrow(
      /exact mode 0600/,
    );
  });

  it("does NOT regenerate when a file already exists", async () => {
    const a = await loadOrCreateTrustChain(path);
    const b = await loadOrCreateTrustChain(path);
    // A fresh setupTrustChain() would produce different operator/account keys.
    expect(b.natsConfig.operatorJwt).toBe(a.natsConfig.operatorJwt);
    expect(b.natsConfig.accountJwt).toBe(a.natsConfig.accountJwt);
  });

  it("throws loudly on a truncated or pre-system-account persisted file", async () => {
    const flat = join(dir, "trust-chain.json"); // dir already exists (mkdtemp)
    writeFileSync(flat, JSON.stringify({ private: {} }), { mode: 0o600 });
    await expect(loadOrCreateTrustChain(flat)).rejects.toThrow(/missing required fields/);

    const legacyPath = join(dir, "legacy-trust-chain.json");
    const legacy = await loadOrCreateTrustChain(legacyPath);
    const systemAccount = legacy.natsConfig.systemAccountPublicKey;
    delete legacy.private.systemAccountCredentials;
    delete legacy.natsConfig.resolverConfig[systemAccount];
    delete (legacy.natsConfig as Partial<NatsSelfContainedAccountConfig>)
      .systemAccountPublicKey;
    writeFileSync(legacyPath, JSON.stringify(legacy), { mode: 0o600 });

    let error: unknown;
    try {
      await loadOrCreateTrustChain(legacyPath);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(legacyPath);
    expect(message).toContain("created without an operator seed");
    expect(message).toContain(`delete ${legacyPath} and restart`);
    expect(message).toContain("disposable demo/e2e chain");
  });

  // A3: a corrupt (non-JSON) file must fail with an actionable message, not a
  // raw JSON SyntaxError — and must NOT be silently regenerated.
  it("throws a legible, recovery-guiding error on a corrupt (non-JSON) file", async () => {
    const flat = join(dir, "trust-chain.json");
    const secretMarker = "SUPER_SECRET_AUTHORITY_VALUE";
    writeFileSync(flat, secretMarker, { mode: 0o600 }); // e.g. a half-written file

    let error: unknown;
    try {
      await loadOrCreateTrustChain(flat);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /corrupt \(not valid JSON\)[\s\S]*delete the file/,
    );
    expect((error as Error).message).not.toContain(secretMarker);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
