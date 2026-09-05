# Repository conventions

## Shared project memory

Claude Code and Codex share the following project memory for this repository.

- Index: `~/.openclaw-webchannel-memory/MEMORY.md`
- Memory root: `~/.openclaw-webchannel-memory/`

Each host must provide `~/.openclaw-webchannel-memory` as a symlink to that
host's Claude Code memory directory for this repository. If the symlink is
missing, report it instead of guessing or searching for another memory
directory.

Follow these rules when working in this repository:

1. Read `MEMORY.md` at the start of a task.
2. Read only the linked memory files that are directly relevant to the current request.
3. Explicit user instructions and the repository's current code, documentation, and observed behavior take precedence over memory.
4. Verify memory that may be stale or conflicts with the current repository state before relying on it.
5. When updating memory, record only verified user decisions, project state, and reusable environment knowledge.
6. Update the `MEMORY.md` index whenever a memory file is added or its summary changes.
7. Multiple worktrees and sessions share this memory. Re-read the latest content before writing, then verify the saved changes afterward.
8. Never store secrets such as tokens, passwords, credentials, or customer personal data in memory.

## Sources of truth

- Read `docs/STATUS.md` before relying on project-status claims. It supersedes
  completion claims in commit messages, `.ouroboros/`, evaluator output, and
  older notes.
- Treat `.ouroboros/` as historical design input, not as the active development
  workflow, unless the user explicitly asks to use it.
- Current code and observed behavior outrank prose. When behavior matters,
  inspect the implementation and run a focused probe instead of extending an
  unverified premise.

## Delivery, message identity, history, and streaming

Before changing or making claims about this subsystem, read
`docs/ISSUE_114_DELIVERY_MIRROR_PLAN.md`, especially sections 0, 0.2, 15,
16.5, 16.5.1, and 16.5.3.

The north star is:

- Our plugin performs the roles of both the Telegram plugin and the Telegram
  server. It owns delivery-time identity and the durable client-facing store.
- Our client performs the role of the Telegram app. It may keep local state,
  cache, a sequence cursor, gap synchronization, and optimistic sends, but it
  must not invent message identity from text or position.
- Do not read the core transcript to construct client history.
- Telegram's `lane` is a content type (`answer` or `reasoning`), while this
  project's lane is per assistant message. Do not copy Telegram's rendering
  behavior without accounting for that difference.
- Before calling a limitation structural, core-imposed, impossible, or part of
  the specification, check the anti-regression NOT list in section 0.2 and the
  pinned core implementation used by the built-in Telegram channel.

## Verification

Do not run the full Vitest sweep locally. `vitest.config.ts` uses isolated
forks without a `maxForks` cap; parallel worktrees on this no-swap host have
caused OOM failures.

- The full-suite evidence is the `E2E Gate` result for the pushed commit.
- Locally, run only named test files or a narrow probe for the code being
  changed.
- `npm run typecheck`, `npm run test:inventory`, and
  `npm run lint:citations` are acceptable local checks.
- Never assign `npm test` or another full local sweep to a subagent.
- Changes to test counts require updating `.github/test-inventory.json` as
  described in `README.md`.

## Integration safety

- Pull requests normally target `develop`, not `main`; verify the actual base
  and inspect the full base-to-head diff.
- Never merge a pull request, publish or release a package, or close an issue
  without explicit user approval for that action.
