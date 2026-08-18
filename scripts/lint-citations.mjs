#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const OPENCLAW_ROOT = path.join(REPO_ROOT, "node_modules", "openclaw");
const OPENCLAW_PACKAGE_JSON = path.join(OPENCLAW_ROOT, "package.json");
const OPENCLAW_DIST_DIR = path.join(OPENCLAW_ROOT, "dist");

// Match candidate `dist/` file citations anywhere in a repository-owned file.
// The trust decision is made afterwards from provenance, not from the shape of
// the basename, so the pattern deliberately accepts any extension, hash length,
// case, or nested location -- none of those can be used to bypass the policy.
// The extension must start and the whole match must END on an alphanumeric so
// a path that ends a sentence (`...speech-provider.js.`) is captured without
// the trailing period. Stems may end in `-` or `_`, and multi-dot stems and
// extensions (`a.b.c.js`, `.d.ts`, `.plugin.json`) are captured in full.
const DIST_PATH_RE =
  /(?:node_modules\/openclaw\/)?dist\/[A-Za-z0-9._/-]*[A-Za-z0-9_-]\.[A-Za-z0-9](?:[A-Za-z0-9.]*[A-Za-z0-9])?/g;

// Source extensions whose tsc/rollup outputs land next to a package `dist/`
// entrypoint. Sources may live under `src/` or at the package root.
const REPO_SOURCE_RE =
  /^packages\/[^/]+\/(?:src\/(.+)|([^/]+))\.(?:[cm]?[jt]sx?)$/;

// Scan every repository-owned surface while avoiding installed dependencies,
// generated outputs, and version-control metadata. Directory names are used so
// nested workspace dependencies and outputs are excluded as well.
const IGNORED_PATH_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
]);

function normalizeDistPath(citation) {
  const distOffset = citation.indexOf("dist/");
  if (distOffset === -1) return null;
  const normalized = path.posix.normalize(citation.slice(distOffset));
  return normalized.startsWith("dist/") ? normalized : null;
}

/**
 * Return the `dist/` paths OpenClaw declares as durable public entrypoints.
 *
 * These are read from the installed package's `exports` map, so they track the
 * contract the package actually publishes rather than a hand-maintained
 * allowlist. A citation resolving to one of these is legal even if its basename
 * happens to look hash-shaped -- provenance, not shape, is what makes it stable.
 */
export function publicExportDistPaths(packageExports) {
  const exportedPaths = new Set();

  function visit(value) {
    if (typeof value === "string") {
      const normalized = value.startsWith("./") ? value.slice(2) : value;
      if (normalized.startsWith("dist/")) exportedPaths.add(normalized);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value && typeof value === "object") {
      for (const entry of Object.values(value)) visit(entry);
    }
  }

  visit(packageExports);
  return exportedPaths;
}

/**
 * Return the conventional tsc outputs backed by this repository's own package
 * sources. These are local artifacts: legal when backed by our own package
 * metadata/source. They are derived from both `packages/*\/src/...` sources and
 * package-root entrypoints shaped like `packages/*\/<name>.<ext>`. An
 * unprefixed repo-owned output wins over any OpenClaw internal path that happens
 * to share its normalized `dist/` form.
 */
export function repoOwnedDistPaths(repoRoot, repositoryFiles) {
  const ownedPaths = new Set();
  for (const file of repositoryFiles) {
    const relative = path.relative(repoRoot, file).split(path.sep).join("/");
    const match = relative.match(REPO_SOURCE_RE);
    if (!match) continue;
    const sourcePath = match[1] ?? match[2];
    ownedPaths.add(`dist/${sourcePath}.js`);
    ownedPaths.add(`dist/${sourcePath}.d.ts`);
  }
  return ownedPaths;
}

/**
 * Enumerate the files present in OpenClaw's internal `dist/` tree, as normalized
 * `dist/...` paths. Membership here is the provenance signal for "OpenClaw
 * internal build output" -- these are not durable evidence, regardless of how
 * semantic or hash-shaped their basenames look.
 */
export async function openclawInternalDistPaths(openclawDistDir) {
  const internalPaths = new Set();

  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const relative = path
          .relative(openclawDistDir, absolute)
          .split(path.sep)
          .join("/");
        internalPaths.add(`dist/${relative}`);
      }
    }
  }

  await walk(openclawDistDir);
  return internalPaths;
}

/**
 * Decide whether a `dist/` citation is a forbidden OpenClaw internal reference.
 *
 * The decision is made purely from provenance:
 *   1. a declared OpenClaw public export is legal;
 *   2. any other explicitly `node_modules/openclaw/`-prefixed citation is
 *      forbidden, even when absent from the pinned internal tree;
 *   3. an unprefixed repository-owned package output is legal;
 *   4. an unprefixed file present in OpenClaw's internal `dist/` tree is
 *      forbidden;
 *   5. any other unprefixed `dist/` path is ignored on purpose. Bare paths also
 *      name legitimate repository and third-party outputs, so treating every
 *      unknown bare path as OpenClaw-owned would create false positives; that
 *      broader policy is deferred.
 *
 * No basename shape, hash length, case, or extension is consulted, so none of
 * those can create a bypass.
 */
export function isForbiddenDistCitation(citation, policy = {}) {
  const {
    publicExports = new Set(),
    repoOwnedOutputs = new Set(),
    openclawInternalPaths = new Set(),
  } = policy;

  const explicitlyOpenClaw = citation.startsWith("node_modules/openclaw/");
  const normalized = normalizeDistPath(citation);
  if (normalized === null) return false;
  if (publicExports.has(normalized)) return false;
  if (explicitlyOpenClaw) return true;
  if (repoOwnedOutputs.has(normalized)) return false;
  return openclawInternalPaths.has(normalized);
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

export async function listRepositoryFiles(repoRoot) {
  const files = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      // `.git` is a directory in a checkout and a metadata file in a worktree.
      if (IGNORED_PATH_NAMES.has(entry.name)) continue;

      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  await walk(repoRoot);
  return files;
}

export async function findCitationFindings(repoRoot, policy = {}, repositoryFiles) {
  const findings = [];
  const files = repositoryFiles ?? await listRepositoryFiles(repoRoot);

  for (const file of files) {
    const contents = await readFile(file, "utf8");
    // Ignore binary files that happen to live in a source tree.
    if (contents.includes("\0")) continue;

    for (const match of contents.matchAll(DIST_PATH_RE)) {
      if (!isForbiddenDistCitation(match[0], policy)) continue;
      findings.push({
        citation: match[0],
        file: path.relative(repoRoot, file).split(path.sep).join("/"),
        line: lineNumberAt(contents, match.index),
      });
    }
  }

  findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.citation.localeCompare(right.citation),
  );
  return findings;
}

async function main() {
  const openclawPackage = JSON.parse(await readFile(OPENCLAW_PACKAGE_JSON, "utf8"));
  const repositoryFiles = await listRepositoryFiles(REPO_ROOT);
  const policy = {
    publicExports: publicExportDistPaths(openclawPackage.exports),
    repoOwnedOutputs: repoOwnedDistPaths(REPO_ROOT, repositoryFiles),
    openclawInternalPaths: await openclawInternalDistPaths(OPENCLAW_DIST_DIR),
  };
  const findings = await findCitationFindings(REPO_ROOT, policy, repositoryFiles);

  if (findings.length > 0) {
    console.error(
      "Citation lint failed: OpenClaw internal dist/ files are not durable " +
        "evidence. Replace each with a stable plugin-sdk / package-export " +
        "contract, an asserting test/gate, or an internal-behavior note stamped " +
        '"verified at <version>" that does not cite the internal bundle path.',
    );
    for (const finding of findings) {
      console.error(`  ${finding.file}:${finding.line}: ${finding.citation}`);
    }
    console.error(`Found ${findings.length} forbidden citation(s).`);
    process.exitCode = 1;
  } else {
    console.log(
      "Citation lint passed: no OpenClaw internal dist citations found in " +
        "repository-owned files.",
    );
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();
