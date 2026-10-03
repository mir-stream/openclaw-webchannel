import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// The pinned SDK does not export config snapshot redaction. Locate the exact
// production exports by source provenance, as in core-outbound-internals.ts;
// a pin change that removes either export fails the test instead of skipping.
async function coreExport(name: string, region: string): Promise<(...args: any[]) => any> {
  const dist = dirname(dirname(createRequire(import.meta.url).resolve("openclaw/plugin-sdk/routing")));
  for (const file of readdirSync(dist)) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(join(dist, file), "utf8");
    if (!source.includes(`//#region ${region}\n`)) continue;
    const exports = /^export \{([^}]*)\};?$/m.exec(source)?.[1] ?? "";
    for (const entry of exports.split(",")) {
      const [local, alias] = entry.trim().split(/\s+as\s+/);
      if (local === name) return (await import(pathToFileURL(join(dist, file)).href))[alias ?? local];
    }
  }
  throw new Error(`pinned core export missing: ${name}`);
}
const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")).channelConfigs.webchannel;
const build = await coreExport("buildConfigSchema", "src/config/schema.ts");
const redact = await coreExport("redactConfigObject", "src/config/redact-snapshot.ts");
const snapshot = await coreExport("redactConfigSnapshot", "src/config/redact-snapshot.ts");
const hints = build({ channels: [{ id: "webchannel", configSchema: manifest.schema, configUiHints: manifest.uiHints }], cache: false }).uiHints;
const credentials = (label: string) => ({ userJwt: `fixture-${label}-jwt`, userSeed: `fixture-${label}-seed`, mode: "static", credsFile: "/fixture/creds" });
const config = { channels: { webchannel: { nats: { credentials: credentials("base") }, accounts: {
  first: { nats: { credentials: credentials("first") } },
  second: { nats: { credentials: credentials("second") } },
} } } };

it("D7 marks flat and named-account credentials sensitive in the core schema", () => {
  for (const prefix of ["channels.webchannel", "channels.webchannel.accounts.*"]) {
    for (const field of ["userJwt", "userSeed"]) expect(hints[`${prefix}.nats.credentials.${field}`]?.sensitive).toBe(true);
  }
});
it("D7 masks inline credentials in core config responses without modifying usable config", () => {
  const redacted = redact(config, hints);
  for (const label of ["base", "first", "second"]) {
    expect(JSON.stringify(redacted)).not.toContain(`fixture-${label}-jwt`);
    expect(JSON.stringify(redacted)).not.toContain(`fixture-${label}-seed`);
  }
  expect(redacted.channels.webchannel.nats.credentials.mode).toBe("static");
  expect(redacted.channels.webchannel.nats.credentials.credsFile).toBe("/fixture/creds");
  expect(config.channels.webchannel.nats.credentials.userSeed).toBe("fixture-base-seed");
});
it("D7 masks raw and parsed config snapshot surfaces", () => {
  const redacted = snapshot({ valid: true, config, parsed: config, resolved: config, sourceConfig: config, runtimeConfig: config, raw: JSON.stringify(config) }, hints);
  for (const label of ["base", "first", "second"]) {
    expect(JSON.stringify(redacted)).not.toContain(`fixture-${label}-jwt`);
    expect(JSON.stringify(redacted)).not.toContain(`fixture-${label}-seed`);
  }
});
