#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# pack-load-smoke.sh — F3 remote-install regression guard.
#
# WHY THIS EXISTS
#   The plugin `openclaw-webchannel` (packages/plugin) ships as a self-contained
#   esbuild bundle: package.json `openclaw.extensions` → ./dist/index-nats.js and
#   `setupEntry` → ./dist/setup-entry.js. esbuild builds with `--packages=external`,
#   so bare runtime imports are NOT inlined — they must be present as real
#   `dependencies` at install time on the consumer's machine.
#
#   Regression "F3": the published tarball once failed to load after a remote
#   `plugins install` (ERR_MODULE_NOT_FOUND). The trap is silent: a FUTURE source
#   file adding a bare runtime import that is misplaced into `devDependencies`
#   (instead of `dependencies`) still BUILDS GREEN — esbuild externalizes it — but
#   the published package omits it, so remote install breaks. No other CI step
#   catches this: every live harness swaps the entry back to the TS source.
#
#   This smoke packs the plugin, installs ONLY production deps (`--omit=dev`), and
#   actually LOADS both declared dist entries in Node. A runtime import that a
#   future change drops into devDependencies won't be installed here, so the
#   import throws ERR_MODULE_NOT_FOUND and this script fails — exactly the F3
#   failure, caught in CI before publish.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO=$(git rev-parse --show-toplevel)
PLUGIN_DIR="$REPO/packages/plugin"

# Host openclaw provides the `openclaw/plugin-sdk/*` peer imports. Locate it via
# the repo-root node_modules path — NOT require.resolve('openclaw/package.json'),
# which throws because openclaw does not export ./package.json.
OPENCLAW_DIR="$REPO/node_modules/openclaw"
if [ ! -d "$OPENCLAW_DIR" ]; then
  echo "ERROR: host openclaw not found at $OPENCLAW_DIR — run 'npm ci' at repo root first." >&2
  exit 1
fi

# Run from the repo root so `npm run build --workspace=...` resolves the workspace
# regardless of the caller's cwd (CI runs at root; this keeps local runs correct too).
cd "$REPO"

# Build fresh — dist/ is gitignored, so this makes the script correct even with
# a stale or absent dist locally (redundant with CI's earlier build; that's fine).
echo "==> Building plugin (fresh dist/)…"
npm run build --workspace=packages/plugin

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "==> Packing plugin into $WORK …"
TARBALL=$(cd "$PLUGIN_DIR" && npm pack --pack-destination "$WORK" | tail -1)
echo "    tarball: $TARBALL"

echo "==> Extracting tarball …"
tar xzf "$WORK/$TARBALL" -C "$WORK"
PKG="$WORK/package"

# ── Assertions on the extracted package ─────────────────────────────────────
if [ -d "$PKG/src" ]; then
  echo "ERROR: packed tarball contains src/ — the bundle must not ship TS source." >&2
  exit 1
fi

for f in dist/index-nats.js dist/setup-entry.js; do
  if [ ! -f "$PKG/$f" ]; then
    echo "ERROR: packed tarball missing declared entry: $f" >&2
    exit 1
  fi
done

for f in dist/index-nats.js dist/setup-entry.js; do
  if [ "$(grep -cF '/src/' "$PKG/$f" || true)" -ne 0 ]; then
    echo "ERROR: $f contains a residual './src/' reference — bundle is not self-contained." >&2
    exit 1
  fi
done

# ── Install ONLY production dependencies (currently just `ws`) ───────────────
# The whole point: a runtime import misplaced into devDependencies won't be
# installed here, so the load step below catches it.
echo "==> Installing production deps only (--omit=dev) …"
(cd "$PKG" && npm install --omit=dev --no-audit --no-fund)

# Make host openclaw (peer, provides openclaw/plugin-sdk/*) resolvable.
mkdir -p "$PKG/node_modules"
ln -sfn "$OPENCLAW_DIR" "$PKG/node_modules/openclaw"

# ── Load BOTH declared dist entries; any load error → non-zero exit → fail ───
# This exercises STATIC top-level imports of the bundle (today: `ws` + node
# builtins + the openclaw peer). A production dep pulled only via a lazy
# `await import()` on an un-run path would not be caught here — acceptable, since
# the F3 imports (notably `ws`) are all static.
echo "==> Loading declared dist entries with production deps only …"
(cd "$PKG" && node --input-type=module -e '
import { pathToFileURL } from "node:url";
for (const f of ["dist/index-nats.js","dist/setup-entry.js"]) {
  await import(pathToFileURL(process.cwd()+"/"+f).href);
  console.log("LOADED", f);
}
console.log("PASS: plugin dist entries load with only production dependencies");
')

echo "SMOKE PASSED: pack-and-load F3 regression guard is green."
