#!/usr/bin/env node
/**
 * check-cache-health.mjs — detect a POISONED actions/cache entry.
 *
 * WHY THIS EXISTS (read before "simplifying" it away):
 * this repository has shipped a CI defect that is, by construction, INVISIBLE.
 * An `actions/cache` entry exists under a key but the restore does
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
 * ── WHAT THIS CLOSES, AND WHAT IT DOES NOT ─────────────────────────────────
 *
 * Two incidents drove this file. It closes ONE of them plus the general
 * fingerprint, and an earlier revision of this header said "twice", which a
 * later maintainer would reasonably read as covering both. It does not.
 *
 * CLOSED — the Playwright entry that matched the key and failed to extract.
 * Verified end to end against recorded fixtures with production-shaped argv:
 * exit 1, naming the entry and its id. It is catchable because the swallowed
 * tar failure leaves the primary's `cache-hit` EMPTY, so the probe's `if:`
 * fires and there is something to compare.
 *
 * NOT CLOSED — the nats entry saved under an absolute /usr/local/bin path
 * (93f2591). Same class of harm, out of reach here for two independent reasons,
 * and the second is the one that matters:
 *
 *   1. It happened in publish.yml. This guard is wired only into e2e-gate.yml.
 *   2. A cache that RESTORES SUCCESSFULLY into a layout the job cannot use is
 *      outside this fingerprint entirely. `cache-hit` is 'true', diagnoseCache
 *      returns `ok` before the probe or the listing is consulted, and nothing
 *      here ever looks at what landed on disk. No amount of probing fixes that:
 *      catching it needs a post-restore assertion on the extracted tree — the
 *      composite action's "Verify nats-server is on PATH" step is the shape of
 *      it — not a cache-existence check.
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
 * soften it: if it can show — from a COMPLETE listing — that every visible
 * entry under the key was created after this run started, the probe hit is a
 * concurrent save landing between the restore and the probe, not poison:
 * verdict `raced`, a warning, PASS. "Complete" is a precondition and not a
 * detail; a listing narrowed by a failed lookup can exhibit that shape while
 * hiding the poison. See diagnoseCache for why the downgrade is safe, what it
 * costs, and what it refuses.
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
 * "FAILS SAFE" HAS TO BE ENFORCED, NOT ASSUMED, and PARTIAL degradation is why.
 * A total failure empties the evidence, which is obviously safe. A partial one
 * — one endpoint of the two answering — leaves a SHORTER evidence list that
 * still looks like an answer, and the `raced` downgrade reasons over exactly
 * that list. Losing `default_branch` alone was measured turning a real poisoned
 * entry into `raced` and exit 0. So the downgrade is gated on `scopeComplete`,
 * which certifies that EVERY diagnostic call answered — see diagnoseCache
 * property 3.
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
 * ONE SUB-SECOND WRINKLE, stated so nobody re-derives it as a bug: measured
 * live, `run_started_at` is truncated to whole seconds while `created_at`
 * carries nine fractional digits, both UTC. An entry created in the same second
 * as the run start therefore reads as post-dating it. That is a ≤1s extension
 * of the checkout-window trade already accepted in diagnoseCache property 4 —
 * same direction, same mitigation (poison is persistent, so it fails properly
 * on the next run), and negligible beside the seconds-to-minutes window that
 * trade already covers.
 *
 * Unparseable/absent timestamps on EITHER side count as "older", so an entry is
 * only ever treated as new when the API positively says so. That direction is
 * deliberate: it keeps the "raced" downgrade unreachable through missing data.
 *
 * BOTH SIDES OF THAT `||` ARE LOAD-BEARING, and they are defended differently.
 * The `created === null` side is the only defence for an entry whose
 * `created_at` is absent or malformed. The `started === null` side overlaps
 * with `scopeComplete`, which independently refuses the downgrade when the runs
 * endpoint did not answer — but the overlap is not total: a `run_started_at`
 * that is PRESENT and unparseable (a GHES quirk, a shape change) satisfies
 * `scopeComplete`, and then this line is the only thing standing between a
 * garbage timestamp and a `raced` pass. Flip either side and evidence is
 * labelled "created after this run started" on no evidence at all.
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
 * Four properties hold, and each is load-bearing:
 *
 * 1. EMPTY EVIDENCE IS STILL `poisoned`. REST is diagnostics-only, and a
 *    degraded REST layer must never be able to hide a real poisoning. Empty
 *    evidence means "we could not rule it out", not "no entries exist". This
 *    covers TOTAL degradation only — a partly-degraded lookup returns a
 *    non-empty list that is merely INCOMPLETE, and property 3 is what covers
 *    that. Do not read this line as the whole defence; it was, and the gap was
 *    a live fail-open.
 * 2. ANY ENTRY PREDATING THE RUN IS STILL `poisoned`. One old entry is enough:
 *    it was restorable and was not restored. Hence `every`, not `some`.
 * 3. AN INCOMPLETE EVIDENCE SCOPE IS STILL `poisoned` — `scopeComplete`, and it
 *    is not a formality. `every()` over a set that is missing entries proves
 *    NOTHING, and PARTIAL degradation is what makes the set lie while looking
 *    healthy. Property 1 only covers total degradation. The measured hole this
 *    closes: `GET /repos/{o}/{r}` fails → `defaultBranch` is undefined →
 *    `refs/heads/main` silently drops out of visibleRefs → an OLD poisoned
 *    entry on the default branch is filtered out of `evidence` → the newer
 *    entry that survives on another visible ref makes `every()` true → `raced`,
 *    exit 0, under a warning asserting the opposite of the truth. Same fixtures,
 *    only the repo endpoint changed: healthy → exit 1 POISONED, 500 → exit 0.
 *    So the downgrade requires the caller to certify the whole diagnostic path:
 *    default branch resolved, run start time resolved, the listing fetch for
 *    THIS key not thrown, and the listing not truncated. Absent or non-`true`,
 *    the downgrade is refused — omitting the argument cannot enable it. One
 *    half of that completeness is computed HERE and not by the caller: an entry
 *    whose `ref` is absent is dropped by the ref filter, which narrows the
 *    evidence exactly the way a failed lookup does, so it blocks the downgrade
 *    on the same flag.
 * 4. THIS TRADES A NARROW FALSE NEGATIVE FOR THAT FALSE POSITIVE, and the trade
 *    is not free. `run_started_at` precedes the primary restore step by the
 *    checkout/setup time, so an entry genuinely written in THAT window is real
 *    poison and gets downgraded to `raced` on this run. That is acceptable for
 *    exactly one reason: poison is PERSISTENT BY CONSTRUCTION — a poisoned
 *    entry can never overwrite itself — so on the next run it predates that
 *    run's start and fails properly. The warning text says so explicitly, so an
 *    operator seeing it twice knows it is not a race.
 *
 * `scopeComplete` asks only "did every diagnostic call ANSWER". Whether the
 * answer was USABLE is predatesRun's job: a present-but-unparseable
 * `run_started_at` passes the completeness check and is then caught by that
 * function's fail direction, which is why both layers exist and both are tested.
 */
export function diagnoseCache({
  label,
  key,
  hit,
  probe,
  entries,
  visibleRefs,
  runStartedAt,
  scopeComplete,
  probeUnavailable,
  listingFailed,
} = {}) {
  if (hit === true) return { label, key, verdict: "ok", evidence: [] };

  const visible = visibleRefs ?? new Set();
  const matchingKey = (entries ?? []).filter((entry) => entry?.key === key);

  // AN ENTRY WITH NO USABLE `ref` IS DROPPED, AND THAT DROP IS NOT FREE.
  // `visible.has(undefined)` is false, so such an entry vanishes from the
  // evidence silently — and if the one it hid was OLD while a newer one
  // survived, `every()` goes true and a real poisoning is downgraded to
  // `raced`, exit 0, over a listing this function otherwise considers complete.
  // Nobody has shown the live API ever omits `ref`, so this is insurance, not a
  // fix for an observed outage; it is cheap because it folds into the
  // completeness flag that already exists rather than adding a branch. An
  // unparseable listing must not be allowed to certify itself.
  const droppedForMissingRef = matchingKey.filter(
    (entry) => typeof entry?.ref !== "string" || entry.ref === "",
  ).length;

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
    .map((entry) => ({ ...entry, createdAfterRunStarted: !predatesRun(entry, runStartedAt) }))
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

  const allEntriesPostDateRun =
    evidence.length > 0 && evidence.every((entry) => entry.createdAfterRunStarted === true);
  const scopeIsComplete = scopeComplete === true && droppedForMissingRef === 0;

  if (allEntriesPostDateRun && scopeIsComplete) {
    return { label, key, verdict: "raced", evidence };
  }

  // Both flags are for the REPORT, not the verdict. `racedSuppressed` explains
  // why a run is failing over a set of entries that all look like a race;
  // `listingFailed` separates "the listing did not resolve" from "it resolved
  // and nothing survived the ref filter", which are different operator actions.
  return {
    label,
    key,
    verdict: "poisoned",
    evidence,
    racedSuppressed: allEntriesPostDateRun && !scopeIsComplete,
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

/**
 * List the entries under one key, and say whether the list is COMPLETE.
 *
 * `truncated` is not decoration: an omitted OLD entry is a route into the
 * `raced` downgrade, because `every()` over a short page can be true while the
 * page that was dropped holds the poison. So the completeness of the answer is
 * reported alongside it and feeds `scopeComplete`.
 *
 * Deliberately NO pagination loop. Refusing to downgrade on a truncated answer
 * costs one falsely-reported poison at worst — which a re-run resolves, since
 * poison recurs and a race does not — while a paging loop adds request-count,
 * rate-limit and partial-failure surface to a step that must never flake. A
 * missing or non-numeric `total_count` counts as truncated for the same reason
 * empty evidence counts as poison: it means "could not rule it out".
 */
export async function fetchCacheEntries({ apiUrl, repository, key, token }) {
  // `?key=` narrows the response (documented as a PREFIX filter); the exact
  // comparison still happens in diagnoseCache.
  const url =
    `${apiUrl}/repos/${repository}/actions/caches` +
    `?key=${encodeURIComponent(key)}&per_page=100`;
  const body = await githubJson(url, token);
  const entries = Array.isArray(body?.actions_caches) ? body.actions_caches : [];
  const totalCount = typeof body?.total_count === "number" ? body.total_count : null;
  // `totalCount` is returned as well as the verdict-facing boolean because a
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
 * ── THE REMEDY IS DRIVEN BY ONE DERIVED LIST, ON PURPOSE ───────────────────
 *
 * `candidates` — the evidence entries that PREDATE the run — is the only thing
 * the remedy branches on. Earlier revisions branched separately on
 * `racedSuppressed`, on `evidence.length === 0` and on `evidence.length > 1`,
 * each with its own prose, and the combinations contradicted each other. The
 * measured one: a suppressed downgrade with two surviving entries printed
 * "the candidate is NOT one of these", then "the candidate is whichever of
 * these matches this run's version", then "delete NOT one of these" — and the
 * middle procedure SUCCEEDS, because the probe hit means an entry really does
 * exist at this run's exact key and version, and on that path the entry is the
 * concurrent save. It fingers a healthy cache created seconds earlier, whose
 * id the report printed eight lines above.
 *
 * The invariant that dissolves all of it: AN ENTRY CREATED AFTER THIS RUN
 * STARTED CANNOT BE THE ONE THE RESTORE FAILED TO PRODUCE, so it is never a
 * deletion target — in any branch, for any reason. Filter once, then let
 * `candidates.length` (0 / 1 / >1) pick the wording. `racedSuppressed` stops
 * being a remedy selector and keeps only its real job: explaining why a run is
 * still failing over a set of entries that all look like a race.
 *
 * The step still exits non-zero regardless. Silence is the disease this guard
 * exists to cure, and a swallowed transient that repeats every run is worth
 * seeing too.
 */
function reportPoisoned(finding, { repository }) {
  const { label, key, evidence, racedSuppressed, listingFailed } = finding;
  const candidates = evidence.filter((entry) => !entry.createdAfterRunStarted);
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
    if (racedSuppressed) {
      // The one thing `racedSuppressed` still selects, and it is an
      // EXPLANATION, not a procedure: without it the report contradicts itself,
      // because every entry it just listed is marked "created after this run
      // started" — the exact shape that passes as a race.
      console.error(
        "  Every entry listed above post-dates this run's start, which on a COMPLETE\n" +
          "  listing would be reported as a concurrent save and pass. It is not passing\n" +
          "  here, deliberately: this listing is not known to be complete — EITHER one of\n" +
          "  the diagnostic calls behind it failed, OR the API reported more entries than\n" +
          "  it returned. The ::warning:: lines from this step say which. So the list may\n" +
          "  be MISSING entries, including an older one that would prove poison, and a set\n" +
          "  that may be incomplete cannot prove every entry is new. Re-run first, as\n" +
          "  below: it re-runs the diagnostics too.",
      );
    }
  }

  console.error("  Remedy, IN THIS ORDER:");
  console.error(
    "    1. Re-run this job. That is the cheapest discriminator: a transient\n" +
      "       download/service failure clears, while poison recurs every single time,\n" +
      "       because a poisoned entry can never overwrite itself.",
  );

  if (candidates.length === 0) {
    // Covers BOTH "we saw nothing" and "everything we saw post-dates the run".
    // They were separate branches with separate prose until the combinations
    // started contradicting each other; the honest sentence is the same for
    // both, because in both this report cannot name a target it can stand behind.
    console.error(
      "    2. ONLY if it recurs, delete the offending entry. THIS REPORT CANNOT NAME IT:\n" +
        "       no entry it could see qualifies as a candidate, because an entry created\n" +
        "       after this run started cannot be the one the restore failed to produce.\n" +
        "       Re-list once the diagnostics recover. `version` NARROWS the field — an\n" +
        "       entry whose version differs from this run's (see the cache step's debug\n" +
        "       log) was saved under a different `path:` or compressor and is not the one\n" +
        "       — but it does NOT identify a single entry, because a version hashes only\n" +
        "       the path and the compression method and is identical on every ref holding\n" +
        "       this key. Among whatever survives that filter, delete ONE AT A TIME,\n" +
        "       oldest first, re-running between and stopping when the gate goes green:",
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
    // sorted that way. The first candidate is the entry the restore reached
    // first. That is a likelihood, not a proof — if its version does not match
    // this run's, the restore fell through to the next — which is exactly why
    // the procedure is one-at-a-time with a re-run between rather than a single
    // named id. The asymmetry makes that safe: deleting a healthy entry costs
    // one re-download, leaving the poisoned one costs a permanently red gate.
    console.error(
      candidates.length > 1
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
    for (const entry of candidates) {
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
      "restore step did not produce — the poison fingerprint — but " +
      (evidence.length === 1
        ? "the only entry visible to this run was"
        : `all ${evidence.length} entries visible to this run were`) +
      " created AFTER this run started, so the most " +
      "likely cause is a concurrent job's end-of-job save landing between the restore and " +
      "the probe (they are minutes apart, not simultaneous). Treating it as a race, not as " +
      "poison, and passing. IF THIS WARNING REPEATS ON A LATER RUN, IT IS NOT A RACE: a " +
      "poisoned entry can never overwrite itself, so on any subsequent run it predates that " +
      "run's start and this guard will fail properly. Two of these in a row means real poison.",
  );
  for (const entry of evidence) console.log(describeEntry(entry));
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

  // THE HALVES OF `scopeComplete` THAT ARE THE SAME FOR EVERY DECLARED CACHE.
  //
  // Both are what BUILT visibleRefs and the age labels, so a failure in either
  // silently narrows the evidence rather than emptying it — which is precisely
  // how a partial degradation forges an `every()` over a set the poison was
  // filtered out of. `defaultBranch` missing drops `refs/heads/main`;
  // `runStartedAt` missing makes every age label meaningless. Neither may
  // enable a downgrade.
  const defaultBranchResolved =
    typeof runContext.defaultBranch === "string" && runContext.defaultBranch !== "";
  const runStartedAtResolved =
    typeof runContext.runStartedAt === "string" && runContext.runStartedAt !== "";

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
        // `truncated: true` is the load-bearing half. The empty list alone is
        // safe only by luck of the `evidence.length > 0` conjunct in
        // diagnoseCache; saying "this listing is not complete" is what makes
        // the refusal to downgrade explicit rather than incidental. `failed`
        // separates it from a truncated-but-successful listing, which needs
        // different wording in both the warning and the report.
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
      runStartedAt: runContext.runStartedAt,
      scopeComplete: defaultBranchResolved && runStartedAtResolved && !listing.truncated,
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
          "this cache's report is a partial view. This guard will not downgrade a probe " +
          "hit to a concurrent-save warning on a listing it cannot trust.",
      );
    }

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
