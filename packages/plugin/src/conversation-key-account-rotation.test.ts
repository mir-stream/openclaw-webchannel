import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConversationKeyGenerationCapacityError,
  ConversationKeyStore,
  type ConversationKeyStoreOptions,
} from "./conversation-key-store.js";
import {
  ConversationKeyReadbackError,
  ConversationKeyTargetDigestMismatchError,
  OfflineConversationKeyRotator,
} from "./offline-conversation-key-rotation.js";
import {
  parseConversationKeyGenerationsDocument,
  serializeConversationKeyGenerationsDocument,
  type ConversationKeyGeneration,
} from "./conversation-key-generations-document.js";
import { tupleStoragePaths } from "./storage-paths.js";

/**
 * #158 — the physically separate offline operator rotation surface.
 *
 * The load-bearing test in this file is the COMMIT COUNT one. An account-wide
 * rotation implemented as a `rotate(peerId)` loop rewrites both whole documents
 * once per peer: O(N²) bytes, ~4.2s measured at 500 peers against a 10,000-peer
 * ceiling, and one of the two reasons boot-time rotation was cut from PR #156.
 * `docs/ISSUE_72_CONTAINMENT_PLAN.md` §8.2 therefore forbids the loop. Nothing
 * else in this repo would notice the regression: a loop produces byte-identical
 * final documents and passes every other assertion here. Pinning the write
 * count is the only device that fails when someone "simplifies" the batch path
 * back into a loop.
 */

const TENANT = "tenant-A";
const ACCOUNT = "acct-a";
const NOW_SEC = 1_700_000_000;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "webchannel-account-rotation-"));
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
    _nowSec: () => NOW_SEC,
    ...options,
  });
}

function createRotator(
  options: Partial<ConversationKeyStoreOptions> = {},
): OfflineConversationKeyRotator {
  return new OfflineConversationKeyRotator({
    tenant: TENANT,
    accountId: ACCOUNT,
    home,
    _nowSec: () => NOW_SEC,
    ...options,
  });
}

function rotateReviewedAccount(
  rotator: OfflineConversationKeyRotator = createRotator(),
) {
  const preview = rotator.previewAccountRotation();
  return rotator.rotateAccountVerified(preview.targetDigest);
}

function paths() {
  return tupleStoragePaths({ tenant: TENANT, accountId: ACCOUNT, home });
}

function durableKeys(): Record<string, string> {
  const document = JSON.parse(
    readFileSync(paths().conversationKeyPath, "utf8"),
  ) as { keys: Record<string, string> };
  return document.keys;
}

function durableGenerations(): Map<string, ConversationKeyGeneration> {
  return parseConversationKeyGenerationsDocument(
    paths().scope,
    readFileSync(paths().conversationKeyGenerationsPath, "utf8"),
  );
}

/** Register `count` peers through the ordinary admission path. */
function seedPeers(count: number): string[] {
  const store = createStore();
  const peerIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const peerId = `peer-${String(index).padStart(4, "0")}`;
    store.getOrCreate(peerId);
    peerIds.push(peerId);
  }
  return peerIds;
}

function seedNamedPeers(
  tenant: string,
  accountId: string,
  peerIds: readonly string[],
): OfflineConversationKeyRotator {
  const store = new ConversationKeyStore({ tenant, accountId, home });
  for (const peerId of peerIds) store.getOrCreate(peerId);
  return new OfflineConversationKeyRotator({ tenant, accountId, home });
}

type WriteCounter = {
  keyWrites: number;
  generationWrites: number;
  seams: Partial<ConversationKeyStoreOptions>;
};

function writeCounter(): WriteCounter {
  const counter: WriteCounter = { keyWrites: 0, generationWrites: 0, seams: {} };
  counter.seams = {
    _beforePersist: () => {
      counter.keyWrites += 1;
    },
    _beforeGenerationPersist: () => {
      counter.generationWrites += 1;
    },
  };
  return counter;
}

describe("account-wide rotation commit count", () => {
  // The seams below are the only two call sites that reach
  // `atomicWritePrivateFile` for these documents, so counting them counts
  // durable writes.
  for (const peerCount of [1, 3, 64]) {
    it(`writes each document exactly once for ${peerCount} peers`, () => {
      seedPeers(peerCount);
      const counter = writeCounter();
      const rotator = createRotator(counter.seams);

      const summary = rotateReviewedAccount(rotator);

      expect(summary.peerCount).toBe(peerCount);
      expect(counter.keyWrites).toBe(1);
      expect(counter.generationWrites).toBe(1);
    });
  }

  it("keeps the write count flat as the peer count grows", () => {
    // Stated as a relation rather than a constant: the failure this guards is
    // "writes scale with N", and a reader should be able to see that claim.
    const counts: number[] = [];
    for (const peerCount of [2, 32]) {
      rmSync(home, { recursive: true, force: true });
      home = mkdtempSync(join(tmpdir(), "webchannel-account-rotation-"));
      seedPeers(peerCount);
      const counter = writeCounter();
      rotateReviewedAccount(createRotator(counter.seams));
      counts.push(counter.keyWrites + counter.generationWrites);
    }
    expect(counts[0]).toBe(counts[1]);
    expect(counts[0]).toBe(2);
  });

  it("leaves no unpublished temp artifacts behind", () => {
    seedPeers(8);
    rotateReviewedAccount();
    const residue = readdirSync(paths().directory).filter((entry) =>
      entry.includes(".tmp-"),
    );
    expect(residue).toEqual([]);
  });
});

describe("account-wide rotation semantics", () => {
  it("replaces every peer's key with distinct fresh material", () => {
    const peerIds = seedPeers(5);
    const before = { ...durableKeys() };

    rotateReviewedAccount();

    const after = durableKeys();
    expect(Object.keys(after).sort()).toEqual([...peerIds].sort());
    const materials = new Set<string>();
    for (const peerId of peerIds) {
      expect(after[peerId]).not.toBe(before[peerId]);
      materials.add(after[peerId] as string);
    }
    expect(materials.size).toBe(peerIds.length);
  });

  it("advances each peer's own epoch and stamps one rotation time", () => {
    const peerIds = seedPeers(3);
    // Give one peer a higher label and drop another's entry entirely, so the
    // per-peer advance cannot be faked by a single shared counter.
    const seeded = new Map<string, ConversationKeyGeneration>([
      [peerIds[0] as string, { epoch: 7, rotatedAtSec: 1_600_000_000 }],
      [peerIds[1] as string, { epoch: 1, rotatedAtSec: 1_600_000_000 }],
    ]);
    writeGenerationsDocument(seeded);

    rotateReviewedAccount();

    const generations = durableGenerations();
    expect(generations.get(peerIds[0] as string)?.epoch).toBe(8);
    expect(generations.get(peerIds[1] as string)?.epoch).toBe(2);
    expect(generations.get(peerIds[2] as string)?.epoch).toBe(1);
    for (const peerId of peerIds) {
      expect(generations.get(peerId)?.rotatedAtSec).toBe(NOW_SEC);
    }
  });

  it("makes a freshly opened store observe the committed keys", () => {
    const peerIds = seedPeers(2);
    const before = createStore().get(peerIds[0] as string);

    rotateReviewedAccount();

    const after = createStore().get(peerIds[0] as string);
    expect(after).not.toBeNull();
    expect(Buffer.from(after as Uint8Array)).not.toEqual(
      Buffer.from(before as Uint8Array),
    );
    expect(Buffer.from(after as Uint8Array).toString("base64url")).toBe(
      durableKeys()[peerIds[0] as string],
    );
  });

  it("refuses an account with no stored key instead of creating one", () => {
    const rotator = createRotator();
    expect(() => rotateReviewedAccount(rotator)).toThrow(/no target/);
    expect(existsSync(paths().conversationKeyPath)).toBe(false);
  });

  it("fails closed on generation capacity without touching key material", () => {
    const peerIds = seedPeers(3);
    const before = { ...durableKeys() };

    const rotator = createRotator({ maxKeys: 2 });
    expect(() => rotateReviewedAccount(rotator)).toThrow(
      ConversationKeyGenerationCapacityError,
    );

    expect(durableKeys()).toEqual(before);
    expect(peerIds.length).toBe(3);
  });

  it("returns no key material to the caller", () => {
    seedPeers(2);
    const summary = rotateReviewedAccount() as Record<
      string,
      unknown
    >;
    expect(Object.keys(summary).sort()).toEqual([
      "peerCount",
      "rotatedAtSec",
      "targetDigest",
    ]);
  });
});

describe("tuple-bound account review digest", () => {
  it("changes when either validated tuple component changes", () => {
    const peers = ["peer-a", "peer-b"];
    const original = seedNamedPeers(TENANT, ACCOUNT, peers)
      .previewAccountRotation().targetDigest;
    const otherTenant = seedNamedPeers("tenant-B", ACCOUNT, peers)
      .previewAccountRotation().targetDigest;
    const otherAccount = seedNamedPeers(TENANT, "acct-b", peers)
      .previewAccountRotation().targetDigest;

    expect(new Set([original, otherTenant, otherAccount]).size).toBe(3);
  });

  it("rechecks the reviewed digest against a fresh snapshot before writes", () => {
    seedPeers(2);
    const rotator = createRotator();
    const reviewed = rotator.previewAccountRotation().targetDigest;
    createStore().getOrCreate("peer-late");
    const keysBefore = readFileSync(paths().conversationKeyPath, "utf8");
    const generationsBefore = readFileSync(
      paths().conversationKeyGenerationsPath,
      "utf8",
    );

    expect(() => rotator.rotateAccountVerified(reviewed)).toThrow(
      ConversationKeyTargetDigestMismatchError,
    );
    expect(readFileSync(paths().conversationKeyPath, "utf8")).toBe(keysBefore);
    expect(readFileSync(paths().conversationKeyGenerationsPath, "utf8")).toBe(
      generationsBefore,
    );
  });
});

describe("readback verification", () => {
  it("fails when the committed documents cannot be re-read", () => {
    seedPeers(2);
    const rotator = createRotator({
      // Runs after both documents are committed and before readback,
      // so this simulates the sidecar disappearing under a successful write.
      _beforeCachePublish: () => {
        unlinkSync(paths().conversationKeyGenerationsPath);
      },
    });
    expect(() => rotateReviewedAccount(rotator)).toThrow(
      ConversationKeyReadbackError,
    );
  });

  it("fails when disk no longer holds what was committed", () => {
    const peerIds = seedPeers(2);
    const rotator = createRotator({
      _beforeCachePublish: () => {
        // A foreign writer replaces the sidecar with a stale-but-valid one.
        writeGenerationsDocument(
          new Map(
            peerIds.map((peerId) => [
              peerId,
              { epoch: 1, rotatedAtSec: 1_600_000_000 },
            ]),
          ),
        );
      },
    });
    expect(() => rotateReviewedAccount(rotator)).toThrow(
      /generation label did not match/,
    );
  });

  it("verifies a per-peer rotation and reports no key material", () => {
    const peerIds = seedPeers(3);
    const before = { ...durableKeys() };

    const summary = createRotator().rotatePeerVerified(peerIds[1] as string);

    expect(Object.keys(summary).sort()).toEqual([
      "epoch",
      "peerId",
      "rotatedAtSec",
    ]);
    expect(summary.peerId).toBe(peerIds[1]);
    const after = durableKeys();
    expect(after[peerIds[1] as string]).not.toBe(before[peerIds[1] as string]);
    expect(after[peerIds[0] as string]).toBe(before[peerIds[0] as string]);
    expect(after[peerIds[2] as string]).toBe(before[peerIds[2] as string]);
  });

  it("rejects a same-cardinality non-target key mutation after peer commit", () => {
    const peerIds = seedPeers(3);
    const rotator = createRotator({
      _beforeCachePublish: () => {
        const document = JSON.parse(
          readFileSync(paths().conversationKeyPath, "utf8"),
        ) as { keys: Record<string, string> };
        document.keys[peerIds[0] as string] = Buffer.alloc(32, 0x5a).toString(
          "base64url",
        );
        writeFileSync(paths().conversationKeyPath, JSON.stringify(document), {
          mode: 0o600,
        });
      },
    });

    expect(() => rotator.rotatePeerVerified(peerIds[1] as string)).toThrow(
      /key material did not match/,
    );
  });

  it("rejects a same-cardinality non-target sidecar mutation after peer commit", () => {
    const peerIds = seedPeers(3);
    const rotator = createRotator({
      _beforeCachePublish: () => {
        const generations = durableGenerations();
        generations.set(peerIds[0] as string, {
          epoch: 99,
          rotatedAtSec: 1_600_000_000,
        });
        writeGenerationsDocument(generations);
      },
    });

    expect(() => rotator.rotatePeerVerified(peerIds[1] as string)).toThrow(
      /generation label did not match/,
    );
  });

  it("rejects generation sidecar cardinality changes after peer commit", () => {
    const peerIds = seedPeers(2);
    const rotator = createRotator({
      _beforeCachePublish: () => {
        const generations = durableGenerations();
        generations.set("foreign-entry", {
          epoch: 1,
          rotatedAtSec: 1_600_000_000,
        });
        writeGenerationsDocument(generations);
      },
    });

    expect(() => rotator.rotatePeerVerified(peerIds[1] as string)).toThrow(
      /sidecar cardinality changed/,
    );
  });

  it("refuses a per-peer rotation of an unknown peer", () => {
    seedPeers(1);
    expect(() => createRotator().rotatePeerVerified("nobody")).toThrow(
      /does not exist/,
    );
  });
});

describe("previews", () => {
  it("reports a peer's non-secret generation label and writes nothing", () => {
    const peerIds = seedPeers(1);
    const before = readFileSync(paths().conversationKeyPath, "utf8");

    const preview = createRotator().previewPeerRotation(peerIds[0] as string);

    expect(preview).toEqual({
      peerId: peerIds[0],
      present: true,
      generation: { epoch: 1, rotatedAtSec: NOW_SEC },
    });
    expect(readFileSync(paths().conversationKeyPath, "utf8")).toBe(before);
  });

  it("reports an absent peer without registering it", () => {
    seedPeers(1);
    const preview = createRotator().previewPeerRotation("nobody");
    expect(preview).toEqual({
      peerId: "nobody",
      present: false,
      generation: null,
    });
    expect(Object.keys(durableKeys())).toEqual(["peer-0000"]);
  });

  it("reports an account as a count and a digest, never a peer list", () => {
    const peerIds = seedPeers(4);
    const preview = createRotator().previewAccountRotation();

    expect(preview.peerCount).toBe(4);
    expect(preview.targetDigest).toMatch(/^[0-9a-f]{64}$/);
    for (const peerId of peerIds) {
      expect(preview.targetDigest).not.toContain(peerId);
    }
  });

  it("keeps the digest stable for a set and changes it when the set does", () => {
    seedPeers(3);
    const first = createRotator().previewAccountRotation().targetDigest;
    expect(createRotator().previewAccountRotation().targetDigest).toBe(first);

    // Rotation replaces key MATERIAL, not membership: the digest must survive.
    rotateReviewedAccount();
    expect(createRotator().previewAccountRotation().targetDigest).toBe(first);

    createStore().getOrCreate("peer-9999");
    expect(createRotator().previewAccountRotation().targetDigest).not.toBe(first);
  });

  it("matches the digest an account-wide rotation reports", () => {
    seedPeers(3);
    const preview = createRotator().previewAccountRotation();
    const summary = rotateReviewedAccount();
    expect(summary.targetDigest).toBe(preview.targetDigest);
  });
});

function writeGenerationsDocument(
  generations: ReadonlyMap<string, ConversationKeyGeneration>,
): void {
  writeFileSync(
    paths().conversationKeyGenerationsPath,
    serializeConversationKeyGenerationsDocument(paths().scope, generations),
    { mode: 0o600 },
  );
}
