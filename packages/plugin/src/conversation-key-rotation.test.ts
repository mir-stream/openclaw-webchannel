import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConversationKeyGenerationCapacityError,
  ConversationKeyStore,
  type ConversationKeyStoreOptions,
} from "./conversation-key-store.js";
import {
  parseConversationKeyGenerationsDocument,
  serializeConversationKeyGenerationsDocument,
  type ConversationKeyGeneration,
} from "./conversation-key-generations-document.js";
import { openEnvelope, sealEnvelope } from "./e2e-session.js";
import { tupleStoragePaths } from "./storage-paths.js";

const TENANT = "tenant-A";
const ACCOUNT = "acct-a";
const PEER = "peer-a";
const ROUTING = { tenant: TENANT, accountId: ACCOUNT, sub: PEER };

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "webchannel-key-rotation-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function createStore(
  options: Partial<ConversationKeyStoreOptions> = {},
): ConversationKeyStore {
  return new ConversationKeyStore({
    tenant: TENANT,
    accountId: ACCOUNT,
    home,
    _nowSec: () => 1_700_000_000,
    ...options,
  });
}

function paths() {
  return tupleStoragePaths({ tenant: TENANT, accountId: ACCOUNT, home });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function durableKey(peerId = PEER): Uint8Array {
  const document = JSON.parse(
    readFileSync(paths().conversationKeyPath, "utf8"),
  ) as { keys: Record<string, string> };
  return new Uint8Array(Buffer.from(document.keys[peerId], "base64url"));
}

function durableGenerations(): Map<string, ConversationKeyGeneration> {
  return parseConversationKeyGenerationsDocument(
    paths().scope,
    readFileSync(paths().conversationKeyGenerationsPath, "utf8"),
  );
}

function writeGenerations(
  generations: ReadonlyMap<string, ConversationKeyGeneration>,
): void {
  mkdirSync(paths().directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    paths().conversationKeyGenerationsPath,
    serializeConversationKeyGenerationsDocument(paths().scope, generations),
    { mode: 0o600 },
  );
}

function seedPeer(): { key: Uint8Array; keyBytes: Buffer; generationBytes: Buffer } {
  const store = createStore();
  const key = store.getOrCreate(PEER);
  return {
    key,
    keyBytes: readFileSync(paths().conversationKeyPath),
    generationBytes: readFileSync(paths().conversationKeyGenerationsPath),
  };
}

function expectOnlyOldKey(
  store: ConversationKeyStore,
  oldKey: Uint8Array,
  oldKeyBytes: Buffer,
): void {
  expect(readFileSync(paths().conversationKeyPath).equals(oldKeyBytes)).toBe(true);
  expect(sameBytes(durableKey(), oldKey)).toBe(true);
  expect(sameBytes(store.get(PEER)!, oldKey)).toBe(true);
}

describe("conversation-key generation sidecar", () => {
  it("writes an owner-only v1 identity-bound initial generation in unix seconds", () => {
    const store = createStore({ _nowSec: () => 1_800_000_123 });
    store.getOrCreate("__proto__");

    expect(statSync(paths().conversationKeyGenerationsPath).mode & 0o777).toBe(
      0o600,
    );
    expect(durableGenerations().get("__proto__")).toEqual({
      epoch: 1,
      rotatedAtSec: 1_800_000_123,
    });
    const raw = JSON.parse(
      readFileSync(paths().conversationKeyGenerationsPath, "utf8"),
    ) as Record<string, unknown>;
    expect(raw).toMatchObject({
      version: 1,
      storageIdentity: { storage: { tenant: TENANT, accountId: ACCOUNT } },
    });
    expect(
      Object.prototype.hasOwnProperty.call(
        (raw.generations as Record<string, unknown>),
        "__proto__",
      ),
    ).toBe(true);
  });

  it.each([
    { epoch: 0, rotatedAtSec: 1 },
    { epoch: -1, rotatedAtSec: 1 },
    { epoch: 1.5, rotatedAtSec: 1 },
    { epoch: 1, rotatedAtSec: 0 },
    { epoch: 1, rotatedAtSec: 1.5 },
  ])("rejects malformed generation values %#", (generation) => {
    const serialized = JSON.stringify({
      version: 1,
      storageIdentity: {
        identityVersion: 2,
        storage: { tenant: TENANT, accountId: ACCOUNT },
      },
      generations: { [PEER]: generation },
    });
    expect(() =>
      parseConversationKeyGenerationsDocument(paths().scope, serialized),
    ).toThrow(expect.objectContaining({
      document: "conversation-key-generations",
      code: "invalid-document",
    }));
  });

  it("rejects a sidecar bound to a different tuple identity", () => {
    const foreignScope = {
      tenant: "tenant-B",
      accountId: ACCOUNT,
    };
    const serialized = serializeConversationKeyGenerationsDocument(
      foreignScope,
      new Map([[PEER, { epoch: 1, rotatedAtSec: 1 }]]),
    );
    expect(() =>
      parseConversationKeyGenerationsDocument(paths().scope, serialized),
    ).toThrow(expect.objectContaining({
      document: "conversation-key-generations",
      code: "identity-mismatch",
    }));
  });

  it("treats corrupt sidecar content as empty audit state without blocking register", () => {
    const first = createStore();
    const key = first.getOrCreate(PEER);
    writeFileSync(paths().conversationKeyGenerationsPath, "{ broken", "utf8");

    const restarted = createStore();
    expect(sameBytes(restarted.getOrCreate(PEER), key)).toBe(true);
    expect(restarted.generationOf(PEER)).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(
        /document=conversation-key-generations code=invalid-document action=empty-state/,
      ),
    );
  });

  it("treats a sidecar read error as empty audit state without blocking a new key", () => {
    mkdirSync(paths().conversationKeyGenerationsPath, {
      recursive: true,
      mode: 0o700,
    });
    const store = createStore();

    expect(store.getOrCreate(PEER)).toHaveLength(32);
    expect(durableKey()).toHaveLength(32);
    expect(store.generationOf(PEER)).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(
        /document=conversation-key-generations code=storage-io-failed action=empty-state/,
      ),
    );
  });

  it("compacts stale sidecar entries before recording a new peer", () => {
    const store = createStore({ maxKeys: 3 });
    store.getOrCreate("peer-existing");
    writeGenerations(new Map([
      ["peer-existing", { epoch: 4, rotatedAtSec: 4 }],
      ["stale-a", { epoch: 7, rotatedAtSec: 7 }],
      ["stale-b", { epoch: 8, rotatedAtSec: 8 }],
    ]));

    store.getOrCreate("peer-new");
    expect([...durableGenerations()]).toEqual([
      ["peer-existing", { epoch: 4, rotatedAtSec: 4 }],
      ["peer-new", { epoch: 1, rotatedAtSec: 1_700_000_000 }],
    ]);
  });

  it("resets the audit sidecar when the authoritative key document is quarantined", () => {
    createStore().getOrCreate(PEER);
    writeFileSync(paths().conversationKeyPath, "{ broken key document", "utf8");

    const recovered = createStore();
    recovered.getOrCreate("peer-b");
    expect([...durableGenerations().keys()]).toEqual(["peer-b"]);
    expect(
      readdirSync(dirname(paths().conversationKeyPath)).some((name) =>
        name.includes("conversation-keys.json.corrupt-v2-"),
      ),
    ).toBe(true);
  });
});

describe("ConversationKeyStore.rotate", () => {
  it("rotates an existing peer, advances its label, and separates K_new cryptographically", () => {
    const store = createStore();
    const oldKey = store.getOrCreate(PEER);
    const result = store.rotate(PEER);

    expect(result).toMatchObject({ epoch: 2, rotatedAtSec: 1_700_000_000 });
    expect(result.key).toHaveLength(32);
    expect(sameBytes(result.key, oldKey)).toBe(false);
    expect(sameBytes(durableKey(), result.key)).toBe(true);
    expect(store.generationOf(PEER)).toEqual({
      epoch: 2,
      rotatedAtSec: 1_700_000_000,
    });

    const envelope = sealEnvelope(ROUTING, result.key, { text: "new" });
    expect(openEnvelope(envelope, result.key).message).toEqual({ text: "new" });
    expect(() => openEnvelope(envelope, oldKey)).toThrow();
  });

  it("returns a defensive key copy that cannot mutate the cached or durable K_new", () => {
    const store = createStore();
    store.getOrCreate(PEER);
    const result = store.rotate(PEER);
    const expectedNewKey = new Uint8Array(result.key);

    expect(sameBytes(result.key, store.get(PEER)!)).toBe(true);
    expect(sameBytes(result.key, durableKey())).toBe(true);
    expect(result.key).not.toBe(store.get(PEER));

    result.key.fill(0);
    expect(sameBytes(result.key, expectedNewKey)).toBe(false);
    expect(sameBytes(store.get(PEER)!, expectedNewKey)).toBe(true);
    expect(sameBytes(durableKey(), expectedNewKey)).toBe(true);
  });

  it("rejects an unknown peer without creating either key or generation state", () => {
    const store = createStore();
    expect(() => store.rotate("unknown")).toThrow(/target does not exist/);
    expect(store.get("unknown")).toBeNull();
    expect(store.generationOf("unknown")).toBeNull();
  });

  it("self-heals an entry-less existing peer before changing its key", () => {
    let failGenerationWrite = true;
    const store = createStore({
      _beforeGenerationPersist: () => {
        if (failGenerationWrite) throw new Error("injected sidecar failure");
      },
    });
    const oldKey = store.getOrCreate(PEER);
    expect(statOrNull(paths().conversationKeyGenerationsPath)).toBeNull();
    expect(store.generationOf(PEER)).toBeNull();

    failGenerationWrite = false;
    const rotated = store.rotate(PEER);
    expect(rotated.epoch).toBe(1);
    expect(sameBytes(rotated.key, oldKey)).toBe(false);
    expect(durableGenerations().get(PEER)).toEqual({
      epoch: 1,
      rotatedAtSec: 1_700_000_000,
    });
  });

  it("sidecar loss does not block register, but rotate fails closed if it cannot restore a durable entry", () => {
    const oldKey = createStore().getOrCreate(PEER);
    unlinkSync(paths().conversationKeyGenerationsPath);
    const beforeKey = readFileSync(paths().conversationKeyPath);

    const restarted = createStore({
      _beforeGenerationPersist: () => {
        throw new Error("injected sidecar write failure");
      },
    });
    expect(sameBytes(restarted.getOrCreate(PEER), oldKey)).toBe(true);
    expect(restarted.generationOf(PEER)).toBeNull();
    expect(() => restarted.rotate(PEER)).toThrow(/injected sidecar write failure/);
    expect(readFileSync(paths().conversationKeyPath).equals(beforeKey)).toBe(true);
    expect(sameBytes(restarted.get(PEER)!, oldKey)).toBe(true);
  });

  it("fails capacity before key mutation when an entry-less target has no durable slot", () => {
    const roomy = createStore({ maxKeys: 3 });
    roomy.getOrCreate("p1");
    roomy.getOrCreate("p2");
    const oldTarget = roomy.getOrCreate("p3");
    writeGenerations(new Map([
      ["p1", { epoch: 1, rotatedAtSec: 1 }],
      ["p2", { epoch: 1, rotatedAtSec: 1 }],
    ]));
    const before = readFileSync(paths().conversationKeyPath);

    const constrained = createStore({ maxKeys: 2 });
    expect(() => constrained.rotate("p3")).toThrow(
      ConversationKeyGenerationCapacityError,
    );
    expect(readFileSync(paths().conversationKeyPath).equals(before)).toBe(true);
    expect(sameBytes(durableKey("p3"), oldTarget)).toBe(true);
  });

  it("keeps a recorded peer capacity-neutral", () => {
    const store = createStore({ maxKeys: 2 });
    const oldKey = store.getOrCreate("p1");
    store.getOrCreate("p2");
    const rotated = store.rotate("p1");
    expect(rotated.epoch).toBe(2);
    expect(sameBytes(rotated.key, oldKey)).toBe(false);
  });

  it("compacts a stale generation before rotating a recorded peer at capacity", () => {
    const store = createStore({ maxKeys: 1 });
    const oldKey = store.getOrCreate(PEER);
    writeGenerations(new Map([
      [PEER, { epoch: 1, rotatedAtSec: 1 }],
      ["stale-peer", { epoch: 9, rotatedAtSec: 9 }],
    ]));

    const rotated = store.rotate(PEER);

    expect(rotated.epoch).toBe(2);
    expect(sameBytes(rotated.key, oldKey)).toBe(false);
    expect([...durableGenerations()]).toEqual([
      [PEER, { epoch: 2, rotatedAtSec: 1_700_000_000 }],
    ]);
  });

  it("rejects a recorded target when lowered capacity is below all live generations", () => {
    const roomy = createStore({ maxKeys: 2 });
    const oldTarget = roomy.getOrCreate("p1");
    roomy.getOrCreate("p2");
    const beforeKeys = readFileSync(paths().conversationKeyPath);
    const beforeGenerations = readFileSync(
      paths().conversationKeyGenerationsPath,
    );

    const constrained = createStore({ maxKeys: 1 });
    expect(sameBytes(constrained.get("p1")!, oldTarget)).toBe(true);
    expect(() => constrained.rotate("p1")).toThrow(
      ConversationKeyGenerationCapacityError,
    );
    expect(readFileSync(paths().conversationKeyPath).equals(beforeKeys)).toBe(
      true,
    );
    expect(
      readFileSync(paths().conversationKeyGenerationsPath).equals(
        beforeGenerations,
      ),
    ).toBe(true);
    expect(sameBytes(constrained.get("p1")!, oldTarget)).toBe(true);
  });
});

describe("direct rotate five crash contracts", () => {
  it("1: candidate read/random failure leaves disk and cache unchanged", () => {
    const seeded = seedPeer();
    const store = createStore({
      _randomBytes: () => {
        throw new Error("injected random failure");
      },
    });
    expect(sameBytes(store.get(PEER)!, seeded.key)).toBe(true);

    expect(() => store.rotate(PEER)).toThrow(/injected random failure/);
    expectOnlyOldKey(store, seeded.key, seeded.keyBytes);
    expect(
      readFileSync(paths().conversationKeyGenerationsPath).equals(
        seeded.generationBytes,
      ),
    ).toBe(true);
  });

  it("2: generation write failure leaves key material and cache unchanged", () => {
    const seeded = seedPeer();
    const store = createStore({
      _beforeGenerationPersist: () => {
        throw new Error("injected generation failure");
      },
    });
    store.get(PEER);

    expect(() => store.rotate(PEER)).toThrow(/injected generation failure/);
    expectOnlyOldKey(store, seeded.key, seeded.keyBytes);
    expect(
      readFileSync(paths().conversationKeyGenerationsPath).equals(
        seeded.generationBytes,
      ),
    ).toBe(true);
  });

  it("3: key write failure permits sidecar-ahead and the next rotate advances again", () => {
    const seeded = seedPeer();
    let failKeyWrite = true;
    const store = createStore({
      _beforePersist: () => {
        if (failKeyWrite) throw new Error("injected key failure");
      },
    });
    store.get(PEER);

    expect(() => store.rotate(PEER)).toThrow(/injected key failure/);
    expectOnlyOldKey(store, seeded.key, seeded.keyBytes);
    expect(durableGenerations().get(PEER)?.epoch).toBe(2);

    failKeyWrite = false;
    const recovered = store.rotate(PEER);
    expect(recovered.epoch).toBe(3);
    expect(sameBytes(recovered.key, seeded.key)).toBe(false);
  });

  it("4: key rename before cache publication leaves restart-visible K_new", () => {
    const seeded = seedPeer();
    const store = createStore({
      _beforeCachePublish: () => {
        throw new Error("simulated post-key-rename crash");
      },
    });
    store.get(PEER);

    expect(() => store.rotate(PEER)).toThrow(/post-key-rename crash/);
    const newKey = durableKey();
    expect(sameBytes(newKey, seeded.key)).toBe(false);
    expect(durableGenerations().get(PEER)?.epoch).toBe(2);
    // The test seam does not really kill this process. The implementation
    // invalidates the stale cache so catching the simulated crash cannot serve K_old.
    expect(sameBytes(store.get(PEER)!, newKey)).toBe(true);
    expect(sameBytes(createStore().get(PEER)!, newKey)).toBe(true);
  });

  it("5: successful return publishes the same K_new to disk and cache", () => {
    const seeded = seedPeer();
    const store = createStore();
    store.get(PEER);
    const result = store.rotate(PEER);
    expect(sameBytes(result.key, seeded.key)).toBe(false);
    expect(sameBytes(store.get(PEER)!, result.key)).toBe(true);
    expect(sameBytes(durableKey(), result.key)).toBe(true);
    expect(durableGenerations().get(PEER)?.epoch).toBe(2);
  });
});

function statOrNull(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}
