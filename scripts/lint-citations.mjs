#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

// Match candidate dist paths first, then classify the basename. OpenClaw's
// generated bundle suffixes are base64url-like and carry an uppercase letter,
// digit, or underscore. Requiring that entropy marker keeps stable lowercase
// artifacts such as dist/rotate-key-entry.js and channel-contract.d.ts legal.
const DIST_PATH_RE = /(?:node_modules\/openclaw\/)?dist\/[A-Za-z0-9._/-]+\.(?:js|d\.ts)/g;
const HASH_ENTROPY_RE = /[A-Z0-9_]/;
const HASH_CHARS_RE = /^[A-Za-z0-9_-]+$/;

// Intentionally no allowlist: every genuine hash-named OpenClaw citation must
// bind to a stable SDK contract, an asserting test/gate, or a version stamp.

async function listFiles(root) {
  const files = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  await walk(root);
  return files;
}

function isHashNamedDistPath(citation) {
  const basename = citation.slice(citation.lastIndexOf("/") + 1);
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

const packageDirs = await readdir(path.join(REPO_ROOT, "packages"), {
  withFileTypes: true,
});
const scanRoots = packageDirs
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(REPO_ROOT, "packages", entry.name, "src"));
scanRoots.push(path.join(REPO_ROOT, "docs"));

const findings = [];
for (const root of scanRoots) {
  let files;
  try {
    files = await listFiles(root);
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }

  for (const file of files) {
    const contents = await readFile(file, "utf8");
    for (const match of contents.matchAll(DIST_PATH_RE)) {
      if (!isHashNamedDistPath(match[0])) continue;
      findings.push({
        citation: match[0],
        file: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
        line: lineNumberAt(contents, match.index),
      });
    }
  }
}

findings.sort(
  (left, right) =>
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.citation.localeCompare(right.citation),
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
      "packages/*/src/** or docs/**.",
  );
}
