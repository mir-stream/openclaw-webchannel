#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const OPENCLAW_PACKAGE_JSON = path.join(
  REPO_ROOT,
  "node_modules",
  "openclaw",
  "package.json",
);

// Match candidate dist paths first, then classify the basename. OpenClaw's
// generated Rollup suffix is normally eight base64url characters. Most hashes
// contain an uppercase letter, digit, or underscore, but lowercase-only hashes
// are valid too (and do occur in the pinned package).
const DIST_PATH_RE = /(?:node_modules\/openclaw\/)?dist\/[A-Za-z0-9._/-]+\.(?:js|d\.ts)/g;
const HASH_ENTROPY_RE = /[A-Z0-9_]/;
const HASH_CHARS_RE = /^[A-Za-z0-9_-]+$/;
const LOWERCASE_ROLLUP_HASH_RE = /^[a-z-]{8}$/;

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
  return distOffset === -1 ? citation : citation.slice(distOffset);
}

/**
 * Return the dist files OpenClaw exposes as durable package entrypoints.
 *
 * An eight-letter lowercase suffix is inherently ambiguous (for example,
 * `contract` has the same shape as a Rollup hash). Deriving the exceptions from
 * the installed package's exports keeps public SDK entrypoints legal without a
 * hand-maintained allowlist of internal bundles.
 */
export function stableDistPathsFromExports(packageExports) {
  const stablePaths = new Set();

  function visit(value) {
    if (typeof value === "string") {
      const normalized = value.startsWith("./") ? value.slice(2) : value;
      if (
        normalized.startsWith("dist/") &&
        (normalized.endsWith(".js") || normalized.endsWith(".d.ts"))
      ) {
        stablePaths.add(normalized);
      }
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
  return stablePaths;
}

/**
 * Return the conventional tsc outputs backed by this repository's own package
 * sources. Bare `dist/foo.js` references do not identify their package, so
 * these paths prevent a stable local source name such as `pop-register` from
 * being mistaken for an all-lowercase OpenClaw hash.
 */
export function stableDistPathsFromSources(repoRoot, repositoryFiles) {
  const stablePaths = new Set();
  for (const file of repositoryFiles) {
    const relative = path.relative(repoRoot, file).split(path.sep).join("/");
    const match = relative.match(/^packages\/[^/]+\/src\/(.+)\.(?:[cm]?[jt]sx?)$/);
    if (!match) continue;
    stablePaths.add(`dist/${match[1]}.js`);
    stablePaths.add(`dist/${match[1]}.d.ts`);
  }
  return stablePaths;
}

export function isHashNamedDistPath(citation, stableDistPaths = new Set()) {
  const normalized = normalizeDistPath(citation);
  if (stableDistPaths.has(normalized)) return false;

  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  const stem = basename.endsWith(".d.ts")
    ? basename.slice(0, -".d.ts".length)
    : basename.slice(0, -".js".length);

  for (let index = stem.indexOf("-"); index !== -1; index = stem.indexOf("-", index + 1)) {
    const suffix = stem.slice(index + 1);
    if (
      suffix.length >= 6 &&
      HASH_CHARS_RE.test(suffix) &&
      HASH_ENTROPY_RE.test(suffix)
    ) {
      return true;
    }
    if (LOWERCASE_ROLLUP_HASH_RE.test(suffix)) return true;
  }
  return false;
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

export async function findCitationFindings(
  repoRoot,
  stableDistPaths = new Set(),
  repositoryFiles,
) {
  const findings = [];
  const files = repositoryFiles ?? await listRepositoryFiles(repoRoot);

  for (const file of files) {
    const contents = await readFile(file, "utf8");
    // Ignore binary files that happen to live in a source tree.
    if (contents.includes("\0")) continue;

    for (const match of contents.matchAll(DIST_PATH_RE)) {
      if (!isHashNamedDistPath(match[0], stableDistPaths)) continue;
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
  const stableDistPaths = stableDistPathsFromExports(openclawPackage.exports);
  const repositoryFiles = await listRepositoryFiles(REPO_ROOT);
  for (const localPath of stableDistPathsFromSources(REPO_ROOT, repositoryFiles)) {
    stableDistPaths.add(localPath);
  }
  const findings = await findCitationFindings(
    REPO_ROOT,
    stableDistPaths,
    repositoryFiles,
  );

  if (findings.length > 0) {
    console.error(
      "Citation lint failed: hash-named OpenClaw dist citations are unstable; " +
        "replace each with a stable plugin-sdk contract, an asserting test/gate, " +
        'or an internal-behavior note stamped "verified at <version>".',
    );
    for (const finding of findings) {
      console.error(`  ${finding.file}:${finding.line}: ${finding.citation}`);
    }
    console.error(`Found ${findings.length} forbidden citation(s).`);
    process.exitCode = 1;
  } else {
    console.log(
      "Citation lint passed: no hash-named OpenClaw dist citations found in " +
        "repository-owned files.",
    );
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();
