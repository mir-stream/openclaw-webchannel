# Publishing & Consuming the WebChannel Packages

Two packages are published privately to **GitHub Packages** (npm registry at
`npm.pkg.github.com`, visibility follows this repo — private):

| Package | What it is |
|---|---|
| `@mir-stream/webchannel-saas` | Headless SaaS trust-chain core (device-flow enrollment, NATS creds/JWT minting) |
| `@mir-stream/webchannel-client` | Framework-agnostic, zero-dependency browser client |

A third artifact — the `openclaw-webchannel` **plugin** — is published to the
**ClawHub** registry (not GitHub Packages) by the same `v*` tag. See
[Plugin publishing (ClawHub)](#plugin-publishing-clawhub) below.

## Cutting a release

One `v*` tag ships **all three** artifacts at a **single, identical version** —
`webchannel-client`, `webchannel-saas` (GitHub Packages) and the
`openclaw-webchannel` plugin (ClawHub). This 3-way lockstep is enforced in CI
(see below), so the plugin can never fall behind the npm packages again.

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

The `Publish Packages` workflow (`.github/workflows/publish.yml`) runs two jobs:

- **`publish`** — builds, tests, and publishes both npm packages using the
  built-in `GITHUB_TOKEN` (no secrets). Also runnable manually from the Actions
  tab (workflow_dispatch), which ships only the npm packages.
- **`publish-plugin`** — gated on `publish` succeeding; builds/tests the plugin
  and publishes it to ClawHub (see next section). Skipped on ALL manual
  workflow_dispatch runs — including one started from a tag ref — since it
  requires a tag *push* (no tag to lockstep against otherwise).

Note: publishing the **same version twice fails** on GitHub Packages — always
bump the version before re-tagging. (The ClawHub leg is idempotent — it skips
an already-published version, so **"Re-run failed jobs"** on `publish-plugin`
is safe, as is a version that was already published manually. A full-workflow
re-run of a shipped tag still goes red on the npm duplicate before the plugin
leg is reached.)

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
that mint fails. **Right now the fallback is the active path.** This repo is
**private**, and ClawHub cannot register trusted publishing for a private repo —
its server-side GitHub repo lookup 404s — so OIDC has nothing to authenticate
against and the CLI falls through to the stored token.

That stored token is a **`CLAWHUB_TOKEN` repo secret** (the raw token string, no
JSON). The `Provision ClawHub token` step writes it to a temp config file on the runner
(`{"registry":"https://clawhub.ai","token":"…"}`, mode `0600`) and points the
CLI at it via the `CLAWHUB_CONFIG_PATH` env var; the secret is passed through
step env and written by `node`, never interpolated into the shell script. The
`id-token: write` permission stays wired so the OIDC path lights up
automatically once the repo is public (see below).

Rotating the token: mint a fresh one locally with `clawhub token`, then
`gh secret set CLAWHUB_TOKEN` with the new value. No workflow change needed.

**Idempotency.** Before publishing, the job runs `clawhub package inspect
openclaw-webchannel --version <V> --json` and confirms the returned JSON
actually contains that version; if so it logs and skips (success). Anything else
(missing package/version, parse failure) falls through to publish. This
tolerates re-runs and versions published manually.

**Upgrading to OIDC (when the repo becomes public).** Once this repo is public,
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

1. Create a GitHub **personal access token (classic)** with the
   `read:packages` scope: <https://github.com/settings/tokens>.
   (Fine-grained tokens do not support GitHub Packages npm reads yet.)

2. In the consuming project, add an `.npmrc`:

   ```ini
   @mir-stream:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
   ```

   Commit this `.npmrc` (it contains no secret — only the env-var reference)
   and export the token in your shell / CI secrets:

   ```sh
   export GITHUB_TOKEN=ghp_...
   ```

3. Install as usual:

   ```sh
   npm install @mir-stream/webchannel-saas @mir-stream/webchannel-client
   ```

Both packages ship compiled JS + `.d.ts` (`dist/`), Node >= 22, ESM only
(`import` — no `require`).

## Local tarball escape hatch

To hand someone a build without any registry:

```sh
npm pack -w packages/saas -w packages/client
# → mir-stream-webchannel-saas-<v>.tgz, mir-stream-webchannel-client-<v>.tgz
npm install ./mir-stream-webchannel-saas-<v>.tgz   # in the consuming project
```
