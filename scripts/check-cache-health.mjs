#!/usr/bin/env node
/**
 * check-cache-health.mjs — detect a POISONED actions/cache entry.
 *
 * WHY THIS EXISTS (read before "simplifying" it away):
 * this repository has twice shipped a CI defect that is, by construction,
 * INVISIBLE. An `actions/cache` entry exists under a key but the restore does
 * not produce it — the archive is truncated, or was saved from a path layout
 * the restore no longer maps onto, or the download simply failed.
 * `actions/cache` swallows the failure and reports:
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
 * ── THE SIGNAL, AND WHY IT IS A PROBE AND NOT THE REST API ─────────────────
 *
 * GitHub matches a cache entry by (KEY, VERSION, REF) — not by key. `version`
 * is a hash of the cached PATH plus the compression method, and it is GitHub's
 * private implementation detail. So this sequence is entirely legitimate:
 *
 *     someone edits `path:` on the cache step (or GitHub changes the
 *     compressor) → the version changes → the restore correctly MISSES,
 *     because nothing exists at the new version → an entry with the SAME KEY
 *     and the same ref is still sitting there from before.
 *
 * A guard that read "miss + key exists + visible" as poison would redden the
 * gate on that, and tell an operator to delete a perfectly healthy cache. And
 * the version cannot be recomputed here: reconstructing a private hash is the
 * same trap this script already refuses for setup-node's npm key (below).
 *
 * So the guard does not guess — IT ASKS THE ACTION. A second
 * `actions/cache/restore@v4` step with `lookup-only: true`, given the SAME
 * `path` and the SAME `key` as the primary, computes the SAME version and
 * answers the one question REST cannot: does an entry exist at OUR key AND OUR
 * version, on a ref this run can restore from? Its `cache-hit` is threaded in
 * as `--probe`, and its `cache-primary-key` as `--probe-key` — the latter is
 * the only proof that the probe step actually RAN, and parseCacheArgs explains
 * at length why that is not redundant.
 *
 * The verdict rests entirely on those two local, authoritative booleans:
 *
 *   primary hit  probe          verdict
 *   ───────────  ─────────────  ──────────────────────────────────────────────
 *   true         (not run)      ok
 *   not true     not true       cold — nothing at our key+version. Covers a
 *                               genuinely new key AND a path/compression
 *                               version change. PASS.
 *   not true     true           POISONED — an entry exists at our exact key and
 *                               version, and the restore did not produce it.
 *                               FAIL.
 *
 * There is exactly ONE thing REST can do to that verdict, and it can only ever
 * soften it: if it can show that EVERY visible entry under the key was created
 * after this run started, the probe hit is a concurrent save landing between
 * the restore and the probe, not poison — verdict `raced`, a warning, PASS. See
 * diagnoseCache for why that is safe and what it costs.
 *
 * ── THE REST API IS DIAGNOSTIC ONLY ────────────────────────────────────────
 *
 * It must NEVER MANUFACTURE a failure — no REST answer can turn a passing run
 * red, and the `raced` downgrade above is the only direction in which it moves
 * a verdict at all. Its real job is to turn "poisoned" into an actionable
 * message: which entries are sitting under this key, on which refs, at which
 * versions, how big, how old, and — the part that matters most — their `id`,
 * because deleting by `?key=` removes the entry on EVERY ref at once and would
 * destroy healthy siblings.
 *
 * Therefore every REST failure — unreachable, timeout, 401/403/404, malformed
 * body, an unresolvable `default_branch` — is a `::warning::` and never fails
 * the step. That is a deliberate reversal of an earlier design in which REST
 * was fail-closed. It was fail-closed because a silently-degraded REST layer
 * meant a silently-degraded VERDICT. It no longer does: a degraded REST layer
 * costs a less detailed message and the `raced` downgrade — both of which fail
 * SAFE, toward reporting poison — and reddening a blocking gate over API
 * reachability buys nothing.
 *
 * TWO THINGS THAT MAKE THIS SUBTLER THAN IT LOOKS:
 *
 * 1. `actions/cache@v4` exposes ONLY `cache-hit`. There is no
 *    `cache-primary-key` / `cache-matched-key` output on the main action, so
 *    the key cannot be read back off the step — it must be threaded to this
 *    script explicitly by the workflow. That is why an absent or empty `--key`
 *    is a hard CONFIGURATION ERROR here and not a silent skip: a guard that
 *    quietly checks nothing is precisely the disease being cured. The same
 *    applies to `--probe` and `--probe-key`.
 *
 * 2. Caches are REF-SCOPED. A run can restore an entry from its own ref, from
 *    its PR base ref, and from the repository default branch — and from
 *    nothing else. The same key routinely exists several times over (once per
 *    branch and once per open PR merge ref). The probe already respects that
 *    scope, because it is the same action asking the same service; the ref
 *    filtering here only keeps the printed evidence honest.
 *
 * OUT OF SCOPE ON PURPOSE: `actions/setup-node`'s internal npm cache. Its key
 * format is GitHub's private implementation detail (it composes the runner OS,
 * an internal version prefix and a lockfile hash, and has changed between
 * setup-node majors). Hardcoding a reconstruction of it here would rot into a
 * guard that checks a key nothing ever writes — green, and meaningless. If that
 * cache ever needs covering, it needs an output from the action, not a guess.
 *
 * Usage (one `--cache/--key/--hit/--probe/--probe-key` quint per declared cache):
 *   node scripts/check-cache-health.mjs \
 *     --cache nats --key "<key>" --hit "<v>" --probe "<v>" --probe-key "<v>" \
 *     --cache playwright --key "<key>" --hit "<v>" --probe "<v>" --probe-key "<v>"
 *
 * Environment: GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_REF, GITHUB_BASE_REF,
 * GITHUB_TOKEN, GITHUB_API_URL (default https://api.github.com — honored so
 * tests can point at a local stub and so GHES works).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_API_URL = "https://api.github.com";
// A hung API call must not stall the gate; every request carries this deadline.
// A timeout is a warning like every other REST failure — see githubJson.
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The refs whose cache entries this run is actually entitled to restore.
 *
 * GitHub's restore scope is: the run's own ref, the base ref of a pull request,
 * and the repository default branch. Nothing else — an entry sitting on an
 * unrelated branch is invisible to this run, so listing one as evidence for
 * this run's miss would be misleading.
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
 * True when this entry existed before the run started.
 *
 * THIS GATES A VERDICT — see the "raced" branch in diagnoseCache. A previous
 * revision demoted it to a decorative label, arguing that "the probe is
 * same-run and same-version, so a concurrent creation is self-resolving". That
 * argument is FALSE, and it produced a reachable false POISONED with nothing
 * wrong anywhere. The probe is same-RUN, not same-INSTANT: the primary restore
 * happens at T0 and the probe at T0+Δ, and Δ is minutes for nats — the primary
 * lives inside .github/actions/install-nats-server while `probe-nats` sits
 * after `npm ci`, `lint:citations` and the whole Playwright cache block. So a
 * concurrent run's END-OF-JOB SAVE can land inside Δ: a PR run legitimately
 * misses a cold key at T0, a develop push writes the entry at T0+60s, and the
 * PR run's probe sees it at T0+90s. Reading that as poison reddens a required
 * check and tells an operator to delete a cache created 30 seconds ago.
 *
 * Unparseable/absent timestamps on EITHER side count as "older", so an entry is
 * only ever treated as new when the API positively says so. That direction is
 * deliberate: it keeps the "raced" downgrade unreachable through missing data.
 */
function predatesRun(entry, runStartedAt) {
  const created = parseTimestamp(entry?.created_at);
  const started = parseTimestamp(runStartedAt);
  if (created === null || started === null) return true;
  return created < started;
}

/**
 * Classify one declared cache. The two booleans decide whether this is a
 * failure; the entries can only ever DOWNGRADE a failure to a warning.
 *
 * Evidence matching is EXACT on the key. The REST API's `?key=` filter is
 * documented as a PREFIX filter, so it is only ever used to narrow the response
 * — the comparison happens here, where `playwright-chromium-abc` cannot be
 * mistaken for `playwright-chromium-abcdef`.
 *
 * ── THE "raced" VERDICT ────────────────────────────────────────────────────
 *
 * A probe hit is only poison if the entry was already there when the restore
 * ran. It need not have been: see predatesRun above for the concurrent-save
 * window this closes. So a probe hit whose every visible entry was created
 * AFTER `run_started_at` is reported as `raced` — a warning, exit 0.
 *
 * Three properties hold, and each is load-bearing:
 *
 * 1. EMPTY EVIDENCE IS STILL `poisoned`. REST is diagnostics-only, and a
 *    degraded REST layer must never be able to hide a real poisoning. Empty
 *    evidence means "we could not rule it out", not "no entries exist".
 * 2. ANY ENTRY PREDATING THE RUN IS STILL `poisoned`. One old entry is enough:
 *    it was restorable and was not restored. Hence `every`, not `some`.
 * 3. THIS TRADES A NARROW FALSE NEGATIVE FOR THAT FALSE POSITIVE, and the trade
 *    is not free. `run_started_at` precedes the primary restore step by the
 *    checkout/setup time, so an entry genuinely written in THAT window is real
 *    poison and gets downgraded to `raced` on this run. That is acceptable for
 *    exactly one reason: poison is PERSISTENT BY CONSTRUCTION — a poisoned
 *    entry can never overwrite itself — so on the next run it predates that
 *    run's start and fails properly. The warning text says so explicitly, so an
 *    operator seeing it twice knows it is not a race.
 */
export function diagnoseCache({
  label,
  key,
  hit,
  probe,
  entries,
  visibleRefs,
  runStartedAt,
} = {}) {
  if (hit === true) return { label, key, verdict: "ok", evidence: [] };

  const visible = visibleRefs ?? new Set();
  const evidence = (entries ?? [])
    .filter((entry) => entry?.key === key && visible.has(entry?.ref))
    .map((entry) => ({ ...entry, createdAfterRunStarted: !predatesRun(entry, runStartedAt) }));

  if (probe !== true) return { label, key, verdict: "cold", evidence };

  const raced =
    evidence.length > 0 && evidence.every((entry) => entry.createdAfterRunStarted === true);

  return { label, key, verdict: raced ? "raced" : "poisoned", evidence };
}

const CACHE_FLAGS = new Set(["--cache", "--key", "--hit", "--probe", "--probe-key"]);

/**
 * Parse the repeated `--cache/--key/--hit/--probe/--probe-key` quints.
 *
 * `hit` and `probe` are true ONLY for the exact string "true": that is what
 * `steps.<id>.outputs.cache-hit` emits on an exact match, and every other value
 * is treated as a miss so a broken expansion cannot mute the check.
 *
 * ── WHY AN EMPTY `--probe` IS *NOT* A WIRING SIGNAL ────────────────────────
 *
 * A previous revision of this file errored on "primary missed but --probe is
 * empty", reasoning that a skipped step is the only thing that yields "". That
 * is WRONG, and it would have reddened this blocking gate the first time anyone
 * upgraded playwright-core or bumped the pinned nats version. From
 * `actions/cache` `src/restoreImpl.ts`:
 *
 *     if (!cacheKey) {
 *         // `cache-hit` is intentionally not set to `false` here to preserve
 *         // existing behavior
 *         // See https://github.com/actions/cache/issues/1466
 *
 * `cache-hit` is set ONLY to "true" on an exact match, and to "false" in one
 * early return (the cache service being unavailable). A probe that RAN and
 * legitimately found nothing emits "" — byte-identical to a probe that was
 * skipped. So an empty `--probe` is the NORMAL COLD PATH. Do not reinstate that
 * error; it cannot distinguish the two cases.
 *
 * ── WHAT DOES DISTINGUISH THEM: `--probe-key` ─────────────────────────────
 *
 * `actions/cache/restore` runs `restoreOnlyRun` → `new NullStateProvider()`,
 * whose `setState` maps straight onto `core.setOutput`
 * (`CachePrimaryKey → Outputs.CachePrimaryKey`). And `restoreImpl.ts` sets it
 * BEFORE the miss return:
 *
 *     stateProvider.setState(State.CachePrimaryKey, primaryKey);   // line 33
 *     ...
 *     if (!cacheKey) { ... return; }                               // line 53
 *
 * So `cache-primary-key` is non-empty whenever the probe step RAN — hit or miss
 * — and empty only when it was skipped. That is the "did it run" signal, and
 * because its value IS the key the probe used, comparing it to `--key` also
 * catches a probe that silently drifted onto a different key.
 */
export function parseCacheArgs(argv) {
  const caches = [];
  const errors = [];
  const warnings = [];

  // A flag standing where a value should be is a threading bug, not a value:
  // it yields `undefined` AND is left unconsumed, so the next iteration reads
  // it as the flag it is rather than silently swallowing the following quint.
  const readValue = (index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return { value: undefined, consumed: 0 };
    return { value, consumed: 1 };
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (CACHE_FLAGS.has(arg)) {
      const { value, consumed } = readValue(index);
      index += consumed;
      if (arg === "--cache") {
        if (value === undefined) errors.push("--cache was given without a label");
        else {
          caches.push({
            label: value,
            key: undefined,
            hit: false,
            probe: undefined,
            probeKey: undefined,
          });
        }
        continue;
      }
      const current = caches[caches.length - 1];
      if (!current) errors.push(`${arg} appeared before any --cache <label>`);
      else if (arg === "--key") current.key = value ?? "";
      else if (arg === "--hit") current.hit = value === "true";
      else if (arg === "--probe") current.probe = value ?? "";
      else current.probeKey = value ?? "";
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
    if (cache.probe === undefined) {
      errors.push(
        `cache "${cache.label}" was declared with no --probe. The verdict is decided by ` +
          "the lookup-only `actions/cache/restore@v4` probe, not by the REST API, so " +
          "without it this cache cannot be classified at all.",
      );
    }
    if (cache.probeKey === undefined) {
      errors.push(
        `cache "${cache.label}" was declared with no --probe-key. It is the only proof ` +
          "that the probe step actually RAN — `cache-hit` is empty both on a genuine " +
          "miss and when the step is skipped — so without it a probe whose `if:` never " +
          "fires would read as a cold key and this guard would check nothing.",
      );
      continue;
    }

    // The probe step is `if:`-gated on the primary having missed, so after a HIT
    // it is correctly skipped and both probe inputs are empty. Nothing to check.
    if (cache.hit === true) continue;

    if (cache.probeKey === "") {
      // ONE non-wiring cause of an empty primary key, and it is distinguishable:
      // `isCacheFeatureAvailable()` failing makes restoreImpl set `cache-hit` to
      // the LITERAL "false" and return before the primary key is ever recorded.
      // Our probe passes no `restore-keys`, so a partial match — the only other
      // producer of a literal "false" — cannot occur. That is a GitHub cache
      // outage, not a broken workflow: the primary cache step could not restore
      // either, everything re-provisions, and nothing is poisoned. Reddening a
      // blocking gate over cache-service availability buys exactly what
      // reddening it over REST availability buys: nothing.
      if (cache.probe === "false") {
        warnings.push(
          `cache "${cache.label}": the probe reported the Actions cache service as ` +
            "unavailable, so poison cannot be distinguished from a cold key on this " +
            "run. Treating it as cold — the primary cache step could not have " +
            "restored anything either.",
        );
        continue;
      }
      errors.push(
        `cache "${cache.label}" reported a MISS but its --probe-key is empty, which ` +
          "means the probe step never ran. Its `if:` condition must fire on exactly " +
          "the primary's non-hit; as wired, a poisoned entry would be reported as a " +
          "cold key and this guard would check nothing.",
      );
    } else if (cache.probeKey !== cache.key) {
      errors.push(
        `cache "${cache.label}" probed a DIFFERENT key than it declared, so the probe ` +
          "answered a question about some other cache and its verdict is meaningless:\n" +
          `      declared (--key)      : ${cache.key}\n` +
          `      probed (--probe-key)  : ${cache.probeKey}`,
      );
    }
  }

  return {
    caches: caches.map((cache) => ({ ...cache, probe: cache.probe === "true" })),
    errors,
    warnings,
  };
}

class CacheApiError extends Error {
  constructor(message) {
    super(message);
    this.name = "CacheApiError";
  }
}

/**
 * Every failure mode is the same failure mode now: a warning.
 *
 * There is no permanent/transient split any more, and no header sniffing to
 * tell a 403-for-permissions from a 403-for-rate-limit. There is nothing left
 * to classify — REST cannot change a verdict, so the worst a failure here can
 * do is make a poisoned-cache message less specific. Failing a blocking gate
 * over api.github.com being reachable would add a brand-new flake source to
 * every job and defend nothing.
 */
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
    throw new CacheApiError(`request to ${url} failed: ${error.message}`);
  }

  if (!response.ok) {
    const hint =
      response.status === 403 || response.status === 401
        ? " — the job is most likely missing a job-level `permissions:` block granting " +
          "`actions: read` (this repository's default workflow token is `read`, which " +
          "does NOT include actions), or this is a fork pull request whose token does " +
          "not carry it. The verdict below still stands; only the entry details are lost"
        : "";
    throw new CacheApiError(`${url} returned HTTP ${response.status}${hint}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new CacheApiError(`could not parse the response from ${url}: ${error.message}`);
  }
}

/**
 * Resolve this run's start time and the repository's default branch.
 *
 * TWO endpoints, on purpose, and the split is load-bearing. The run object
 * carries `run_started_at`, but its nested `repository` object is a MINIMAL
 * repo reference: it has no `default_branch` key at all. Reading it there
 * yields `undefined` on every real run, which drops the default branch out of
 * the visible-ref set — and while that can no longer change a verdict, it would
 * silently hide the very entry an operator needs to see.
 *
 * The two are settled INDEPENDENTLY: one endpoint failing must not throw away
 * the other's answer, because both are pure diagnostics and half a diagnostic
 * beats none. Each failure is returned as a warning for the caller to print.
 */
export async function fetchRunContext({ apiUrl, repository, runId, token }) {
  const [runResult, repoResult] = await Promise.allSettled([
    githubJson(
      `${apiUrl}/repos/${repository}/actions/runs/${encodeURIComponent(runId)}`,
      token,
    ),
    githubJson(`${apiUrl}/repos/${repository}`, token),
  ]);

  const warnings = [];
  let runStartedAt;
  let defaultBranch;

  if (runResult.status === "fulfilled") runStartedAt = runResult.value?.run_started_at;
  else warnings.push(`this run's start time is unavailable: ${runResult.reason.message}`);

  if (repoResult.status === "fulfilled") {
    const branch = repoResult.value?.default_branch;
    if (typeof branch === "string" && branch !== "") defaultBranch = branch;
    else {
      warnings.push(
        `${apiUrl}/repos/${repository} returned no default_branch, so entries visible ` +
          "to this run only via the default branch will be omitted from the evidence " +
          "below. The verdict is unaffected — it comes from the probe.",
      );
    }
  } else {
    warnings.push(`the repository default branch is unavailable: ${repoResult.reason.message}`);
  }

  return { runStartedAt, defaultBranch, warnings };
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

function describeEntry(entry) {
  const age = entry.createdAfterRunStarted ? " [created after this run started]" : "";
  return (
    `    id ${entry.id ?? "(absent)"} · ref ${entry.ref ?? "(absent)"}\n` +
    `      version    : ${entry.version ?? "(absent)"}\n` +
    `      size       : ${formatBytes(entry.size_in_bytes)}\n` +
    `      created_at : ${entry.created_at ?? "(absent)"}${age}`
  );
}

/**
 * Report a poisoned entry, claiming ONLY what the probe proves.
 *
 * What is proven: an entry exists at this exact key AND version, on a ref this
 * run can restore from, and the restore did not produce it. What is NOT proven
 * is corruption — `actions/cache@v4` swallows EVERY non-validation restore
 * error, not just a tar failure, so a service error, a failed download or a
 * timeout lands here identically. An earlier revision of this message asserted
 * "the only way both are true is that the entry downloaded and failed to
 * extract" and told the operator to delete. That was simply false, and on a
 * transient blip it destroyed a healthy 263 MB cache for nothing.
 *
 * Hence the remedy ORDER: re-run first. A re-run is the cheapest discriminator
 * there is — a transient failure clears, and poison recurs by construction,
 * because a poisoned entry can never overwrite itself. Deletion is the second
 * step, taken only once the re-run has shown it recurs, and it deletes ONE
 * entry by `id`: the `?key=` form removes the entry on every ref at once, and
 * this repository routinely carries the same key on both a branch and an open
 * PR's merge ref.
 *
 * The step still exits non-zero regardless. Silence is the disease this guard
 * exists to cure, and a swallowed transient that repeats every run is worth
 * seeing too.
 */
function reportPoisoned(finding, { repository }) {
  const { label, key, evidence } = finding;
  console.error(`POISONED CACHE: ${label}`);
  console.error(`  key : ${key}`);
  console.error(
    "  A lookup-only actions/cache/restore probe — same path, same key, so the same\n" +
      "  cache VERSION — found an entry, and the restore step did not produce it.\n" +
      "  Two things do that, and this guard cannot tell them apart from here:\n" +
      "    - the archive is corrupt or unextractable (truncated, or saved from a\n" +
      "      path layout the restore no longer maps onto); or\n" +
      "    - a download or cache-service failure that actions/cache SWALLOWED.\n" +
      "  Either way the step printed \"Cache not found for input keys\" — identical to\n" +
      "  a cold key — and the job re-provisioned from the network and stayed green.",
  );

  if (evidence.length === 0) {
    console.error(
      "  No entry details are available (the REST listing above did not resolve), so\n" +
        "  this report cannot name the entry. Re-run the job first — see below.",
    );
  } else {
    console.error(
      `  Entries under this key on refs this run can restore from (${evidence.length}):`,
    );
    for (const entry of evidence) console.error(describeEntry(entry));
    if (evidence.length > 1) {
      console.error(
        "  More than one entry is listed and this script cannot compute its own cache\n" +
          "  version (the probe returns only a boolean), so NONE of these is named as\n" +
          "  the bad one. The candidate is whichever entry's `version` matches this\n" +
          "  run's — compare against the version printed by the cache step's debug log.",
      );
    }
  }

  console.error("  Remedy, IN THIS ORDER:");
  console.error(
    "    1. Re-run this job. That is the cheapest discriminator: a transient\n" +
      "       download/service failure clears, while poison recurs every single time,\n" +
      "       because a poisoned entry can never overwrite itself.",
  );
  console.error(
    evidence.length > 1
      ? "    2. ONLY if it recurs, delete the ONE entry whose version matches this run —\n" +
          "       one of these, not both:"
      : "    2. ONLY if it recurs, delete that one entry by id:",
  );
  for (const entry of evidence) {
    console.error(
      `         gh api -X DELETE "repos/${repository}/actions/caches/${entry.id}"  # ${entry.ref}`,
    );
  }
  if (evidence.length === 0) {
    console.error(
      `         gh api "repos/${repository}/actions/caches?key=${key}" --jq '.actions_caches[]'\n` +
        `         gh api -X DELETE "repos/${repository}/actions/caches/<id>"`,
    );
  }
  console.error(
    "       Delete by ID, never by `?key=` — the key form removes the entry on EVERY\n" +
      "       ref at once, and this repository routinely holds the same key on a\n" +
      "       branch and on an open PR's merge ref simultaneously.",
  );
}

/**
 * Report a probe hit that every visible entry post-dates: a concurrent save.
 *
 * Warns and does NOT fail. The message has one job beyond describing the race:
 * telling the operator how to tell a race from poison, because the classifier
 * cannot. `run_started_at` precedes the primary restore by the checkout/setup
 * time, so genuine poison written inside that window lands here too — once.
 * Poison cannot overwrite itself, so on the next run it predates that run's
 * start and this comes out `poisoned`. REPETITION IS THE DISCRIMINATOR, and the
 * text has to say so or the warning is just noise someone learns to scroll past.
 */
function reportRaced(finding) {
  const { label, key, evidence } = finding;
  console.log(
    `::warning::cache "${label}": a lookup-only probe found an entry at ${key} that the ` +
      `restore step did not produce — the poison fingerprint — but all ${evidence.length} ` +
      "entry/entries visible to this run were created AFTER this run started, so the most " +
      "likely cause is a concurrent job's end-of-job save landing between the restore and " +
      "the probe (they are minutes apart, not simultaneous). Treating it as a race, not as " +
      "poison, and passing. IF THIS WARNING REPEATS ON A LATER RUN, IT IS NOT A RACE: a " +
      "poisoned entry can never overwrite itself, so on any subsequent run it predates that " +
      "run's start and this guard will fail properly. Two of these in a row means real poison.",
  );
  for (const entry of evidence) console.log(describeEntry(entry));
}

function reportCold(finding) {
  const { label, key, evidence } = finding;
  console.log(
    `cache "${label}": the lookup-only probe found nothing at ${key} for this run's ` +
      "cache version, so the miss is expected.",
  );
  if (evidence.length > 0) {
    // The P1 false positive this model exists to prevent, made visible rather
    // than merely tolerated: entries under this key DO exist, and they are
    // still not restorable by this run, because a cache is matched by
    // (key, version, ref) and `version` hashes the cached path plus the
    // compression method. Editing `path:` — or GitHub changing its compressor —
    // strands every older entry under a live key. That is healthy. Do not
    // delete them; they age out on their own.
    console.log(
      `  Note: ${evidence.length} entry/entries exist under this key on refs this run can\n` +
        "  restore from, at a DIFFERENT cache version — the `path:` or the compression\n" +
        "  method changed. They are not restorable here and they are not poison. Leave\n" +
        "  them alone; GitHub evicts them on its own.",
    );
    for (const entry of evidence) console.log(describeEntry(entry));
  }
}

async function main(argv, env) {
  const { caches, errors, warnings } = parseCacheArgs(argv);
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
  for (const warning of warnings) console.log(`::warning::${warning}`);

  // Diagnostics are fetched unconditionally, even when every declared cache
  // reported a hit. It is what exercises `actions: read` on EVERY run, so a
  // missing permission surfaces as a warning immediately instead of lying
  // dormant until the first miss — which is the run where an operator most
  // needs the entry list.
  let runContext = { runStartedAt: undefined, defaultBranch: undefined, warnings: [] };
  try {
    runContext = await fetchRunContext({ apiUrl, repository, runId, token });
  } catch (error) {
    runContext.warnings.push(`run context is unavailable: ${error.message}`);
  }
  for (const warning of runContext.warnings) {
    console.log(`::warning::cache health guard diagnostics degraded: ${warning}`);
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
        console.log(
          `::warning::cache "${cache.label}": entry details unavailable, so the report ` +
            `below cannot name entries or ids: ${error.message}`,
        );
        entriesByKey.set(cache.key, []);
      }
    }

    const finding = diagnoseCache({
      label: cache.label,
      key: cache.key,
      hit: cache.hit,
      probe: cache.probe,
      entries: entriesByKey.get(cache.key),
      visibleRefs,
      runStartedAt: runContext.runStartedAt,
    });

    if (finding.verdict === "ok") {
      console.log(`cache "${finding.label}": restored from ${finding.key} — healthy.`);
    } else if (finding.verdict === "cold") {
      reportCold(finding);
    } else if (finding.verdict === "raced") {
      reportRaced(finding);
    } else {
      reportPoisoned(finding, { repository });
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
