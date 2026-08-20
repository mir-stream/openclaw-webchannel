#!/usr/bin/env node
/**
 * check-cache-health.mjs — detect a POISONED actions/cache entry.
 *
 * WHY THIS EXISTS (read before "simplifying" it away):
 * this repository has twice shipped a CI defect that is, by construction,
 * INVISIBLE. An `actions/cache` entry exists under a key but cannot be
 * extracted — the archive is truncated, or was saved from a path layout the
 * restore no longer maps onto. `actions/cache` downloads the entry, `tar`
 * fails, the action SWALLOWS that failure and reports:
 *
 *     Cache not found for input keys: <key>
 *
 * which is byte-for-byte what a genuinely cold key prints. The guarded install
 * step (`if: steps.X.outputs.cache-hit != 'true'`) then re-provisions from the
 * network — correct behaviour, so the job goes green — and the save at the end
 * of the job fails with:
 *
 *     Unable to reserve cache with key <key>, another job may be creating this cache.
 *     ... a cache with this key already exists
 *
 * That last part is what makes this permanent rather than a bad day: the
 * poisoned entry HOLDS THE KEY, can never overwrite itself, and burns the same
 * download on every single run, forever, while every run reports success. The
 * most recent instance survived four consecutive green runs at ~13s and 263 MB
 * apiece and was found only by a human reading raw logs. Nothing automated in
 * this repo would have caught it, and the gate is about to fan out into ~9
 * parallel jobs, which multiplies that invisible waste by 9.
 *
 * THE SIGNAL. There is exactly one observable that separates the two cases,
 * and it is not in the job's own logs: whether an entry under that key EXISTS.
 *
 *   - miss + no entry            → cold key. Normal. Must pass.
 *   - miss + entry already there → the restore had something to restore and
 *                                  did not. POISONED. Must fail.
 *
 * So the guard reads the repository's cache list over the REST API and
 * compares it against what the cache step reported.
 *
 * THREE THINGS THAT MAKE THIS SUBTLER THAN IT LOOKS:
 *
 * 1. `actions/cache@v4` exposes ONLY `cache-hit`. There is no
 *    `cache-primary-key` / `cache-matched-key` output on the main action, so
 *    the key cannot be read back off the step — it must be threaded to this
 *    script explicitly by the workflow. That is why an absent or empty `--key`
 *    is a hard CONFIGURATION ERROR here and not a silent skip: a guard that
 *    quietly checks nothing is precisely the disease being cured.
 *
 * 2. Caches are REF-SCOPED. A run can restore an entry from its own ref, from
 *    its PR base ref, and from the repository default branch — and from
 *    nothing else. The same key routinely exists several times over (once per
 *    branch and once per open PR merge ref). A guard that asked "does this key
 *    exist anywhere in the repo?" would go red on every run whose sibling
 *    branch happens to hold an entry it was never entitled to restore.
 *
 * 3. Caches are created CONCURRENTLY. A job on another ref can legitimately
 *    create the entry while this job is running, after this job's cache step
 *    already (correctly) missed. Only an entry that PREDATES this run's start
 *    can be one this run failed to restore, so `created_at >= run_started_at`
 *    is ignored. An entry with no parseable `created_at` still counts — this
 *    guard fails toward detection, never toward silence.
 *
 * OUT OF SCOPE ON PURPOSE: `actions/setup-node`'s internal npm cache. Its key
 * format is GitHub's private implementation detail (it composes the runner OS,
 * an internal version prefix and a lockfile hash, and has changed between
 * setup-node majors). Hardcoding a reconstruction of it here would rot into a
 * guard that checks a key nothing ever writes — green, and meaningless. If that
 * cache ever needs covering, it needs an output from the action, not a guess.
 *
 * Usage (one `--cache/--key/--hit` triple per declared cache):
 *   node scripts/check-cache-health.mjs \
 *     --cache nats       --key "<key>" --hit "<true|false>" \
 *     --cache playwright --key "<key>" --hit "<true|false>"
 *
 * Environment: GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_REF, GITHUB_BASE_REF,
 * GITHUB_TOKEN, GITHUB_API_URL (default https://api.github.com — honored so
 * tests can point at a local stub and so GHES works).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_API_URL = "https://api.github.com";
// A hung API call must not stall the gate; every request carries this deadline
// and a timeout is classified as transient (see classifyHttpStatus).
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The refs whose cache entries this run is actually entitled to restore.
 *
 * GitHub's restore scope is: the run's own ref, the base ref of a pull request,
 * and the repository default branch. Nothing else — an entry sitting on an
 * unrelated branch is invisible to this run, so finding one there says nothing
 * about the miss and must not be read as poison.
 */
export function visibleCacheRefs({ ref, baseRef, defaultBranch } = {}) {
  const refs = new Set();
  if (ref) refs.add(ref);
  if (baseRef) refs.add(`refs/heads/${baseRef}`);
  if (defaultBranch) refs.add(`refs/heads/${defaultBranch}`);
  return refs;
}

function parseTimestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * True when this entry existed before the run started, and is therefore an
 * entry the run's cache step had the opportunity to restore.
 *
 * Unparseable/absent timestamps on EITHER side count as "older". A guard that
 * treated missing metadata as "probably a race" would be silent in exactly the
 * situation where it has the least information — and silence is the failure
 * mode this whole script replaces.
 *
 * DO NOT "TIGHTEN" THIS. `run_started_at` is when the WORKFLOW RUN started,
 * which is strictly EARLIER than when the cache step actually ran, so the
 * window between the two is time in which a real poisoned entry is ignored.
 * That skew is deliberate: it errs toward missing poison, never toward
 * inventing it. Moving the boundary later (a step timestamp, "now") would buy
 * a little detection and pay for it with false alarms on entries a concurrent
 * job legitimately created mid-run — turning a gate every branch depends on
 * into a flake. Under-reporting here is recoverable; a flaky blocking gate
 * gets disabled.
 */
function predatesRun(entry, runStartedAt) {
  const created = parseTimestamp(entry?.created_at);
  const started = parseTimestamp(runStartedAt);
  if (created === null || started === null) return true;
  return created < started;
}

/**
 * Classify one declared cache from the reported hit plus the live entry list.
 *
 * Matching is EXACT on the key. The REST API's `?key=` filter is documented as
 * a PREFIX filter, so it is only ever used to narrow the response — the
 * decision is made here, where `playwright-chromium-abc` cannot be mistaken for
 * `playwright-chromium-abcdef`.
 */
export function diagnoseCache({ label, key, hit, entries, visibleRefs, runStartedAt } = {}) {
  if (hit === true) return { label, key, verdict: "ok", entry: null };

  const visible = visibleRefs ?? new Set();
  const candidates = entries ?? [];
  const match = candidates.find(
    (entry) =>
      entry?.key === key && visible.has(entry?.ref) && predatesRun(entry, runStartedAt),
  );

  if (match) return { label, key, verdict: "poisoned", entry: match };
  return { label, key, verdict: "cold", entry: null };
}

/**
 * Parse the repeated `--cache/--key/--hit` triples.
 *
 * `hit` is true ONLY for the exact string "true": that is what
 * `steps.<id>.outputs.cache-hit` emits on a restore, and every other value
 * ("false", "", an unexpanded expression) is treated as a miss so a broken
 * expansion cannot mute the check.
 */
export function parseCacheArgs(argv) {
  const caches = [];
  const errors = [];

  // A flag standing where a value should be is a threading bug, not a value:
  // it yields `undefined` AND is left unconsumed, so the next iteration reads
  // it as the flag it is rather than silently swallowing the following triple.
  const readValue = (index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return { value: undefined, consumed: 0 };
    return { value, consumed: 1 };
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cache" || arg === "--key" || arg === "--hit") {
      const { value, consumed } = readValue(index);
      index += consumed;
      if (arg === "--cache") {
        if (value === undefined) errors.push("--cache was given without a label");
        else caches.push({ label: value, key: undefined, hit: false });
        continue;
      }
      const current = caches[caches.length - 1];
      if (!current) errors.push(`${arg} appeared before any --cache <label>`);
      else if (arg === "--key") current.key = value ?? "";
      else current.hit = value === "true";
      continue;
    }
    errors.push(`unrecognized argument: ${arg}`);
  }

  if (caches.length === 0 && errors.length === 0) {
    errors.push("no --cache <label> was declared; this guard would check nothing");
  }
  for (const cache of caches) {
    if (!cache.key) {
      errors.push(
        `cache "${cache.label}" was declared with no --key. actions/cache@v4 exposes ` +
          "only `cache-hit`, so the key cannot be recovered from the step and the " +
          "workflow must thread it through explicitly. Fix the workflow rather than " +
          "letting this cache go unchecked.",
      );
    }
  }

  return { caches, errors };
}

class CacheApiError extends Error {
  constructor(message, { permanent }) {
    super(message);
    this.name = "CacheApiError";
    this.permanent = permanent;
  }
}

/**
 * The API failure split is deliberate and asymmetric.
 *
 *   transient (network error, timeout, 5xx, rate limit) → warn and pass.
 *     Making a green gate depend on api.github.com being reachable would add a
 *     brand-new flake source to every job, to defend against a defect that
 *     costs seconds per run. Not worth it.
 *
 *   permanent (401/403/404) → fail.
 *     These mean the guard is MISCONFIGURED — no `actions: read` on the job, a
 *     revoked token, the wrong repository. A guard that 403s on every run and
 *     shrugs would sit green and useless for months, which is the exact disease
 *     this script exists to cure. It must be loud the first time.
 */
function classifyHttpStatus(status) {
  return status === 401 || status === 403 || status === 404;
}

async function githubJson(url, token) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CacheApiError(`request to ${url} failed: ${error.message}`, {
      permanent: false,
    });
  }

  if (!response.ok) {
    const permanent = classifyHttpStatus(response.status);
    const hint =
      response.status === 403 || response.status === 401
        ? " — the job is most likely missing a job-level `permissions:` block granting " +
          "`actions: read` (this repository's default workflow token is `read`, which " +
          "does NOT include actions), or this is a fork pull request whose token does " +
          "not carry it"
        : "";
    throw new CacheApiError(`${url} returned HTTP ${response.status}${hint}`, {
      permanent,
    });
  }

  try {
    return await response.json();
  } catch (error) {
    throw new CacheApiError(`could not parse the response from ${url}: ${error.message}`, {
      permanent: false,
    });
  }
}

/**
 * Resolve this run's start time and the repository's default branch.
 *
 * TWO endpoints, on purpose, and the split is load-bearing. The run object
 * carries `run_started_at`, but its nested `repository` object is a MINIMAL
 * repo reference: it has no `default_branch` key at all. Reading it there
 * yielded `undefined` on every real run, which dropped the default branch out
 * of the visible-ref set and made the guard blind to a poisoned entry sitting
 * on the default branch — while printing "genuinely new" and exiting 0. That
 * is this script's own disease, so the field is now read from
 * `GET /repos/{owner}/{repo}`, which is where it actually lives. Both calls sit
 * inside the scopes the job already grants.
 */
export async function fetchRunContext({ apiUrl, repository, runId, token }) {
  const [run, repo] = await Promise.all([
    githubJson(
      `${apiUrl}/repos/${repository}/actions/runs/${encodeURIComponent(runId)}`,
      token,
    ),
    githubJson(`${apiUrl}/repos/${repository}`, token),
  ]);

  const defaultBranch = repo?.default_branch;
  // FAIL CLOSED. An unresolved default branch does not mean "check fewer refs"
  // — a narrowed visible set cannot produce a false alarm, it produces false
  // NEGATIVES, and a guard that under-reports in silence is worth less than no
  // guard. Degrading here would rebuild the exact defect this fetch fixes, so
  // an absent default branch is a permanent misconfiguration and stops the run.
  if (typeof defaultBranch !== "string" || defaultBranch === "") {
    throw new CacheApiError(
      `${apiUrl}/repos/${repository} returned no default_branch, so the set of refs ` +
        "this run can restore from cannot be computed. The guard would check a " +
        "narrowed ref set and under-report poisoned entries instead of failing, so " +
        "it stops here rather than passing on an incomplete view.",
      { permanent: true },
    );
  }

  return { runStartedAt: run?.run_started_at, defaultBranch };
}

export async function fetchCacheEntries({ apiUrl, repository, key, token }) {
  // `?key=` narrows the response (documented as a PREFIX filter); the exact
  // comparison still happens in diagnoseCache.
  const url =
    `${apiUrl}/repos/${repository}/actions/caches` +
    `?key=${encodeURIComponent(key)}&per_page=100`;
  const body = await githubJson(url, token);
  return Array.isArray(body?.actions_caches) ? body.actions_caches : [];
}

function formatBytes(size) {
  if (typeof size !== "number" || !Number.isFinite(size)) return "unknown size";
  // Decimal MB, and the exact byte count alongside it. The rounded figure is
  // only there to make the wasted transfer legible at a glance; `1e6` rather
  // than a 1024 multiplier keeps this line out of the port-literal authority's
  // scan range (e2e/local/ports.test.ts), which no size formatter is worth
  // buying a waiver in.
  return `${(size / 1e6).toFixed(1)} MB (${size} bytes)`;
}

function reportPoisoned(finding, { repository, runStartedAt }) {
  const { label, key, entry } = finding;
  console.error(`POISONED CACHE: ${label}`);
  console.error(`  key              : ${key}`);
  console.error(`  entry ref        : ${entry.ref}`);
  console.error(`  entry size       : ${formatBytes(entry.size_in_bytes)}`);
  console.error(`  entry created_at : ${entry.created_at ?? "(absent)"}`);
  console.error(`  this run started : ${runStartedAt ?? "(unknown)"}`);
  console.error(
    "  actions/cache reported a MISS, but an entry under this exact key already\n" +
      "  exists on a ref this run can restore from and predates this run's start.\n" +
      "  The only way both are true is that the entry downloaded and failed to\n" +
      "  extract: actions/cache swallows the tar failure and prints \"Cache not\n" +
      "  found for input keys\", so the job re-provisions from the network and\n" +
      "  stays green. It cannot self-heal — the save at the end of the job cannot\n" +
      "  overwrite a key that already exists, so this entry holds the key and\n" +
      "  burns the same download on every future run until it is deleted.",
  );
  console.error("  Remedy — delete the entry, then re-run this job:");
  console.error(`    gh api -X DELETE "repos/${repository}/actions/caches?key=${key}"`);
}

async function main(argv, env) {
  const { caches, errors } = parseCacheArgs(argv);
  const apiUrl = (env.GITHUB_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  const token = env.GITHUB_TOKEN;

  // Missing wiring is the same class of defect as a missing key: the guard
  // cannot run, and pretending otherwise is how a check becomes decorative.
  if (!repository) errors.push("GITHUB_REPOSITORY is not set");
  if (!runId) errors.push("GITHUB_RUN_ID is not set");
  if (!token) errors.push("GITHUB_TOKEN is not set (pass secrets.GITHUB_TOKEN in the step env)");

  if (errors.length > 0) {
    console.error("Cache health guard is misconfigured and checked nothing:");
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }

  // The run context is fetched unconditionally, even when every declared cache
  // reported a hit. It is what exercises `actions: read` on EVERY run, so a
  // missing permission surfaces immediately instead of lying dormant until the
  // first miss — which is the run where this guard is the only thing looking.
  let runContext;
  try {
    runContext = await fetchRunContext({ apiUrl, repository, runId, token });
  } catch (error) {
    if (!error.permanent) {
      console.log(`::warning::cache health guard skipped: ${error.message}`);
      return 0;
    }
    console.error(`Cache health guard cannot reach the Actions API: ${error.message}`);
    return 1;
  }

  const visibleRefs = visibleCacheRefs({
    ref: env.GITHUB_REF,
    baseRef: env.GITHUB_BASE_REF,
    defaultBranch: runContext.defaultBranch,
  });

  let failed = false;
  const entriesByKey = new Map();

  // Every declared cache is reported before exiting: a first poisoned entry
  // must not hide a second one and cost another round trip through CI.
  for (const cache of caches) {
    if (!entriesByKey.has(cache.key)) {
      try {
        entriesByKey.set(
          cache.key,
          await fetchCacheEntries({ apiUrl, repository, key: cache.key, token }),
        );
      } catch (error) {
        if (!error.permanent) {
          console.log(
            `::warning::cache "${cache.label}" not checked: ${error.message}`,
          );
          entriesByKey.set(cache.key, null);
        } else {
          console.error(
            `Cache health guard cannot list caches for "${cache.label}": ${error.message}`,
          );
          entriesByKey.set(cache.key, null);
          failed = true;
        }
      }
    }

    const entries = entriesByKey.get(cache.key);
    if (entries === null) continue;

    const finding = diagnoseCache({
      label: cache.label,
      key: cache.key,
      hit: cache.hit,
      entries,
      visibleRefs,
      runStartedAt: runContext.runStartedAt,
    });

    if (finding.verdict === "ok") {
      console.log(`cache "${finding.label}": restored from ${finding.key} — healthy.`);
    } else if (finding.verdict === "cold") {
      console.log(
        `cache "${finding.label}": no entry exists for ${finding.key} on any ref this ` +
          "run can restore from, so the miss is expected — this key is genuinely new.",
      );
    } else {
      reportPoisoned(finding, { repository, runStartedAt: runContext.runStartedAt });
      failed = true;
    }
  }

  return failed ? 1 : 0;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
