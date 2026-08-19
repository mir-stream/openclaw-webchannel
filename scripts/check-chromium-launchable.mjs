#!/usr/bin/env node
// Precondition guard for the Chromium-driven live e2e.
//
// Replaces `playwright-core install-deps chromium` in CI. On the GitHub-hosted
// ubuntu image every shared library Chromium links is already present — that
// command spent ~130s doing an `apt-get update` (11.4 MB of package indexes) to
// discover 26 libs were "already the newest version", then installed 9 CJK/X
// font packages. Nothing here renders text: `e2e/local/all-real.mjs` drives a
// headless peer that asserts NATS frames and ids, never pixels or glyphs.
//
// So instead of provisioning, PROVE the thing the e2e actually needs: launch the
// same binary with the same flags and open a page. That is a stronger guarantee
// than an `ldd` scan (it exercises the sandbox flags and the renderer, not just
// the link table) and it fails here, by name, instead of mid-e2e.
//
// Mirrors the launch in `e2e/local/all-real.mjs`. If that call changes its
// resolution path or flags, change this one with it — a guard that boots a
// different browser than the suite proves nothing.
//
// If a future runner image really does drop a library, this exits non-zero with
// Playwright's own diagnostic, which names the missing packages. The fix then is
// to install exactly those, not to restore the blanket `install-deps`.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const { chromium } = require(
  `${ROOT}/node_modules/openclaw/node_modules/playwright-core`,
);

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--single-process",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  const page = await browser.newPage();
  // Render something, so a renderer that dies on startup cannot pass as a
  // successful launch of the browser process alone.
  await page.setContent("<title>chromium-launchable</title><p>ok</p>");
  const title = await page.title();
  if (title !== "chromium-launchable") {
    throw new Error(`renderer returned an unexpected title: ${title}`);
  }
  console.log("PASS: chromium launches and renders with the e2e launch flags.");
} catch (err) {
  console.error(
    "ERROR: chromium could not launch with the flags e2e/local/all-real.mjs uses.",
  );
  console.error(
    "If the cause is missing host packages, install exactly those in the gate —",
  );
  console.error(
    "do not restore the blanket `playwright-core install-deps chromium`.",
  );
  console.error(String(err?.stack ?? err));
  process.exitCode = 1;
} finally {
  await browser?.close();
}
