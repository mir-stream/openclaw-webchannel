# shellcheck shell=bash
#
# Shared helpers for the six live e2e gates (e2e/local/run-*.sh).
#
# Source it once near the top of a gate (after $REPO is set), then:
#
#     . "$REPO/e2e/local/lib/harness.sh"
#     harness_ports run-turn-outcome                                  # exports GW_PORT, NATS_WS, …
#     harness_build_plugin run-turn-outcome "$OCH/plugin-build.log"   # step 0, before any server
#     …boot the gateway, wait for readiness…
#     harness_assert_loaded_dist run-turn-outcome "$OCH/gateway.log"  # after readiness
#
# ---------------------------------------------------------------------------
# WHY `harness_build_plugin` EXISTS (#125)
#
# The gateway resolves this plugin's BUILT bundle (packages/plugin/dist/
# index-nats.js) regardless of the package.json entry swap each gate performs.
# Before this helper, only run-multi-message.sh rebuilt it; the other five
# booted whatever bundle happened to be on disk. A gate that loads a stale
# bundle does not test your working tree — it tests whoever built last.
#
# That is not hypothetical. During #113 a decision point was edited and
# run-two-account-isolation.sh was run twice, both times concluding "this guard
# is not the cause". The edit had never executed. It was caught only by an
# impossible pair: a console.log inserted directly above a warning that WAS
# printing did not appear.
#
# MEASURED on the pinned core, while validating run-multi-message.sh (the gate
# that pioneered this step): the gateway resolves the BUILT bundle regardless of
# the package.json entry swap each gate performs —
#   [plugins] channel "webchannel" registered … (plugin=webchannel,
#     source=…/packages/plugin/dist/index-nats.js)
# Proven by bisection: with the #94 fix reverted in `src/` but a stale FIXED
# `dist/` on disk the harness PASSED (exit 0); with `dist/` rebuilt from that
# same reverted `src/` it FAILED (exit 6). The entry swap is kept for parity and
# for a core that DOES honour a .ts entry, but the build is what makes a gate see
# your working tree.
#
# NO IDEMPOTENCE CHECK, ON PURPOSE. The build is a single esbuild bundle —
# MEASURED at 276ms of esbuild, 0.6–0.9s wall including npm's own startup. Six
# gates therefore cost ~5s of rebuilds against harnesses that each take minutes
# of live nats-server, gateway boot and enrollment. An mtime-comparison fast
# path would buy back seconds while re-introducing the one failure mode this
# helper exists to kill: a build that gets SKIPPED when it should have run. A
# redundant rebuild is free; a skipped one costs a review round and a wrong
# conclusion. Always build.
# ---------------------------------------------------------------------------

_harness_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # e2e/local/lib
HARNESS_REPO="$(cd "$_harness_lib_dir/../../.." && pwd)"           # repo root
HARNESS_PORTS_JSON="$_harness_lib_dir/../ports.json"               # e2e/local/ports.json

# harness_prepare_private_root <root>
#
# Creates the per-run OpenClaw layout without deleting anything, then makes the
# root owner-only. Callers retain their explicit, narrowly scoped pre-clean so
# this helper can never turn an empty or malformed argument into an `rm` target.
harness_prepare_private_root() {
  if [ "$#" -ne 1 ] || [ -z "${1:-}" ]; then
    echo "[harness] FATAL: harness_prepare_private_root requires one non-empty root path" >&2
    return 2
  fi

  local root
  root="$(node -e '
    const { resolve } = require("node:path");
    process.stdout.write(resolve(process.argv[1]));
  ' "$1")" || {
    echo "[harness] FATAL: could not resolve private root: $1" >&2
    return 2
  }

  if [ "$root" = "/" ]; then
    echo "[harness] FATAL: refusing unsafe private root target: $1" >&2
    return 2
  fi
  if [ -L "$root" ]; then
    echo "[harness] FATAL: private root must not be a symlink: $root" >&2
    return 2
  fi

  mkdir -p "$root/.openclaw" || {
    echo "[harness] FATAL: could not create private root layout: $root" >&2
    return 2
  }
  if [ -L "$root" ] || [ ! -d "$root" ]; then
    echo "[harness] FATAL: private root is not a real directory: $root" >&2
    return 2
  fi
  chmod 0700 "$root" || {
    echo "[harness] FATAL: could not set private root mode 0700: $root" >&2
    return 2
  }

  local mode
  mode="$(node -e '
    const fs = require("node:fs");
    process.stdout.write((fs.statSync(process.argv[1]).mode & 0o777).toString(8));
  ' "$root")" || {
    echo "[harness] FATAL: could not verify private root mode: $root" >&2
    return 2
  }
  if [ "$mode" != "700" ]; then
    echo "[harness] FATAL: private root mode is $mode, expected 700: $root" >&2
    return 2
  fi
}

# harness_ports <harness-name> [log-tag]
#
# Exports every port in e2e/local/ports.json under harnesses.<harness-name> as a
# shell variable of the same key (GW_PORT, NATS_WS, NATS_TCP, ECHO_PORT, …), and
# echoes what it loaded. ports.json is the single source of truth — a gate must
# never hard-code a port literal again (see the rules at the top of that file).
#
# <harness-name> must match the run-*.sh basename (ports.test.ts enforces that).
# [log-tag] defaults to it, and exists only because some gates log under a
# shorter name than their filename (run-two-account-isolation → run-two-acct).
harness_ports() {
  local harness="$1"
  local tag="${2:-$1}"
  local assignments

  if [ ! -f "$HARNESS_PORTS_JSON" ]; then
    echo "[$tag] FATAL: port authority missing: $HARNESS_PORTS_JSON" >&2
    return 1
  fi

  assignments="$(node -e '
    const fs = require("node:fs");
    const [file, harness] = process.argv.slice(1);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const block = doc.harnesses && doc.harnesses[harness];
    if (!block) {
      console.error(`no harnesses[${JSON.stringify(harness)}] block in ${file}`);
      console.error(`known harnesses: ${Object.keys(doc.harnesses || {}).join(", ")}`);
      process.exit(1);
    }
    const out = [];
    for (const [k, v] of Object.entries(block)) {
      if (k.startsWith("$")) continue; // $note and friends are documentation
      // Keys become shell variables via `eval`. A non-identifier key would make
      // eval emit a bare `command not found` instead of our FATAL line.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        console.error(`harnesses[${JSON.stringify(harness)}] key ${JSON.stringify(k)} is not a shell identifier`);
        process.exit(1);
      }
      if (!Number.isInteger(v) || v < 1 || v > 65535) {
        console.error(`harnesses[${JSON.stringify(harness)}].${k} = ${JSON.stringify(v)} is not a port`);
        process.exit(1);
      }
      out.push(`${k}=${v}`);
    }
    if (out.length === 0) {
      console.error(`harnesses[${JSON.stringify(harness)}] declares no ports`);
      process.exit(1);
    }
    process.stdout.write(out.join("\n"));
  ' "$HARNESS_PORTS_JSON" "$harness")" || {
    echo "[$tag] FATAL: could not load port assignments from $HARNESS_PORTS_JSON" >&2
    return 1
  }

  eval "$assignments"
  # Name the BLOCK, not just the log tag. A gate loading another gate's block
  # (`harness_ports run-turn-outcome run-multi-message`) is #118 with no literal
  # anywhere; if the run log only says "[run-multi-message]" nothing reveals it.
  # ports.test.ts asserts run-X.sh loads block X; this makes it visible too.
  echo "[$tag] ports (block '$harness' of e2e/local/ports.json): $(echo "$assignments" | tr '\n' ' ')"
}

# harness_build_plugin <tag> <build-log-path>
#
# Rebuilds packages/plugin/dist from the working tree and prints one provenance
# line naming the bundle: absolute path, build time, size, content hash. Exports
# HARNESS_DIST and HARNESS_DIST_SHA for harness_assert_loaded_dist.
#
# THE PROVENANCE LINE IS NOT A CHECK. It is a record for whoever reads the log
# later — which bundle, which bytes. It cannot detect a skipped build: it is
# printed inside this function, immediately after an unconditional build that
# always rewrites the output, so its timestamp is always "just now" and its hash
# is always the hash of what we just wrote. There is no code path that prints it
# without having built. Do not treat any field in it as evidence of anything
# beyond "this is the file that existed after the build."
#
# The load-bearing check is harness_assert_loaded_dist, below.
harness_build_plugin() {
  local tag="$1"
  local logfile="$2"
  local dist="$HARNESS_REPO/packages/plugin/dist/index-nats.js"

  echo "[$tag] building plugin dist/ from the working tree…"
  ( cd "$HARNESS_REPO" && npm run build --workspace=packages/plugin ) >"$logfile" 2>&1 || {
    echo "[$tag] plugin build FAILED — log:" >&2
    cat "$logfile" >&2
    return 2
  }

  if [ ! -f "$dist" ]; then
    echo "[$tag] FATAL: build reported success but $dist does not exist" >&2
    return 2
  fi

  HARNESS_DIST="$dist"
  HARNESS_DIST_SHA="$(node -e '
    const fs = require("node:fs"), crypto = require("node:crypto");
    process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
  ' "$dist")"

  # node (not stat/date) so the format is identical on Linux and macOS.
  TAG="$tag" SHA="$HARNESS_DIST_SHA" node -e '
    const fs = require("node:fs");
    const p = process.argv[1];
    const st = fs.statSync(p);
    console.log(
      `[${process.env.TAG}] built dist: ${p} ` +
      `(${new Date(st.mtimeMs).toISOString()}, ${st.size} bytes, ` +
      `sha256 ${process.env.SHA.slice(0, 16)})`,
    );
  ' "$dist"
}

# harness_assert_loaded_dist <tag> <gateway-log-path>
#
# Call AFTER the gateway reports readiness. Asserts that the bundle the gateway
# actually resolved is the one harness_build_plugin just wrote.
#
# WHY THIS AND NOT THE PROVENANCE LINE (#125 review): building the right file and
# the gateway LOADING that file are two different claims, and only the first was
# ever checked. The full-registration callback behind `index-nats.ts`, in
# `packages/plugin/src/nats-account-runtime.ts`, always self-reports the running
# module path (resolved from `import.meta.url`) as
#   webchannel: loaded plugin bundle (plugin=webchannel, source=<path>)
# Pinned core may also log its resolution as
#   [plugins] channel "webchannel" registered … (plugin=webchannel, source=<path>)
# That core diagnostic is corroborating when present, while the plugin-owned
# record is the guaranteed healthy-load signal. Both carry the same
# parenthetical, so the complete parsed source set still catches a core update
# that changes plugin resolution (e.g. one that starts honouring the .ts entry,
# or resolves an installed copy instead of the workspace) — the whole class of
# "your build was fine and irrelevant".
#
# It also re-hashes the bundle to catch anything that rewrote dist/ between the
# build and gateway start (a concurrent gate, a stray watch process).
harness_assert_loaded_dist() {
  local tag="$1"
  local gwlog="$2"

  if [ -z "${HARNESS_DIST:-}" ]; then
    echo "[$tag] FATAL: harness_assert_loaded_dist called before harness_build_plugin" >&2
    return 2
  fi

  if [ ! -f "$gwlog" ]; then
    echo "[$tag] DIST-ASSERT FAIL: no gateway log at $gwlog" >&2
    return 2
  fi

  local plugin_loaded_sources loaded_sources
  plugin_loaded_sources="$(
    sed -nE '
      s/^.*webchannel: loaded plugin bundle \(plugin=webchannel, source=(.*)\)[[:space:]]*$/\1/p
    ' "$gwlog" | sort -u
  )"
  loaded_sources="$(
    sed -nE '
      /[(,][[:space:]]*plugin=webchannel[[:space:]]*[,)]/ {
        s/^.*[(,][[:space:]]*source=(.*)\)[[:space:]]*$/\1/p
      }
    ' "$gwlog" | sort -u
  )"

  # `sort -u` deliberately permits duplicate identical registration records,
  # but the complete resolved-source SET must be the singleton built bundle.
  # One correct record must never mask a second stale/foreign resolution.
  if [ "$loaded_sources" != "$HARNESS_DIST" ]; then
    echo "[$tag] DIST-ASSERT FAIL: the gateway did not load the bundle this gate built." >&2
    echo "[$tag]   expected: source=$HARNESS_DIST" >&2
    echo "[$tag]   sources resolved for plugin=webchannel:" >&2
    if [ -n "$loaded_sources" ]; then
      printf '%s\n' "$loaded_sources" | sed "s|^|[$tag]     source=|" >&2
    else
      echo "[$tag]     (none — no provenance record for plugin=webchannel)" >&2
    fi
    return 2
  fi

  # Core can report the same parenthetical for both successful registration and
  # load failures. Only this plugin-owned marker proves full registration ran.
  if [ "$plugin_loaded_sources" != "$HARNESS_DIST" ]; then
    echo "[$tag] DIST-ASSERT FAIL: no plugin-owned healthy-load marker for the bundle this gate built." >&2
    echo "[$tag]   expected marker: webchannel: loaded plugin bundle (plugin=webchannel, source=$HARNESS_DIST)" >&2
    echo "[$tag]   plugin-reported loaded sources:" >&2
    if [ -n "$plugin_loaded_sources" ]; then
      printf '%s\n' "$plugin_loaded_sources" | sed "s|^|[$tag]     source=|" >&2
    else
      echo "[$tag]     (none — no plugin-owned loaded-bundle marker)" >&2
    fi
    return 2
  fi

  local now
  now="$(node -e '
    const fs = require("node:fs"), crypto = require("node:crypto");
    process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
  ' "$HARNESS_DIST")"
  if [ "$now" != "$HARNESS_DIST_SHA" ]; then
    echo "[$tag] DIST-ASSERT FAIL: dist/ changed between build and gateway start." >&2
    echo "[$tag]   built:  sha256 ${HARNESS_DIST_SHA:0:16}" >&2
    echo "[$tag]   on disk now: sha256 ${now:0:16}" >&2
    return 2
  fi

  echo "[$tag] ✓ DIST-ASSERT: gateway loaded the bundle this gate built (source=$HARNESS_DIST, sha256 ${HARNESS_DIST_SHA:0:16})"
}
