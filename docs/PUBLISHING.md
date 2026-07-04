# Publishing & Consuming the WebChannel Packages

Two packages are published privately to **GitHub Packages** (npm registry at
`npm.pkg.github.com`, visibility follows this repo — private):

| Package | What it is |
|---|---|
| `@mir-stream/webchannel-saas` | Headless SaaS trust-chain core (device-flow enrollment, NATS creds/JWT minting) |
| `@mir-stream/webchannel-client` | Framework-agnostic, zero-dependency browser client |

The `openclaw-webchannel` plugin package is **not** published here — it is
installed into the OpenClaw agent through the plugin channel instead.

## Cutting a release

1. Bump `version` in `packages/client/package.json` and
   `packages/saas/package.json` (kept in lockstep).
2. Commit, then tag and push:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

The `Publish Packages` workflow (`.github/workflows/publish.yml`) builds,
tests, and publishes both packages using the built-in `GITHUB_TOKEN` — no
secrets to configure. It can also be run manually from the Actions tab
(workflow_dispatch).

Note: publishing the **same version twice fails** — always bump the version
before re-tagging.

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
