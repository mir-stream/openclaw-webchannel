import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RuntimeSkipAuditError,
  auditRuntimeSkips,
  countCtxSkipCallsites,
  validateAllowances,
} from "./check-runtime-skips.mjs";
import { exampleCoverageFailure } from "./example-test-guard-core.mjs";

const REPO = resolve(import.meta.dirname, "..");

function assertion(status) {
  return { status, title: `${status} fixture`, ancestorTitles: [] };
}

function report(file, statuses) {
  return {
    testResults: [
      {
        name: resolve(REPO, file),
        assertionResults: statuses.map(assertion),
      },
    ],
  };
}

describe("runtime skip budget (#136)", () => {
  it("I136-R1: gives every unlisted file a zero runtime-skip allowance", () => {
    expect(() => auditRuntimeSkips(report("demo/example.test.ts", ["passed", "skipped"]), {
      "demo/example.test.ts": 2,
    }, {})).toThrowError(/demo\/example\.test\.ts: 1 runtime-skipped, allowance 0/);
  });

  it("I136-R2: permits only the committed width in an allowed file", () => {
    const rows = auditRuntimeSkips(
      report("packages/example.test.ts", ["passed", "skipped", "skipped"]),
      { "packages/example.test.ts": 3 },
      { "packages/example.test.ts": { maxRuntimeSkips: 2 } },
    );
    expect(rows).toEqual([
      {
        file: "packages/example.test.ts",
        collected: 3,
        completed: 1,
        runtimeSkipped: 2,
        allowed: 2,
      },
    ]);
  });

  it("I136-R3: does not misclassify statically skipped report entries", () => {
    const rows = auditRuntimeSkips(
      report("packages/static.test.ts", ["passed", "passed", ...Array(7).fill("skipped")]),
      { "packages/static.test.ts": 2 },
      {},
    );
    expect(rows[0]?.runtimeSkipped).toBe(0);
  });

  it("I136-R4: makes a removed or added ctx.skip callsite invalidate its allowance", () => {
    const snapshot = {
      note: "fixture",
      files: {
        "packages/example.test.ts": {
          maxRuntimeSkips: 2,
          ctxSkipCallsites: 1,
          reason: "fixture",
        },
      },
    };
    const inventory = { "packages/example.test.ts": 2 };

    expect(() => validateAllowances(snapshot, inventory, () => "const clean = true;"))
      .toThrowError(RuntimeSkipAuditError);
    expect(() => validateAllowances(snapshot, inventory, () => "// ctx.skip();\nconst text = 'ctx.skip()';"))
      .toThrowError(/1 committed ctx\.skip callsite\(s\), 0 live/);
    expect(() => validateAllowances(snapshot, inventory, () => "ctx.skip();\nctx.skip();"))
      .toThrowError(/1 committed ctx\.skip callsite\(s\), 2 live/);
    expect(countCtxSkipCallsites("(ctx as unknown as { skip(): void }).skip();"))
      .toBe(1);
  });
});

describe("examples coverage floor (#132)", () => {
  it("I132-EG1: requires both a registered test and an executed assertion", () => {
    expect(exampleCoverageFailure(0, 0)).toBe("registered 0 tests");
    expect(exampleCoverageFailure(1, 0)).toBe("executed 0 assertions");
    expect(exampleCoverageFailure(1, 1)).toBeNull();
  });
});
