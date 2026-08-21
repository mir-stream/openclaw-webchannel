import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseCache, parseCacheArgs, visibleCacheRefs } from "./check-cache-health.mjs";

const CLI = fileURLToPath(new URL("./check-cache-health.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
// The CLI makes two requests to a loopback stub; this only has to be large
// enough that a healthy run never trips it.
const CLI_TIMEOUT_MS = 5_000;

// ─── FIXTURES TRANSCRIBED FROM LIVE API RESPONSES ──────────────────────────
// Recorded against mir-stream/openclaw-webchannel, run 32219789806, with
// `gh api`. DO NOT HAND-INVENT OR "TIDY" THESE SHAPES.
//
// The first revision invented `default_branch` inside the run object's nested
// `repository`, a key that endpoint has never returned. Keep the repository
// payload separate: a stub that answers a shape the API does not have certifies
// nothing. If a field moves, re-record it with `gh api <path>` and paste it.
//
// `id` and `version` are load-bearing:
// `id` is what the remedy deletes (the `?key=` form would take out healthy
// siblings on other refs), and `version` is the field whose existence forced
// the whole verdict model onto the lookup-only probe, because a cache is
// matched by (key, version, ref) and `version` is a private hash of the cached
// path plus the compression method.
//
// Only the fields the guard reads are transcribed, plus the ones whose ABSENCE
// is load-bearing. Unrelated fields are omitted rather than invented.

const REPOSITORY = "mir-stream/openclaw-webchannel";
/** GET /repos/{owner}/{repo} — this is the ONLY place `default_branch` lives. */
const REPO_PAYLOAD = { full_name: REPOSITORY, default_branch: "main" };

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
 * `created_at` carries NINE fractional digits and is kept verbatim.
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

const DEVELOP_ENTRY = LIVE_CACHE_ENTRIES[1];
const MERGE_ENTRY = LIVE_CACHE_ENTRIES[0];

/**
 * A poisoned entry reachable ONLY through the repository default branch.
 *
 * `main` is neither this run's ref nor its base ref in the test that uses it, so
 * it enters the visible-ref set only if `default_branch` was read from the
 * endpoint that actually returns it. Its `id` is what the remedy deletes, and
 * losing it is what the old defect cost an operator.
 */
const DEFAULT_BRANCH_ENTRY = {
  ...DEVELOP_ENTRY,
  id: 6776501133,
  ref: "refs/heads/main",
};

let stubServer;

afterEach(async () => {
  // Closed here rather than at the end of each test so a failing assertion
  // cannot leak a listening socket into the rest of the sweep.
  const server = stubServer;
  stubServer = undefined;
  if (server) await new Promise((resolve) => server.close(resolve));
});

/**
 * Stand up a loopback stand-in for the Actions REST API, routing the two
 * paths the guard calls. `actionsCaches` is returned for every key query.
 *
 * `fail` takes either "caches" or "repo" and 500s that endpoint alone.
 *
 * `totalCount` overrides the count reported alongside the entries, which is how
 * a TRUNCATED diagnostic page is modelled: the API says "there are N" and hands
 * back fewer details than the report can show.
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
    if (request.url.includes("/actions/caches")) {
      if (outage("caches")) return;
      const body = { actions_caches: actionsCaches };
      // `totalCount: null` OMITS the field — a body with no usable count, which
      // the guard must also treat as incomplete. Undefined keeps the honest
      // default of "as many as we handed back".
      if (totalCount !== null) body.total_count = totalCount ?? actionsCaches.length;
      response.end(JSON.stringify(body));
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
        entries: [DEVELOP_ENTRY],
        visibleRefs,
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
      }),
    ).toEqual({
      label: "playwright",
      key: KEY,
      verdict: "cold",
      evidence: [],
      probeUnavailable: false,
    });
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
      entries: [DEVELOP_ENTRY],
      visibleRefs,
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
      entries: [DEVELOP_ENTRY],
      visibleRefs,
    });
    expect(finding.verdict).toBe("poisoned");
    expect(finding.evidence).toEqual([DEVELOP_ENTRY]);
  });

  it("reports poisoned from the probe alone when REST produced no entries", () => {
    // A 403 or an unreachable API costs the message its detail and nothing
    // else. The verdict is local, so it survives empty evidence.
    expect(
      diagnoseCache({
        label: "playwright",
        key: KEY,
        hit: false,
        probe: true,
        entries: [],
        visibleRefs,
      }),
    ).toEqual({
      label: "playwright",
      key: KEY,
      verdict: "poisoned",
      evidence: [],
      // The listing did not throw, so the report must say "nothing
      // survived the ref filter", not "the listing did not resolve".
      listingFailed: false,
    });
  });

  it("keeps evidence to entries on refs this run can restore from", () => {
    const finding = diagnoseCache({
      label: "playwright",
      key: KEY,
      hit: false,
      probe: true,
      entries: [DEVELOP_ENTRY, { ...DEVELOP_ENTRY, ref: "refs/pull/999/merge" }],
      visibleRefs,
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
      entries: [{ ...DEVELOP_ENTRY, key: `${KEY}-extra` }],
      visibleRefs,
    });
    expect(finding.evidence).toEqual([]);
  });

  it("orders evidence by RESTORE PRIORITY, not by the order the API returned", () => {
    // GitHub searches this run's own ref, then the PR base ref, then the default
    // branch, and visibleCacheRefs inserts them in exactly that order (Set
    // iteration preserves insertion). The first surviving entry is therefore the
    // one the restore actually reached first — which is what makes the
    // multi-candidate remedy's "in the order listed" instruction meaningful.
    const finding = diagnoseCache({
      label: "playwright",
      key: KEY,
      hit: false,
      probe: true,
      entries: [
        { ...DEVELOP_ENTRY, id: 1, ref: "refs/heads/main" },
        { ...DEVELOP_ENTRY, id: 2, ref: "refs/heads/develop" },
        { ...DEVELOP_ENTRY, id: 3, ref: "refs/pull/200/merge" },
      ],
      visibleRefs: visibleCacheRefs({
        ref: "refs/pull/200/merge",
        baseRef: "develop",
        defaultBranch: "main",
      }),
    });
    expect(finding.evidence.map((entry) => entry.ref)).toEqual([
      "refs/pull/200/merge",
      "refs/heads/develop",
      "refs/heads/main",
    ]);
  });

  it("carries the live listing through as evidence, ids and versions intact", () => {
    const finding = diagnoseCache({
      label: "playwright",
      key: KEY,
      hit: false,
      probe: true,
      entries: [MERGE_ENTRY, DEVELOP_ENTRY],
      visibleRefs: visibleCacheRefs({ ref: "refs/pull/200/merge", baseRef: "develop" }),
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
      { label: "nats", key: "nats-key", hit: true, probe: false, probeKey: "",
        probeUnavailable: false },
      { label: "playwright", key: KEY, hit: false, probe: true, probeKey: KEY,
        probeUnavailable: false },
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

  it("reports a missing --key ONCE, without a spurious drift error", () => {
    // The drift check compares --probe-key against --key. Ungated it fires as a
    // consequence of the missing key and renders the literal
    // `declared (--key) : undefined`, which reads like a second, independent
    // wiring fault and sends whoever is fixing it looking for two problems.
    const { errors } = parseCacheArgs([
      "--cache", "nats", "--hit", "false", "--probe", "true", "--probe-key", "nats-key",
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('cache "nats" was declared with no --key');
    expect(errors.join("\n")).not.toContain("DIFFERENT key");
    expect(errors.join("\n")).not.toContain("undefined");
  });

  it("treats a missing --hit as a configuration error, not a silent false", () => {
    // The last quint member that defaulted silently, against the header's own
    // doctrine. No false green today — a missing --hit on a genuinely hit run
    // resurfaces as the empty-`--probe-key` error, because the probe step was
    // skipped — but relying on one wiring bug to expose another is the
    // "checks nothing" shape this guard exists to end.
    const { errors } = parseCacheArgs([
      "--cache", "nats", "--key", "nats-key", "--probe", "", "--probe-key", "nats-key",
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('cache "nats" was declared with no --hit');
  });

  it("still accepts an EMPTY --hit as the ordinary miss", () => {
    // `--hit ""` is what the workflow expands to on every cold run: the flag is
    // threaded, the value is empty. That must stay a miss, not an error, or the
    // gate reddens on every legitimate cache miss.
    const { errors, caches } = parseCacheArgs([
      "--cache", "nats", "--key", "nats-key", "--hit", "", "--probe", "", "--probe-key", "nats-key",
    ]);
    expect(errors).toEqual([]);
    expect(caches[0].hit).toBe(false);
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
    const { origin, requests } = await startStubApi({ actionsCaches: [DEVELOP_ENTRY] });

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
    expect(output).toContain(`actions/caches/${DEVELOP_ENTRY.id}`);
    expect(output).not.toContain("actions/caches?key=");
    // Proves the CLI actually talked to both diagnostic endpoints rather than
    // short-circuiting, including the endpoint that owns `default_branch`.
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

  it("does not claim `version` picks between two same-version candidates", async () => {
    // A cache VERSION hashes the `path:` string plus the compression method and
    // NOTHING ELSE, so it is ref-independent by construction and identical on
    // every ref holding this key. LIVE_CACHE_ENTRIES is the recorded proof: one
    // byte-identical VERSION across `refs/pull/200/merge` and
    // `refs/heads/develop`. "Delete the ONE whose version matches this run" is
    // therefore unexecutable on the NORMAL case — on any PR run both match, and
    // the reader has just been told not to delete all of them. This report
    // closes by saying the repository routinely holds exactly that pair.
    //
    // The develop entry is listed FIRST in the API response on purpose: a naive
    // implementation prints the API's order, and this run's own ref is the merge
    // ref, so restore-priority order must reverse it.
    const { origin } = await startStubApi({
      actionsCaches: [DEVELOP_ENTRY, MERGE_ENTRY],
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin, { GITHUB_REF: "refs/pull/200/merge", GITHUB_BASE_REF: "develop" }),
    );

    expect(result.code).not.toBe(0);
    const { stderr } = result;
    // Both versions really are the same — the premise, asserted not assumed.
    expect(MERGE_ENTRY.version).toBe(DEVELOP_ENTRY.version);

    // The false discriminator is gone...
    expect(stderr).not.toContain("delete the ONE entry whose `version` matches");
    expect(stderr).not.toContain("The candidate is whichever entry's");
    // ...replaced by the truth and a procedure that can actually be followed.
    expect(stderr).toContain("ONE AT A TIME");
    expect(stderr).toContain("IDENTICAL on every ref holding this");
    expect(stderr).toContain("re-running this job after each deletion");

    // RESTORE PRIORITY ORDER: this run's own ref first, then the PR base ref —
    // the reverse of the order the API returned them in.
    const mergeDelete = stderr.indexOf(`actions/caches/${MERGE_ENTRY.id}`);
    const developDelete = stderr.indexOf(`actions/caches/${DEVELOP_ENTRY.id}`);
    expect(mergeDelete).toBeGreaterThan(-1);
    expect(developDelete).toBeGreaterThan(-1);
    expect(mergeDelete).toBeLessThan(developDelete);
    // ...and the evidence listing above it is in that same order.
    expect(stderr.indexOf(`id ${MERGE_ENTRY.id}`)).toBeLessThan(
      stderr.indexOf(`id ${DEVELOP_ENTRY.id}`),
    );
  });

  it("STILL fails when the cache listing endpoint 500s", async () => {
    const { origin } = await startStubApi({
      actionsCaches: [DEVELOP_ENTRY],
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
  });

  it("STILL fails when the cache listing is TRUNCATED, and SAYS SO", async () => {
    // The API says there are two entries and hands back one. That changes only
    // the report, but the operator still needs the count mismatch called out.
    const { origin } = await startStubApi({
      actionsCaches: [DEVELOP_ENTRY],
      totalCount: 2,
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("POISONED CACHE: playwright");
    // The annotation exists, and it names both sides of the mismatch.
    expect(result.stdout).toContain("::warning::");
    expect(result.stdout).toContain("listing is INCOMPLETE");
    expect(result.stdout).toContain("reported 2 entries under this key");
    expect(result.stdout).toContain("carried 1");
    expect(result.stdout).toContain("verdict is unaffected");
    // No REST call failed, so the prose must not claim one did.
    expect(result.stderr).not.toContain("dropped out of scope when the lookup failed");
  });

  it("says the listing is incomplete when total_count is ABSENT", async () => {
    // A body with no usable `total_count` cannot be shown complete, so the
    // diagnostic warning must explain that limitation.
    const { origin } = await startStubApi({
      actionsCaches: [DEVELOP_ENTRY],
      totalCount: null,
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("returned no usable total_count");
    expect(result.stderr).toContain("POISONED CACHE: playwright");
  });

  it("asserts NOTHING about the key when the cache SERVICE was unavailable", async () => {
    // `--probe false` with an empty `--probe-key` is `isCacheFeatureAvailable()`
    // returning false: restoreImpl set the literal "false" and returned BEFORE
    // consulting the service. The probe did not check our key at our version
    // and come up empty — it did not check. One line under a warning saying
    // exactly that, the report used to claim "the probe found nothing … so the
    // miss is expected" and "none of them was restorable AT THIS RUN'S CACHE
    // VERSION". Same overclaim class already removed twice, on the branch
    // neither pass covered.
    const { origin } = await startStubApi({ actionsCaches: [DEVELOP_ENTRY] });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "false",
        "--probe-key", ""],
      cliEnv(origin),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("cache service as unavailable");
    expect(result.stdout).toContain("THIS RUN DID NOT CHECK");
    expect(result.stdout).not.toContain("the miss is expected");
    expect(result.stdout).not.toContain("none of them was restorable");
    // The entries are still shown — as facts, with no claim attached.
    expect(result.stdout).toContain("listed as fact and nothing more");
    expect(result.stdout).toContain(`id ${DEVELOP_ENTRY.id}`);
  });

  it("does NOT annotate a truncated listing on a run where every cache HIT", async () => {
    // The verdict is `ok` and never consults the listing, so an annotation here
    // points at a report that does not exist. Left at fetch time this fires on
    // fully healthy runs, and a non-numeric `total_count` would annotate every
    // green run of a gate fanning out to ~9 jobs — which teaches operators to
    // scroll past this guard's warnings.
    const { origin } = await startStubApi({
      actionsCaches: [DEVELOP_ENTRY],
      totalCount: 7,
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "true", "--probe", "", "--probe-key", ""],
      cliEnv(origin),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("healthy");
    expect(result.stdout).not.toContain("listing is INCOMPLETE");
    expect(result.stderr).toBe("");
  });

  it("blames the REF FILTER, not the listing, when the listing resolved fine", async () => {
    // Measured: the listing resolved AND contained the poisoned entry on
    // `refs/heads/main`; `visibleCacheRefs` filtered it out because the failed
    // repo lookup dropped the default branch. Saying "the REST listing did not
    // resolve" sends the operator to debug `actions: read` while the real gap
    // is the visible-ref set.
    const { origin } = await startStubApi({
      actionsCaches: [DEFAULT_BRANCH_ENTRY],
      fail: ["repo"],
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin, { GITHUB_REF: "refs/heads/feature/x", GITHUB_BASE_REF: "" }),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("The REST listing resolved");
    expect(result.stderr).toContain("visible on a ref");
    expect(result.stderr).not.toContain("the REST listing did not resolve");
    expect(result.stderr).not.toContain("No entry details are available");
  });

  it("still says the listing did not resolve when it genuinely did not", async () => {
    // The other half of that split must keep its original wording.
    const { origin } = await startStubApi({ actionsCaches: [], fail: ["caches"] });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("No entry details are available");
    expect(result.stderr).toContain("did not resolve");
    expect(result.stderr).not.toContain("The REST listing resolved");
  });

  it("never emits a DELETE command for an entry with no id", async () => {
    // `describeEntry` already prints `id (absent)`; the remedy used to print a
    // copy-pasteable `.../actions/caches/undefined` four lines under it.
    const { origin } = await startStubApi({
      actionsCaches: [{ ...DEVELOP_ENTRY, id: undefined }],
    });

    const result = await runCli(
      ["--cache", "playwright", "--key", KEY, "--hit", "false", "--probe", "true",
        "--probe-key", KEY],
      cliEnv(origin),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("id (absent)");
    expect(result.stderr).not.toContain("actions/caches/undefined");
    expect(result.stderr).toContain("has no id in the listing");
  });

  it("claims only what is proven, and orders the remedy re-run FIRST", async () => {
    // actions/cache@v4 swallows EVERY non-validation restore error, so entry
    // existence does not prove corruption. Asserting it did — and leading with
    // "delete" — destroyed healthy caches on a transient blip.
    const { origin } = await startStubApi({ actionsCaches: [DEVELOP_ENTRY] });

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
    // this run's own ref, but it was saved at a different cache version (`path:`
    // changed), so the restore correctly missed and the
    // lookup-only probe found nothing. Reading the REST listing as the verdict
    // would redden the gate here and order a healthy cache deleted.
    const { origin } = await startStubApi({
      actionsCaches: [
        {
          ...DEVELOP_ENTRY,
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
    expect(result.stdout).toContain("AT THIS RUN'S CACHE VERSION");
    expect(result.stdout).toContain("leave them alone");
    // THE NOTE MUST NOT CERTIFY HEALTH. actions/cache swallows a failed lookup
    // inside the PROBE exactly as it does on the primary, so a transient there
    // lands here as `cold` — this branch cannot know the entries are innocent.
    // That is the same overclaim removed from reportPoisoned after it cost a
    // healthy 263 MB cache.
    expect(result.stdout).not.toContain("they are not poison");
    expect(result.stdout).toContain("not the only one");
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
    expect(result.stdout).not.toContain("AT THIS RUN'S CACHE VERSION");
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
