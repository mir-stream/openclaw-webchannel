import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findCitationFindings,
  isForbiddenDistCitation,
  openclawInternalDistPaths,
  publicExportDistPaths,
  repoOwnedDistPaths,
} from "./lint-citations.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

// Internal-path string literals are assembled at runtime so the repository-wide
// citation scan (npm run lint:citations) does not flag this test file's own
// example paths that resolve into the installed OpenClaw dist tree.
const speechProvider = ["dist/extensions/google/", "speech-provider", ".js"].join("");
const doctorContract = ["dist/extensions/elevenlabs/", "doctor-contract", ".js"].join("");
const sessionIdentity = ["dist/acp-core/runtime/", "session-identity", ".d.ts"].join("");
const exportTemplate = ["dist/export-html/", "template", ".css"].join("");
const hashedInternal = ["dist/message-handler.process-", "CcPQD8zK", ".js"].join("");
const jsonInternal = ["dist/extensions/telegram/", "openclaw.plugin", ".json"].join("");

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
    "/repo/packages/client/src/pop-register.ts",
    "/repo/packages/plugin/src/index-nats.ts",
    "/repo/packages/saas/reference/enrollment-server.ts",
  ]);

  const openclawInternalPaths = new Set([
    // Semantic basenames that nonetheless live in OpenClaw's internal dist tree.
    speechProvider,
    doctorContract,
    sessionIdentity,
    exportTemplate,
    jsonInternal,
    // A currently hash-shaped internal chunk.
    hashedInternal,
    // Collisions: these normalized paths ALSO exist internally, but provenance
    // (a public export / a repo-owned output) must win over internal existence.
    "dist/index.js",
    "dist/index-nats.js",
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
    // `dist/index.js` is both a declared export and present internally.
    expect(isForbiddenDistCitation("dist/index.js", policy)).toBe(false);
    expect(policy.openclawInternalPaths.has("dist/index.js")).toBe(true);
  });

  it("lets a repo-owned output win over internal existence on a path collision", () => {
    // `dist/index-nats.js` is both a repo-owned output and present internally.
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
    const owned = repoOwnedDistPaths("/repo", [
      "/repo/packages/plugin/src/index-nats.ts",
      "/repo/packages/client/src/pop-register.tsx",
      "/repo/packages/example/README.md",
      "/repo/apps/web/src/main.ts",
    ]);
    expect(owned).toEqual(
      new Set([
        "dist/index-nats.js",
        "dist/index-nats.d.ts",
        "dist/pop-register.js",
        "dist/pop-register.d.ts",
      ]),
    );
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

  it("treats a missing OpenClaw dist directory as an empty internal set", async () => {
    const internal = await openclawInternalDistPaths(
      path.join(tmpdir(), "does-not-exist-openclaw-dist"),
    );
    expect(internal).toEqual(new Set());
  });
});

describe("repository citation scan", () => {
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
