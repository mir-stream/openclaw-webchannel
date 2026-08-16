import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #158 requirement 1 — the offline rotation command and the running gateway
 * must not be able to reach each other.
 *
 * WHY A STRUCTURAL TEST AND NOT A REVIEW NOTE. Rotating K is only safe when
 * nothing is serving the tuple. An endpoint that could rotate from inside a
 * live gateway would be a way to do the one thing the whole containment
 * procedure exists to prevent, and it would arrive by accident: one convenience
 * import from a channel or command module and the separation is gone with
 * nothing failing. So both directions are pinned here:
 *
 *   FORWARD  the rotation binary must not be able to open a transport. Its
 *            import closure may not contain the plugin SDK, `ws`, or any NATS
 *            module — if it cannot import them, it cannot connect or subscribe.
 *   BACKWARD the gateway entrypoints must not be able to call the rotation
 *            command. Neither entry's closure may contain the CLI.
 *
 * This walks static imports. A `await import()` of a literal path is caught
 * too; a computed specifier is not, and nothing in these closures uses one.
 */

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ROTATION_ENTRY = "rotate-key-entry.ts";
const GATEWAY_ENTRIES = ["index-nats.ts", "setup-entry.ts"];

/** Modules that are the whole point of the separation. */
const ROTATION_MODULES = [
  "src/rotate-conversation-key-cli.ts",
  "src/rotation-preflight.ts",
];

/** Bare specifiers that would give the rotation binary a network. */
const TRANSPORT_PACKAGES = [/^ws$/, /^openclaw(\/|$)/, /^nats(\/|$)/];

/** Plugin modules that own a live connection or subscription. */
const TRANSPORT_MODULES = [
  "src/nats-transport.ts",
  "src/nats-channel.ts",
  "src/nats-account-runtime.ts",
  "src/nats-register.ts",
  "src/enrolled-nats-connection.ts",
];

type Closure = { files: Set<string>; bare: Set<string> };

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const pattern of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s+["']([^"']+)["']/gm,
  ]) {
    for (const match of source.matchAll(pattern)) found.push(match[1] as string);
  }
  return found;
}

/** Transitive static-import closure of one entry, relative to the package. */
function closureOf(entry: string): Closure {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [resolve(PACKAGE_DIR, entry)];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    const key = relative(PACKAGE_DIR, file);
    if (files.has(key)) continue;
    files.add(key);

    for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) {
        bare.add(specifier);
        continue;
      }
      // Sources import each other with the emitted ".js" extension.
      const source = resolve(dirname(file), specifier).replace(/\.js$/, ".ts");
      queue.push(source);
    }
  }
  return { files, bare };
}

describe("offline rotation is a separate process from the gateway", () => {
  it("gives the rotation binary no way to reach a transport", () => {
    const closure = closureOf(ROTATION_ENTRY);

    // Guard the guard: a closure that failed to walk would pass everything.
    expect(closure.files.has("src/rotate-conversation-key-cli.ts")).toBe(true);
    expect(closure.files.has("src/conversation-key-store.ts")).toBe(true);

    const offending = [...closure.bare].filter((specifier) =>
      TRANSPORT_PACKAGES.some((pattern) => pattern.test(specifier)),
    );
    expect(offending).toEqual([]);
    for (const module of TRANSPORT_MODULES) {
      expect(closure.files.has(module)).toBe(false);
    }
    // Everything it does import is a node builtin or a local module.
    for (const specifier of closure.bare) {
      expect(specifier.startsWith("node:")).toBe(true);
    }
  });

  for (const entry of GATEWAY_ENTRIES) {
    it(`gives ${entry} no way to invoke a rotation`, () => {
      const closure = closureOf(entry);
      expect(closure.files.size).toBeGreaterThan(1);
      for (const module of ROTATION_MODULES) {
        expect(closure.files.has(module)).toBe(false);
      }
    });
  }

  it("keeps the rotation entry out of the plugin's loaded extensions", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf8"),
    ) as {
      bin: Record<string, string>;
      openclaw: { extensions: string[]; setupEntry: string };
    };

    // OpenClaw loads these into the gateway; the rotation entry is not one.
    const loaded = [...manifest.openclaw.extensions, manifest.openclaw.setupEntry];
    for (const path of loaded) expect(path).not.toContain("rotate-key");

    // It reaches operators as a bin instead.
    expect(manifest.bin["openclaw-webchannel-rotate-key"]).toBe(
      "./dist/rotate-key-entry.js",
    );
  });
});
