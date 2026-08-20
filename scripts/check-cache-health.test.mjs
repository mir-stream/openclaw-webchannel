import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseCache, parseCacheArgs, visibleCacheRefs } from "./check-cache-health.mjs";

const CLI = fileURLToPath(new URL("./check-cache-health.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
// The CLI makes three requests to a loopback stub; this only has to be large
// enough that a healthy run never trips it.
const CLI_TIMEOUT_MS = 5_000;

// ─── FIXTURES TRANSCRIBED FROM LIVE API RESPONSES ──────────────────────────
// Recorded against mir-stream/openclaw-webchannel, run 32219789806, with
// `gh api`. DO NOT HAND-INVENT OR "TIDY" THESE SHAPES.
//
// The first revision of this file did exactly that: it stubbed `default_branch`
// INSIDE the run object's nested `repository`, a key that endpoint has never
// returned. Seventeen tests went green over a guard that resolved
// `defaultBranch: undefined` on every real run, silently dropped the default
// branch from the visible-ref set, and could not see a poisoned entry on it —
// printing "genuinely new" and exiting 0. A stub that answers a shape the API
// does not have certifies nothing. If a field moves, re-record it with
// `gh api <path>` and paste what came back.
//
// Only the fields the guard reads are transcribed, plus the ones whose ABSENCE
// is load-bearing. Unrelated fields are omitted rather than invented.

const REPOSITORY = "mir-stream/openclaw-webchannel";
const RUN_ID = "32219789806";

/** GET /repos/{owner}/{repo} — this is the ONLY place `default_branch` lives. */
const REPO_PAYLOAD = { full_name: REPOSITORY, default_branch: "main" };

/**
 * GET /repos/{owner}/{repo}/actions/runs/{run_id}
 *
 * `run_started_at` is present and correct. The nested `repository` object is a
 * MINIMAL repo reference carrying NO `default_branch` — that absence is the
 * point of this fixture, and it is what stops the old defect from ever going
 * green here again.
 */
const RUN_PAYLOAD = {
  run_started_at: "2026-08-19T05:32:17Z",
  head_branch: "develop",
  repository: { full_name: REPOSITORY },
};

const KEY =
  "playwright-chromium-b8f20e2c06bcbc1b22fca4dd4d1d7ffbcee94616a3295deced9f0751e6e924c4";

/**
 * GET /repos/{owner}/{repo}/actions/caches?key=<KEY>&per_page=100 — the live
 * response, confirming the `key=` filter works and that the same key really is
 * duplicated across a PR merge ref and a branch ref.
 *
 * `created_at` carries NINE fractional digits. Kept verbatim so a future
 * timestamp-parsing change cannot quietly regress these into the
 * "unparseable ⇒ treat as older" branch and turn the race guard into a
 * false-alarm generator.
 */
const LIVE_CACHE_ENTRIES = [
  {
    ref: "refs/pull/200/merge",
    key: KEY,
    created_at: "2026-08-19T08:34:14.020019000Z",
    size_in_bytes: 273962989,
  },
  {
    ref: "refs/heads/develop",
    key: KEY,
    created_at: "2026-08-19T08:28:57.659366000Z",
    size_in_bytes: 273962419,
  },
];

const RUN_STARTED_AT = RUN_PAYLOAD.run_started_at;
// Same nanosecond shape as the live entries, moved before the run start so it
// models an entry this run had the opportunity to restore.
const BEFORE_RUN = "2026-08-18T22:11:03.884512000Z";
const AFTER_RUN = LIVE_CACHE_ENTRIES[1].created_at;

let stubServer;

afterEach(async () => {
  // Closed here rather than at the end of each test so a failing assertion
  // cannot leak a listening socket into the rest of the sweep.
  const server = stubServer;
  stubServer = undefined;
  if (server) await new Promise((resolve) => server.close(resolve));
});

/**
 * Stand up a loopback stand-in for the Actions REST API, routing the three
 * paths the guard calls. `actionsCaches` is returned for every key query.
 */
async function startStubApi({ actionsCaches, repoPayload = REPO_PAYLOAD }) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url.includes("/actions/runs/")) {
      response.end(JSON.stringify(RUN_PAYLOAD));
      return;
    }
    if (request.url.includes("/actions/caches")) {
      response.end(
        JSON.stringify({ total_count: actionsCaches.length, actions_caches: actionsCaches }),
      );
      return;
    }
    if (request.url === `/repos/${REPOSITORY}`) {
      response.end(JSON.stringify(repoPayload));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "unexpected path" }));
  });
  stubServer = server;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

async function runCli(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  // The helper owns the timeout so a hung CLI is killed and awaited here. If
  // Vitest's own timeout fired instead, the child would outlive the run.
  const code = await new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CLI_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `cache health CLI did not exit within ${CLI_TIMEOUT_MS}ms; killed and awaited exit`,
          ),
        );
        return;
      }
      resolve(exitCode);
    });
  });

  return { code, stdout, stderr };
}

function cliEnv(origin, overrides = {}) {
  return {
    GITHUB_API_URL: origin,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_REF: "refs/heads/develop",
    GITHUB_BASE_REF: "",
    GITHUB_TOKEN: "stub-token",
    ...overrides,
  };
}

describe("visibleCacheRefs", () => {
  it("scopes a push run to its own ref plus the default branch", () => {
    expect(
      visibleCacheRefs({ ref: "refs/heads/develop", baseRef: "", defaultBranch: "main" }),
    ).toEqual(new Set(["refs/heads/develop", "refs/heads/main"]));
  });

  it("scopes a pull request run to its merge ref, its base ref and the default branch", () => {
    expect(
      visibleCacheRefs({
        ref: "refs/pull/200/merge",
        baseRef: "develop",
        defaultBranch: "main",
      }),
    ).toEqual(new Set(["refs/pull/200/merge", "refs/heads/develop", "refs/heads/main"]));
  });

  it("ignores empty and undefined inputs", () => {
    expect(visibleCacheRefs({ ref: "refs/heads/feature/x" })).toEqual(
      new Set(["refs/heads/feature/x"]),
    );
    expect(visibleCacheRefs({})).toEqual(new Set());
  });
});

describe("diagnoseCache", () => {
  const visibleRefs = new Set(["refs/heads/develop", "refs/heads/main"]);
  const poisonedEntry = {
    ref: "refs/heads/develop",
    key: KEY,
    created_at: BEFORE_RUN,
    size_in_bytes: 273962419,
  };

  it("reports ok on a hit without consulting the entry list", () => {
    expect(
      diagnoseCache({
        label: "playwright",
        key: KEY,
        hit: true,
        entries: [poisonedEntry],
        visibleRefs,
        runStartedAt: RUN_STARTED_AT,
      }),
    ).toEqual({ label: "playwright", key: KEY, verdict: "ok", entry: null });
  });

  it("reports cold on a miss with no entries at all", () => {
    expect(
      diagnoseCache({
        label: "playwright",
        key: KEY,
        hit: false,
        entries: [],
        visibleRefs,
        runStartedAt: RUN_STARTED_AT,
      }),
    ).toEqual({ label: "playwright", key: KEY, verdict: "cold", entry: null });
  });

  it("reports poisoned on a miss with a matching older entry on a visible ref", () => {
    expect(
      diagnoseCache({
        label: "playwright",
        key: KEY,
        hit: false,
        entries: [poisonedEntry],
        visibleRefs,
        runStartedAt: RUN_STARTED_AT,
      }),
    ).toEqual({ label: "playwright", key: KEY, verdict: "poisoned", entry: poisonedEntry });
  });

  it("reports poisoned when the entry is visible only via the default branch", () => {
    // A feature-branch run with no PR base: the default branch is the ONLY
    // thing keeping this entry in view. Resolving it wrongly made this case
    // invisible in production while every stub test stayed green.
    const onDefaultBranch = { ...poisonedEntry, ref: "refs/heads/main" };
    expect(
      diagnoseCache({
        label: "playwright",
        key: KEY,
        hit: false,
        entries: [onDefaultBranch],
        visibleRefs: visibleCacheRefs({
          ref: "refs/heads/feature/cache-guard",
          defaultBranch: "main",
        }),
        runStartedAt: RUN_STARTED_AT,
      }),
    ).toEqual({ label: "playwright", key: KEY, verdict: "poisoned", entry: onDefaultBranch });
  });

  it("reports cold when the only matching entry lives on a ref this run cannot restore", () => {
    expect(
      diagnoseCache({
        label: "playwright",
        key: KEY,
        hit: false,
        entries: [{ ...poisonedEntry, ref: "refs/pull/999/merge" }],
        visibleRefs,
        runStartedAt: RUN_STARTED_AT,
      }).verdict,
    ).toBe("cold");
  });

  it("reports cold when a prefix-sibling key is the only entry", () => {
    // `?key=` is a PREFIX filter, so the API legitimately returns neighbours;
    // the exact comparison is what keeps them from reading as poison.
    expect(
      diagnoseCache({
        label: "playwright",
        key: KEY,
        hit: false,
        entries: [{ ...poisonedEntry, key: `${KEY}-extra` }],
        visibleRefs,
        runStartedAt: RUN_STARTED_AT,
      }).verdict,
    ).toBe("cold");
  });

  it("reports cold when the matching entry was created after this run started", () => {
    // Race guard, and the nanosecond-timestamp lock: `created_at` here has the
    // live API's nine fractional digits. If a parser change ever made that
    // unparseable it would fall into the "treat as older" branch, this entry
    // would read as poison, and this test goes red instead of the gate
    // false-alarming on every concurrently created cache.
    expect(
      diagnoseCache({
        label: "playwright",
        key: KEY,
        hit: false,
        entries: [{ ...poisonedEntry, created_at: AFTER_RUN }],
        visibleRefs,
        runStartedAt: RUN_STARTED_AT,
      }).verdict,
    ).toBe("cold");
  });

  it("reports cold for the recorded live listing, whose entries postdate the run", () => {
    // Both live entries were created ~3h after run 32219789806 started, so the
    // correct verdict against real data today is cold. This pins the observed
    // behaviour so a later change cannot quietly turn it into an alarm.
    expect(
      diagnoseCache({
        label: "playwright",
        key: KEY,
        hit: false,
        entries: LIVE_CACHE_ENTRIES,
        visibleRefs,
        runStartedAt: RUN_STARTED_AT,
      }).verdict,
    ).toBe("cold");
  });

  it("reports poisoned when created_at is missing (fails toward detection)", () => {
    const undated = { ...poisonedEntry, created_at: undefined };
    expect(
      diagnoseCache({
        label: "playwright",
        key: KEY,
        hit: false,
        entries: [undated],
        visibleRefs,
        runStartedAt: RUN_STARTED_AT,
      }),
    ).toEqual({ label: "playwright", key: KEY, verdict: "poisoned", entry: undated });
  });
});

describe("parseCacheArgs", () => {
  it("parses repeated triples and treats only the exact string true as a hit", () => {
    const { caches, errors } = parseCacheArgs([
      "--cache", "nats", "--key", "nats-key", "--hit", "true",
      "--cache", "playwright", "--key", KEY, "--hit", "false",
    ]);
    expect(errors).toEqual([]);
    expect(caches).toEqual([
      { label: "nats", key: "nats-key", hit: true },
      { label: "playwright", key: KEY, hit: false },
    ]);
  });

  it("treats an empty key as a configuration error, never as a skip", () => {
    const { errors } = parseCacheArgs(["--cache", "nats", "--key", "", "--hit", "false"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('cache "nats" was declared with no --key');
  });

  it("treats a swallowed --key flag as a configuration error", () => {
    const { errors } = parseCacheArgs(["--cache", "nats", "--key", "--hit", "false"]);
    expect(errors[0]).toContain('cache "nats" was declared with no --key');
  });
});

// The pure functions above are worth nothing if the CLI never reaches them, so
// every direction is proven end to end against the recorded API shapes: same
// key, same arguments, only the listing and the run's ref differ.
describe("cache health CLI against a stub Actions API", () => {
  it("exits nonzero and names the key when the entry exists but was missed", async () => {
    const { origin, requests } = await startStubApi({
      actionsCaches: [
        {
          ref: "refs/heads/develop",
          key: KEY,
          created_at: BEFORE_RUN,
          size_in_bytes: 273962419,
        },
      ],
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false"],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("POISONED CACHE: playwright");
    expect(output).toContain(KEY);
    expect(output).toContain("refs/heads/develop");
    expect(output).toContain("actions/caches?key=");
    // Proves the CLI actually talked to the API rather than short-circuiting,
    // and that it reads the default branch from the endpoint that has it.
    expect(requests.some((url) => url.includes(`/actions/runs/${RUN_ID}`))).toBe(true);
    expect(requests).toContain(`/repos/${REPOSITORY}`);
    expect(requests.some((url) => url.includes("/actions/caches?key="))).toBe(true);
  });

  it("detects a poisoned entry reachable ONLY through the default branch", async () => {
    // The production defect, end to end: a feature-branch run with no PR base,
    // whose only path to this entry is the repository default branch. With the
    // default branch unresolved the guard printed "genuinely new" and exited 0.
    const { origin } = await startStubApi({
      actionsCaches: [
        {
          ref: "refs/heads/main",
          key: KEY,
          created_at: BEFORE_RUN,
          size_in_bytes: 273962419,
        },
      ],
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false"],
      cliEnv(origin, {
        GITHUB_REF: "refs/heads/feature/cache-guard",
        GITHUB_BASE_REF: "",
      }),
    );

    expect(result.code).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("POISONED CACHE: playwright");
    expect(output).toContain("refs/heads/main");
    expect(output).not.toContain("genuinely new");
  });

  it("fails closed when the repository endpoint yields no default branch", async () => {
    // Degrading to a narrowed ref set here would produce false NEGATIVES —
    // exactly the silence this guard exists to end — so it must stop instead.
    const { origin } = await startStubApi({
      actionsCaches: [],
      repoPayload: { full_name: REPOSITORY },
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false"],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no default_branch");
    expect(result.stdout).not.toContain("genuinely new");
  });

  it("exits zero for the same key when no entry exists", async () => {
    const { origin } = await startStubApi({ actionsCaches: [] });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false"],
      cliEnv(origin),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("this key is genuinely new");
    expect(result.stderr).toBe("");
  });

  it("exits nonzero when the API answers 403, instead of passing quietly", async () => {
    // A guard that 403s forever and reports success is the disease, not a fix.
    const server = createServer((request, response) => {
      response.statusCode = 403;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ message: "Resource not accessible by integration" }));
    });
    stubServer = server;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false"],
      cliEnv(`http://127.0.0.1:${server.address().port}`),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("actions: read");
  });

  it("exits nonzero when the workflow fails to thread a key through", async () => {
    const { origin } = await startStubApi({ actionsCaches: [] });

    const result = await runCli(
      ["--cache", "playwright", "--key", "", "--hit", "false"],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("checked nothing");
  });
});
