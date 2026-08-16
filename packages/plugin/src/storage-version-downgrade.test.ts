/**
 * #159 — a document from the FUTURE is a downgrade, not corruption.
 *
 * Every secret-bearing store in this package has a recovery path for corrupt
 * content, and each one is destructive in its own way: the key document is
 * archived and replaced with an empty one, the audit sidecar is overwritten in
 * place with no archive at all. Those paths are correct for corruption and
 * catastrophic for a file written by a NEWER release — the case that appears
 * the first time a deployer rolls a release back.
 *
 * So these tests do not stop at "it threw". Throwing while a `.corrupt-v2-*`
 * sibling appears, or while the sidecar has already been rewritten, would still
 * be the outage. Each case reads the file back and compares BYTES.
 *
 * The complementary direction is asserted too: an OLDER version, unparseable
 * JSON, and a corrupt sidecar must all keep the behavior they have today. This
 * change narrows one classification; it does not touch quarantine or the
 * sidecar's audit-only contract.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationKeyStore } from "./conversation-key-store.js";
import {
  CONVERSATION_KEY_DOCUMENT_VERSION,
  LEGACY_CONVERSATION_KEY_DOCUMENT_VERSION,
  parseConversationKeyDocument,
  parseLegacyConversationKeyDocument,
} from "./conversation-key-document.js";
import {
  CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION,
  parseConversationKeyGenerationsDocument,
} from "./conversation-key-generations-document.js";
import { loadCredentialDocumentAtPath } from "./account-config.js";
import { generateKeyPair } from "./e2e-crypto.js";
import { StorageDocumentError } from "./storage-document.js";
import { STORAGE_IDENTITY_VERSION } from "./storage-identity.js";
import { tupleStoragePaths } from "./storage-paths.js";

const TENANT = "tenant-A";
const ACCOUNT = "acct-a";
const PEER = "user-42";
const SCOPE = { tenant: TENANT, accountId: ACCOUNT } as const;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "webchannel-downgrade-"));
  // The quarantine path logs before archiving; keep the suite output readable
  // without hiding whether it ran (the file-byte assertions decide that).
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function paths(): ReturnType<typeof tupleStoragePaths> {
  return tupleStoragePaths({ tenant: TENANT, accountId: ACCOUNT, home });
}

function store(): ConversationKeyStore {
  return new ConversationKeyStore({
    tenant: TENANT,
    accountId: ACCOUNT,
    home,
  });
}

/** Write an exact byte string at `path`, creating the tuple directory. */
function writeRaw(path: string, contents: string): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode: 0o600 });
  return readFileSync(path);
}

function keyDocument(version: number): string {
  return JSON.stringify(
    {
      version,
      storageIdentity: {
        identityVersion: STORAGE_IDENTITY_VERSION,
        storage: { ...SCOPE },
      },
      keys: { [PEER]: Buffer.alloc(32, 7).toString("base64url") },
      // A real future document would also carry fields this build cannot know
      // about. They must survive untouched, which is exactly what a byte
      // comparison after a failed load proves.
      wrappedFor: { "device-1": "opaque-to-this-build" },
    },
    null,
    2,
  );
}

function generationsDocument(version: number): string {
  return JSON.stringify(
    {
      version,
      storageIdentity: {
        identityVersion: STORAGE_IDENTITY_VERSION,
        storage: { ...SCOPE },
      },
      generations: { [PEER]: { epoch: 4, rotatedAtSec: 1_700_000_000 } },
    },
    null,
    2,
  );
}

/** Sibling files the quarantine path would leave behind, if it ran. */
function quarantineSiblings(path: string): string[] {
  const base = path.slice(dirname(path).length + 1);
  return readdirSync(dirname(path)).filter(
    (entry) => entry.startsWith(`${base}.`) && entry !== base,
  );
}

describe("#159 conversation-keys.json written by a newer release", () => {
  it("fails closed and leaves the file byte-identical, with nothing quarantined", () => {
    const path = paths().conversationKeyPath;
    const before = writeRaw(
      path,
      keyDocument(CONVERSATION_KEY_DOCUMENT_VERSION + 1),
    );

    expect(() => store().getOrCreate(PEER)).toThrow(
      /conversation-keys version-too-new/,
    );

    expect(readFileSync(path).equals(before)).toBe(true);
    expect(quarantineSiblings(path)).toEqual([]);
  });

  it("names the situation as a downgrade and says what to do, with no key material", () => {
    const path = paths().conversationKeyPath;
    const encodedKey = Buffer.alloc(32, 7).toString("base64url");
    writeRaw(path, keyDocument(CONVERSATION_KEY_DOCUMENT_VERSION + 1));

    let caught: unknown;
    try {
      store().get(PEER);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StorageDocumentError);
    const message = (caught as StorageDocumentError).message;
    expect((caught as StorageDocumentError).code).toBe("version-too-new");
    expect(message).toContain("version downgrade");
    expect(message).toContain("Run the plugin version that wrote it");
    // Sanitized as strictly as every other storage failure: no key material, no
    // peer id, no tenant/account, no path.
    for (const forbidden of [encodedKey, PEER, TENANT, ACCOUNT, path, home]) {
      expect(message).not.toContain(forbidden);
    }
  });

  it("keeps quarantine for an OLDER version (the upgrade direction is untouched)", () => {
    const path = paths().conversationKeyPath;
    writeRaw(path, keyDocument(CONVERSATION_KEY_DOCUMENT_VERSION - 1));

    const key = store().getOrCreate(PEER);

    expect(key).toHaveLength(32);
    expect(quarantineSiblings(path)).toHaveLength(1);
    const reloaded = parseConversationKeyDocument(
      SCOPE,
      readFileSync(path, "utf8"),
    );
    expect(reloaded.size).toBe(1);
  });

  it("keeps quarantine for unparseable JSON", () => {
    const path = paths().conversationKeyPath;
    writeRaw(path, "{ not json");

    expect(store().getOrCreate(PEER)).toHaveLength(32);
    expect(quarantineSiblings(path)).toHaveLength(1);
  });

  it("classifies a non-numeric or fractional version as ordinary corruption", () => {
    for (const version of ["3", 2.5, null, undefined]) {
      const serialized = JSON.stringify({
        version,
        storageIdentity: {
          identityVersion: STORAGE_IDENTITY_VERSION,
          storage: { ...SCOPE },
        },
        keys: {},
      });
      try {
        parseConversationKeyDocument(SCOPE, serialized);
        expect.unreachable(`version ${String(version)} should not parse`);
      } catch (error) {
        expect((error as StorageDocumentError).code).toBe("invalid-document");
      }
    }
  });
});

describe("#159 the v1 legacy reader answers the same question", () => {
  it("reports version-too-new above the version it understands", () => {
    const serialized = JSON.stringify({
      version: LEGACY_CONVERSATION_KEY_DOCUMENT_VERSION + 1,
      keys: {},
    });
    try {
      parseLegacyConversationKeyDocument(SCOPE, serialized);
      expect.unreachable("a future legacy document must not parse");
    } catch (error) {
      expect((error as StorageDocumentError).code).toBe("version-too-new");
    }
  });

  it("still reads its own version", () => {
    const serialized = JSON.stringify({
      version: LEGACY_CONVERSATION_KEY_DOCUMENT_VERSION,
      keys: { [PEER]: Buffer.alloc(32, 3).toString("base64url") },
    });
    expect(parseLegacyConversationKeyDocument(SCOPE, serialized).size).toBe(1);
  });
});

describe("#159 the generation sidecar (audit-only, but never overwritten)", () => {
  it("fails closed on a future sidecar and leaves its bytes intact", () => {
    const { conversationKeyGenerationsPath } = paths();
    const before = writeRaw(
      conversationKeyGenerationsPath,
      generationsDocument(CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION + 1),
    );

    expect(() => store().getOrCreate(PEER)).toThrow(
      /conversation-key-generations version-too-new/,
    );

    expect(
      readFileSync(conversationKeyGenerationsPath).equals(before),
    ).toBe(true);
  });

  it("fails closed BEFORE a key is minted — nothing is published either", () => {
    const { conversationKeyPath, conversationKeyGenerationsPath } = paths();
    writeRaw(
      conversationKeyGenerationsPath,
      generationsDocument(CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION + 1),
    );

    expect(() => store().getOrCreate(PEER)).toThrow(/version-too-new/);

    expect(readdirSync(dirname(conversationKeyPath))).not.toContain(
      "conversation-keys.json",
    );
  });

  it("still refuses rotation rather than replacing a future sidecar", () => {
    const { conversationKeyPath, conversationKeyGenerationsPath } = paths();
    // Mint K with a healthy sidecar, then simulate the rollback.
    store().getOrCreate(PEER);
    const keysBefore = readFileSync(conversationKeyPath);
    const before = writeRaw(
      conversationKeyGenerationsPath,
      generationsDocument(CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION + 1),
    );

    expect(() => store().rotate(PEER)).toThrow(/version-too-new/);

    expect(
      readFileSync(conversationKeyGenerationsPath).equals(before),
    ).toBe(true);
    expect(readFileSync(conversationKeyPath).equals(keysBefore)).toBe(true);
  });

  it("keeps admitting registrations when the sidecar is merely CORRUPT", () => {
    // The audit-only contract (§8.1) is the reason version-too-new had to be
    // split out instead of hardening the whole read. Corruption still degrades.
    const { conversationKeyGenerationsPath } = paths();
    writeRaw(conversationKeyGenerationsPath, "{ not json");

    const key = store().getOrCreate(PEER);

    expect(key).toHaveLength(32);
    expect(store().generationOf(PEER)).not.toBeNull();
  });

  it("keeps admitting registrations when the sidecar version is OLDER", () => {
    const { conversationKeyGenerationsPath } = paths();
    writeRaw(
      conversationKeyGenerationsPath,
      generationsDocument(CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION - 1),
    );

    expect(store().getOrCreate(PEER)).toHaveLength(32);
  });

  it("parses its own version", () => {
    const parsed = parseConversationKeyGenerationsDocument(
      SCOPE,
      generationsDocument(CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION),
    );
    expect(parsed.get(PEER)?.epoch).toBe(4);
  });
});

describe("#159 credentials.json was already fail-closed — proving it stays so", () => {
  /**
   * This document carries no top-level `version`; its version field is the
   * binding identity's `identityVersion`. The load API returns a sanitized
   * non-match for an unsupported one and every credential write is create-only
   * (`replace: false`), so no code change was needed here — only the evidence
   * that the property holds, so a future edit cannot quietly remove it.
   */
  it("reports an unsupported identityVersion without touching the file", () => {
    const { credentialPath } = paths();
    const pair = generateKeyPair();
    const publicKey = Buffer.from(pair.publicKey).toString("base64url");
    // Everything except the identity version is valid, so the payload parser
    // cannot be what rejects this document.
    const before = writeRaw(
      credentialPath,
      JSON.stringify(
        {
          tenant: TENANT,
          accountId: ACCOUNT,
          saasEnrollUrl: "https://saas.example/api/enroll",
          saasPollUrl: "https://saas.example/api/poll",
          identityKey: {
            publicKey,
            privateKey: Buffer.from(pair.privateKey).toString("base64url"),
          },
          enrollment: {
            creds: { userJwt: "jwt-placeholder", userSeed: "seed-placeholder" },
            peerId: "peer-1",
            jwksUrl: "https://saas.example/.well-known/jwks.json",
            bootstrapUrl: "https://saas.example/api/bootstrap",
            natsUrl: "wss://relay.example",
          },
          credentialIdentity: {
            identityVersion: STORAGE_IDENTITY_VERSION + 1,
            storage: { ...SCOPE },
            binding: {
              saasBaseUrl: "https://saas.example",
              deliveredIssuer: null,
              relayUrl: "wss://relay.example",
              agentPublicKey: publicKey,
            },
          },
        },
        null,
        2,
      ),
    );

    const loaded = loadCredentialDocumentAtPath(
      {
        tenant: TENANT,
        accountId: ACCOUNT,
        saasBaseUrl: "https://saas.example",
      },
      credentialPath,
    );

    expect(loaded.status).toBe("invalid");
    expect(loaded).toMatchObject({ code: "unsupported-version" });
    expect(readFileSync(credentialPath).equals(before)).toBe(true);
  });
});
