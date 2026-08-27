#!/usr/bin/env bash
# Self-test for ONE line of `pack-load-smoke.sh`: the residual-`/src/` scan.
#
# WHY THIS EXISTS. That scan was an unfiltered `grep -cF '/src/'`, and #240
# half 2 made it fail on a bundle that was perfectly self-contained — esbuild
# prefixes each inlined module with a bare `// <relative path>` banner, and the
# plugin now inlines the client's reducer (one reducer is the whole point of the
# v6 design). Filtering the banner out is the fix, and a filter added to make a
# red gate green is exactly the kind of change that can quietly disarm the thing
# it edits. So the filter is pinned here, both directions.
#
# Run: bash scripts/pack-load-smoke-selftest.sh
set -euo pipefail

# The predicate under test, character-for-character as `pack-load-smoke.sh` runs
# it. Kept as a copy on purpose: sourcing that script would run the whole smoke
# test (a full pack + install).
#
# ⚠️ A COPY IS ONLY A TEST OF THE ORIGINAL IF THE COPY IS PINNED, and an earlier
# revision of this comment claimed the checks below "fail loudly if the two ever
# disagree" — they cannot, because nothing here reads the production script.
# Widening `pack-load-smoke.sh`'s filter (say to `grep -cvE '^//'`, which drops
# EVERY comment line and disarms the scan) would leave every check below green.
# So the pin is explicit: assert the production file still contains this exact
# pipeline, and fail if it does not.
PREDICATE=$'grep -F \'/src/\' "$PKG/$f" | grep -cvE \'^// [^[:space:]]+$\''
SMOKE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pack-load-smoke.sh"
if [ ! -f "$SMOKE" ]; then
  echo "FAIL — cannot pin the predicate: $SMOKE not found" >&2
  exit 1
fi
if ! grep -qF -- "$PREDICATE" "$SMOKE"; then
  echo "FAIL — pack-load-smoke.sh no longer contains the predicate this self-test copies." >&2
  echo "       expected to find, verbatim:" >&2
  echo "         $PREDICATE" >&2
  echo "       Either the scan changed (update the copy below AND re-derive these" >&2
  echo "       checks against it) or it was disarmed. Do not just edit this file." >&2
  exit 1
fi

residual_count() {
  grep -F '/src/' "$1" | grep -cvE '^// [^[:space:]]+$' || true
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
failures=0

check() {
  local name="$1" expected="$2" file="$3" got
  got="$(residual_count "$file")"
  if [ "$got" -eq 0 ] && [ "$expected" = "pass" ]; then
    echo "  ok   — $name"
  elif [ "$got" -ne 0 ] && [ "$expected" = "fail" ]; then
    echo "  ok   — $name (caught $got)"
  else
    echo "  FAIL — $name: expected $expected, residual count = $got" >&2
    failures=$((failures + 1))
  fi
}

# ── The banner must NOT trip it ──────────────────────────────────────────────
# Verbatim shape esbuild emits, including the inlined body underneath, so this
# stays honest if esbuild's banner format ever changes.
cat > "$WORK/banner.js" <<'EOF'
// ../client/src/durable-view-reducer.ts
function applyDurableEvent(view, event) {
  switch (event.kind) {
    case "user":
      return applyUser(view, event);
  }
}
EOF
check "esbuild module banner is not a residual reference" pass "$WORK/banner.js"

# ── A real leak must trip it, in every shape it could arrive in ──────────────
for shape in \
  'require("./src/leak.js");' \
  'import { x } from "../client/src/leak.js";' \
  'await import("./src/leak.js");' \
  'const p = "packages/client/src/leak.js";'
do
  printf '// ../client/src/durable-view-reducer.ts\n%s\n' "$shape" > "$WORK/leak.js"
  check "leak still caught: ${shape:0:34}" fail "$WORK/leak.js"
done

# The adversarial case the filter could plausibly miss: a leak APPENDED to a
# banner line, so the line still starts like one.
printf '// ../client/src/durable-view-reducer.ts\nrequire("./src/leak.js");\n' > "$WORK/append.js"
check "leak on the line after a banner" fail "$WORK/append.js"
printf '// ../client/src/durable-view-reducer.ts require("./src/leak.js")\n' > "$WORK/inline.js"
check "leak appended to a banner line (two tokens, not one)" fail "$WORK/inline.js"

# A leak hidden in a comment is still a leak the scan should surface — it means
# a path that does not ship is being named in the output.
printf '// see ./src/leak.js for the real thing\n' > "$WORK/comment.js"
check "path named in a multi-token comment" fail "$WORK/comment.js"

# ── Clean bundle ─────────────────────────────────────────────────────────────
printf 'function f() { return 1; }\n' > "$WORK/clean.js"
check "a bundle with no /src/ at all" pass "$WORK/clean.js"

if [ "$failures" -ne 0 ]; then
  echo "pack-load-smoke self-test: $failures failure(s)" >&2
  exit 1
fi
echo "pack-load-smoke self-test: all checks passed"
