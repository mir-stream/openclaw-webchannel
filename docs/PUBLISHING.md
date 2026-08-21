# Publishing & Consuming the WebChannel Packages

Two packages are published to the **public npm registry**
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
public npm registry *and* to the **ClawHub** registry by the same `v*` tag. See
[Plugin publishing (ClawHub)](#plugin-publishing-clawhub) below.

## Cutting a release

One `v*` tag ships **all three** artifacts at a **single, identical version** —
`webchannel-client`, `webchannel-saas` and the `openclaw-webchannel` plugin (all
three to public npm; the plugin additionally to ClawHub). This 3-way lockstep is
enforced in CI (see below), so the plugin can never fall behind the npm packages
again.

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

The `Publish Packages` workflow (`.github/workflows/publish.yml`) runs three jobs:

- **`publish`** — builds, tests, and publishes `webchannel-client` and
  `webchannel-saas` to public npm via **OIDC trusted publishing** with
  `--provenance` (no `NPM_TOKEN`, no PAT — the job's `id-token: write` is the
  whole credential story). Also runnable manually from the Actions tab
  (workflow_dispatch), which ships only the two scoped packages.
- **`publish-plugin-npm`** — gated on `publish` succeeding; builds/tests the
  plugin and publishes it to public npm the same way. Tag *push* only.
- **`publish-plugin`** — gated on `publish` succeeding; builds/tests the plugin
  and publishes it to ClawHub (see next section). Skipped on ALL manual
  workflow_dispatch runs — including one started from a tag ref — since it
  requires a tag *push* (no tag to lockstep against otherwise).

Note: **all three legs are idempotent.** Each package (client, saas, plugin) is
skipped when that exact version is positively confirmed already on its registry
(the npm leg checks each package with `npm view`, the ClawHub leg with `package
inspect`) — so **"Re-run failed jobs"** is safe anywhere in the workflow,
including after a partial npm publish (e.g. client shipped but saas flaked), and
a full re-run of an already-shipped tag is a green no-op end-to-end. An
already-published version is **never republished** (it is skipped, not
overwritten): to ship new content you must **bump the version and cut a new
tag**.

## One-time bootstrap: trusted publishing for client + saas

**This is required exactly once, by hand, before the workflow can ever publish
these two packages.** npm attaches a Trusted Publisher to an *existing* package,
so a brand-new package name has a chicken-and-egg problem: OIDC cannot create
it, and the workflow's publish step is denied by npm until the trusted publisher
exists. `@mir-stream/webchannel-client` and `@mir-stream/webchannel-saas` are
brand-new names *on npmjs.org* (their history lives on GitHub Packages, which is
a different registry), so both halves below must be done for both packages. This
is the same procedure the `openclaw-webchannel` plugin already went through.

**(a) Publish once manually.** An **owner of the `@mir-stream` npm org**, from a
**clean checkout of the release commit** (the tarball you ship by hand is the
one people get — do not do this from a dirty tree):

```sh
git clone https://github.com/mir-stream/openclaw-webchannel.git
cd openclaw-webchannel
git checkout <release-commit-or-tag>
npm ci
npm run build -w packages/client -w packages/saas

npm login   # if not already authenticated against registry.npmjs.org
npm publish -w packages/client --access public --registry https://registry.npmjs.org
npm publish -w packages/saas   --access public --registry https://registry.npmjs.org
```

`--access public` is not optional in spirit: scoped packages default to
**restricted**, and a restricted publish silently recreates the auth problem
this whole move exists to delete. (Both manifests also carry
`publishConfig.access: "public"`; the flag is belt-and-braces.) These manual
publishes carry **no provenance attestation** — only the CI legs do.

**(b) Attach the Trusted Publisher.** On npmjs.com, for **each** of
`@mir-stream/webchannel-client` and `@mir-stream/webchannel-saas`:

> Package → Settings → Trusted Publisher → Add:
> - Publisher = **GitHub Actions**
> - Repository = **`mir-stream/openclaw-webchannel`**
> - Workflow = **`publish.yml`**
> - Environment = *(blank)*

From then on every tagged release publishes from CI with zero credentials, and
`npm publish` mints short-lived tokens from the workflow's id-token itself.

**Consequence for the bootstrap release.** The workflow's idempotency guard
skips any version already on the registry, so a tag pushed *after* a manual
bootstrap of that same version is a **green no-op for those two packages** —
that is the expected, correct outcome, not a failure. The plugin leg is
unaffected and publishes normally in the same run. The first version that
actually flows through OIDC for client/saas is therefore the **next** one.

## Plugin publishing (ClawHub)

The `publish-plugin` job publishes `openclaw-webchannel` (`packages/plugin`) to
the ClawHub registry as owner `mir-stream`, family `code-plugin`.

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
