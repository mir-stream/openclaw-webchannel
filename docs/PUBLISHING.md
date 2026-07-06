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
2. Commit, then tag and push:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

The `Publish Packages` workflow (`.github/workflows/publish.yml`) runs two jobs:

- **`publish`** — builds, tests, and publishes both npm packages using the
  built-in `GITHUB_TOKEN` (no secrets). Also runnable manually from the Actions
  tab (workflow_dispatch), which ships only the npm packages.
- **`publish-plugin`** — gated on `publish` succeeding; builds/tests the plugin
  and publishes it to ClawHub (see next section). Skipped on manual
  workflow_dispatch runs (no tag to lockstep against).

Note: publishing the **same version twice fails** on GitHub Packages — always
bump the version before re-tagging. (The ClawHub leg is idempotent — it skips
an already-published version, so **"Re-run failed jobs"** on `publish-plugin`
is safe, as is a version that was already published manually. A full-workflow
re-run of a shipped tag still goes red on the npm duplicate before the plugin
leg is reached.)

## Plugin publishing (ClawHub)

The `publish-plugin` job publishes `openclaw-webchannel` (`packages/plugin`) to
the ClawHub registry as owner `mir-stream`, family `code-plugin`.

**3-way version lockstep.** Before publishing, the job hard-fails unless the tag
version equals the plugin, client, and saas `package.json` versions. A mismatch
aborts the release with a clear error — bump all three to match the tag.

**Authentication — GitHub Actions OIDC trusted publishing (no stored token).**
The pinned `clawhub` CLI auto-detects the Actions OIDC environment, requests a
GitHub OIDC token (audience `clawhub`), and exchanges it for a short-lived
ClawHub publish token. The job therefore only needs `id-token: write`
permission — there is **no `CLAWHUB_TOKEN` secret** to manage or rotate. If OIDC
is unavailable the CLI falls back to a stored login token (used only for local
manual publishes).

**Idempotency.** The job runs `clawhub package inspect openclaw-webchannel
--version <V> --json` first; if that version already exists it logs and skips
the publish (success). This tolerates re-runs and versions published manually.

**One-time setup (registry side).** Trusted publishing must be registered once
so ClawHub trusts this repo's workflow. An owner of the `openclaw-webchannel`
package runs:

```sh
clawhub package trusted-publisher set openclaw-webchannel \
  --repository mir-stream/openclaw-webchannel \
  --workflow-filename publish.yml
```

After this is set, **manual** (local) publishes of the plugin require an
explicit `--manual-override-reason "<why>"` flag; CI publishes via OIDC need no
such flag.

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
