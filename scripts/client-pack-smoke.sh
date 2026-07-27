#!/usr/bin/env bash
# client-pack-smoke.sh — stale ignored-dist + published-surface regression guard.
#
# TypeScript does not remove outputs for source files deleted since a prior build.
# Seed the exact retired Gateway client artifacts into the reused client dist,
# then pack through the real prepack lifecycle. Clean-before-build must remove the
# seeds, and the complete tarball allowlist prevents any other stale output from
# silently shipping.
set -euo pipefail

REPO=$(git rev-parse --show-toplevel)
CLIENT_DIR="$REPO/packages/client"
WORK=$(mktemp -d)
cleanup() {
  rm -f \
    "$CLIENT_DIR/dist/client.js" \
    "$CLIENT_DIR/dist/client.d.ts" \
    "$CLIENT_DIR/dist/client.test.js" \
    "$CLIENT_DIR/dist/client.test.d.ts" \
    "$CLIENT_DIR/dist/e2e-browser-client.js" \
    "$CLIENT_DIR/dist/e2e-browser-client.d.ts"
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$CLIENT_DIR/dist"
printf '%s\n' 'export class WebChannelClient {}' 'export const path = "/webchannel/ws";' \
  'export const ticket = "?ticket=";' \
  > "$CLIENT_DIR/dist/client.js"
printf '%s\n' 'export declare class WebChannelClient {}' \
  > "$CLIENT_DIR/dist/client.d.ts"
printf '%s\n' 'export class WebChannelClient {}' \
  > "$CLIENT_DIR/dist/client.test.js"
printf '%s\n' 'export declare class WebChannelClient {}' \
  > "$CLIENT_DIR/dist/client.test.d.ts"
printf '%s\n' 'export class WebChannelClient {}' 'export const path = "/webchannel/ws";' \
  'export const ticket = "?ticket=";' \
  > "$CLIENT_DIR/dist/e2e-browser-client.js"
printf '%s\n' 'export declare class WebChannelClient {}' \
  > "$CLIENT_DIR/dist/e2e-browser-client.d.ts"

echo "==> Packing client after deliberately seeding retired Gateway outputs …"
TARBALL=$(cd "$CLIENT_DIR" && npm_config_cache="$WORK/npm-cache" npm pack --pack-destination "$WORK" --silent)
echo "    tarball: $TARBALL"

for stale in client.js client.d.ts client.test.js client.test.d.ts e2e-browser-client.js e2e-browser-client.d.ts; do
  if [ -e "$CLIENT_DIR/dist/$stale" ]; then
    echo "ERROR: client build retained stale generated output: dist/$stale" >&2
    exit 1
  fi
done

# Pin the complete publish surface. npm prefixes every tar entry with package/.
EXPECTED_FILES=$(cat <<'EOF'
README.md
dist/abort-mirror.d.ts
dist/abort-mirror.js
dist/browser-demo-entry.d.ts
dist/browser-demo-entry.js
dist/browser-jwt-entry.d.ts
dist/browser-jwt-entry.js
dist/chacha20poly1305.d.ts
dist/chacha20poly1305.js
dist/command-filter.d.ts
dist/command-filter.js
dist/e2e-crypto-browser.d.ts
dist/e2e-crypto-browser.js
dist/index.d.ts
dist/index.js
dist/nats-client-wrapper.d.ts
dist/nats-client-wrapper.js
dist/nats-client.d.ts
dist/nats-client.js
dist/nats-nkey-browser.d.ts
dist/nats-nkey-browser.js
dist/pop-register.d.ts
dist/pop-register.js
dist/protocol.d.ts
dist/protocol.js
dist/saas-bootstrap.d.ts
dist/saas-bootstrap.js
dist/types.d.ts
dist/types.js
package.json
EOF
)
EXPECTED_FILES=$(printf '%s\n' "$EXPECTED_FILES" | LC_ALL=C sort)
ACTUAL_FILES=$(tar tzf "$WORK/$TARBALL" | sed -e 's#^package/##' -e '/\/$/d' | LC_ALL=C sort)
if [ "$ACTUAL_FILES" != "$EXPECTED_FILES" ]; then
  echo "ERROR: packed client tarball file list differs from the allowlist." >&2
  diff -u <(printf '%s\n' "$EXPECTED_FILES") <(printf '%s\n' "$ACTUAL_FILES") >&2 || true
  exit 1
fi

tar xzf "$WORK/$TARBALL" -C "$WORK"
PKG="$WORK/package"

node --input-type=module - "$PKG/package.json" <<'NODE'
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (pkg.main !== "./dist/index.js" || pkg.module !== "./dist/index.js") {
  throw new Error(`unexpected client JS entries: main=${pkg.main} module=${pkg.module}`);
}
if (pkg.types !== "./dist/index.d.ts") {
  throw new Error(`unexpected client types entry: ${pkg.types}`);
}
const expectedExport = { types: "./dist/index.d.ts", import: "./dist/index.js" };
if (JSON.stringify(pkg.exports?.["."]) !== JSON.stringify(expectedExport)) {
  throw new Error(`unexpected client root export: ${JSON.stringify(pkg.exports?.["."])}`);
}
if (JSON.stringify(pkg.files) !== JSON.stringify(["dist"])) {
  throw new Error(`unexpected client files allowlist: ${JSON.stringify(pkg.files)}`);
}
NODE

# Plain grep, not rg: the self-hosted e2e runner does not guarantee ripgrep.
if grep -rnE 'WebChannelClient|WebChannelTransport|handleUpgrade|[?]ticket=' "$PKG/dist" \
  || grep -rnF '"/webchannel/ws"' "$PKG/dist" \
  || grep -rnF "'/webchannel/ws'" "$PKG/dist"; then
  echo "ERROR: packed client dist contains a removed Gateway transport symbol." >&2
  exit 1
fi

(cd "$PKG" && node --input-type=module <<'NODE'
import { pathToFileURL } from "node:url";
const api = await import(pathToFileURL(`${process.cwd()}/dist/index.js`).href);
if (typeof api.WebChannelNATSClient !== "function") {
  throw new Error("packed client is missing WebChannelNATSClient");
}
if ("WebChannelClient" in api) {
  throw new Error("packed client unexpectedly exports removed WebChannelClient");
}
NODE
)

echo "PASS: client pack is rebuilt cleanly and matches the pinned Gateway-free surface."
