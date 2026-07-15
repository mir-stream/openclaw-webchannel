import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { openMessage, sealMessage } from "./e2e-crypto-browser.js";

describe("register-delivered conversation crypto", () => {
  it("seals and opens with the delivered conversation key", async () => {
    const key = randomBytes(32);
    const frame = sealMessage({ accountId: "a", tenant: "t", sub: "p" }, key, "hello");
    expect(openMessage(frame, key)).toBe("hello");
  });

  it("does not put plaintext on the wire", async () => {
    const frame = sealMessage(
      { accountId: "a", tenant: "t", sub: "p" },
      randomBytes(32),
      "secret-marker",
    );
    expect(JSON.stringify(frame)).not.toContain("secret-marker");
  });

  it("drops a frame opened with the wrong delivered key", async () => {
    const frame = sealMessage(
      { accountId: "a", tenant: "t", sub: "p" },
      randomBytes(32),
      "hello",
    );
    expect(openMessage(frame, randomBytes(32))).toBeNull();
  });
});
