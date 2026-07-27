import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const serverPath = join(here, "..", "reference", "bootstrap-server.ts");
const tsxBin = [
  join(here, "..", "node_modules", ".bin", "tsx"),
  join(repoRoot, "node_modules", ".bin", "tsx"),
].find(existsSync) ?? "tsx";

function start(overrides: Record<string, string | undefined>): ChildProcessWithoutNullStreams {
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const key of ["ENABLE_TEST_ROUTES", "REFERENCE_TENANT", "REFERENCE_ACCOUNT_ID"]) {
    delete env[key];
  }
  Object.assign(env, overrides, { PORT: "0" });
  return spawn(tsxBin, [serverPath], {
    cwd: dirname(serverPath),
    env: env as NodeJS.ProcessEnv,
    stdio: "pipe",
  });
}

async function exited(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; output: string }> {
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`bootstrap subprocess did not exit\n${output}`));
    }, 15_000);
    child.once("error", reject);
    child.once("exit", (value) => { clearTimeout(timer); resolve(value); });
  });
  return { code, output };
}

async function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
): Promise<string> {
  let output = "";
  return new Promise<string>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(expected)) {
        cleanup();
        resolve(output);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`bootstrap subprocess exited early (${code})\n${output}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`bootstrap subprocess emitted no startup warning\n${output}`));
    }, 30_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

describe("standalone bootstrap-server unsafe-test startup gate", () => {
  it("refuses to start without the explicit ENABLE_TEST_ROUTES gate", async () => {
    const result = await exited(start({
      REFERENCE_TENANT: "reference-tenant",
      REFERENCE_ACCOUNT_ID: "reference-account",
    }));
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("set ENABLE_TEST_ROUTES=1 explicitly");
  });

  it.each([
    [{ REFERENCE_ACCOUNT_ID: "reference-account" }, "REFERENCE_TENANT"],
    [{ REFERENCE_TENANT: "reference-tenant" }, "REFERENCE_ACCOUNT_ID"],
    [{ REFERENCE_TENANT: "bad.tenant", REFERENCE_ACCOUNT_ID: "reference-account" }, "REFERENCE_TENANT"],
    [{ REFERENCE_TENANT: "reference-tenant", REFERENCE_ACCOUNT_ID: "bad.account" }, "REFERENCE_ACCOUNT_ID"],
  ] as const)("rejects an incomplete or invalid fixed tuple: %s", async (tuple, field) => {
    const result = await exited(start({ ENABLE_TEST_ROUTES: "1", ...tuple }));
    expect(result.code).not.toBe(0);
    expect(result.output).toContain(field);
  });

  it("starts with a valid fixed tuple and emits a prominent unsafe-test warning", async () => {
    const child = start({
      ENABLE_TEST_ROUTES: "1",
      REFERENCE_TENANT: "reference-tenant",
      REFERENCE_ACCOUNT_ID: "reference-account",
    });
    try {
      const output = await waitForOutput(child, "UNSAFE TEST-ONLY unauthenticated issuer");
      expect(output).toContain("UNSAFE TEST-ONLY");
      expect(output).toContain("never expose as SaaS");
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGINT");
    }
  }, 35_000);
});
