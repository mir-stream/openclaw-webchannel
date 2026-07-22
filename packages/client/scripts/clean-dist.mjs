import { rm } from "node:fs/promises";

// Keep package builds reproducible when a worktree reuses an ignored dist/ from
// an older source tree. The static URL deliberately scopes deletion to this
// package's generated output directory.
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
