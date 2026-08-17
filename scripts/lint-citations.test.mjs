import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findCitationFindings,
  isHashNamedDistPath,
  stableDistPathsFromExports,
  stableDistPathsFromSources,
} from "./lint-citations.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("hash-named OpenClaw dist citation classification", () => {
  it("rejects generated Rollup suffixes across supported asset types", () => {
    const paths = [
      ["dist/exec-approvals-", "bouecjdj", ".d.ts"].join(""),
      ["dist/web-provider-runtime-shared-", "bduftxrn", ".js"].join(""),
      ["node_modules/openclaw/dist/sqlite-store-", "guctwyfg", ".js"].join(""),
      ["dist/exec-approval-channel-runtime-", "t-dyeapo", ".d.ts"].join(""),
      ["dist/message-handler.process-", "CcPQD8zK", ".js"].join(""),
      ["dist/control-ui/assets/index-", "LH4ofOKi", ".css"].join(""),
    ];

    for (const citation of paths) {
      expect(isHashNamedDistPath(citation), citation).toBe(true);
    }
  });

  it("keeps stable package names and exported SDK entrypoints legal", () => {
    const stableDistPaths = stableDistPathsFromExports({
      "./plugin-sdk/channel-contract": {
        types: "./dist/plugin-sdk/channel-contract.d.ts",
        default: "./dist/plugin-sdk/channel-contract.js",
      },
      "./plugin-sdk/channel-outbound": {
        types: "./dist/plugin-sdk/channel-outbound.d.ts",
        default: "./dist/plugin-sdk/channel-outbound.js",
      },
    });
    for (const localPath of stableDistPathsFromSources("/repo", [
      "/repo/packages/client/src/pop-register.ts",
    ])) {
      stableDistPaths.add(localPath);
    }

    for (const citation of [
      "dist/rotate-key-entry.js",
      "dist/pop-register.d.ts",
      "dist/export-html/template.css",
      "dist/plugin-sdk/channel-contract.d.ts",
      "node_modules/openclaw/dist/plugin-sdk/channel-outbound.js",
    ]) {
      expect(isHashNamedDistPath(citation, stableDistPaths), citation).toBe(false);
    }
  });
});

describe("repository citation scan", () => {
  it("covers every first-party documentation and source surface", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "citation-lint-"));
    temporaryDirectories.push(repoRoot);
    const citation = [
      "node_modules/openclaw/dist/control-ui/assets/index-",
      "LH4ofOKi",
      ".css",
    ].join("");
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

    const findings = await findCitationFindings(repoRoot);
    expect(findings).toEqual(
      includedFiles
        .sort((left, right) => left.localeCompare(right))
        .map((file) => ({ citation, file, line: 2 })),
    );
  });
});
