import { describe, expect, it } from "vitest";

import { PopRejectedError, PopServerError } from "./pop-register.js";

describe("register-hop recovery classification", () => {
  it("keeps authentication rejection terminal", () => {
    expect(new PopRejectedError("rejected")).toBeInstanceOf(PopRejectedError);
  });

  it("keeps register server errors terminal", () => {
    expect(new PopServerError(500)).toBeInstanceOf(PopServerError);
  });
});
