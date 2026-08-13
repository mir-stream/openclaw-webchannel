import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasExplicitSessionReasoningOptOut,
  type ReasoningOptOutStoreAccess,
} from "./reasoning-opt-out.js";

const SESSION_KEY = "agent:main:webchannel:default:direct:peer";
const temporaryDirectories: string[] = [];

function temporaryStorePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "webchannel-reasoning-opt-out-"));
  temporaryDirectories.push(directory);
  return join(directory, "sessions.json");
}

function productionInput(storePath: string, sessionKey = SESSION_KEY) {
  return {
    cfg: { session: { store: storePath } } as never,
    agentId: "main",
    sessionKey,
  };
}

function injectedStore(options?: {
  raw?: string;
  reasoningLevel?: string;
  readError?: unknown;
}): ReasoningOptOutStoreAccess {
  const raw = options?.raw ?? "{}";
  return {
    resolveStorePath: vi.fn(() => "/tmp/webchannel-reasoning-store.json"),
    readFile: vi.fn(() => {
      if (options?.readError !== undefined) throw options.readError;
      return raw;
    }),
    resolveSessionStoreEntry: vi.fn(() => ({
      normalizedKey: SESSION_KEY,
      existing:
        options?.reasoningLevel === undefined
          ? undefined
          : { reasoningLevel: options.reasoningLevel },
      legacyKeys: [],
    })),
  } as unknown as ReasoningOptOutStoreAccess;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("hasExplicitSessionReasoningOptOut", () => {
  it("reads a valid store and vetoes a persisted explicit off", () => {
    const storePath = temporaryStorePath();
    writeFileSync(storePath, JSON.stringify({ [SESSION_KEY]: { reasoningLevel: "off" } }));

    expect(hasExplicitSessionReasoningOptOut(productionInput(storePath))).toBe(true);
  });

  it("uses core entry resolution against the verified snapshot", () => {
    const storePath = temporaryStorePath();
    writeFileSync(storePath, JSON.stringify({ [SESSION_KEY]: { reasoningLevel: "off" } }));

    expect(hasExplicitSessionReasoningOptOut(productionInput(storePath, `  ${SESSION_KEY}  `))).toBe(
      true,
    );
  });

  it("does not veto when the valid store has no matching session", () => {
    const storePath = temporaryStorePath();
    writeFileSync(storePath, "{}");

    expect(hasExplicitSessionReasoningOptOut(productionInput(storePath))).toBe(false);
  });

  it.each(["on", "stream"])("does not veto the explicit level %s", (level) => {
    const storePath = temporaryStorePath();
    writeFileSync(storePath, JSON.stringify({ [SESSION_KEY]: { reasoningLevel: level } }));

    expect(hasExplicitSessionReasoningOptOut(productionInput(storePath))).toBe(false);
  });

  it("treats a missing store as an empty store", () => {
    const storePath = temporaryStorePath();

    expect(hasExplicitSessionReasoningOptOut(productionInput(storePath))).toBe(false);
  });

  it.each(["", "   \n", "{not-json"])(
    "fails closed for an empty or malformed store snapshot %#",
    (raw) => {
      const storePath = temporaryStorePath();
      writeFileSync(storePath, raw);

      expect(hasExplicitSessionReasoningOptOut(productionInput(storePath))).toBe(true);
    },
  );

  it.each([null, [], 0, "invalid", false])(
    "fails closed for invalid top-level store shape %#",
    (value) => {
      const storePath = temporaryStorePath();
      writeFileSync(storePath, JSON.stringify(value));

      expect(hasExplicitSessionReasoningOptOut(productionInput(storePath))).toBe(true);
    },
  );

  it.each([null, [], 0, "invalid", false])(
    "fails closed when a store entry has invalid shape %#",
    (value) => {
      const storePath = temporaryStorePath();
      writeFileSync(storePath, JSON.stringify({ [SESSION_KEY]: value }));

      expect(hasExplicitSessionReasoningOptOut(productionInput(storePath))).toBe(true);
    },
  );

  it("fails closed for a non-ENOENT read error", () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const store = injectedStore({ readError: error });

    expect(
      hasExplicitSessionReasoningOptOut({
        cfg: {} as never,
        agentId: "main",
        sessionKey: SESSION_KEY,
        store,
      }),
    ).toBe(true);
    expect(store.resolveSessionStoreEntry).not.toHaveBeenCalled();
  });

  it("passes the one parsed snapshot to core entry resolution", () => {
    const store = injectedStore({
      raw: JSON.stringify({ [SESSION_KEY]: { reasoningLevel: "off" } }),
      reasoningLevel: "off",
    });

    expect(
      hasExplicitSessionReasoningOptOut({
        cfg: {} as never,
        agentId: "main",
        sessionKey: SESSION_KEY,
        store,
      }),
    ).toBe(true);
    expect(store.readFile).toHaveBeenCalledTimes(1);
    expect(store.resolveSessionStoreEntry).toHaveBeenCalledWith({
      store: { [SESSION_KEY]: { reasoningLevel: "off" } },
      sessionKey: SESSION_KEY,
    });
  });

  it("does not read the store when there is no session key", () => {
    const store = injectedStore({ reasoningLevel: "off" });
    expect(
      hasExplicitSessionReasoningOptOut({
        cfg: {} as never,
        agentId: "main",
        sessionKey: "",
        store,
      }),
    ).toBe(false);
    expect(store.readFile).not.toHaveBeenCalled();
  });
});
