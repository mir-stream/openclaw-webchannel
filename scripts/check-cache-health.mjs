#!/usr/bin/env node
/**
 * check-cache-health.mjs — detect a POISONED actions/cache entry.
 *
 * `actions/cache` swallows extraction and download failures and prints the
 * same "Cache not found for input keys" message as a genuinely cold key. The
 * fallback download succeeds, the job stays green, and the broken entry keeps
 * holding its key so the end-of-job save cannot replace it.
 *
 * The guard asks `actions/cache/restore@v4` itself. Immediately after a primary
 * miss, a lookup-only probe reuses the exact same `path:` and `key:` strings,
 * and therefore the same private cache version. The two in-job booleans decide
 * the verdict completely:
 *
 *   primary hit  probe          verdict
 *   true         (not run)      ok
 *   not true     not true       cold
 *   not true     true           poisoned
 *
 * `--probe-key` carries the probe's `cache-primary-key`. Unlike `cache-hit`,
 * which is empty both on a miss and when a step is skipped, it is recorded
 * before the miss return and proves that the probe actually ran on `--key`.
 *
 * The REST API is diagnostics only. It cannot change a verdict; failures and
 * truncated listings are warnings. Its entry list makes poison actionable by
 * showing restore-priority order, ref, version, size, creation time, and entry
 * `id`. The remedy always says to re-run first because a transient restore
 * failure and real poison are indistinguishable inside one job. Only if the
 * failure recurs should entries be deleted, one at a time by `id`, never by
 * `?key=` (which deletes healthy siblings carrying the key on other refs).
 *
 * Caches are ref-scoped, so printed evidence is limited to the run's own ref,
 * its PR base ref, and the repository default branch. The latter still comes
 * from `GET /repos/{owner}/{repo}`: the run payload's nested repository object
 * does not include `default_branch`. Failure to resolve it degrades only the
 * report, never the verdict.
 *
 * `actions/setup-node`'s internal npm cache is intentionally out of scope. Its
 * key is a private implementation detail; reconstructing it would create a
 * guard that can drift into checking a key nothing writes.
 *
 * Usage (one `--cache/--key/--hit/--probe/--probe-key` quint per declared cache):
 *   node scripts/check-cache-health.mjs \
 *     --cache nats --key "<key>" --hit "<v>" --probe "<v>" --probe-key "<v>" \
 *     --cache playwright --key "<key>" --hit "<v>" --probe "<v>" --probe-key "<v>"
 *
 * Environment: GITHUB_REPOSITORY, GITHUB_REF, GITHUB_BASE_REF, GITHUB_TOKEN,
 * GITHUB_API_URL (default https://api.github.com; honored for GHES and tests).
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

/**
 * Classify one declared cache. Only the primary and probe booleans decide the
 * verdict; REST entries are carried through solely for reporting.
 *
 * Evidence matching is EXACT on the key. The REST API's `?key=` filter is
 * documented as a PREFIX filter, so it is only ever used to narrow the response
 * — the comparison happens here, where `playwright-chromium-abc` cannot be
 * mistaken for `playwright-chromium-abcdef`.
 */
export function diagnoseCache({
  label,
  key,
  hit,
  probe,
  entries,
  visibleRefs,
  probeUnavailable,
  listingFailed,
} = {}) {
  if (hit === true) return { label, key, verdict: "ok", evidence: [] };

  const visible = visibleRefs ?? new Set();
  const matchingKey = (entries ?? []).filter((entry) => entry?.key === key);

  // RESTORE PRIORITY ORDER, and it is load-bearing for the remedy rather than
  // cosmetic. GitHub searches this run's own ref, then the PR base ref, then the
  // default branch — which is exactly the insertion order visibleCacheRefs uses,
  // and Set iteration preserves it. The first surviving entry is therefore the
  // one the restore actually reached first. Entries on refs outside the set
  // cannot appear here at all, so the fallback rank is unreachable in practice
  // and exists only so the sort is total.
  const priority = [...visible];
  const rankOf = (entry) => {
    const index = priority.indexOf(entry.ref);
    return index === -1 ? priority.length : index;
  };
  const evidence = matchingKey
    .filter((entry) => visible.has(entry.ref))
    .sort((left, right) => rankOf(left) - rankOf(right));

  // `probeUnavailable` changes NO verdict — an outage is still reported cold,
  // for the reason parseCacheArgs gives. It rides along so reportCold can avoid
  // claiming the probe looked at something when it returned before looking.
  if (probe !== true) {
    return {
      label,
      key,
      verdict: "cold",
      evidence,
      probeUnavailable: probeUnavailable === true,
    };
  }

  return {
    label,
    key,
    verdict: "poisoned",
    evidence,
    listingFailed: listingFailed === true,
  };
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
            hit: undefined,
            probe: undefined,
            probeKey: undefined,
            probeUnavailable: false,
          });
        }
        continue;
      }
      const current = caches[caches.length - 1];
      if (!current) errors.push(`${arg} appeared before any --cache <label>`);
      else if (arg === "--key") current.key = value ?? "";
      else if (arg === "--hit") current.hit = value ?? "";
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
    if (cache.hit === undefined) {
      // The LAST quint member to get this treatment, and it was the odd one out
      // for no reason: it silently defaulted to `false` while the header
      // declared the doctrine that an absent member is a hard CONFIGURATION
      // ERROR and never a silent skip. There is no false green in that default
      // today — a missing --hit on a genuinely hit run resurfaces as the
      // empty-`--probe-key` error below, because the probe step was skipped —
      // but relying on one wiring bug to expose another is precisely the
      // "checks nothing" shape this guard exists to end. Make the code and the
      // doctrine agree.
      errors.push(
        `cache "${cache.label}" was declared with no --hit. That is the primary cache ` +
          "step's `cache-hit`, and it decides whether this cache is examined at all; " +
          "defaulting it would silently reclassify a HIT as a miss. Thread " +
          "`steps.<id>.outputs.cache-hit` through explicitly.",
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
    if (cache.hit === "true") continue;

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
        // Recorded on the cache, not just warned about, because the REPORT has
        // to know too: on this path the probe returned before consulting the
        // service, so reportCold must not phrase anything as a finding about
        // this key.
        cache.probeUnavailable = true;
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
    } else if (cache.key && cache.probeKey !== cache.key) {
      // Gated on `cache.key` so a missing --key reports ONE error. Ungated, the
      // drift check fires as a consequence of the first error and renders the
      // literal `declared (--key) : undefined`, which reads like a second,
      // separate wiring fault.
      errors.push(
        `cache "${cache.label}" probed a DIFFERENT key than it declared, so the probe ` +
          "answered a question about some other cache and its verdict is meaningless:\n" +
          `      declared (--key)      : ${cache.key}\n` +
          `      probed (--probe-key)  : ${cache.probeKey}`,
      );
    }
  }

  return {
    caches: caches.map((cache) => ({
      ...cache,
      hit: cache.hit === "true",
      probe: cache.probe === "true",
    })),
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

/** Resolve the default branch used to keep ref-filtered diagnostics honest. */
export async function fetchRepositoryContext({ apiUrl, repository, token }) {
  const warnings = [];
  let defaultBranch;
  try {
    const repositoryDetails = await githubJson(`${apiUrl}/repos/${repository}`, token);
    const branch = repositoryDetails?.default_branch;
    if (typeof branch === "string" && branch !== "") defaultBranch = branch;
    else {
      warnings.push(
        `${apiUrl}/repos/${repository} returned no default_branch, so entries visible ` +
          "to this run only via the default branch will be omitted from the evidence " +
          "below. The verdict is unaffected — it comes from the probe.",
      );
    }
  } catch (error) {
    warnings.push(`the repository default branch is unavailable: ${error.message}`);
  }

  return { defaultBranch, warnings };
}

/** List the entries under one key and flag a partial diagnostic response. */
export async function fetchCacheEntries({ apiUrl, repository, key, token }) {
  // `?key=` narrows the response (documented as a PREFIX filter); the exact
  // comparison still happens in diagnoseCache.
  const url =
    `${apiUrl}/repos/${repository}/actions/caches` +
    `?key=${encodeURIComponent(key)}&per_page=100`;
  const body = await githubJson(url, token);
  const entries = Array.isArray(body?.actions_caches) ? body.actions_caches : [];
  const totalCount = typeof body?.total_count === "number" ? body.total_count : null;
  // `totalCount` is returned as well as the `truncated` boolean because a
  // truncated listing is a SUCCESSFUL call: nothing else in the run would print
  // a word about it, and "the API said N and gave us fewer" is the only fact an
  // operator can act on when the report tells them the listing is incomplete.
  return {
    entries,
    totalCount,
    truncated: totalCount === null || totalCount > entries.length,
  };
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

/** "1 entry" / "3 entries" — used in a parenthetical so no verb has to agree. */
function countEntries(count) {
  return count === 1 ? "1 entry" : `${count} entries`;
}

function describeEntry(entry) {
  return (
    `    id ${entry.id ?? "(absent)"} · ref ${entry.ref ?? "(absent)"}\n` +
    `      version    : ${entry.version ?? "(absent)"}\n` +
    `      size       : ${formatBytes(entry.size_in_bytes)}\n` +
    `      created_at : ${entry.created_at ?? "(absent)"}`
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
  const { label, key, evidence, listingFailed } = finding;
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
    // TWO DIFFERENT SILENCES, and blaming the wrong one sends an operator to
    // debug `actions: read` while the real gap is the ref filter. The listing
    // genuinely can succeed, contain the poisoned entry, and still leave this
    // empty — that is what happens when a failed default-branch lookup drops
    // `refs/heads/main` out of the visible-ref set.
    console.error(
      listingFailed
        ? "  No entry details are available: the REST listing did not resolve, so this\n" +
            '  report cannot name the entry. See the "entry details unavailable" warning\n' +
            "  from this step."
        : "  The REST listing resolved, but no entry under this key was visible on a ref\n" +
            "  this run can restore from — its own ref, its PR base ref, and the repository\n" +
            "  default branch. The entry the probe matched exists; it is simply not one\n" +
            '  this report can see. A "diagnostics degraded" warning from this step, if\n' +
            "  present, means that visible-ref set was itself narrowed by a failed lookup.",
    );
  } else {
    console.error(
      `  Entries under this key on refs this run can restore from (${countEntries(evidence.length)}):`,
    );
    for (const entry of evidence) console.error(describeEntry(entry));
  }

  console.error("  Remedy, IN THIS ORDER:");
  console.error(
    "    1. Re-run this job. That is the cheapest discriminator: a transient\n" +
      "       download/service failure clears, while poison recurs every single time,\n" +
      "       because a poisoned entry can never overwrite itself.",
  );

  if (evidence.length === 0) {
    console.error(
      "    2. ONLY if it recurs, delete the offending entry. THIS REPORT CANNOT NAME IT:\n" +
        "       no entry under this key survived the diagnostic listing and ref filter.\n" +
        "       Re-list once the diagnostics recover. `version` NARROWS the field — an\n" +
        "       entry whose version differs from this run's (see the cache step's debug\n" +
        "       log) was saved under a different `path:` or compressor and is not the one\n" +
        "       — but it does NOT identify a single entry, because a version hashes only\n" +
        "       the path and the compression method and is identical on every ref holding\n" +
        "       this key. Among whatever survives that filter, delete ONE AT A TIME in\n" +
        "       restore-priority order, re-running between and stopping when the gate\n" +
        "       goes green:",
    );
    console.error(
      `         gh api "repos/${repository}/actions/caches?key=${key}" --jq '.actions_caches[]'\n` +
        `         gh api -X DELETE "repos/${repository}/actions/caches/<id>"`,
    );
  } else {
    // `version` IS NOT A DISCRIMINATOR BETWEEN THESE, and every earlier
    // revision of this instruction assumed it was. A cache VERSION hashes the
    // `path:` string plus the compression method — nothing else — so it is
    // ref-independent by construction and IDENTICAL on every ref holding this
    // key. This PR's own recorded fixture shows the same key on
    // `refs/pull/200/merge` and `refs/heads/develop` carrying one byte-identical
    // version, and the closing line of this very report says the repository
    // routinely holds both at once. So "delete the one whose version matches"
    // is unexecutable on the NORMAL case: on any PR run both match, and the
    // reader has just been told not to delete all of them.
    //
    // What is genuinely known is ORDER: the restore tried this run's own ref,
    // then the PR base ref, then the default branch, and the evidence arrives
    // sorted that way. The first entry is the one the restore reached
    // first. That is a likelihood, not a proof — if its version does not match
    // this run's, the restore fell through to the next — which is exactly why
    // the procedure is one-at-a-time with a re-run between rather than a single
    // named id. The asymmetry makes that safe: deleting a healthy entry costs
    // one re-download, leaving the poisoned one costs a permanently red gate.
    console.error(
      evidence.length > 1
        ? "    2. ONLY if it recurs, delete them ONE AT A TIME, in the order listed below,\n" +
            "       re-running this job after each deletion and STOPPING as soon as it goes\n" +
            "       green. Do not delete them all at once, and do not try to pick by\n" +
            "       `version`: a cache version hashes the `path:` string and the compression\n" +
            "       method and nothing else, so it is IDENTICAL on every ref holding this\n" +
            "       key — which is the normal case here. The order below is restore\n" +
            "       priority (this run's ref, then the PR base ref, then the default\n" +
            "       branch), so the first is the entry the restore reached first and the\n" +
            "       likeliest culprit. Deleting a healthy one costs a single re-download;\n" +
            "       leaving the poisoned one costs a permanently red gate."
        : "    2. ONLY if it recurs, delete that one entry by id:",
    );
    for (const entry of evidence) {
      // An entry the listing returned without an `id` would otherwise render a
      // copy-pasteable `.../actions/caches/undefined`, four lines under a
      // describeEntry that already said `id (absent)`.
      console.error(
        entry.id == null
          ? `         # entry on ${entry.ref ?? "(absent)"} has no id in the listing — re-list to get it`
          : `         gh api -X DELETE "repos/${repository}/actions/caches/${entry.id}"  # ${entry.ref}`,
      );
    }
  }
  console.error(
    "       Delete by ID, never by `?key=` — the key form removes the entry on EVERY\n" +
      "       ref at once, and this repository routinely holds the same key on a\n" +
      "       branch and on an open PR's merge ref simultaneously.",
  );
}

function reportCold(finding) {
  const { label, key, evidence, probeUnavailable } = finding;

  // THE PROBE NEVER LOOKED, so nothing below may be phrased as a finding about
  // this key. `isCacheFeatureAvailable()` returning false makes restoreImpl set
  // `cache-hit` to a literal "false" and return BEFORE consulting the service —
  // it did not check our key at our version and come up empty, it did not check
  // at all. The previous wording said "the probe found nothing … so the miss is
  // expected" and then "none of them was restorable AT THIS RUN'S CACHE
  // VERSION", one line under a warning stating the service was unreachable.
  // Both are the same overclaim already removed from reportPoisoned and from
  // the ordinary cold path; this is the branch neither pass covered.
  if (probeUnavailable) {
    console.log(
      `cache "${label}": treating the miss at ${key} as a cold key, but THIS RUN DID NOT ` +
        "CHECK. The Actions cache service was reported unavailable, so the probe returned " +
        "before asking about any entry — a cold key and a poisoned one are " +
        "indistinguishable here. The primary cache step could not have restored anything " +
        "either, so nothing is broken by passing; but nothing below is a statement about " +
        "this key's health.",
    );
    if (evidence.length > 0) {
      console.log(
        `  Entries under this key on refs this run can restore from ` +
          `(${countEntries(evidence.length)}), listed as fact and nothing more:`,
      );
      for (const entry of evidence) console.log(describeEntry(entry));
    }
    return;
  }

  console.log(
    `cache "${label}": the lookup-only probe found nothing at ${key} for this run's ` +
      "cache version, so the miss is expected.",
  );
  if (evidence.length > 0) {
    // The P1 false positive this model exists to prevent, made visible rather
    // than merely tolerated: entries under this key DO exist, and none of them
    // is restorable AT THIS RUN'S VERSION, because a cache is matched by
    // (key, version, ref) and `version` hashes the cached path plus the
    // compression method. Editing `path:` — or GitHub changing its compressor —
    // strands every older entry under a live key.
    //
    // WHAT THIS NOTE MUST NOT DO IS ASSERT HEALTH. An earlier revision said
    // "they are not poison", which this branch cannot know: actions/cache
    // swallows a failed lookup inside the PROBE exactly as it does on the
    // primary, so a transient there yields an empty `cache-hit`, lands here as
    // `cold`, and prints a clean bill of health over an entry that may well be
    // at this run's version. That is the same overclaim that was removed from
    // reportPoisoned after it destroyed a healthy 263 MB cache; it must not be
    // reintroduced on this branch. "Leave them alone" survives regardless —
    // deleting is never the correct first move under either reading.
    console.log(
      `  Note: ${countEntries(evidence.length)} under this key on refs this run can\n` +
        "  restore from, and none of them was restorable AT THIS RUN'S CACHE VERSION.\n" +
        "  The likely reading is healthy: the `path:` or the compression method changed,\n" +
        "  which strands older entries under a live key. It is not the only one — the\n" +
        "  probe swallows a failed lookup just as the primary does, so a transient there\n" +
        "  produces this same shape while an entry at this run's version sits right\n" +
        "  here. Either way, leave them alone: deleting is never the right first move,\n" +
        "  GitHub evicts them on its own, and a re-run separates the two (a version\n" +
        "  change reproduces this note exactly; a transient does not).",
    );
    for (const entry of evidence) console.log(describeEntry(entry));
  }
}

async function main(argv, env) {
  const { caches, errors, warnings } = parseCacheArgs(argv);
  const apiUrl = (env.GITHUB_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;

  // Missing wiring is the same class of defect as a missing key: the guard
  // cannot run, and pretending otherwise is how a check becomes decorative.
  if (!repository) errors.push("GITHUB_REPOSITORY is not set");
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
  const repositoryContext = await fetchRepositoryContext({ apiUrl, repository, token });
  for (const warning of repositoryContext.warnings) {
    console.log(`::warning::cache health guard diagnostics degraded: ${warning}`);
  }

  const visibleRefs = visibleCacheRefs({
    ref: env.GITHUB_REF,
    baseRef: env.GITHUB_BASE_REF,
    defaultBranch: repositoryContext.defaultBranch,
  });

  let failed = false;
  const entriesByKey = new Map();

  // Every declared cache is reported before exiting: a first poisoned entry
  // must not hide a second one and cost another round trip through CI.
  for (const cache of caches) {
    if (!entriesByKey.has(cache.key)) {
      try {
        // The truncation fact is HELD, not announced here — see below.
        entriesByKey.set(cache.key, await fetchCacheEntries({ apiUrl, repository, key: cache.key, token }));
      } catch (error) {
        console.log(
          `::warning::cache "${cache.label}": entry details unavailable, so the report ` +
            `for it cannot name entries or ids: ${error.message}`,
        );
        // `failed` distinguishes an unavailable listing from a successful one
        // whose ref filter simply produced no evidence.
        entriesByKey.set(cache.key, {
          entries: [],
          totalCount: null,
          truncated: true,
          failed: true,
        });
      }
    }

    const listing = entriesByKey.get(cache.key);
    const finding = diagnoseCache({
      label: cache.label,
      key: cache.key,
      hit: cache.hit,
      probe: cache.probe,
      entries: listing.entries,
      visibleRefs,
      probeUnavailable: cache.probeUnavailable,
      listingFailed: listing.failed === true,
    });

    // ANNOUNCED HERE, AFTER THE VERDICT, AND PER LABEL — not at fetch time.
    //
    // At fetch time this fired on runs where every cache HIT: verdict `ok`
    // never consults the listing, so the warning pointed at a report that does
    // not exist ("the entries named below" — there are none). If `total_count`
    // ever stops being numeric it would then annotate every green run of a gate
    // fanning out to ~9 jobs, which is how operators learn to scroll past this
    // guard's annotations — the one thing it cannot afford. Per label rather
    // than per key because `entriesByKey` memoises: two labels sharing a key
    // would otherwise have the fact reported under the first label only.
    if (listing.truncated && !listing.failed && finding.verdict !== "ok") {
      console.log(
        `::warning::cache "${cache.label}" (key ${cache.key}): the cache listing is ` +
          `INCOMPLETE. The API ${
            listing.totalCount === null
              ? "returned no usable total_count"
              : `reported ${listing.totalCount} entries under this key`
          } but this response carried ${listing.entries.length}, so any entry list in ` +
          "this cache's report is a partial view. The verdict is unaffected because it " +
          "comes from the primary restore and lookup-only probe.",
      );
    }

    if (finding.verdict === "ok") {
      console.log(`cache "${finding.label}": restored from ${finding.key} — healthy.`);
    } else if (finding.verdict === "cold") {
      reportCold(finding);
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
