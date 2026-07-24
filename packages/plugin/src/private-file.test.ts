import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensurePrivateDirectory,
  fsyncDirectoryBestEffort,
} from "./private-file.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "webchannel-private-file-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("private directory durability", () => {
  it("creates a private recursive chain without changing an existing parent mode", () => {
    chmodSync(root, 0o755);
    const first = join(root, "first");
    const leaf = join(first, "leaf");

    ensurePrivateDirectory(leaf, true);

    expect(statSync(root).mode & 0o777).toBe(0o755);
    expect(statSync(first).mode & 0o777).toBe(0o700);
    expect(statSync(leaf).mode & 0o777).toBe(0o700);
  });

  it("keeps unsupported directory fsync best-effort", () => {
    expect(() =>
      fsyncDirectoryBestEffort(join(root, "does-not-exist")),
    ).not.toThrow();
  });
});
