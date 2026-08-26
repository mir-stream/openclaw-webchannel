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
#   actually LOADS both gateway dist entries in Node, then resolves and executes
#   the offline entry from an isolated managed installation. A runtime import
#   that a future change drops into devDependencies won't be installed here, so the
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
TARBALL=$(cd "$PLUGIN_DIR" && npm_config_cache="$WORK/npm-cache" npm pack --pack-destination "$WORK" | tail -1)
echo "    tarball: $TARBALL"

echo "==> Extracting tarball …"
tar xzf "$WORK/$TARBALL" -C "$WORK"
PKG="$WORK/package"

# The packed manifest must expose the two NATS-safe gateway entries and the
# dedicated offline rotation entry at its exact installed-artifact path.
node --input-type=module - "$PKG/package.json" <<'NODE'
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expectedExtensions = ["./dist/index-nats.js"];
if (JSON.stringify(pkg.openclaw?.extensions) !== JSON.stringify(expectedExtensions)) {
  throw new Error(`unexpected openclaw.extensions: ${JSON.stringify(pkg.openclaw?.extensions)}`);
}
if (pkg.openclaw?.setupEntry !== "./dist/setup-entry.js") {
  throw new Error(`unexpected openclaw.setupEntry: ${JSON.stringify(pkg.openclaw?.setupEntry)}`);
}
if (pkg.bin?.["openclaw-webchannel-rotate-key"] !== "./dist/rotate-key-entry.js") {
  throw new Error(`unexpected rotation bin: ${JSON.stringify(pkg.bin)}`);
}
NODE

# Pin the complete tarball surface. npm prefixes entries with `package/`.
EXPECTED_FILES=$(cat <<'EOF'
LICENSE
README.md
dist/index-nats.js
dist/rotate-key-entry.js
dist/setup-entry.js
index-nats.ts
openclaw.plugin.json
package.json
rotate-key-entry.ts
setup-entry.ts
EOF
)
# LC_ALL=C on BOTH sides: the heredoc above is ordered by C-locale sort, and an
# unpinned `sort` (e.g. ko_KR.UTF-8) orders README.md differently → false diff.
EXPECTED_FILES=$(printf '%s\n' "$EXPECTED_FILES" | LC_ALL=C sort)
ACTUAL_FILES=$(tar tzf "$WORK/$TARBALL" | sed -e 's#^package/##' -e '/\/$/d' | LC_ALL=C sort)
if [ "$ACTUAL_FILES" != "$EXPECTED_FILES" ]; then
  echo "ERROR: packed tarball file list differs from the allowlist." >&2
  diff -u <(printf '%s\n' "$EXPECTED_FILES") <(printf '%s\n' "$ACTUAL_FILES") >&2 || true
  exit 1
fi

# ── Assertions on the extracted package ─────────────────────────────────────
if [ -d "$PKG/src" ]; then
  echo "ERROR: packed tarball contains src/ — the bundle must not ship TS source." >&2
  exit 1
fi

for f in dist/index-nats.js dist/setup-entry.js dist/rotate-key-entry.js; do
  if [ ! -f "$PKG/$f" ]; then
    echo "ERROR: packed tarball missing declared entry: $f" >&2
    exit 1
  fi
done

for f in dist/index-nats.js dist/setup-entry.js; do
  if grep -qF 'conversation-key account rotation has no target' "$PKG/$f"; then
    echo "ERROR: offline account rotation mutation leaked into $f." >&2
    exit 1
  fi
done
if ! grep -qF 'conversation-key account rotation has no target' \
  "$PKG/dist/rotate-key-entry.js"; then
  echo "ERROR: rotation bundle lacks the offline account mutation guard." >&2
  exit 1
fi

# Plain grep, NOT rg: rg is absent on the self-hosted runner, and an exit-127
# inside `if` reads as "no matches" — the scan would be silently disarmed.
if grep -rnE 'handleUpgrade|[?]ticket=|WebChannelTransport' "$PKG/dist"; then
  echo "ERROR: packed dist contains a removed gateway transport symbol." >&2
  exit 1
fi

# A residual `/src/` reference means the bundle would try to resolve a source
# path that the published tarball does not ship — the thing this whole smoke
# test exists to catch.
#
# ⚠️ ESBUILD'S MODULE BANNER IS NOT ONE, AND EXCLUDING IT IS NOT A SOFTENING.
# esbuild prefixes each inlined module with a bare `// <relative path>` comment.
# Since #240 half 2 the plugin has a PRODUCTION cross-package source import —
# `journal-history.ts` pulls the client's `durable-view-reducer.ts`, because
# `history == live` requires literally one reducer — so `index-nats.js` now
# carries `// ../client/src/durable-view-reducer.ts` with the reducer INLINED
# directly beneath it. That line is evidence the bundle is self-contained, and
# the unfiltered grep read it as proof of the opposite. (It only appeared now:
# in half 1 the module had no callers and was tree-shaken out.)
#
# So the filter drops ONLY a line that is entirely an esbuild banner — `// ` and
# a single token, nothing else. An import specifier, a `require(...)`, a dynamic
# `import(...)` or any string literal still matches, because none of those can
# be the whole of such a line. Proven both ways in
# `scripts/pack-load-smoke-selftest.sh`: the real banner passes, and an injected
# `require("./src/leak.js")` — on its own line, appended to a banner line, and
# inside a comment — still fails.
for f in dist/index-nats.js dist/setup-entry.js dist/rotate-key-entry.js; do
  if [ "$(grep -F '/src/' "$PKG/$f" | grep -cvE '^// [^[:space:]]+$' || true)" -ne 0 ]; then
    echo "ERROR: $f contains a residual './src/' reference — bundle is not self-contained." >&2
    grep -F '/src/' "$PKG/$f" | grep -vE '^// [^[:space:]]+$' | head -5 >&2
    exit 1
  fi
done

# ── Install ONLY production dependencies (currently just `ws`) ───────────────
# The whole point: a runtime import misplaced into devDependencies won't be
# installed here, so the load step below catches it.
echo "==> Installing production deps only (--omit=dev) …"
(cd "$PKG" && npm_config_cache="$WORK/npm-cache" npm install --omit=dev --no-audit --no-fund)

# Make host openclaw (peer, provides openclaw/plugin-sdk/*) resolvable.
mkdir -p "$PKG/node_modules"
ln -sfn "$OPENCLAW_DIR" "$PKG/node_modules/openclaw"

# ── Load BOTH gateway dist entries; any load error → non-zero exit → fail ──
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

# ── Install through OpenClaw and resolve the managed artifact root ───────
# ClawHub/managed installs do not expose package bins on PATH. This is the exact
# supported operator path documented by the containment runbook.
MANAGED_STATE="$WORK/openclaw-state"
MANAGED_CONFIG="$MANAGED_STATE/openclaw.json"
OPENCLAW_BIN="$REPO/node_modules/.bin/openclaw"
mkdir -p "$MANAGED_STATE"

echo "==> Installing packed plugin into isolated OpenClaw state …"
OPENCLAW_STATE_DIR="$MANAGED_STATE" \
OPENCLAW_CONFIG_PATH="$MANAGED_CONFIG" \
  "$OPENCLAW_BIN" plugins install "$WORK/$TARBALL"

INSPECT_JSON=$(
  OPENCLAW_STATE_DIR="$MANAGED_STATE" \
  OPENCLAW_CONFIG_PATH="$MANAGED_CONFIG" \
    "$OPENCLAW_BIN" plugins inspect webchannel --json
)
PLUGIN_ROOT=$(
  printf '%s' "$INSPECT_JSON" | node --input-type=module -e '
    import { isAbsolute } from "node:path";
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const root = JSON.parse(chunks.join("")).plugin?.rootDir;
    if (typeof root !== "string" || !isAbsolute(root)) process.exit(2);
    process.stdout.write(root);
  '
)
if [ ! -f "$PLUGIN_ROOT/dist/rotate-key-entry.js" ]; then
  echo "ERROR: inspected plugin root lacks dist/rotate-key-entry.js: $PLUGIN_ROOT" >&2
  exit 1
fi

echo "==> Executing managed rotation entry --help …"
ROTATE_HELP=$(node "$PLUGIN_ROOT/dist/rotate-key-entry.js" --help)
if ! printf '%s' "$ROTATE_HELP" | grep -qF -- '--credential-path <file>'; then
  echo "ERROR: managed rotation entry help lacks --credential-path." >&2
  exit 1
fi
if ! printf '%s' "$ROTATE_HELP" | \
  grep -qF -- 'SERVICE CONTEXT IS PART OF THE TARGET'; then
  echo "ERROR: managed rotation entry help lacks the service-context warning." >&2
  exit 1
fi

# ── Exercise packed dry run, apply, and complete durable readback ───────
ROTATE_STORAGE_ROOT="$WORK/rotation-store"
ROTATE_TENANT="pack-smoke-tenant"
ROTATE_ACCOUNT="pack-smoke-account"
ROTATE_PEER="peer-one"
export ROTATE_STORAGE_ROOT ROTATE_TENANT ROTATE_ACCOUNT ROTATE_PEER

node --input-type=module <<'NODE'
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const frame = (value) => {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};
const scope = {
  tenant: process.env.ROTATE_TENANT,
  accountId: process.env.ROTATE_ACCOUNT,
};
const hash = createHash("sha256");
for (const value of [
  "openclaw-webchannel/storage-identity/v2",
  scope.tenant,
  scope.accountId,
]) hash.update(frame(value));
const directory = join(
  process.env.ROTATE_STORAGE_ROOT,
  `v2_${hash.digest("base64url")}`,
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const storageIdentity = { identityVersion: 2, storage: scope };
writeFileSync(
  join(directory, "conversation-keys.json"),
  JSON.stringify({
    version: 2,
    storageIdentity,
    keys: {
      "peer-one": Buffer.alloc(32, 0x11).toString("base64url"),
      "peer-two": Buffer.alloc(32, 0x22).toString("base64url"),
    },
  }, null, 2),
  { mode: 0o600 },
);
writeFileSync(
  join(directory, "conversation-key-generations.json"),
  JSON.stringify({
    version: 1,
    storageIdentity,
    generations: {
      "peer-one": { epoch: 1, rotatedAtSec: 1700000000 },
      "peer-two": { epoch: 1, rotatedAtSec: 1700000000 },
    },
  }, null, 2),
  { mode: 0o600 },
);
NODE

read_rotation_keys() {
  node --input-type=module -e '
    import { createHash } from "node:crypto";
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    const frame = (value) => {
      const bytes = Buffer.from(value, "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      return Buffer.concat([length, bytes]);
    };
    const hash = createHash("sha256");
    for (const value of [
      "openclaw-webchannel/storage-identity/v2",
      process.env.ROTATE_TENANT,
      process.env.ROTATE_ACCOUNT,
    ]) hash.update(frame(value));
    const path = join(
      process.env.ROTATE_STORAGE_ROOT,
      `v2_${hash.digest("base64url")}`,
      "conversation-keys.json",
    );
    process.stdout.write(JSON.stringify(JSON.parse(readFileSync(path, "utf8")).keys));
  '
}

KEYS_BEFORE=$(read_rotation_keys)
DRY_OUTPUT=$(node "$PLUGIN_ROOT/dist/rotate-key-entry.js" \
  --tenant "$ROTATE_TENANT" --account "$ROTATE_ACCOUNT" \
  --storage-root "$ROTATE_STORAGE_ROOT" --peer "$ROTATE_PEER")
KEYS_AFTER_DRY=$(read_rotation_keys)
if [ "$KEYS_AFTER_DRY" != "$KEYS_BEFORE" ]; then
  echo "ERROR: packed rotation dry run changed key material." >&2
  exit 1
fi
if ! printf '%s' "$DRY_OUTPUT" | grep -qF 'DRY RUN'; then
  echo "ERROR: packed rotation dry run did not identify itself." >&2
  exit 1
fi

APPLY_OUTPUT=$(node "$PLUGIN_ROOT/dist/rotate-key-entry.js" \
  --tenant "$ROTATE_TENANT" --account "$ROTATE_ACCOUNT" \
  --storage-root "$ROTATE_STORAGE_ROOT" --peer "$ROTATE_PEER" --apply)
KEYS_AFTER_APPLY=$(read_rotation_keys)
node --input-type=module - "$KEYS_BEFORE" "$KEYS_AFTER_APPLY" <<'NODE'
const before = JSON.parse(process.argv[2]);
const after = JSON.parse(process.argv[3]);
if (after["peer-one"] === before["peer-one"]) {
  throw new Error("packed apply did not replace the target key");
}
if (after["peer-two"] !== before["peer-two"]) {
  throw new Error("packed exact-peer apply changed a non-target key");
}
NODE
if ! printf '%s' "$APPLY_OUTPUT" | grep -qF 'readback:  verified from disk'; then
  echo "ERROR: packed rotation apply did not report verified readback." >&2
  exit 1
fi

KEYS_BEFORE_ACCOUNT=$(read_rotation_keys)
ACCOUNT_DRY_OUTPUT=$(node "$PLUGIN_ROOT/dist/rotate-key-entry.js" \
  --tenant "$ROTATE_TENANT" --account "$ROTATE_ACCOUNT" \
  --storage-root "$ROTATE_STORAGE_ROOT" --all-peers)
TARGET_DIGEST=$(printf '%s\n' "$ACCOUNT_DRY_OUTPUT" | sed -n 's/^  digest:    //p')
node -e '
  if (!/^[0-9a-f]{64}$/.test(process.argv[1])) {
    throw new Error("packed account dry run emitted no valid target digest");
  }
' "$TARGET_DIGEST"
ACCOUNT_APPLY_OUTPUT=$(node "$PLUGIN_ROOT/dist/rotate-key-entry.js" \
  --tenant "$ROTATE_TENANT" --account "$ROTATE_ACCOUNT" \
  --storage-root "$ROTATE_STORAGE_ROOT" --all-peers --apply \
  --confirm-digest "$TARGET_DIGEST")
KEYS_AFTER_ACCOUNT=$(read_rotation_keys)
node --input-type=module - "$KEYS_BEFORE_ACCOUNT" "$KEYS_AFTER_ACCOUNT" <<'NODE'
const before = JSON.parse(process.argv[2]);
const after = JSON.parse(process.argv[3]);
for (const peerId of ["peer-one", "peer-two"]) {
  if (after[peerId] === before[peerId]) {
    throw new Error(`packed account apply did not replace ${peerId}`);
  }
}
NODE
if ! printf '%s' "$ACCOUNT_APPLY_OUTPUT" | grep -qF 'readback:  verified from disk'; then
  echo "ERROR: packed account apply did not report verified readback." >&2
  exit 1
fi

if printf '%s' "$DRY_OUTPUT$APPLY_OUTPUT$ACCOUNT_DRY_OUTPUT$ACCOUNT_APPLY_OUTPUT" | \
  grep -qF "$(node -e 'process.stdout.write(Buffer.alloc(32, 0x11).toString("base64url"))')"; then
  echo "ERROR: packed rotation output leaked key material." >&2
  exit 1
fi

echo "PASS: managed installed rotation entry completed peer/account dry runs, applies, and readbacks"

echo "SMOKE PASSED: pack-and-load F3 regression guard is green."
