# Repository conventions

## Shared project memory

Claude Code and Codex share project memory for this repository.

- Index: `~/.openclaw-webchannel-memory/MEMORY.md`
- Memory root: `~/.openclaw-webchannel-memory/`

Each host must map `~/.openclaw-webchannel-memory` to that host's Claude Code
memory directory for this repository. If it is missing, report it instead of
guessing another location.

Follow these rules when working in this repository:

1. At the start of a task, read `MEMORY.md` and only the linked files directly relevant to the request.
2. Explicit user instructions and the current repository and observed behavior override memory. Verify anything stale or conflicting.
3. Store only verified decisions, project state, and reusable environment knowledge. Never store secrets or personal data.
4. Memory is shared across worktrees and sessions. Re-read before writing, update the index when needed, and verify the saved result.

## Project rules

- `docs/STATUS.md` is the source of truth for project status. Current code and
  observed behavior take precedence over documentation and memory.
- Local test runs can OOM this no-swap host. Prefer the `E2E Gate` for the
  pushed commit; run only focused local checks when necessary, and never run or
  assign the full `npm test` suite locally.
- Pull requests normally target `develop`, not `main`.
- Never merge a pull request, publish or release a package, or close an issue
  without explicit user approval for that action.
