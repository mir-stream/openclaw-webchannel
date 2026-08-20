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
// This matters MORE now than it did then. `id` and `version` are load-bearing:
// `id` is what the remedy deletes (the `?key=` form would take out healthy
// siblings on other refs), and `version` is the field whose existence forced
// the whole verdict model onto the lookup-only probe, because a cache is
// matched by (key, version, ref) and `version` is a private hash of the cached
// path plus the compression method.
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
 * point of this fixture.
 *
 * BUT THE FIXTURE ALONE GUARANTEES NOTHING, and an earlier version of this
 * comment claimed it did. Reintroducing the exact old defect — reading
 * `runResult.value?.repository?.default_branch` instead of the repo endpoint's
 * — left every test in this file green, because they all pin
 * `GITHUB_REF: refs/heads/develop` with entries on refs reachable without the
 * default branch, so `defaultBranch` was decorative everywhere. A fixture can
 * only make a defect OBSERVABLE; an assertion is what makes it FAIL. The test
 * that actually closes it is "surfaces an entry visible ONLY via the repository
 * default branch" below, whose single entry is unreachable any other way — it
 * was confirmed to go red under that mutation and green without it.
 */
const RUN_PAYLOAD = {
  run_started_at: "2026-08-19T05:32:17Z",
  head_branch: "develop",
  repository: { full_name: REPOSITORY },
};

const KEY =
  "playwright-chromium-b8f20e2c06bcbc1b22fca4dd4d1d7ffbcee94616a3295deced9f0751e6e924c4";

/** The live cache VERSION both entries below carry — same `path:`, same hash. */
const VERSION = "b11b119dfd10565044882f81f06d3a75b1602bec6f8658ac905dd63583b2a885";

/**
 * GET /repos/{owner}/{repo}/actions/caches?key=<KEY>&per_page=100 — the live
 * response, confirming the `key=` filter works and that the same key really is
 * duplicated across a PR merge ref and a branch ref. That duplication is why
 * the remedy deletes by `id`: `?key=` would take BOTH of these.
 *
 * `created_at` carries NINE fractional digits. Kept verbatim so a future
 * timestamp-parsing change cannot quietly regress the evidence label that
 * marks an entry as created after the run started.
 */
const LIVE_CACHE_ENTRIES = [
  {
    id: 6776960828,
    ref: "refs/pull/200/merge",
    key: KEY,
    version: VERSION,
    last_accessed_at: "2026-08-20T05:56:45.235035000Z",
    created_at: "2026-08-19T08:34:14.020019000Z",
    size_in_bytes: 273962989,
  },
  {
    id: 6776817145,
    ref: "refs/heads/develop",
    key: KEY,
    version: VERSION,
    last_accessed_at: "2026-08-20T03:09:08.301979000Z",
    created_at: "2026-08-19T08:28:57.659366000Z",
    size_in_bytes: 273962419,
  },
];

const RUN_STARTED_AT = RUN_PAYLOAD.run_started_at;
// Same nanosecond shape as the live entries, moved before the run start so it
// models an entry this run had the opportunity to restore.
const BEFORE_RUN = "2026-08-18T22:11:03.884512000Z";
const AFTER_RUN = LIVE_CACHE_ENTRIES[1].created_at;

/**
 * The live develop-ref entry, back-dated to before this run started.
 *
 * The back-dating is load-bearing, not cosmetic: an entry created after
 * `run_started_at` cannot have been there for the restore to miss, so a probe
 * hit over one is classified `raced` (warning, exit 0) rather than `poisoned`.
 * Every fixture below that means to model POISON must predate the run.
 */
const OLDER_LIVE_ENTRY = { ...LIVE_CACHE_ENTRIES[1], created_at: BEFORE_RUN };

/** The live PR-merge-ref entry, back-dated the same way and for the same reason. */
const OLDER_LIVE_MERGE_ENTRY = { ...LIVE_CACHE_ENTRIES[0], created_at: BEFORE_RUN };

/**
 * A poisoned entry reachable ONLY through the repository default branch.
 *
 * `main` is neither this run's ref nor its base ref in the test that uses it, so
 * it enters the visible-ref set only if `default_branch` was read from the
 * endpoint that actually returns it. Its `id` is what the remedy deletes, and
 * losing it is what the old defect cost an operator.
 */
const DEFAULT_BRANCH_ENTRY = {
  ...OLDER_LIVE_ENTRY,
  id: 6776501133,
  ref: "refs/heads/main",
};

/**
 * A concurrent save: this run's own ref, created after the run started.
 *
 * Paired with DEFAULT_BRANCH_ENTRY it reproduces the measured fail-open — the
 * two together are poison plus a race, and dropping the default branch from the
 * visible-ref set leaves only the race behind.
 */
const NEWER_OWN_REF_ENTRY = { ...LIVE_CACHE_ENTRIES[1], id: 6776999002, created_at: AFTER_RUN };

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
 *
 * `fail` takes any of "runs" | "caches" | "repo" and 500s that endpoint ALONE.
 * PARTIAL degradation is the point: the earlier stub could only be all-healthy
 * or all-403, and the fail-open it therefore could not express was the guard
 * downgrading real poison to `raced` when only `GET /repos/{o}/{r}` was down.
 *
 * `totalCount` overrides the count reported alongside the entries, which is how
 * a TRUNCATED page is modelled — the API says "there are N" and hands back
 * fewer, and the entry it withheld may be the old one that proves poison.
 */
async function startStubApi({
  actionsCaches,
  repoPayload = REPO_PAYLOAD,
  fail = [],
  totalCount,
}) {
  const failing = new Set(fail);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    const outage = (which) => {
      if (!failing.has(which)) return false;
      response.statusCode = 500;
      response.end(JSON.stringify({ message: `stub outage: ${which}` }));
      return true;
    };
    if (request.url.includes("/actions/runs/")) {
      if (outage("runs")) return;
      response.end(JSON.stringify(RUN_PAYLOAD));
      return;
    }
    if (request.url.includes("/actions/caches")) {
      if (outage("caches")) return;
      response.end(
        JSON.stringify({
          total_count: totalCount ?? actionsCaches.length,
          actions_caches: actionsCaches,
        }),
      );
      return;
    }
    if (request.url === `/repos/${REPOSITORY}`) {
      if (outage("repo")) return;
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

  it("reports ok on a hit without consulting the probe or the entry list", () => {
    expect(
      diagnoseCache({
        label: "playwright",
        key: KEY,
        hit: true,
        probe: true,
        entries: [OLDER_LIVE_ENTRY],
        visibleRefs,
        runStartedAt: RUN_STARTED_AT,
      }),
    ).toEqual({ label: "playwright", key: KEY, verdict: "ok", evidence: [] });
  });

  it("reports cold on a miss when the probe found nothing", () => {
    expect(
      diagnoseCache({
        label: "playwright",
        key: KEY,
        hit: false,
        probe: false,
        entries: [],
        visibleRefs,
        runStartedAt: RUN_STARTED_AT,
      }),
    ).toEqual({ label: "playwright", key: KEY, verdict: "cold", evidence: [] });
  });

  it("reports COLD when the key exists but the probe missed — a version change", () => {
    // THE P1 FALSE POSITIVE. Editing `path:` (or GitHub changing its
    // compressor) moves the cache VERSION, so the restore correctly misses
    // while an older entry keeps holding the key. The previous model called
    // this poison and told the operator to delete a healthy 263 MB cache.
    const finding = diagnoseCache({
      label: "playwright",
      key: KEY,
      hit: false,
      probe: false,
      entries: [OLDER_LIVE_ENTRY],
      visibleRefs,
      runStartedAt: RUN_STARTED_AT,
    });
    expect(finding.verdict).toBe("cold");
    // The entry is still surfaced as evidence — cold does not mean invisible.
    expect(finding.evidence).toHaveLength(1);
  });

  it("reports poisoned when the probe found an entry at this key and version", () => {
    const finding = diagnoseCache({
      label: "playwright",
      key: KEY,
      hit: false,
      probe: true,
      entries: [OLDER_LIVE_ENTRY],
      visibleRefs,
      runStartedAt: RUN_STARTED_AT,
    });
    expect(finding.verdict).toBe("poisoned");
    expect(finding.evidence).toEqual([{ ...OLDER_LIVE_ENTRY, createdAfterRunStarted: false }]);
  });

  it("reports poisoned from the probe alone when REST produced no entries", () => {
    // A 403 or an unreachable API costs the message its detail and nothing
    // else. The verdict is local, so it survives — and specifically, EMPTY
    // EVIDENCE MUST NOT BECOME `raced`. Empty means "we could not rule poison
    // out", not "no entries exist"; a degraded REST layer must never be able to
    // downgrade a real poisoning to a warning.
    expect(
      diagnoseCache({
        label: "playwright",
        key: KEY,
        hit: false,
        probe: true,
        entries: [],
        visibleRefs,
        runStartedAt: RUN_STARTED_AT,
        scopeComplete: true,
      }),
    ).toEqual({
      label: "playwright",
      key: KEY,
      verdict: "poisoned",
      evidence: [],
      // Not a suppressed downgrade — an empty set never qualified for one, even
      // with a perfectly complete scope. The two refusals stay distinguishable
      // so the report does not blame a healthy API for this failure.
      racedSuppressed: false,
    });
  });

  it("keeps evidence to entries on refs this run can restore from", () => {
    const finding = diagnoseCache({
      label: "playwright",
      key: KEY,
      hit: false,
      probe: true,
      entries: [OLDER_LIVE_ENTRY, { ...OLDER_LIVE_ENTRY, ref: "refs/pull/999/merge" }],
      visibleRefs,
      runStartedAt: RUN_STARTED_AT,
    });
    expect(finding.evidence.map((entry) => entry.ref)).toEqual(["refs/heads/develop"]);
  });

  it("keeps a prefix-sibling key out of the evidence", () => {
    // `?key=` is a PREFIX filter, so the API legitimately returns neighbours;
    // the exact comparison is what keeps them out of the delete commands.
    const finding = diagnoseCache({
      label: "playwright",
      key: KEY,
      hit: false,
      probe: true,
      entries: [{ ...OLDER_LIVE_ENTRY, key: `${KEY}-extra` }],
      visibleRefs,
      runStartedAt: RUN_STARTED_AT,
    });
    expect(finding.evidence).toEqual([]);
  });

  it("reports RACED when EVERY visible entry was created after the run started", () => {
    // The concurrent-save false positive. The probe is same-RUN, not
    // same-INSTANT: minutes separate the primary restore from the probe, so a
    // parallel job's end-of-job save can land in between and turn an honest
    // cold miss into a probe hit. Calling that poison reddens a required check
    // and orders a 30-second-old healthy cache deleted. The nanosecond shape is
    // the live one, so a timestamp-parser regression shows up right here.
    const finding = diagnoseCache({
      label: "playwright",
      key: KEY,
      hit: false,
      probe: true,
      entries: [{ ...OLDER_LIVE_ENTRY, created_at: AFTER_RUN }],
      visibleRefs,
      runStartedAt: RUN_STARTED_AT,
      scopeComplete: true,
    });
    expect(finding.verdict).toBe("raced");
    expect(finding.evidence[0].createdAfterRunStarted).toBe(true);
  });

  it("REFUSES the downgrade when the evidence scope is incomplete", () => {
    // The fail-open. `every()` over a set that may be MISSING entries proves
    // nothing, and a partial REST failure is what makes the set short while
    // still looking like an answer. Same inputs, only the completeness flag
    // differs — so this pins the conjunct itself rather than any one cause.
    const shared = {
      label: "playwright",
      key: KEY,
      hit: false,
      probe: true,
      entries: [{ ...OLDER_LIVE_ENTRY, created_at: AFTER_RUN }],
      visibleRefs,
      runStartedAt: RUN_STARTED_AT,
    };
    expect(diagnoseCache({ ...shared, scopeComplete: true }).verdict).toBe("raced");

    const refused = diagnoseCache({ ...shared, scopeComplete: false });
    expect(refused.verdict).toBe("poisoned");
    // Flagged so the report can explain itself; the entries it lists all look
    // like a race, and an unexplained failure over them reads as a broken guard.
    expect(refused.racedSuppressed).toBe(true);
  });

  it("refuses the downgrade when scopeComplete is not passed at all", () => {
    // Fail-safe default. A caller that forgets to certify the scope must not
    // thereby certify it — absent is not "complete".
    const finding = diagnoseCache({
      label: "playwright",
      key: KEY,
      hit: false,
      probe: true,
      entries: [{ ...OLDER_LIVE_ENTRY, created_at: AFTER_RUN }],
      visibleRefs,
      runStartedAt: RUN_STARTED_AT,
    });
    expect(finding.verdict).toBe("poisoned");
    expect(finding.racedSuppressed).toBe(true);
  });

  it("treats every entry as pre-existing when the run start time is ABSENT", () => {
    // predatesRun's fail direction on the `started === null` half, isolated.
    // `scopeComplete: true` is deliberately a lie here — main would compute
    // false and refuse the downgrade structurally — precisely so this asserts
    // predatesRun ALONE and cannot pass on the back of that other guard.
    // The label assertion is the one that bites: it is upstream of every
    // verdict rule, so no amount of scope-checking can mask it.
    const finding = diagnoseCache({
      label: "playwright",
      key: KEY,
      hit: false,
      probe: true,
      entries: [{ ...OLDER_LIVE_ENTRY, created_at: AFTER_RUN }],
      visibleRefs,
      runStartedAt: undefined,
      scopeComplete: true,
    });
    expect(finding.evidence[0].createdAfterRunStarted).toBe(false);
    expect(finding.verdict).toBe("poisoned");
  });

  it("treats every entry as pre-existing when run_started_at is UNPARSEABLE", () => {
    // The gap `scopeComplete` genuinely cannot cover: the runs endpoint
    // ANSWERED, so completeness is satisfied, but the answer is garbage (a GHES
    // quirk, a shape change). predatesRun's fail direction is the only thing
    // between that and a `raced` pass, and here it is the sole defence.
    const finding = diagnoseCache({
      label: "playwright",
      key: KEY,
      hit: false,
      probe: true,
      entries: [{ ...OLDER_LIVE_ENTRY, created_at: AFTER_RUN }],
      visibleRefs,
      runStartedAt: "not-a-timestamp",
      scopeComplete: true,
    });
    expect(finding.verdict).toBe("poisoned");
    expect(finding.evidence[0].createdAfterRunStarted).toBe(false);
  });

  it("stays POISONED when even ONE visible entry predates the run", () => {
    // `every`, not `some`. One entry that was already sitting there when the
    // restore ran is a restorable entry the restore did not produce — poison,
    // whatever else was created alongside it afterwards. The label still rides
    // along on the newer entry so the printed evidence stays readable.
    const finding = diagnoseCache({
      label: "playwright",
      key: KEY,
      hit: false,
      probe: true,
      entries: [{ ...OLDER_LIVE_MERGE_ENTRY, created_at: AFTER_RUN }, OLDER_LIVE_ENTRY],
      visibleRefs: visibleCacheRefs({ ref: "refs/pull/200/merge", baseRef: "develop" }),
      runStartedAt: RUN_STARTED_AT,
    });
    expect(finding.verdict).toBe("poisoned");
    expect(finding.evidence.map((entry) => entry.createdAfterRunStarted)).toEqual([true, false]);
  });

  it("does not label an entry whose created_at is missing", () => {
    const finding = diagnoseCache({
      label: "playwright",
      key: KEY,
      hit: false,
      probe: true,
      entries: [{ ...OLDER_LIVE_ENTRY, created_at: undefined }],
      visibleRefs,
      runStartedAt: RUN_STARTED_AT,
    });
    expect(finding.evidence[0].createdAfterRunStarted).toBe(false);
  });

  it("carries the live listing through as evidence, ids and versions intact", () => {
    // The two live entries are recorded from a run LATER than the recorded
    // `run_started_at`, so both are back-dated here — otherwise this models the
    // `raced` path rather than the poisoned one it is about. Only `created_at`
    // is touched; `id` and `version`, the fields under assertion, stay verbatim.
    const finding = diagnoseCache({
      label: "playwright",
      key: KEY,
      hit: false,
      probe: true,
      entries: [OLDER_LIVE_MERGE_ENTRY, OLDER_LIVE_ENTRY],
      visibleRefs: visibleCacheRefs({ ref: "refs/pull/200/merge", baseRef: "develop" }),
      runStartedAt: RUN_STARTED_AT,
    });
    expect(finding.verdict).toBe("poisoned");
    expect(finding.evidence.map((entry) => entry.id)).toEqual([6776960828, 6776817145]);
    expect(finding.evidence.every((entry) => entry.version === VERSION)).toBe(true);
  });
});

describe("parseCacheArgs", () => {
  it("parses repeated quints and treats only the exact string true as a hit", () => {
    const { caches, errors } = parseCacheArgs([
      "--cache", "nats", "--key", "nats-key", "--hit", "true", "--probe", "", "--probe-key", "",
      "--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
      "--probe-key", KEY,
    ]);
    expect(errors).toEqual([]);
    expect(caches).toEqual([
      { label: "nats", key: "nats-key", hit: true, probe: false, probeKey: "" },
      { label: "playwright", key: KEY, hit: false, probe: true, probeKey: KEY },
    ]);
  });

  it("treats an empty key as a configuration error, never as a skip", () => {
    const { errors } = parseCacheArgs([
      "--cache", "nats", "--key", "", "--hit", "false", "--probe", "false", "--probe-key", "",
    ]);
    expect(errors[0]).toContain('cache "nats" was declared with no --key');
  });

  it("treats a swallowed --key flag as a configuration error", () => {
    const { errors } = parseCacheArgs([
      "--cache", "nats", "--key", "--hit", "false", "--probe", "false", "--probe-key", "nats-key",
    ]);
    expect(errors[0]).toContain('cache "nats" was declared with no --key');
  });

  it("treats a missing --probe as a configuration error", () => {
    // The verdict comes from the probe. A cache declared without one cannot be
    // classified at all, which is the "checks nothing" failure this guard is.
    const { errors } = parseCacheArgs([
      "--cache", "nats", "--key", "nats-key", "--hit", "false", "--probe-key", "nats-key",
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('cache "nats" was declared with no --probe');
  });

  it("treats a missing --probe-key as a configuration error", () => {
    const { errors } = parseCacheArgs([
      "--cache", "nats", "--key", "nats-key", "--hit", "false", "--probe", "",
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('cache "nats" was declared with no --probe-key');
  });

  it("accepts an empty --probe on a MISS — that is a genuine cold key", () => {
    // THE GATE-BREAKING BUG. actions/cache never sets `cache-hit` to "false" on
    // a miss ("intentionally not set ... See issue 1466"), so a probe that RAN
    // and found nothing is indistinguishable from a skipped one by `cache-hit`
    // alone. An earlier revision errored here and would have reddened this
    // blocking gate on every playwright-core upgrade and every nats pin bump.
    const { errors, caches } = parseCacheArgs([
      "--cache", "nats", "--key", "nats-key", "--hit", "false", "--probe", "",
      "--probe-key", "nats-key",
    ]);
    expect(errors).toEqual([]);
    expect(caches[0].probe).toBe(false);
  });

  it("accepts both probe inputs empty after a HIT", () => {
    // The probe step is `if:`-gated on the primary missing, so after a hit it is
    // correctly skipped and neither output exists.
    const { errors, warnings } = parseCacheArgs([
      "--cache", "nats", "--key", "k", "--hit", "true", "--probe", "", "--probe-key", "",
    ]);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("errors when a MISS carries an empty --probe-key: the probe never ran", () => {
    // `cache-primary-key` is recorded BEFORE restoreImpl's miss return, so it is
    // non-empty whenever the step ran. Empty here means the `if:` never fired.
    const { errors } = parseCacheArgs([
      "--cache", "nats", "--key", "k", "--hit", "false", "--probe", "", "--probe-key", "",
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("its --probe-key is empty");
    expect(errors[0]).toContain("never ran");
  });

  it("errors when the probe answered about a DIFFERENT key, naming both", () => {
    const { errors } = parseCacheArgs([
      "--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
      "--probe-key", `${KEY}-drifted`,
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(KEY);
    expect(errors[0]).toContain(`${KEY}-drifted`);
    expect(errors[0]).toContain("DIFFERENT key");
  });

  it("warns rather than errors when the cache SERVICE was unavailable", () => {
    // The one non-wiring cause of an empty primary key, and it is
    // distinguishable: `isCacheFeatureAvailable()` failing is the only path
    // that sets `cache-hit` to a LITERAL "false" before recording the key (our
    // probe passes no restore-keys, so a partial match cannot produce one).
    // The primary cache step could not have restored anything either, so this
    // is an outage, not a broken workflow.
    const { errors, warnings } = parseCacheArgs([
      "--cache", "nats", "--key", "k", "--hit", "false", "--probe", "false", "--probe-key", "",
    ]);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("cache service as unavailable");
  });
});

// The pure functions above are worth nothing if the CLI never reaches them, so
// every direction is proven end to end against the recorded API shapes: same
// key, same arguments, only the probe result and the listing differ.
describe("cache health CLI against a stub Actions API", () => {
  it("fails and prints a delete-BY-ID remedy when the probe finds the entry", async () => {
    const { origin, requests } = await startStubApi({ actionsCaches: [OLDER_LIVE_ENTRY] });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("POISONED CACHE: playwright");
    expect(output).toContain(KEY);
    expect(output).toContain("refs/heads/develop");
    expect(output).toContain(VERSION);
    // The remedy deletes ONE entry by id. The `?key=` form removes the entry on
    // every ref at once — this repo demonstrably carries this key on two.
    expect(output).toContain(`actions/caches/${OLDER_LIVE_ENTRY.id}`);
    expect(output).not.toContain("actions/caches?key=");
    // Proves the CLI actually talked to the API rather than short-circuiting,
    // and that it reads the default branch from the endpoint that has it.
    expect(requests.some((url) => url.includes(`/actions/runs/${RUN_ID}`))).toBe(true);
    expect(requests).toContain(`/repos/${REPOSITORY}`);
    expect(requests.some((url) => url.includes("/actions/caches?key="))).toBe(true);
  });

  it("surfaces an entry visible ONLY via the repository default branch", async () => {
    // THE ASSERTION THAT CLOSES THE OLD default_branch DEFECT — see the fixture
    // header. This run is on an unrelated feature branch with no base ref, so
    // the sole entry is reachable only if `default_branch` came from
    // GET /repos/{owner}/{repo}. Read it off the run object's nested
    // `repository` instead (where it has never existed) and the ref set narrows
    // to the feature branch, the evidence empties, and the report degrades to
    // "No entry details are available" — the operator loses the `id` the remedy
    // deletes, on the one run where they need it. Verified to go red under
    // exactly that mutation.
    const { origin } = await startStubApi({ actionsCaches: [DEFAULT_BRANCH_ENTRY] });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin, { GITHUB_REF: "refs/heads/feature/x", GITHUB_BASE_REF: "" }),
    );

    expect(result.code).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("POISONED CACHE: playwright");
    expect(output).toContain("refs/heads/main");
    expect(output).toContain(`actions/caches/${DEFAULT_BRANCH_ENTRY.id}`);
    expect(output).not.toContain("No entry details are available");
  });

  it("WARNS and exits ZERO when every entry post-dates the run — a concurrent save", async () => {
    // The concurrent-save false positive, end to end. A cold key on a PR run
    // misses at T0; a develop push saves the entry seconds later; this run's
    // probe — minutes downstream of its own restore — then sees it. Failing
    // here blocks merges and orders a brand-new healthy cache deleted. The
    // warning has to name the discriminator, because the guard cannot: poison
    // cannot overwrite itself, so a repeat on a later run is not a race.
    const { origin } = await startStubApi({
      actionsCaches: [{ ...OLDER_LIVE_ENTRY, created_at: AFTER_RUN }],
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("::warning::");
    expect(result.stdout).toContain("created AFTER this run started");
    expect(result.stdout).toContain("IF THIS WARNING REPEATS");
    expect(result.stdout).not.toContain("POISONED CACHE");
    // The evidence is still printed — a warning nobody can act on is noise.
    expect(result.stdout).toContain(`id ${OLDER_LIVE_ENTRY.id}`);
  });

  it("still FAILS when only some entries post-date the run", async () => {
    // One entry that predates the run is one restorable entry the restore did
    // not produce. A concurrent save alongside it does not launder that.
    const { origin } = await startStubApi({
      actionsCaches: [{ ...OLDER_LIVE_MERGE_ENTRY, created_at: AFTER_RUN }, OLDER_LIVE_ENTRY],
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin, { GITHUB_REF: "refs/pull/200/merge", GITHUB_BASE_REF: "develop" }),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("POISONED CACHE: playwright");
    expect(result.stderr).toContain("[created after this run started]");
  });

  // ─── PARTIAL REST DEGRADATION MUST NOT BUY A PASS ────────────────────────
  //
  // Every test in this block feeds the guard a poisoned cache and breaks ONE
  // diagnostic call. All four must exit non-zero. The measured fail-open they
  // close: `raced` reasons with `every()` over an evidence list that REST
  // itself narrowed, so a partly-degraded lookup can hand it a set the poison
  // was filtered out of — a shorter list still looks like an answer, where a
  // total outage merely empties it.
  const POISON_PLUS_RACE = [DEFAULT_BRANCH_ENTRY, NEWER_OWN_REF_ENTRY];

  it("fails on a default-branch poisoned entry while the repo endpoint is HEALTHY", async () => {
    // The control half of the reviewer's measurement. Both entries are visible,
    // the old one on `refs/heads/main` predates the run, so `every()` is false
    // and this is unambiguous poison. Changing ONLY the repo endpoint between
    // this test and the next is what isolates the defect.
    const { origin } = await startStubApi({ actionsCaches: POISON_PLUS_RACE });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("POISONED CACHE: playwright");
    expect(result.stderr).toContain(`actions/caches/${DEFAULT_BRANCH_ENTRY.id}`);
  });

  it("STILL fails on that entry when the repo endpoint 500s and hides it", async () => {
    // THE FAIL-OPEN, end to end, with the identical fixtures. `default_branch`
    // is lost, so `refs/heads/main` drops out of the visible-ref set and the
    // poisoned entry is filtered out of the evidence — leaving only the newer
    // `refs/heads/develop` save, over which `every()` is trivially true. Before
    // `scopeComplete` this printed a `::warning::` asserting every entry was
    // new and exited 0, passing the one defect the guard exists to catch.
    const { origin } = await startStubApi({
      actionsCaches: POISON_PLUS_RACE,
      fail: ["repo"],
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("POISONED CACHE: playwright");
    // The report has to explain itself: every entry it lists post-dates the run,
    // which is the shape that normally passes.
    expect(result.stderr).toContain("may be MISSING entries");
    expect(result.stdout).not.toContain("IF THIS WARNING REPEATS");
  });

  it("STILL fails when the runs endpoint 500s and every entry looks new", async () => {
    // `run_started_at` is what every age label is computed against, so losing it
    // makes "created after this run started" unknowable — not false. Two guards
    // cover this and both must hold: `scopeComplete` refuses structurally, and
    // predatesRun's fail direction labels every entry as pre-existing.
    const { origin } = await startStubApi({
      actionsCaches: [NEWER_OWN_REF_ENTRY],
      fail: ["runs"],
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("run's start time is unavailable");
    expect(result.stderr).toContain("POISONED CACHE: playwright");
    expect(result.stdout).not.toContain("IF THIS WARNING REPEATS");
  });

  it("STILL fails when the cache listing endpoint 500s", async () => {
    // Belt and braces: the listing throws, so the evidence is empty and the
    // empty-evidence rule already fails this. `scopeComplete` makes the refusal
    // explicit instead of incidental — see the assumption noted in the report.
    const { origin } = await startStubApi({
      actionsCaches: [NEWER_OWN_REF_ENTRY],
      fail: ["caches"],
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("entry details unavailable");
    expect(result.stderr).toContain("POISONED CACHE: playwright");
    expect(result.stdout).not.toContain("IF THIS WARNING REPEATS");
  });

  it("STILL fails when the cache listing is TRUNCATED", async () => {
    // The API says there are two entries and hands back one. The withheld one
    // may be the old entry that proves poison, so `every()` over the page that
    // arrived proves nothing. Refusing to downgrade costs at most one falsely
    // reported poison, which a re-run resolves; paginating would add
    // rate-limit and partial-failure surface to a step that must not flake.
    const { origin } = await startStubApi({
      actionsCaches: [NEWER_OWN_REF_ENTRY],
      totalCount: 2,
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("POISONED CACHE: playwright");
    expect(result.stderr).toContain("may be MISSING entries");
    expect(result.stdout).not.toContain("IF THIS WARNING REPEATS");
  });

  it("claims only what is proven, and orders the remedy re-run FIRST", async () => {
    // actions/cache@v4 swallows EVERY non-validation restore error, so entry
    // existence does not prove corruption. Asserting it did — and leading with
    // "delete" — destroyed healthy caches on a transient blip.
    const { origin } = await startStubApi({ actionsCaches: [OLDER_LIVE_ENTRY] });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    const output = `${result.stdout}${result.stderr}`;
    expect(output).not.toContain("The only way both are true");
    expect(output).toContain("corrupt or unextractable");
    expect(output).toContain("SWALLOWED");
    expect(output.indexOf("1. Re-run this job")).toBeGreaterThan(-1);
    expect(output.indexOf("1. Re-run this job")).toBeLessThan(
      output.indexOf("ONLY if it recurs, delete"),
    );
  });

  it("passes on the SAME key at a DIFFERENT version — the probe, not the key, decides", async () => {
    // The P1 false positive, end to end: an entry under this exact key sits on
    // this run's own ref and predates the run, but it was saved at a different
    // cache version (`path:` changed), so the restore correctly missed and the
    // lookup-only probe found nothing. Reading the REST listing as the verdict
    // would redden the gate here and order a healthy cache deleted.
    const { origin } = await startStubApi({
      actionsCaches: [
        {
          ...OLDER_LIVE_ENTRY,
          version: "0f5b3a2d9c1e47a6b8d02f37e5c91a4d6b8e0c2f4a6d8b0e2c4f6a8d0b2e4c6f",
        },
      ],
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "false",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("the miss is expected");
    expect(result.stdout).toContain("DIFFERENT cache version");
    expect(result.stderr).toBe("");
  });

  it("exits zero for the same key when no entry exists at all", async () => {
    const { origin } = await startStubApi({ actionsCaches: [] });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "false",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("the miss is expected");
    expect(result.stdout).not.toContain("DIFFERENT cache version");
    expect(result.stderr).toBe("");
  });

  it("warns and exits ZERO when the API answers 403", async () => {
    // Inverted deliberately from the previous design. REST was fail-closed
    // because a degraded REST layer meant a degraded VERDICT; it no longer
    // does. Reddening a blocking gate over API reachability now buys nothing —
    // the probe already decided, and all that is lost is entry detail.
    const server = createServer((request, response) => {
      response.statusCode = 403;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ message: "Resource not accessible by integration" }));
    });
    stubServer = server;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "false",
        "--probe-key", KEY],
      cliEnv(`http://127.0.0.1:${server.address().port}`),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("::warning::");
    expect(result.stdout).toContain("actions: read");
    expect(result.stdout).toContain("the miss is expected");
  });

  it("still fails on a probe hit when the API answers 403", async () => {
    // The other half of the same reversal: losing REST must not lose the
    // verdict. The report degrades to "no entry details", not to silence.
    const server = createServer((request, response) => {
      response.statusCode = 403;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ message: "Resource not accessible by integration" }));
    });
    stubServer = server;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(`http://127.0.0.1:${server.address().port}`),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("POISONED CACHE: playwright");
    expect(result.stderr).toContain("No entry details are available");
  });

  it("warns and exits zero when the repository endpoint yields no default branch", async () => {
    // Also inverted. An unresolved default branch used to be fatal because it
    // narrowed the ref set the VERDICT was computed over. It now narrows only
    // the printed evidence, so it is a warning and the probe still decides.
    const { origin } = await startStubApi({
      actionsCaches: [],
      repoPayload: { full_name: REPOSITORY },
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "false",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("::warning::");
    expect(result.stdout).toContain("no default_branch");
    expect(result.stdout).toContain("the miss is expected");
  });

  it("reaches a poisoned verdict even with no default branch resolved", async () => {
    const { origin } = await startStubApi({
      actionsCaches: [],
      repoPayload: { full_name: REPOSITORY },
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("no default_branch");
    expect(result.stderr).toContain("POISONED CACHE: playwright");
  });

  it("PASSES on a miss whose probe legitimately found nothing", async () => {
    // THE GATE-BREAKING CASE, end to end. A probe that ran and found nothing
    // emits an empty `cache-hit` — actions/cache never writes "false" on a miss
    // (restoreImpl.ts, "intentionally not set ... issue 1466"). That is the
    // ordinary cold path: a new playwright-core version, a bumped nats pin, a
    // fresh branch. `--probe-key` is what proves the step ran; treating the
    // empty `--probe` itself as a wiring signal reds this blocking gate on
    // every routine dependency bump.
    const { origin } = await startStubApi({ actionsCaches: [] });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("the miss is expected");
    expect(result.stderr).toBe("");
  });

  it("PASSES on a hit with both probe inputs empty, as a skipped probe emits", async () => {
    const { origin } = await startStubApi({ actionsCaches: LIVE_CACHE_ENTRIES });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "true", "--probe", "", "--probe-key", ""],
      cliEnv(origin),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("healthy");
    expect(result.stderr).toBe("");
  });

  it("exits nonzero when the probe's `if:` never fired (empty --probe-key on a miss)", async () => {
    const { origin } = await startStubApi({ actionsCaches: [] });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "", "--probe-key", ""],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("checked nothing");
    expect(result.stderr).toContain("never ran");
  });

  it("exits nonzero and names both keys when the probe drifted onto another key", async () => {
    const { origin } = await startStubApi({ actionsCaches: [] });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", "playwright-chromium-STALE"],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("DIFFERENT key");
    expect(result.stderr).toContain(KEY);
    expect(result.stderr).toContain("playwright-chromium-STALE");
  });

  it("exits nonzero when the workflow fails to thread a key through", async () => {
    const { origin } = await startStubApi({ actionsCaches: [] });

    const result = await runCli(
      ["--cache", "playwright", "--key", "", "--hit", "false", "--probe", "false",
        "--probe-key", ""],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("checked nothing");
  });

  it("exits nonzero when the workflow fails to thread a probe result through", async () => {
    const { origin } = await startStubApi({ actionsCaches: [] });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("declared with no --probe");
  });

  it("exits nonzero when the workflow fails to thread the probe key through", async () => {
    const { origin } = await startStubApi({ actionsCaches: [] });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true"],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("declared with no --probe-key");
  });
});
