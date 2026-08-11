import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SELF = "packages/saas/src/bootstrap-surface-inventory.test.ts";

type InventoryEntry = {
  count: number;
  classification: string;
};

/**
 * Explicit security review inventory. A new bootstrap endpoint/caller or direct
 * claim-builder/signer call must be classified here before this guard passes.
 * Counts also stop extra issuance sites from hiding inside an already-reviewed
 * file. bootstrapUrl metadata is intentionally inventoried as policy-free data.
 */
const EXPECTED: Record<string, InventoryEntry> = {
  "demo/chaos-nats.ts :: /bootstrap template": {
    count: 1, classification: "demo attack/replay harness consumer",
  },
  "demo/saas-server.ts :: /bootstrap literal": {
    count: 1, classification: "deployable session-authorized scalar route",
  },
  "demo/saas-server.ts :: /bootstrap template": {
    count: 1, classification: "enrollment bootstrapUrl metadata",
  },
  "demo/saas-server.ts :: buildBootstrapClaims call": {
    count: 1, classification: "deployable session-authorized scalar issuer",
  },
  "demo/verify-evict.mjs :: /bootstrap template": {
    count: 1, classification: "demo signing-key eviction harness consumer",
  },
  "demo/web/src/widget.ts :: /bootstrap literal": {
    count: 1, classification: "deployable demo single-lane consumer",
  },
  "e2e/local/enrolled-transport-roundtrip.ts :: /test/bootstrap-jwt template": {
    count: 1, classification: "explicitly gated local E2E harness consumer",
  },
  "e2e/local/turn-outcome-roundtrip.ts :: /test/bootstrap-jwt template": {
    count: 1, classification: "explicitly gated local E2E harness consumer",
  },
  "e2e/local/two-account-isolation-roundtrip.ts :: /test/bootstrap-jwt literal": {
    count: 2, classification: "explicitly gated same-key cross-account E2E harness consumer",
  },
  "examples/minimal-consumer/src/operator.ts :: buildBootstrapClaims call": {
    count: 1, classification: "policy-free low-level builder example; no route",
  },
  "examples/minimal-consumer/test/operator-handler.test.ts :: /bootstrap literal": {
    count: 1, classification: "negative test proving the context-free route is 404",
  },
  "examples/webchannel-app/server/index.ts :: /bootstrap literal": {
    count: 1, classification: "canonical deployable session-authorized fixed route",
  },
  "examples/webchannel-app/server/index.ts :: /bootstrap template": {
    count: 1, classification: "enrollment bootstrapUrl metadata",
  },
  "examples/webchannel-app/server/index.ts :: buildBootstrapClaims call": {
    count: 1, classification: "canonical deployable fixed-tuple issuer",
  },
  "examples/webchannel-app/server/index.ts :: createBootstrapIssuer call": {
    count: 1, classification: "canonical deployable signer construction",
  },
  "examples/webchannel-app/test/smoke.mjs :: /bootstrap template": {
    count: 3, classification: "canonical example smoke plus caller-target/tenant rejection consumers",
  },
  "examples/webchannel-app/web/app.ts :: /bootstrap literal": {
    count: 1, classification: "canonical deployable scalar browser consumer",
  },
  "packages/client/src/browser-demo-entry.ts :: /bootstrap template": {
    count: 1, classification: "session-authorized demo scalar consumer",
  },
  "packages/client/src/browser-jwt-entry.ts :: /bootstrap template": {
    count: 1, classification: "test-only fixed-tuple standalone consumer",
  },
  "packages/client/src/browser-jwt-entry.ts :: /test/bootstrap-jwt template": {
    count: 1, classification: "explicitly gated negative/E2E harness consumer",
  },
  "packages/saas/reference/bootstrap-server.ts :: /bootstrap literal": {
    count: 1, classification: "test-only fixed-tuple route",
  },
  "packages/saas/reference/bootstrap-server.ts :: /bootstrap template": {
    count: 1, classification: "test-only startup diagnostic",
  },
  "packages/saas/reference/bootstrap-server.ts :: buildBootstrapClaims call": {
    count: 1, classification: "test-only fixed-tuple issuer",
  },
  "packages/saas/reference/enrollment-server.ts :: /bootstrap literal": {
    count: 1, classification: "reference deployable session-authorized scalar route",
  },
  "packages/saas/reference/enrollment-server.ts :: /bootstrap template": {
    count: 2, classification: "reference enrollment metadata and session-route log",
  },
  "packages/saas/reference/enrollment-server.ts :: /test/bootstrap-jwt literal": {
    count: 1, classification: "demo-suppressed explicitly gated test route",
  },
  "packages/saas/reference/enrollment-server.ts :: buildBootstrapClaims call": {
    count: 2, classification: "session-authorized issuer plus gated test issuer",
  },
  "packages/saas/src/ac6-device-flow-e2e.test.ts :: /bootstrap template": {
    count: 5, classification: "standalone fixed-tuple integration fixtures",
  },
  "packages/saas/src/ac6-device-flow-e2e.test.ts :: /test/bootstrap-jwt template": {
    count: 2, classification: "explicitly gated reference-server fixtures including malformed peer rejection",
  },
  "packages/saas/src/bootstrap-claims.test.ts :: buildBootstrapClaims call": {
    count: 16, classification: "isolated primitive claim-builder unit tests",
  },
  "packages/saas/src/bootstrap-issuer.test.ts :: buildBootstrapClaims call": {
    count: 2, classification: "isolated signer unit-test claims",
  },
  "packages/saas/src/bootstrap-issuer.test.ts :: createBootstrapIssuer call": {
    count: 2, classification: "isolated signer unit tests",
  },
  "packages/saas/src/demo-server-role.test.ts :: /bootstrap template": {
    count: 1, classification: "deployable demo session/tuple/pin route contract",
  },
  "packages/saas/src/demo-ui-smoke.test.ts :: /bootstrap template": {
    count: 1, classification: "reference demo session/tuple/pin route contract",
  },
  "packages/saas/src/p1-1-http-ui-contract.test.ts :: /bootstrap literal": {
    count: 1, classification: "negative test proving shared-handler route is 404",
  },
};

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    if (name === ".git" || name === "node_modules" || name === "dist") continue;
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if ((path.endsWith(".ts") || path.endsWith(".mjs")) && relative(REPO_ROOT, path) !== SELF) {
      files.push(path);
    }
  }
  return files;
}

function inventory(): Record<string, number> {
  const found = new Map<string, number>();
  const record = (file: string, kind: string): void => {
    const key = `${relative(REPO_ROOT, file)} :: ${kind}`;
    found.set(key, (found.get(key) ?? 0) + 1);
  };

  for (const file of sourceFiles(REPO_ROOT)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const called = node.expression.getText(source);
        if (called === "buildBootstrapClaims" || called.endsWith(".buildBootstrapClaims")) {
          record(file, "buildBootstrapClaims call");
        }
        if (called === "createBootstrapIssuer" || called.endsWith(".createBootstrapIssuer")) {
          record(file, "createBootstrapIssuer call");
        }
      }
      if (ts.isStringLiteralLike(node)) {
        if (node.text === "/bootstrap") record(file, "/bootstrap literal");
        if (node.text === "/test/bootstrap-jwt") record(file, "/test/bootstrap-jwt literal");
      } else if (
        node.kind === ts.SyntaxKind.TemplateHead ||
        node.kind === ts.SyntaxKind.TemplateMiddle ||
        node.kind === ts.SyntaxKind.TemplateTail
      ) {
        const text = node.getText(source);
        if (text.includes("/test/bootstrap-jwt")) record(file, "/test/bootstrap-jwt template");
        else if (text.includes("/bootstrap")) record(file, "/bootstrap template");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return Object.fromEntries([...found.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

describe("first-party bootstrap issuance/caller inventory", () => {
  it("contains only explicitly classified security-relevant occurrences", () => {
    expect(inventory()).toEqual(
      Object.fromEntries(Object.entries(EXPECTED).map(([key, value]) => [key, value.count])),
    );
    expect(Object.values(EXPECTED).every((entry) => entry.classification.length > 0)).toBe(true);
  });
});
