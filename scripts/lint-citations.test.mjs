import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCitationPolicy,
  findCitationFindings,
  isForbiddenDistCitation,
  listRepositoryFiles,
  openclawInternalDistPaths,
  publicExportDistPaths,
  repoOwnedDistPaths,
} from "./lint-citations.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
// The real CLI run over this repository takes ~0.4s; this only has to be large
// enough that a healthy run never trips it.
const CLI_TIMEOUT_MS = 3_000;
const temporaryDirectories = [];

async function runCitationLint(script, cwd, label) {
  const captureDir = path.join(cwd, "coverage");
  await mkdir(captureDir, { recursive: true });
  const stdoutPath = path.join(captureDir, `${label}.stdout`);
  const stderrPath = path.join(captureDir, `${label}.stderr`);
  const [stdoutFile, stderrFile] = await Promise.all([
    open(stdoutPath, "w"),
    open(stderrPath, "w"),
  ]);
  let code;
  try {
    // The helper owns the timeout so a hung CLI is killed and awaited here. If
    // Vitest's own timeout fired instead, the child would outlive the run.
    code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        cwd,
        stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, CLI_TIMEOUT_MS);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new Error(
              `citation lint CLI did not exit within ${CLI_TIMEOUT_MS}ms; killed and awaited exit`,
            ),
          );
          return;
        }
        resolve(exitCode);
      });
    });
  } finally {
    await Promise.all([stdoutFile.close(), stderrFile.close()]);
  }
  return {
    code,
    stderr: await readFile(stderrPath, "utf8"),
    stdout: await readFile(stdoutPath, "utf8"),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

// Forbidden citation literals are assembled at runtime so the repository-wide
// scan (npm run lint:citations) does not flag this test file's own cases. These
// include installed internal paths and explicit non-exports that are absent.
const speechProvider = ["dist/extensions/google/", "speech-provider", ".js"].join("");
const doctorContract = ["dist/extensions/elevenlabs/", "doctor-contract", ".js"].join("");
const sessionIdentity = ["dist/acp-core/runtime/", "session-identity", ".d.ts"].join("");
const exportTemplate = ["dist/export-html/", "template", ".css"].join("");
const messageHandlerStem = "dist/message-handler.process";
const hashedInternal = [messageHandlerStem, "-", "CcPQD8zK", ".js"].join("");
const jsonInternal = ["dist/extensions/telegram/", "openclaw.plugin", ".json"].join("");
const dashTerminatedInternal = ["dist/nix-", "DxyfQZE-", ".js"].join("");
const underscoreTerminatedInternal = ["dist/safe-buffer-", "Ce0qmGn_", ".js"].join("");
const speechProviderDotAlias = ["dist/extensions/google/./", "speech-provider", ".js"].join("");
const indexTypes = ["dist/index", ".d.ts"].join("");
const prefixedIndexTypes = `node_modules/openclaw/${indexTypes}`;
const missingInternal = ["dist/does-not-exist-", "CcPQD8zK", ".js"].join("");
const traversalInternal = [messageHandlerStem, "-", "C5Yiltgh", ".js"].join("");
const traversalCitation = [
  "node_modules/openclaw/",
  "dist/../../openclaw/",
  traversalInternal,
].join("");
const pluginSdkIndex = ["dist/plugin-sdk/index", ".d.ts"].join("");
const customDist = ["dist/custom", ".js"].join("");

// A public export whose basename is deliberately hash-shaped, proving the trust
// decision is provenance (declared export) and not basename shape.
const hashShapedExport = ["dist/control-ui/assets/index-", "LH4ofOKi", ".css"].join("");

function buildPolicy() {
  const publicExports = publicExportDistPaths({
    ".": "./dist/index.js",
    "./extension-api": "./dist/extensionAPI.js",
    "./plugin-sdk/channel-contract": {
      types: "./dist/plugin-sdk/channel-contract.d.ts",
      default: "./dist/plugin-sdk/channel-contract.js",
    },
    // A declared export that happens to be hash-shaped.
    "./control-ui": `./${hashShapedExport}`,
  });

  const repoOwnedOutputs = repoOwnedDistPaths("/repo", [
    "/repo/packages/client/src/index.ts",
    "/repo/packages/client/src/pop-register.ts",
    "/repo/packages/plugin/index-nats.ts",
    "/repo/packages/saas/reference/enrollment-server.ts",
  ]);
  // Keep the public `dist/index.js` row isolated from repo-owned provenance;
  // its `.d.ts` sibling remains a synthetic repo-owned/internal collision.
  repoOwnedOutputs.delete("dist/index.js");

  const openclawInternalPaths = new Set([
    // Synthetic internal membership exercises the forbidden branch directly;
    // `hashedInternal` deliberately models a stale hash absent from this pin.
    speechProvider,
    doctorContract,
    sessionIdentity,
    exportTemplate,
    jsonInternal,
    hashedInternal,
    traversalInternal,
    // The test constructs collisions for every public-export and repo-owned
    // matrix row, so only the provenance branch named by the row can make it
    // legal. `dist/index-nats.js`, among others, is not internal in this pin.
    "dist/index.js",
    "dist/plugin-sdk/channel-contract.js",
    "dist/plugin-sdk/channel-contract.d.ts",
    hashShapedExport,
    "dist/index-nats.js",
    "dist/pop-register.d.ts",
    indexTypes,
  ]);

  return { publicExports, repoOwnedOutputs, openclawInternalPaths };
}

// Citation-form matrix. `forbidden` is what the provenance policy must decide,
// independent of basename shape, hash length, case, extension, or nesting.
const CITATION_MATRIX = [
  // OpenClaw public package exports -> durable contract, legal.
  { form: "public export", citation: "dist/index.js", forbidden: false },
  {
    form: "public export (nested subpath)",
    citation: "dist/plugin-sdk/channel-contract.js",
    forbidden: false,
  },
  {
    form: "public export (openclaw-prefixed .d.ts)",
    citation: "node_modules/openclaw/dist/plugin-sdk/channel-contract.d.ts",
    forbidden: false,
  },
  {
    form: "public export with hash-shaped basename",
    citation: hashShapedExport,
    forbidden: false,
  },
  // Repository-owned package outputs -> local artifacts backed by our sources.
  { form: "repo-owned output (.js)", citation: "dist/index-nats.js", forbidden: false },
  { form: "repo-owned output (.d.ts)", citation: "dist/pop-register.d.ts", forbidden: false },
  // OpenClaw internal dist files -> not durable evidence, rejected by provenance.
  {
    form: "internal dist with semantic basename",
    citation: speechProvider,
    forbidden: true,
  },
  {
    form: "internal dist through a normalized ./ alias",
    citation: speechProviderDotAlias,
    forbidden: true,
  },
  {
    form: "internal dist with semantic basename",
    citation: sessionIdentity,
    forbidden: true,
  },
  {
    form: "internal dist with semantic basename",
    citation: doctorContract,
    forbidden: true,
  },
  {
    form: "internal dist with non-enumerated extension",
    citation: jsonInternal,
    forbidden: true,
  },
  {
    form: "internal dist with hash-shaped basename",
    citation: hashedInternal,
    forbidden: true,
  },
  {
    form: "internal dist, openclaw-prefixed",
    citation: `node_modules/openclaw/${hashedInternal}`,
    forbidden: true,
  },
  {
    form: "canonicalized openclaw-prefixed internal traversal",
    citation: traversalCitation,
    forbidden: true,
  },
  {
    form: "non-export internal, openclaw-prefixed repo-owned collision",
    citation: prefixedIndexTypes,
    forbidden: true,
  },
  // An explicit OpenClaw non-export is rejected even when stale; the same bare
  // path stays ignored because it has no OpenClaw provenance.
  {
    form: "openclaw-prefixed non-export absent from the internal tree",
    citation: `node_modules/openclaw/${missingInternal}`,
    forbidden: true,
  },
  {
    form: "unprefixed path absent from the internal tree",
    citation: missingInternal,
    forbidden: false,
  },
  // Not an OpenClaw citation at all -> ignored (no false positives).
  { form: "unrelated dependency bin", citation: "dist/cli.js", forbidden: false },
  { form: "unrelated doc example", citation: "dist/foo.js", forbidden: false },
  { form: "unrelated test fixture", citation: "dist/ignored.spec.js", forbidden: false },
];

describe("provenance-based OpenClaw dist citation classification", () => {
  const policy = buildPolicy();

  for (const { form, citation, forbidden } of CITATION_MATRIX) {
    it(`${forbidden ? "rejects" : "accepts"} ${form}: ${citation}`, () => {
      expect(isForbiddenDistCitation(citation, policy)).toBe(forbidden);
    });
  }

  it("lets a public export win over internal existence on a path collision", () => {
    // The fixture deliberately constructs this public/internal collision.
    expect(isForbiddenDistCitation("dist/index.js", policy)).toBe(false);
    expect(policy.openclawInternalPaths.has("dist/index.js")).toBe(true);
  });

  it("lets a repo-owned output win over internal existence on a path collision", () => {
    // The fixture deliberately constructs this repo-owned/internal collision.
    expect(isForbiddenDistCitation("dist/index-nats.js", policy)).toBe(false);
    expect(policy.openclawInternalPaths.has("dist/index-nats.js")).toBe(true);
  });
});

describe("policy derivation", () => {
  it("derives public exports from every dist entry in the exports map", () => {
    const exports = publicExportDistPaths({
      ".": "./dist/index.js",
      "./plugin-sdk": {
        types: "./dist/plugin-sdk/index.d.ts",
        default: "./dist/plugin-sdk/index.js",
      },
      "./bin": ["./dist/cli.js", "./openclaw.mjs"],
    });
    expect(exports).toEqual(
      new Set([
        "dist/index.js",
        "dist/plugin-sdk/index.d.ts",
        "dist/plugin-sdk/index.js",
        "dist/cli.js",
      ]),
    );
  });

  it("derives repo-owned outputs from package sources", () => {
    const owned = repoOwnedDistPaths(REPO_ROOT, [
      path.join(REPO_ROOT, "packages/plugin/index-nats.ts"),
      path.join(REPO_ROOT, "packages/plugin/setup-entry.ts"),
      path.join(REPO_ROOT, "packages/plugin/rotate-key-entry.ts"),
      path.join(REPO_ROOT, "packages/client/src/pop-register.ts"),
      path.join(REPO_ROOT, "packages/client/README.md"),
    ]);
    expect(owned).toEqual(
      new Set([
        "dist/index-nats.js",
        "dist/index-nats.d.ts",
        "dist/setup-entry.js",
        "dist/setup-entry.d.ts",
        "dist/rotate-key-entry.js",
        "dist/rotate-key-entry.d.ts",
        "dist/pop-register.js",
        "dist/pop-register.d.ts",
      ]),
    );
  });

  it("derives shipped plugin entry outputs from the actual repository file list", async () => {
    const repositoryFiles = await listRepositoryFiles(REPO_ROOT);
    const owned = repoOwnedDistPaths(REPO_ROOT, repositoryFiles);

    expect(owned.has("dist/index-nats.js")).toBe(true);
    expect(owned.has("dist/setup-entry.js")).toBe(true);
    expect(owned.has("dist/rotate-key-entry.js")).toBe(true);
  });

  it("enumerates OpenClaw internal dist files as normalized paths", async () => {
    const distDir = await mkdtemp(path.join(tmpdir(), "oc-dist-"));
    temporaryDirectories.push(distDir);
    await mkdir(path.join(distDir, "extensions", "google"), { recursive: true });
    await writeFile(path.join(distDir, "index.js"), "", "utf8");
    await writeFile(
      path.join(distDir, "extensions", "google", "speech-provider.js"),
      "",
      "utf8",
    );

    const internal = await openclawInternalDistPaths(distDir);
    expect(internal).toEqual(
      new Set(["dist/index.js", speechProvider]),
    );
  });

  it("fails loudly when the configured OpenClaw dist root is missing", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "missing-oc-dist-"));
    temporaryDirectories.push(parent);
    const missingDist = path.join(parent, "node_modules", "openclaw", "dist");

    await expect(openclawInternalDistPaths(missingDist)).rejects.toThrow(
      `OpenClaw dist tree is missing or incomplete at ${missingDist}; run npm ci`,
    );
  });

  it("fails when a nested dist directory disappears during enumeration", async () => {
    const distDir = await mkdtemp(path.join(tmpdir(), "incomplete-oc-dist-"));
    temporaryDirectories.push(distDir);
    const missingNested = path.join(distDir, "extensions");
    await mkdir(missingNested);
    const realFs = await vi.importActual("node:fs/promises");
    vi.doMock("node:fs/promises", () => ({
      ...realFs,
      readdir: async (directory, options) => {
        if (directory === missingNested) {
          throw Object.assign(new Error(`ENOENT: ${directory}`), { code: "ENOENT" });
        }
        return realFs.readdir(directory, options);
      },
    }));

    try {
      const isolatedModule = await import("./lint-citations.mjs?nested-enoent");
      await expect(isolatedModule.openclawInternalDistPaths(distDir)).rejects.toThrow(
        `OpenClaw dist tree is missing or incomplete at ${distDir}; run npm ci`,
      );
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("assembles the real citation policy used by the CLI", async () => {
    const repositoryFiles = await listRepositoryFiles(REPO_ROOT);
    const policy = await buildCitationPolicy(REPO_ROOT, repositoryFiles);
    const scratchRoot = await mkdtemp(path.join(tmpdir(), "citation-policy-e2e-"));
    temporaryDirectories.push(scratchRoot);
    await writeFile(
      path.join(scratchRoot, "citations.md"),
      [
        speechProvider,
        "dist/plugin-sdk/channel-contract.js",
        "dist/index-nats.js",
        // A real OpenClaw-internal/repo-owned collision makes omission of the
        // repo-owned set observable; index-nats itself is not internal.
        indexTypes,
      ].join("\n"),
      "utf8",
    );

    await expect(findCitationFindings(scratchRoot, policy)).resolves.toEqual([
      { citation: speechProvider, file: "citations.md", line: 1 },
    ]);
  });
});

describe("citation lint CLI", () => {
  it("exits nonzero for an internal citation and zero after it is removed", async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), "citation-cli-"));
    temporaryDirectories.push(scratchRoot);
    const scriptDir = path.join(scratchRoot, "scripts");
    const openclawRoot = path.join(scratchRoot, "node_modules", "openclaw");
    const internalFile = path.join(
      openclawRoot,
      "dist",
      "extensions",
      "google",
      "speech-provider.js",
    );
    await mkdir(scriptDir, { recursive: true });
    await mkdir(path.dirname(internalFile), { recursive: true });
    const script = path.join(scriptDir, "lint-citations.mjs");
    await copyFile(path.join(REPO_ROOT, "scripts", "lint-citations.mjs"), script);
    await copyFile(
      path.join(REPO_ROOT, "node_modules", "openclaw", "package.json"),
      path.join(openclawRoot, "package.json"),
    );
    await writeFile(internalFile, "", "utf8");
    const citationFile = path.join(scratchRoot, "evidence.md");
    await writeFile(citationFile, `${speechProvider}\n`, "utf8");

    const rejected = await runCitationLint(script, scratchRoot, "rejected");
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain(`evidence.md:1: ${speechProvider}`);
    expect(rejected.stderr).toContain("Found 1 forbidden citation(s).");

    await writeFile(citationFile, "", "utf8");
    const accepted = await runCitationLint(script, scratchRoot, "accepted");
    expect(accepted.code).toBe(0);
    expect(accepted.stdout).toContain(
      "Citation lint passed: no OpenClaw internal dist citations found in repository-owned files.",
    );
  });
});

describe("repository citation scan", () => {
  it("captures whole tokens while preserving supported citation delimiters", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "citation-lint-boundaries-"));
    temporaryDirectories.push(repoRoot);
    const policy = {
      openclawInternalPaths: new Set([
        speechProvider,
        dashTerminatedInternal,
        pluginSdkIndex,
        jsonInternal,
        customDist,
      ]),
    };
    await writeFile(
      path.join(repoRoot, "valid.md"),
      [`./${speechProvider}`, `${dashTerminatedInternal}.`, `${pluginSdkIndex}:691`].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "invalid.md"),
      [
        `non${speechProvider}`,
        `${jsonInternal}-extra`,
        `xnode_modules/openclaw/${customDist}`,
        ["node_modules/openclaw/", "dist/index", ".js-extra"].join(""),
      ].join("\n"),
      "utf8",
    );

    const findings = await findCitationFindings(repoRoot, policy);
    expect(findings).toEqual([
      { citation: speechProvider, file: "valid.md", line: 1 },
      { citation: dashTerminatedInternal, file: "valid.md", line: 2 },
      { citation: pluginSdkIndex, file: "valid.md", line: 3 },
    ]);
  });

  // The matcher must not settle for a shorter valid-looking prefix of a longer
  // malformed token: reporting `...openclaw.plugin` for a file that says
  // `...openclaw.plugin.json-extra` would quote a string the file never wrote.
  // Both the truncated stem and the real path are internal here, so a matcher
  // that backtracks into either one produces a finding and fails this test.
  // The whole-token rule is what makes the answer "no citation at all".
  it("never truncates a malformed token onto a shorter internal path", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "citation-lint-truncation-"));
    temporaryDirectories.push(repoRoot);
    const truncatedStem = jsonInternal.slice(0, jsonInternal.lastIndexOf("."));
    const policy = {
      openclawInternalPaths: new Set([jsonInternal, truncatedStem]),
    };
    await writeFile(path.join(repoRoot, "malformed.md"), `${jsonInternal}-extra\n`, "utf8");

    await expect(findCitationFindings(repoRoot, policy)).resolves.toEqual([]);
  });

  it("matches internal basenames whose hashes end in dash or underscore", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "citation-lint-hash-end-"));
    temporaryDirectories.push(repoRoot);
    const policy = {
      openclawInternalPaths: new Set([dashTerminatedInternal, underscoreTerminatedInternal]),
    };
    await writeFile(
      path.join(repoRoot, "hashes.md"),
      `${dashTerminatedInternal}\n${underscoreTerminatedInternal}\n`,
      "utf8",
    );

    const findings = await findCitationFindings(repoRoot, policy);
    expect(findings).toEqual([
      { citation: dashTerminatedInternal, file: "hashes.md", line: 1 },
      { citation: underscoreTerminatedInternal, file: "hashes.md", line: 2 },
    ]);
  });

  it("covers every first-party documentation and source surface", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "citation-lint-"));
    temporaryDirectories.push(repoRoot);
    // A forbidden citation resolved via policy (internal dist, not an export).
    const citation = `node_modules/openclaw/${speechProvider}`;
    const policy = { openclawInternalPaths: new Set([speechProvider]) };
    const includedFiles = [
      "README.md",
      "docs/plan.md",
      "packages/example/README.md",
      "packages/example/index.ts",
      "packages/example/src/index.ts",
      "packages/example/reference/server.ts",
      "packages/example/examples/example.ts",
      "examples/consumer/src/index.ts",
      "demo/server.ts",
      "e2e/harness.test.ts",
      "scripts/check.mjs",
    ];
    const ignoredFiles = [
      ".git/objects/note",
      ".hg/cache/note",
      ".svn/text-base/note",
      "coverage/report/index.html",
      "nested-worktree/.git",
      "node_modules/dependency/index.js",
      "packages/example/dist/index.js",
    ];

    for (const relativeFile of [...includedFiles, ...ignoredFiles]) {
      const absoluteFile = path.join(repoRoot, relativeFile);
      await mkdir(path.dirname(absoluteFile), { recursive: true });
      await writeFile(absoluteFile, `first line\n${citation}\n`, "utf8");
    }

    const findings = await findCitationFindings(repoRoot, policy);
    expect(findings).toEqual(
      includedFiles
        .sort((left, right) => left.localeCompare(right))
        .map((file) => ({ citation, file, line: 2 })),
    );
  });

  it("flags an internal citation that ends a sentence with a period", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "citation-lint-period-"));
    temporaryDirectories.push(repoRoot);
    const policy = { openclawInternalPaths: new Set([speechProvider]) };
    // Period form (path terminates a sentence) and the trailing-space control
    // must both be captured without the delimiter and reported.
    await writeFile(
      path.join(repoRoot, "period.md"),
      `Loads ${speechProvider}.\n`,
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "space.md"),
      `Loads ${speechProvider} now.\n`,
      "utf8",
    );

    const findings = await findCitationFindings(repoRoot, policy);
    expect(findings).toEqual([
      { citation: speechProvider, file: "period.md", line: 1 },
      { citation: speechProvider, file: "space.md", line: 1 },
    ]);
  });

  it("reports no findings when every citation resolves to a durable provenance", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "citation-lint-clean-"));
    temporaryDirectories.push(repoRoot);
    const policy = {
      publicExports: new Set(["dist/index.js"]),
      repoOwnedOutputs: new Set(["dist/index-nats.js"]),
      openclawInternalPaths: new Set([speechProvider]),
    };
    await writeFile(
      path.join(repoRoot, "README.md"),
      "dist/index.js and dist/index-nats.js and dist/cli.js\n",
      "utf8",
    );
    const findings = await findCitationFindings(repoRoot, policy);
    expect(findings).toEqual([]);
  });
});
