/**
 * Public entry-surface contract test (#160).
 *
 * The client package has `index-exports.test.ts` because it IS a library: it
 * has `main`/`exports` and consumers import names from it. This package has
 * neither. Nobody imports it as a JS module — OpenClaw loads it through three
 * declared artifacts, and those are the whole public contract:
 *
 *   package.json  openclaw.extensions → dist/index-nats.js   (full runtime)
 *   package.json  openclaw.setupEntry → dist/setup-entry.js  (setup-only)
 *   openclaw.plugin.json                                     (manifest)
 *
 * `index-nats.ts` is a one-line re-export whose text `index-nats-wiring.test.ts`
 * already pins, so the shapes that can actually break a host are the two entry
 * OBJECTS behind it, plus the channel id.
 *
 * The channel id is the load-bearing string here. `channels.webchannel.*` is
 * what every deployer's config file says, and today the literal is written out
 * in five places across three files with nothing comparing them. Renaming the
 * channel — or drifting one copy — silently invalidates other people's configs
 * after publication. Every copy is asserted against the single `WEBCHANNEL_ID`
 * constant below.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import entry from "./nats-account-runtime.js";
import setupEntry from "../setup-entry.js";
import { WEBCHANNEL_ID } from "./channel-contract.js";

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"),
  ) as Record<string, unknown>;
}

const MANIFEST = readJson("../openclaw.plugin.json");
const PACKAGE = readJson("../package.json");

describe("full entry object (openclaw.extensions → dist/index-nats.js)", () => {
  it("keeps every member the host reads off a defined channel entry", () => {
    // Dropping or renaming any of these is breaking for the gateway, and after
    // publication it breaks for gateway versions we no longer control.
    expect(typeof entry.id).toBe("string");
    expect(typeof entry.name).toBe("string");
    expect(typeof entry.description).toBe("string");
    expect(typeof entry.register).toBe("function");
    expect(entry.configSchema).toBeDefined();
    expect(entry.channelPlugin).toBeDefined();
  });

  it("declares the channel id, not a second spelling of it", () => {
    expect(entry.id).toBe(WEBCHANNEL_ID);
    expect(entry.channelPlugin.id).toBe(WEBCHANNEL_ID);
  });
});

describe("setup entry object (openclaw.setupEntry → dist/setup-entry.js)", () => {
  it("exposes the setup-only plugin under the same channel id", () => {
    expect(setupEntry.plugin).toBeDefined();
    expect(setupEntry.plugin.id).toBe(WEBCHANNEL_ID);
  });
});

describe("channel id agreement across the published artifacts", () => {
  it("package.json openclaw.channel.id matches the code constant", () => {
    const openclaw = PACKAGE.openclaw as {
      channel?: { id?: unknown; blurb?: unknown };
    };
    expect(openclaw.channel?.id).toBe(WEBCHANNEL_ID);
    // #170: the package.json openclaw.channel block is a live pre-load catalog
    // presentation source (read by core's channel-catalog registry), SEPARATE
    // from the runtime plugin.meta. Its blurb must stay the owner-approved
    // canonical copy so the catalog surface and plugin.meta agree — a drift here
    // ships two different blurbs for the same channel.
    expect(openclaw.channel?.blurb).toBe(
      "Self-hosted, end-to-end encrypted browser chat over NATS.",
    );
  });

  it("openclaw.plugin.json declares exactly this one channel", () => {
    expect(MANIFEST.id).toBe(WEBCHANNEL_ID);
    expect(MANIFEST.channels).toEqual([WEBCHANNEL_ID]);
    expect((MANIFEST.packageChannel as { id?: unknown }).id).toBe(
      WEBCHANNEL_ID,
    );
  });

  it("the manifest's channelConfigs key is the config path deployers write", () => {
    // `channelConfigs.<id>` is what becomes `channels.<id>` in a deployer's
    // config, and `readWebchannelSection` reads that exact key back.
    expect(Object.keys(MANIFEST.channelConfigs as object)).toEqual([
      WEBCHANNEL_ID,
    ]);
  });
});
