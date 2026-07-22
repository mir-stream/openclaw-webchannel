import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/core";

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  channelConfigs: {
    webchannel: {
      schema: Parameters<typeof buildJsonChannelConfigSchema>[0];
    };
  };
};

describe("shipped WebChannel manifest schema", () => {
  const runtime = buildJsonChannelConfigSchema(
    manifest.channelConfigs.webchannel.schema,
  ).runtime!;

  it("accepts the channel lifecycle enabled flag", () => {
    expect(runtime.safeParse({ enabled: false })).toEqual({
      success: true,
      data: { enabled: false },
    });
  });

  it("retains strict unknown-key rejection", () => {
    expect(runtime.safeParse({ unknownLifecycleKey: true }).success).toBe(false);
  });
});
