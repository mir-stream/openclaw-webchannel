# Publishing & Consuming the WebChannel Packages

Two packages publish to the **public npm registry** (`registry.npmjs.org`),
MIT-licensed, installable by anyone with no authentication at all:

| Package | What it is |
|---|---|
| `openclaw-webchannel-saas` | Headless SaaS trust-chain core (device-flow enrollment, NATS creds/JWT minting) |
| `openclaw-webchannel-client` | Framework-agnostic, zero-dependency browser client |

**Both unscoped names exist on npm, but carry no real release yet.** Each holds
only the hand-published, **unattested** `0.0.0-bootstrap.0` placeholder from
step (a) of the
[one-time bootstrap](#one-time-bootstrap-trusted-publishing-for-client--saas)
below — which npm also made their `latest`, so a bare `npm install` of either
resolves the placeholder. The first real, provenance-carrying release under
these names is still to come. What is installable as a **working library today**
is the previous,
scoped pair — `@mir-stream/webchannel-saas` and `@mir-stream/webchannel-client`
at `0.6.1`, on public npm, `latest`, with provenance. Those scoped names are
unpublished once the unscoped ones ship, so consumers must move; see
[Migrating an existing consumer](#migrating-an-existing-consumer).

The scoped names lived on **GitHub Packages** until 0.6.1. That registry requires
an authenticated `read:packages` token for *every* consumer read — even of a
public package — so every downstream project, CI job, Docker build and deploy
host needed a credential just to `npm install`, which is why real consumers
vendored these packages instead. The repo is public and the packages are MIT, so
as of 0.6.1 they publish to npmjs.org like the plugin already did: OIDC trusted
publishing, no long-lived token, with provenance attestation. The rename changes
the names only — that registry story is unaffected.

A third artifact — the `openclaw-webchannel` **plugin** — is published to the
public npm registry by the same `v*` tag. It has a ClawHub leg too, but that leg
is **disabled by default** and ships nothing unless the `PUBLISH_CLAWHUB`
repository variable is set to `"true"` — see
[Plugin publishing (ClawHub)](#plugin-publishing-clawhub) below.

## Cutting a release

One `v*` tag ships **all three** artifacts at a **single, identical version** —
`openclaw-webchannel-client`, `openclaw-webchannel-saas` and the
`openclaw-webchannel` plugin, all three to public npm (the plugin additionally to
ClawHub *if* that leg is enabled, which by default it is not). This 3-way
lockstep is enforced in CI (see below),
so the plugin can never fall behind the npm packages again.

1. Bump `version` to the **same** value in all three:
   `packages/client/package.json`, `packages/saas/package.json`, and
   `packages/plugin/package.json`.
2. Commit, then tag and push. Use a **lightweight** tag (plain `git tag vX.Y.Z`,
   not `git tag -a`): on an annotated-tag push `GITHUB_SHA` can reference the tag
   object instead of the commit, which would pollute the `--source-commit`
   metadata the plugin leg records.

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

The `Publish Packages` workflow (`.github/workflows/publish.yml`) runs four jobs:

- **`publish`** — builds, tests, and publishes `openclaw-webchannel-client` and
  `openclaw-webchannel-saas` to public npm via **OIDC trusted publishing** with
  `--provenance` (no `NPM_TOKEN`, no PAT — the job's `id-token: write` is the
  whole credential story). Also runnable manually (`workflow_dispatch`): a
  dispatch from any ref builds, tests, and runs both lockstep gates, but never
  publishes anything. Only a `v*` tag push publishes. A fresh manual dispatch is
  therefore not release recovery. Re-run the **original tag-push run** instead:

  ```sh
  gh run rerun <RUN_ID>          # or: gh run list --workflow publish.yml
  ```

  GitHub preserves that run's original `push` event and tag ref, so every job's
  guard still matches.

- **`publish-plugin-npm`** — gated on `publish` succeeding; builds/tests the
  plugin and publishes it to public npm the same way. Tag *push* only.
- **`verify-dist-tags`** — gated on both public-npm publish jobs succeeding;
  confirms that all three packages' `latest` tags equal the release version.
  Tag *push* only.
- **`publish-plugin`** — gated on `publish` succeeding; builds/tests the plugin
  and publishes it to ClawHub (see next section). Disabled by default via the
  `PUBLISH_CLAWHUB` repository variable, and additionally skipped on ALL manual
  workflow_dispatch runs — including one started from a tag ref — because its
  publish surface deliberately remains tag-*push*-only.

Note: **all three legs are idempotent.** Each package (client, saas, plugin) is
skipped when that exact version is positively confirmed already on its registry
(the npm leg checks each package with `npm view`, the ClawHub leg with `package
inspect`). For all three public-npm artifacts, a version match is accepted only
when npm also reports a provenance attestation and a `gitHead` equal to the run's
`GITHUB_SHA`; either mismatch fails the run loudly. Therefore **"Re-run failed
jobs"** is safe anywhere in the workflow, including after a partial npm publish
(e.g. client shipped but saas flaked). On a full re-run of an already-shipped
tag, the publish legs are verified no-ops and skip green. End-to-end green also
requires all three public-npm `latest` tags to equal the re-run tag's version,
so re-running a superseded tag ends red at `verify-dist-tags` by design; never
move `latest` backward to make it pass. An already-published version is **never
republished** (it is skipped, not overwritten): to ship new content you must
**bump the version and cut a new tag**.

### Recovering a split `latest`

npm advances each package's `latest` dist-tag independently; there is no
multi-package transaction. If a release stops partway through, some packages
can therefore resolve at the new version while another still resolves at an
older version (or at the bootstrap placeholder for a new package name). The
read-only `verify-dist-tags` job has a roughly 19.5-minute sleep budget (39
30-second inter-attempt sleeps) and a 30-minute hard job timeout that bounds the
polling plus registry latency, including how long the job can hold the
`npm-release` concurrency group. The polling horizon covers npm's publish-time
malware scan, which creates a delay between publishing and availability
(typically about five minutes, but 15 minutes or more at peak times or for some
package content and sizes):
https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/.
Do not re-run while a version is still scan-pending; an immediate re-run can see
the version as absent and try to publish it again.

The verifier succeeds only when all three registry reads succeed and all three
`latest` tags equal the run's tag version. A re-run of a superseded tag therefore
ends red by design because the tags no longer point at that version. **Never move
`latest` backward** to make it pass; re-run the current release's run instead.

Once the versions are actually installable, re-run the original tag-push run:

```sh
gh run rerun <RUN_ID>
```

The publish legs are idempotent, so packages already present with the expected
provenance and `gitHead` are verified and skipped while a missing publish is
retried. If the version is published but its `latest` tag is still wrong, an
operator must repair that package with interactive npm authentication:

Use the **exact package name the failing job printed** — it reads all three names
from the manifests, so they change when the packages are renamed:

```sh
npm dist-tag add <name>@<version> latest \
  --registry=https://registry.npmjs.org/
```

That form is correct for every **unscoped** name — `openclaw-webchannel`, and
`openclaw-webchannel-client` / `openclaw-webchannel-saas` once they carry a real
release. Today those two have a `latest`, but it points at the bootstrap
placeholder — there is no release for it to have split away from, so there is
nothing here to repair yet.

**If the name is scoped** (`@scope/...`), that command silently targets the
wrong registry, because a plain `--registry` does **not** override an
`@scope:registry` mapping — and the legacy `.npmrc` line documented later in
this guide maps `@mir-stream` to GitHub Packages. Override the scope instead:

```sh
npm dist-tag add @scope/<package>@<version> latest \
  --@scope:registry=https://registry.npmjs.org/
```

**This still applies to the scoped names today.**
`@mir-stream/webchannel-{client,saas}@0.6.1` are live and `latest` on npm until
the rename release unpublishes them, so they remain what this runbook repairs:

```sh
npm dist-tag add @mir-stream/webchannel-client@0.6.1 latest \
  --@mir-stream:registry=https://registry.npmjs.org/
```

That `@scope:registry`-beats-`--registry` precedence is live npm behavior worth
remembering, and it stops applying to this repo only once the old names are gone.

Before changing any tag, confirm the intended version is newer; never move
`latest` backward.

CI cannot perform that fallback: its trusted-publishing OIDC credential
authorizes `npm publish` and `npm stage publish`, but not `npm dist-tag add`.

## One-time bootstrap: trusted publishing for client + saas

**This is required exactly once, by hand, before the workflow can ever publish
these two packages.** npm attaches a Trusted Publisher to an *existing* package,
so a brand-new package name has a chicken-and-egg problem: OIDC cannot create
it, and the workflow's publish step is denied by npm until the trusted publisher
exists. (This is a known npm gap — PyPI lets you configure a trusted publisher
for a name that does not exist yet; npm does not. See npm/cli#8544.)
`openclaw-webchannel-client` and `openclaw-webchannel-saas` were brand-new names
*on npmjs.org*, which is why they need this at all. **Steps (a) and (b) have
already been performed for both (2026-08-22)** — each now holds the
`0.0.0-bootstrap.0` placeholder, and each has its Trusted Publisher attached.
What remains before the release is **(c)**, the publishing-access lockdown, then
**(d)**, the release itself. (a)–(c) are recorded below for re-execution and
audit.

**Only (a) is verifiable from outside the web UI.** The registry exposes
versions, dist-tags and maintainers — it carries no trusted-publisher or
publishing-access fields, and no npm CLI subcommand reads them either. So (b)
and (c) cannot be re-checked from a script; the dates recorded here are the only
audit trail, and confirming them means opening **Package → Settings** on
npmjs.com for each name. A wrong trusted-publisher entry does not fail on save
and surfaces only much later as a `404 on PUT` during the release.

The chicken-and-egg is per package **name**, so the existing
`openclaw-webchannel` plugin registration configures neither of them, even
though all three names now share that prefix: an unscoped prefix is not a
namespace npm recognises. OIDC
trusted publishing with provenance is already proven for this org by
`@mir-stream/openclaw-prompt-compat@0.3.0`, whose registry metadata includes a
SLSA v1 provenance attestation and a `gitHead`. That package comes from a
different repository, so it proves only that the registry path works; it does
not configure this repo's workflow for client or saas, and both names still
require the bootstrap below.

**Do not bootstrap at the release version.** Publishing the release version by
hand would ship it **unattested**, and the workflow's idempotency guard would
reject that unknown tarball and fail the real tag. The version would already be occupied, so
CI could not replace it with the attested build the release promises. Bootstrap
with a throwaway `0.0.0-bootstrap.0` instead, so the **real** release is the first
thing CI publishes and it carries provenance.

**Prerequisite.** A brand-new **unscoped** name is claimed by whoever publishes
it first, so `@mir-stream` org membership is not a precondition here — the
bootstrap publish itself is what claims the name, and there is no separate grant
step. Two things must hold before step (a), and neither is self-diagnosing
afterwards:

1. **You are logged in as the account that owns the existing plugin.** All three
   packages must end up under one account: the operator repair path this guide
   depends on (`npm dist-tag add`) can only be run by an owner, so bootstrapping
   from a different account splits the three packages across two principals — and
   you would discover it mid-release. `npm whoami` must equal the owner of
   `openclaw-webchannel`:

   ```sh
   npm whoami --registry https://registry.npmjs.org
   npm owner ls openclaw-webchannel --registry https://registry.npmjs.org  # → mir-stream
   ```

2. **Neither name is claimed by anyone else.** A `404` is the clean
   precondition, not an error:

   ```sh
   npm view openclaw-webchannel-client --registry https://registry.npmjs.org   # E404, or triage below
   npm view openclaw-webchannel-saas   --registry https://registry.npmjs.org   # E404, or triage below
   ```

   Both now resolve rather than 404, because step (a) already ran for both on
   2026-08-22: each carries exactly `["0.0.0-bootstrap.0"]`. That is the
   *expected* post-step-(a) reading — it routes to the triage below, not to a
   stop. Pin the registry on these
   reads: a stale `registry=` in `~/.npmrc` would 404 from the *wrong* registry
   and hand you a false "unclaimed".

   **If either stops returning `404`, check what is published before concluding
   anything.** Step (a) publishes the two packages separately, so a partial
   bootstrap is entirely normal — one can succeed and the other fail (the two
   scoped packages were created 14 seconds apart, as two publishes). Triage on
   the **versions**, which subsumes the ownership question:

   ```sh
   npm view openclaw-webchannel-client versions --json --registry https://registry.npmjs.org
   ```

   Exactly `["0.0.0-bootstrap.0"]` means you claimed that name on an earlier
   attempt: leave it alone, skip to step (b) **for that name only**, and repeat
   step (a) for whichever name still 404s.

   **Anything else is a stop.** A different owner means no amount of
   configuration recovers the name, and the bootstrap plus every later release
   under it are blocked until a different name is chosen. Any *other* version
   present — the release version above all — means a hand publish went out at a
   release version: it is unattested, step (d) below depends on that version being
   absent, and CI cannot replace it. See **Do not bootstrap at the release
   version** above.

**(a) Publish a `0.0.0-bootstrap.0` placeholder for each package.** The point is
only to make the *name* exist so npm will accept a trusted-publisher configuration
on it. Work in a **throwaway clone** — the version edit below must never be
committed or tagged, and the repo's own `package.json` files stay at `0.6.1`.

**Clone a ref that carries the #226 rename**, and do not run this step until the
rename is merged to that ref. The manifests decide which names get claimed, and
an unpinned clone takes the default branch — which still carries the old scoped
names until the rename lands there. The assertion below makes that
self-diagnosing; do not skip it.

```sh
# <ref> must be a branch or tag whose manifests already carry the new names.
git clone --branch <ref> https://github.com/mir-stream/openclaw-webchannel.git /tmp/wc-bootstrap
cd /tmp/wc-bootstrap
npm ci
npm login --registry https://registry.npmjs.org   # if not already authenticated

# Rewrite the two manifests IN THIS THROWAWAY CLONE ONLY.
# --no-git-tag-version stops npm from committing or tagging the change.
npm version 0.0.0-bootstrap.0 --no-git-tag-version -w packages/client
npm version 0.0.0-bootstrap.0 --no-git-tag-version -w packages/saas

# ASSERT the clone carries the renamed manifests, then publish. The assert exits
# non-zero on an @mir-stream/… name and the `&&` stops the publishes, so a wrong
# ref cannot silently claim nothing. Do not split these lines apart.
node -e 'for (const [w,n] of [["client","openclaw-webchannel-client"],["saas","openclaw-webchannel-saas"]]) { const a=require(`./packages/${w}/package.json`).name; if (a!==n) { console.error(`STOP: packages/${w} is named ${a}, expected ${n} — wrong ref.`); process.exit(1); } console.log(a); }' \
  && npm publish -w packages/client --access public --tag bootstrap --registry https://registry.npmjs.org \
  && npm publish -w packages/saas   --access public --tag bootstrap --registry https://registry.npmjs.org

cd / && rm -rf /tmp/wc-bootstrap   # the clone has served its purpose
```

There is deliberately no build step: both manifests declare `"prepack": "npm run
build"`, so `npm publish` rebuilds `dist/` itself. An explicit build line would
be one more thing to forget, and forgetting it would ship a stale tarball.

One flag carries the weight here:

- **`--access public`** — a no-op for these names, kept for clarity. Unscoped
  packages are always public; the restricted default that this flag exists to
  override applies to scoped names only. (Both manifests also carry
  `publishConfig.access: "public"`, equally harmless.)
- **`--tag bootstrap`** — adds the explicit `bootstrap` tag, but does **not** keep
  a first publish off `latest`: measured on both client and saas, npm set both
  `bootstrap` and `latest` to `0.0.0-bootstrap.0`. During the window before the
  real release, a bare `npm install` of either package therefore resolves
  `latest` and can serve the unattested placeholder; there is no `ETARGET`
  protection. npm does not permit removing the `latest` dist-tag, so keep this
  bootstrap window short and cut the release promptly — that publish moves
  `latest` to the real version. Keep the prerelease suffix anyway: once a real
  release exists, ordinary `*` range resolution excludes prereleases, so the
  placeholder cannot be selected again by a version range even if `latest` were
  ever unset or moved.

**Do not `npm unpublish` the placeholder** before the real release ships.
Unpublishing the only version of a package removes the package itself — taking
the trusted-publisher configuration with it, and putting you back at square one.
Leave `0.0.0-bootstrap.0@bootstrap` in place; it is harmless.

**(b) Attach the Trusted Publisher.** On npmjs.com, for **each** of
`openclaw-webchannel-client` and `openclaw-webchannel-saas`:

> Package → Settings → Trusted Publisher → Add:
> - Organization or user = **`mir-stream`**
> - Repository = **`openclaw-webchannel`**
> - Workflow = **`publish.yml`**
> - Environment = *(blank)*
> - Allowed actions = **npm publish**

**(c) Disable token publishing.** After enabling the Trusted Publisher above,
on npmjs.com, for **both** packages, open **Settings → Publishing access** and
select **"Require two-factor authentication and disallow bypass 2fa tokens (recommended)"**.
The same page confirms that all publishing access options are compatible with
OIDC trusted publishers, and an already-configured trusted publisher keeps
working regardless of which option is selected, so this step cannot break the
OIDC release path. Trusted publishing coexists with token authentication by
default; this closes the route by which a leaked or mistakenly used token could
occupy a release version outside OIDC. The workflow guard can detect that
conflict only after the version has been burned, so registry policy must prevent
it.

**(d) Cut the release normally.** From then on every tagged release publishes
from CI with zero credentials — `npm publish` mints short-lived tokens from the
workflow's id-token itself. Because the placeholder is `0.0.0-bootstrap.0` and
the release is `<version>`, the idempotency guard finds no match and
**`<version>` publishes through OIDC with provenance**, exactly as the changelog
and the section below claim. On a re-run, the guard skips it only after verifying
that provenance and the published `gitHead` against the run's commit.

`<version>` must be **greater than `0.6.1`**: that version is already burned on
the plugin (`openclaw-webchannel@0.6.1`, published with `gitHead 23bb278…`), the
`v0.6.1` tag is pushed, and `publish.yml`'s plugin guard hard-fails a re-cut of
that tag on the `gitHead` mismatch. Pick the actual number when the release is
cut and read it back from the CHANGELOG / the release tag.

After the release publishes, verify that `latest` moved for **both** packages:

```sh
curl -s https://registry.npmjs.org/-/package/openclaw-webchannel-client/dist-tags
curl -s https://registry.npmjs.org/-/package/openclaw-webchannel-saas/dist-tags
```

Each response must report `latest` equal to the release version, not
`0.0.0-bootstrap.0`.

**The bootstrap no longer blocks releases.** Steps (a) and (b) are done for both
names, so a `v*` tag has everything it needs; the outstanding step (c) is registry
policy and gates nothing in CI — as noted above, publishing access cannot break
the OIDC release path. A **plugin-only hotfix needs no further npm web-UI work.**

What is *not* proven yet is that step (b) was entered correctly. Nothing outside
the npm web UI can read a trusted-publisher entry back, and a typo in one does not
fail on save — it surfaces as a `404 on PUT` the first time the `publish` job runs.
The next release is therefore what verifies (b); if it 404s, re-check both entries
character by character before suspecting anything else.

Keep the mechanism in mind, because it is what made (a) and (b) urgent: while
either was missing, every `v*` tag failed at the `publish` job, and both plugin
legs `needs: publish`, so they were skipped — meaning even a plugin-only hotfix
could not ship until client and saas were squared away on the registry. That is
the state to expect again if a future rename introduces another new name.

## Plugin publishing (ClawHub)

The `publish-plugin` job publishes `openclaw-webchannel` (`packages/plugin`) to
the ClawHub registry as owner `mir-stream`, family `code-plugin`.

**This leg is disabled by default and ships nothing today.** It runs only when
the `PUBLISH_CLAWHUB` repository variable is set to `"true"`; unset (the default)
evaluates falsy and the job is skipped on every release. It was switched off
because a `scan:suspicious` moderation flag pins ClawHub's `latest` at `0.2.0`
regardless of what is pushed, so the job could only go green while achieving
nothing. npm is the distribution channel that matters and it publishes fine. The
job body below is kept correct and ready for the day the flag clears; everything
it describes is what *would* happen when the variable is set.

**3-way version lockstep.** The check runs in **both** jobs. In the npm leg
(`publish`) it runs *before anything is published* — so if the tag version does
not equal the plugin, client, and saas `package.json` versions, the release
aborts with a clear error and **nothing ships**; the copy in `publish-plugin` is
defense-in-depth. Because the abort happens before any artifact is published,
the tag is not burned: fix the versions to match, then delete and re-push the
tag to recover.

**Authentication — OIDC-first, stored-token fallback (fallback is active today).**
The pinned `clawhub` CLI tries GitHub Actions OIDC trusted publishing *first*
(requesting a GitHub OIDC token, audience `clawhub`, and exchanging it for a
short-lived ClawHub token) and only falls back to a stored config token when
that mint fails. **The fallback is still the wired path.** It was forced while
this repo was **private** — ClawHub cannot register trusted publishing for a
private repo, its server-side GitHub repo lookup 404s — so OIDC had nothing to
authenticate against and the CLI fell through to the stored token. The repo is
public now, so that blocker is gone; the registration below has simply not been
done yet.

That stored token is a **`CLAWHUB_TOKEN` repo secret** (the raw token string, no
JSON). The `Provision ClawHub token` step writes it to a temp config file on the runner
(`{"registry":"https://clawhub.ai","token":"…"}`, mode `0600`) and points the
CLI at it via the `CLAWHUB_CONFIG_PATH` env var; the secret is passed through
step env and written by `node`, never interpolated into the shell script. The
`id-token: write` permission stays wired so the OIDC path lights up
automatically once trusted publishing is registered (see below).

Rotating the token: mint a fresh one locally with `clawhub token`, then
`gh secret set CLAWHUB_TOKEN` with the new value. No workflow change needed.

**Idempotency.** Before publishing, the job runs `clawhub package inspect
openclaw-webchannel --version <V> --json` and confirms the returned JSON
actually contains that version; if so it logs and skips (success). Anything else
(missing package/version, parse failure) falls through to publish. This
tolerates re-runs and versions published manually.

**Upgrading to OIDC.** The repo is public now, so this is unblocked:
register trusted publishing once — then OIDC takes over automatically and the
`CLAWHUB_TOKEN` secret can be deleted (no workflow change). An owner of the
`openclaw-webchannel` package runs:

```sh
clawhub package trusted-publisher set openclaw-webchannel \
  --repository mir-stream/openclaw-webchannel \
  --workflow-filename publish.yml
```

After trusted publishing is registered, **manual** (local) publishes of the
plugin require an explicit `--manual-override-reason "<why>"` flag; CI publishes
via OIDC need no such flag.

**CLI pinning.** The workflow pins `clawhub@0.23.1` so a registry-side CLI
release can't silently change the publish contract mid-release. Bump the pin in
`publish.yml` deliberately and re-verify the publish flow when you do.

## Consuming from another project

### Migrating an existing consumer

**Do this once the rename release is published — not before.** The unscoped
names already exist on npm, but so far only as the `0.0.0-bootstrap.0`
placeholder (see the top of this guide) — so "the name resolves" is *not* the
signal to migrate. Until the real release ships, stay on the scoped names, which
keep working. Confirm **both** names before you start — a release can stop
partway with one name on the new version and the other still on the placeholder
(see [Recovering a split `latest`](#recovering-a-split-latest)), which is exactly
the state that makes step 3 `ETARGET`:

```sh
for p in openclaw-webchannel-client openclaw-webchannel-saas; do
  v=$(npm view "$p" version --registry https://registry.npmjs.org) || exit 1
  case "$v" in 0.0.0-bootstrap.*) echo "STOP: $p is still the bootstrap placeholder ($v)." >&2; exit 1;; esac
  echo "$p: $v"
done
```

Once it *is* published, **every existing consumer must migrate**, whichever
release you are on: the packages were renamed, and the old
`@mir-stream/webchannel-*` names are unpublished shortly after. This is a *name*
change, so a plain `npm update` will not do it — nothing resolves the old name to
the new one.

(Operator note: npm's unconditional unpublish window is 72h, but it runs off
**two different clocks** and erasing the old names is governed by the earlier
one. A *version-only* unpublish is gated 72h from that version's publish —
`@mir-stream/webchannel-{client,saas}@0.6.1` went out 2026-08-22T03:17:03Z /
03:17:10Z, so that clock runs to about 2026-08-25T03:17Z. Removing the **whole
package** is gated 72h from the package's *first* publish, which for both scoped
names is the `0.0.0-bootstrap.0` placeholder that created them —
2026-08-22T01:38:56Z / 01:39:10Z, closing about **2026-08-25T01:39Z**. That
whole-package clock is the binding one, 98 minutes earlier than the version-only
one: unpublishing just `0.6.1` would leave `0.0.0-bootstrap.0` behind, so the
scoped names would still exist and still surface in npm search — the exact thing
the rename is meant to end. Do not re-derive this deadline from `0.6.1` alone.
After the window, unpublishing becomes conditional and the fallback is
`npm deprecate`, which leaves the old names installable but warns on install.)

Steps 1 and 2 apply only if you consumed a **pre-0.6.1** release and may still
force the `@mir-stream` scope through GitHub Packages; if you are already on
0.6.1 from public npm, start at step 3.

1. **Remove the old registry configuration first.** Delete the scope line and
   any matching token line wherever they exist — project `.npmrc`, user-level
   `~/.npmrc`, and CI-generated npm configuration:

   ```ini
   @mir-stream:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${TOKEN}
   ```

2. **Confirm the scope override is gone.**

   ```sh
   npm config get @mir-stream:registry
   ```

   It must no longer print `https://npm.pkg.github.com`.

3. **Add the new names, then remove the old ones — in that order.** Install
   first so a failed install leaves you on the working old packages rather than
   with neither. Removing them afterwards is not optional: installing the new
   names only *adds* them, and the old dependencies stay in `package.json` and
   the lockfile — where they still resolve, so you would ship two copies of the
   library and never notice.

   ```sh
   npm install --save-exact openclaw-webchannel-saas@<version> openclaw-webchannel-client@<version> \
     && npm uninstall @mir-stream/webchannel-saas @mir-stream/webchannel-client
   ```

   The `&&` is what makes the ordering an actual guarantee. `npm install a@X
   b@Y` aborts the whole ideal-tree build on a single `ETARGET`, so *neither*
   new package lands; pasted as two plain lines, the `npm uninstall` would still
   run and strip the working old packages, leaving you with neither.

   `<version>` is the rename release printed by the gate above — the same value
   the CHANGELOG and the release tag carry. Do not pin `0.6.1` here: that
   version exists only under the old scoped names, so it would `ETARGET`.

4. **Rewrite every import specifier in your source.** The package name changed,
   so every `import`/`require` still naming the old package will now fail to
   resolve. Find them first, then rewrite:

   ```sh
   grep -rn '@mir-stream/webchannel-' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .
   ```

   `@mir-stream/webchannel-saas` → `openclaw-webchannel-saas`, and
   `@mir-stream/webchannel-client` → `openclaw-webchannel-client`. The exported
   API is unchanged, so nothing but the specifier moves. Package names can also
   appear outside source files — `tsconfig.json` `compilerOptions.paths`, bundler
   aliases, and browser import maps — which is why the search above is not
   restricted by file extension.

5. **Verify the migration is complete.** This fails on any of the four ways it
   can be left half-done — a leftover GitHub Packages URL, a residual old-name
   dependency, a source file still importing the old name (step 4 skipped), or
   the new packages not actually installed. That last check is the one that
   catches a step-3 `ETARGET`: every other check here is negative, so all of
   them pass on a project with no WebChannel library installed at all.
   The lockfile checks are **npm-specific**; on yarn or pnpm keep the source
   check and apply the equivalent inspection to your own lockfile.

   ```sh
   if [ ! -r package-lock.json ]; then
     echo "ERROR: package-lock.json is missing or unreadable." >&2
     exit 1
   fi
   if grep -n 'npm\.pkg\.github\.com' package-lock.json; then
     echo "ERROR: package-lock.json still contains GitHub Packages URLs." >&2
     exit 1
   fi
   if grep -n '@mir-stream/webchannel-' package-lock.json; then
     echo "ERROR: package-lock.json still depends on the old package names." >&2
     exit 1
   fi
   if grep -rn '@mir-stream/webchannel-' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .; then
     echo "ERROR: source still imports the old package names (step 4)." >&2
     exit 1
   fi
   node -e 'const l=require("./package-lock.json"); for (const p of ["openclaw-webchannel-saas","openclaw-webchannel-client"]) { const e=l.packages?.[`node_modules/${p}`]; if (!e?.resolved?.startsWith("https://registry.npmjs.org/")) { console.error(`ERROR: ${p}: expected a registry.npmjs.org tarball, found ${e?.resolved ?? "<not installed — step 3 failed>"}`); process.exitCode=1; } else console.log(`${p}: ${e.resolved}`); }'
   ```

### Installing

Install them. That is the whole procedure — but wait for the rename release. A
bare install **succeeds today** and silently gives you the unattested
`0.0.0-bootstrap.0` placeholder, which npm also made `latest`; see the top of
this guide:

```sh
npm install openclaw-webchannel-saas openclaw-webchannel-client
```

**No `.npmrc`, no token, no registry configuration** — they are public packages
on the default registry, so a plain `npm install` works in a laptop, a CI job, a
Docker build, and a deploy host alike. Pin a version the usual way
(`openclaw-webchannel-saas@<version>`, taking `<version>` from the CHANGELOG or
the release tag) if you want reproducibility.

Releases published by CI carry an npm **provenance attestation** linking the
tarball to the workflow run and source commit that built it. Verify it with:

```sh
npm audit signatures
```

(The one-time bootstrap publishes described above are manual and therefore
unattested; every release from CI is attested.)

Both packages ship compiled JS + `.d.ts` (`dist/`), Node >= 22, ESM only
(`import` — no `require`).

## Local tarball escape hatch

To hand someone a build without any registry:

```sh
npm pack -w packages/saas -w packages/client
# → openclaw-webchannel-saas-<v>.tgz, openclaw-webchannel-client-<v>.tgz
npm install ./openclaw-webchannel-saas-<v>.tgz   # in the consuming project
```
