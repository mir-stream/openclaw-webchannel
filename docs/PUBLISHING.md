# Publishing & Consuming the WebChannel Packages

As of **0.6.1**, two packages publish to the **public npm registry**
(`registry.npmjs.org`), MIT-licensed, installable by anyone with no
authentication at all:

| Package | What it is |
|---|---|
| `@mir-stream/webchannel-saas` | Headless SaaS trust-chain core (device-flow enrollment, NATS creds/JWT minting) |
| `@mir-stream/webchannel-client` | Framework-agnostic, zero-dependency browser client |

They lived on **GitHub Packages** until 0.6.1. That registry requires an
authenticated `read:packages` token for *every* consumer read — even of a public
package — so every downstream project, CI job, Docker build and deploy host
needed a credential just to `npm install`, which is why real consumers vendored
these packages instead. The repo is public and the packages are MIT, so as of
0.6.1 they publish to npmjs.org like the plugin already did: OIDC trusted
publishing, no long-lived token, with provenance attestation.

A third artifact — the `openclaw-webchannel` **plugin** — is published to the
public npm registry by the same `v*` tag. It has a ClawHub leg too, but that leg
is **disabled by default** and ships nothing unless the `PUBLISH_CLAWHUB`
repository variable is set to `"true"` — see
[Plugin publishing (ClawHub)](#plugin-publishing-clawhub) below.

## Cutting a release

One `v*` tag ships **all three** artifacts at a **single, identical version** —
`webchannel-client`, `webchannel-saas` and the `openclaw-webchannel` plugin, all
three to public npm (the plugin additionally to ClawHub *if* that leg is enabled,
which by default it is not). This 3-way lockstep is enforced in CI (see below),
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

- **`publish`** — builds, tests, and publishes `webchannel-client` and
  `webchannel-saas` to public npm via **OIDC trusted publishing** with
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

That form is correct for every **unscoped** name, which today means
`openclaw-webchannel` and, after the #226 rename, `openclaw-webchannel-client`
and `openclaw-webchannel-saas`.

**If the name is scoped** (`@scope/...`, i.e. the `@mir-stream/webchannel-*`
packages up to and including 0.6.x), that command silently targets the wrong
registry: the legacy `.npmrc` line documented later in this guide maps
`@mir-stream` to GitHub Packages, and a plain `--registry` does **not** override
an `@scope:registry` mapping. Override the scope instead:

```sh
npm dist-tag add @mir-stream/<package>@<version> latest \
  --@mir-stream:registry=https://registry.npmjs.org/
```

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
`@mir-stream/webchannel-client` and `@mir-stream/webchannel-saas` are brand-new
names *on npmjs.org* — their history is on GitHub Packages, a different registry
— so all four steps below must be done for both packages.

The chicken-and-egg is per package **name**, not per scope, so the existing
unscoped plugin registration does not configure either new scoped name. The
`@mir-stream` scope and scoped OIDC trusted publishing with provenance for this
org are already proven by `@mir-stream/openclaw-prompt-compat@0.3.0`, whose
registry metadata includes a SLSA v1 provenance attestation and a `gitHead`.
That package comes from a different repository, so it proves only that the
registry/scope path works; it does not configure this repo's workflow for client
or saas, and both names still require the bootstrap below.

**Do not bootstrap at the release version.** Publishing `0.6.1` by hand would
ship it **unattested**, and the workflow's idempotency guard would reject that
unknown tarball and fail the real tag. The version would already be occupied, so
CI could not replace it with the attested build the release promises. Bootstrap
with a throwaway `0.0.0-bootstrap.0` instead, so the **real** release is the first
thing CI publishes and it carries provenance.

**Prerequisite.** The `@mir-stream` org exists on registry.npmjs.org. Before
starting, confirm you are a member of it with publish rights — step (a) fails
with a `403` otherwise, and nothing about the rest is self-diagnosing:

```sh
npm whoami --registry https://registry.npmjs.org
npm org ls mir-stream
```

**(a) Publish a `0.0.0-bootstrap.0` placeholder for each package.** The point is
only to make the *name* exist so npm will accept a trusted-publisher configuration
on it. Work in a **throwaway clone** — the version edit below must never be
committed or tagged, and the repo's own `package.json` files stay at `0.6.1`:

```sh
git clone https://github.com/mir-stream/openclaw-webchannel.git /tmp/wc-bootstrap
cd /tmp/wc-bootstrap
npm ci
npm login   # if not already authenticated against registry.npmjs.org

# Rewrite the two manifests IN THIS THROWAWAY CLONE ONLY.
# --no-git-tag-version stops npm from committing or tagging the change.
npm version 0.0.0-bootstrap.0 --no-git-tag-version -w packages/client
npm version 0.0.0-bootstrap.0 --no-git-tag-version -w packages/saas

npm publish -w packages/client --access public --tag bootstrap --registry https://registry.npmjs.org
npm publish -w packages/saas   --access public --tag bootstrap --registry https://registry.npmjs.org

cd / && rm -rf /tmp/wc-bootstrap   # the clone has served its purpose
```

There is deliberately no build step: both manifests declare `"prepack": "npm run
build"`, so `npm publish` rebuilds `dist/` itself. An explicit build line would
be one more thing to forget, and forgetting it would ship a stale tarball.

Two flags carry the weight here:

- **`--access public`** — scoped packages default to **restricted**, and a
  restricted publish silently recreates the auth problem this whole move exists
  to delete. (Both manifests also carry `publishConfig.access: "public"`; the
  flag is belt-and-braces.)
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
`@mir-stream/webchannel-client` and `@mir-stream/webchannel-saas`:

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
the release is `0.6.1`, the idempotency guard finds no match and **`0.6.1`
publishes through OIDC with provenance**, exactly as the changelog and the
section below claim. On a re-run, the guard skips it only after verifying that
provenance and the published `gitHead` against the run's commit.

After the release publishes, verify that `latest` moved for **both** packages:

```sh
curl -s https://registry.npmjs.org/-/package/@mir-stream%2fwebchannel-client/dist-tags
curl -s https://registry.npmjs.org/-/package/@mir-stream%2fwebchannel-saas/dist-tags
```

Each response must report `latest` equal to the release version, not
`0.0.0-bootstrap.0`.

**Until the bootstrap lands, releases are blocked.** Every `v*` tag fails at the
`publish` job, and both plugin legs `needs: publish`, so they are skipped — which
means even a **plugin-only hotfix cannot ship** until client and saas are
squared away on the registry.

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

Projects that consumed a pre-0.6.1 release may still force the entire
`@mir-stream` scope through GitHub Packages.

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

3. **Upgrade explicitly and refresh the lockfile.** This replaces an old
   dependency spec instead of letting Arborist preserve it:

   ```sh
   npm install --save-exact @mir-stream/webchannel-saas@0.6.1 @mir-stream/webchannel-client@0.6.1
   ```

4. **Verify no GitHub Packages URL remains.**

   ```sh
   if [ ! -r package-lock.json ]; then
     echo "ERROR: package-lock.json is missing or unreadable." >&2
     exit 1
   fi
   if grep -n 'npm\.pkg\.github\.com' package-lock.json; then
     echo "ERROR: package-lock.json still contains GitHub Packages URLs." >&2
     exit 1
   fi
   ```

### Installing

Install them. That is the whole procedure:

```sh
npm install @mir-stream/webchannel-saas @mir-stream/webchannel-client
```

**No `.npmrc`, no token, no registry configuration** — they are public packages
on the default registry, so a plain `npm install` works in a laptop, a CI job, a
Docker build, and a deploy host alike. Pin a version the usual way
(`@mir-stream/webchannel-saas@0.6.1`) if you want reproducibility.

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
# → mir-stream-webchannel-saas-<v>.tgz, mir-stream-webchannel-client-<v>.tgz
npm install ./mir-stream-webchannel-saas-<v>.tgz   # in the consuming project
```
