#!/usr/bin/env bash
set -euo pipefail

REPO=$(git rev-parse --show-toplevel)
cd "$REPO"

# git grep instead of ripgrep: rg is not guaranteed on the self-hosted runner
# (and an rg exit-127 inside `if` reads as "no matches" — a silently disarmed
# guard). git grep is present wherever the checkout is, scans tracked +
# untracked-but-not-ignored files, and never descends into node_modules/dist.
#
# No \b in the pattern: git grep -E is POSIX ERE (no word boundaries). The
# substring match is strictly BROADER than the old rg pattern, which is the
# safe direction for a ban guard.
PATTERN='WebChannelClient|WebChannelTransport|handleUpgrade|[?]ticket=|key_exchange|devOpen|DEV_OPEN|subscribeWildcard|handleHandshake|resolveAdmissionMode|devOpenAgentIdentity'

if git grep -nE --untracked "$PATTERN" -- \
  packages examples demo e2e .ouroboros README.md CHANGELOG.md docs .github scripts \
  ':(exclude)packages/plugin/src/account-config.ts' \
  ':(exclude)packages/plugin/src/account-config.test.ts' \
  ':(exclude)packages/plugin/src/nats-credential-source.ts' \
  ':(exclude)packages/plugin/src/nats-credential-source.test.ts' \
  ':(exclude)packages/plugin/openclaw.plugin.json' \
  ':(exclude)CHANGELOG.md' \
  ':(exclude)docs/archive' \
  ':(exclude)docs/review-2026-07-15' \
  ':(exclude)docs/REVIEW_2026-07-15.md' \
  ':(exclude)scripts/check-banned-symbols.sh' \
  ':(exclude)scripts/client-pack-smoke.sh' \
  ':(exclude)scripts/pack-load-smoke.sh'; then
  echo "ERROR: removed transport/admission symbol found in a current source, package, doc, or workflow." >&2
  exit 1
fi

echo "PASS: removed transport/admission symbols are absent from current surfaces."
