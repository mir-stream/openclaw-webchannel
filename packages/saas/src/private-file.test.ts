import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atomicWritePrivateFile } from "./private-file.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "webchannel-saas-private-file-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("atomicWritePrivateFile", () => {
  it("publishes a mode-0600 regular file in an owner-controlled 0755 root", () => {
    chmodSync(root, 0o755);
    const destination = join(root, "system-account.creds");

    atomicWritePrivateFile(destination, "private credential");

    const entry = lstatSync(destination);
    expect(entry.isFile()).toBe(true);
    expect(entry.isSymbolicLink()).toBe(false);
    expect(entry.mode & 0o777).toBe(0o600);
    expect(readFileSync(destination, "utf8")).toBe("private credential");
  });

  it("rejects a destination symlink without changing its sentinel target", () => {
    const sentinel = join(root, "sentinel");
    const destination = join(root, "system-account.creds");
    writeFileSync(sentinel, "sentinel unchanged");
    symlinkSync(sentinel, destination);

    expect(() => atomicWritePrivateFile(destination, "private credential")).toThrow(
      /must not be a symlink/,
    );

    expect(readFileSync(sentinel, "utf8")).toBe("sentinel unchanged");
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(
      readdirSync(root).some((name) => name.includes("system-account.creds.tmp-")),
    ).toBe(false);

    unlinkSync(destination);
    atomicWritePrivateFile(destination, "private credential");
    const published = lstatSync(destination);
    expect(published.isFile()).toBe(true);
    expect(published.isSymbolicLink()).toBe(false);
    expect(published.mode & 0o777).toBe(0o600);
  });

  it("rejects a group/other-writable caller root before creating an output", () => {
    chmodSync(root, 0o777);
    const destination = join(root, "system-account.creds");

    expect(() => atomicWritePrivateFile(destination, "private credential")).toThrow(
      /must not be writable by group or others/,
    );
    expect(existsSync(destination)).toBe(false);
  });
});
