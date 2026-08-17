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
  existsSync,
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

import {
  ConversationKeyStore,
  type ConversationKeyStoreOptions,
} from "./conversation-key-store.js";
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
import { loadPersistedCredentialDocument } from "./account-config.js";
import { generateKeyPair } from "./e2e-crypto.js";
import {
  credentialStorageFailureDiagnostic,
  StorageDocumentError,
} from "./storage-document.js";
import { STORAGE_IDENTITY_VERSION } from "./storage-identity.js";
import { legacyTuplePaths, tupleStoragePaths } from "./storage-paths.js";

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

function store(
  options: Partial<ConversationKeyStoreOptions> = {},
): ConversationKeyStore {
  return new ConversationKeyStore({
    tenant: TENANT,
    accountId: ACCOUNT,
    home,
    ...options,
  });
}

/** Write an exact byte string at `path`, creating the tuple directory. */
function writeRaw(path: string, contents: string): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode: 0o600 });
  return readFileSync(path);
}

function keyDocument(
  version: number,
  identityVersion: number = STORAGE_IDENTITY_VERSION,
): string {
  return JSON.stringify(
    {
      version,
      storageIdentity: {
        identityVersion,
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

function generationsDocument(
  version: number,
  identityVersion: number = STORAGE_IDENTITY_VERSION,
): string {
  return JSON.stringify(
    {
      version,
      storageIdentity: {
        identityVersion,
        storage: { ...SCOPE },
      },
      generations: { [PEER]: { epoch: 4, rotatedAtSec: 1_700_000_000 } },
    },
    null,
    2,
  );
}

function credentialDocument(identityVersion: unknown): string {
  const pair = generateKeyPair();
  const publicKey = Buffer.from(pair.publicKey).toString("base64url");
  return JSON.stringify(
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
        creds: {
          userJwt: "jwt-placeholder",
          userSeed: "seed-placeholder",
        },
        peerId: "peer-1",
        jwksUrl: "https://saas.example/.well-known/jwks.json",
        bootstrapUrl: "https://saas.example/api/bootstrap",
        natsUrl: "wss://relay.example",
      },
      credentialIdentity: {
        identityVersion,
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
  it.each([
    [
      "current key",
      "conversation-keys",
      () =>
        parseConversationKeyDocument(
          SCOPE,
          keyDocument(
            CONVERSATION_KEY_DOCUMENT_VERSION,
            STORAGE_IDENTITY_VERSION + 1,
          ),
        ),
    ],
    [
      "legacy key",
      "conversation-keys",
      () =>
        parseLegacyConversationKeyDocument(
          SCOPE,
          keyDocument(
            LEGACY_CONVERSATION_KEY_DOCUMENT_VERSION,
            STORAGE_IDENTITY_VERSION + 1,
          ),
        ),
    ],
    [
      "generation sidecar",
      "conversation-key-generations",
      () =>
        parseConversationKeyGenerationsDocument(
          SCOPE,
          generationsDocument(
            CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION,
            STORAGE_IDENTITY_VERSION + 1,
          ),
        ),
    ],
  ] as const)(
    "preserves a future identity classification in a current %s envelope",
    (_name, document, parse) => {
      let caught: unknown;
      try {
        parse();
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        document,
        code: "version-too-new",
        fields: ["identityVersion"],
      });
    },
  );

  it("preserves all non-future identity classifications at the parser boundary", () => {
    const parseIdentity = (storageIdentity: unknown): StorageDocumentError => {
      const serialized = JSON.stringify({
        version: CONVERSATION_KEY_DOCUMENT_VERSION,
        storageIdentity,
        keys: {},
      });
      try {
        parseConversationKeyDocument(SCOPE, serialized);
        throw new Error("expected identity parsing to fail");
      } catch (error) {
        return error as StorageDocumentError;
      }
    };

    for (const identityVersion of [
      STORAGE_IDENTITY_VERSION - 1,
      String(STORAGE_IDENTITY_VERSION + 1),
      STORAGE_IDENTITY_VERSION + 0.5,
    ]) {
      expect(
        parseIdentity({ identityVersion, storage: { ...SCOPE } }),
      ).toMatchObject({ code: "identity-invalid" });
    }
    expect(parseIdentity({ storage: { ...SCOPE } })).toMatchObject({
      code: "identity-unbound",
    });
    expect(
      parseIdentity({ identityVersion: STORAGE_IDENTITY_VERSION }),
    ).toMatchObject({ code: "identity-incomplete" });
    expect(
      parseIdentity({
        identityVersion: STORAGE_IDENTITY_VERSION,
        storage: { tenant: TENANT, accountId: "someone-else" },
      }),
    ).toMatchObject({ code: "identity-mismatch" });
    expect(
      parseConversationKeyDocument(
        SCOPE,
        keyDocument(
          CONVERSATION_KEY_DOCUMENT_VERSION,
          STORAGE_IDENTITY_VERSION,
        ),
      ).size,
    ).toBe(1);
  });

  it("fails closed and leaves the file byte-identical, with nothing quarantined", () => {
    const path = paths().conversationKeyPath;
    const before = writeRaw(
      path,
      keyDocument(
        CONVERSATION_KEY_DOCUMENT_VERSION + 1,
        STORAGE_IDENTITY_VERSION + 1,
      ),
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
      storageIdentity: {
        identityVersion: STORAGE_IDENTITY_VERSION + 1,
        storage: { ...SCOPE },
      },
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

  it("leaves a current legacy envelope with a future identity in place during migration", () => {
    const legacy = legacyTuplePaths(ACCOUNT, home);
    const destination = paths();
    const before = writeRaw(
      legacy.conversationKeyPath,
      keyDocument(
        LEGACY_CONVERSATION_KEY_DOCUMENT_VERSION,
        STORAGE_IDENTITY_VERSION + 1,
      ),
    );
    const beforePersist = vi.fn();
    const beforeGenerationPersist = vi.fn();

    expect(() =>
      store({
        _beforePersist: beforePersist,
        _beforeGenerationPersist: beforeGenerationPersist,
      }).getOrCreate(PEER),
    ).toThrow(/conversation-keys version-too-new/);

    expect(readFileSync(legacy.conversationKeyPath).equals(before)).toBe(true);
    expect(quarantineSiblings(legacy.conversationKeyPath)).toEqual([]);
    expect(beforePersist).not.toHaveBeenCalled();
    expect(beforeGenerationPersist).not.toHaveBeenCalled();
    expect(existsSync(destination.conversationKeyPath)).toBe(false);
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

  it.each([
    [
      "future envelope and identity",
      CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION + 1,
      STORAGE_IDENTITY_VERSION + 1,
    ],
    [
      "current envelope with future identity",
      CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION,
      STORAGE_IDENTITY_VERSION + 1,
    ],
  ] as const)("fails closed BEFORE a key is minted for %s", (_case, version, identityVersion) => {
    const { conversationKeyPath, conversationKeyGenerationsPath } = paths();
    const before = writeRaw(
      conversationKeyGenerationsPath,
      generationsDocument(version, identityVersion),
    );
    const beforePersist = vi.fn();
    const beforeGenerationPersist = vi.fn();

    expect(() =>
      store({ _beforePersist: beforePersist, _beforeGenerationPersist: beforeGenerationPersist })
        .getOrCreate(PEER),
    ).toThrow(/version-too-new/);

    expect(
      readFileSync(conversationKeyGenerationsPath).equals(before),
    ).toBe(true);
    expect(quarantineSiblings(conversationKeyGenerationsPath)).toEqual([]);
    expect(beforePersist).not.toHaveBeenCalled();
    expect(beforeGenerationPersist).not.toHaveBeenCalled();
    expect(readdirSync(dirname(conversationKeyPath))).not.toContain(
      "conversation-keys.json",
    );
  });

  it.each([
    [
      "future envelope",
      CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION + 1,
      STORAGE_IDENTITY_VERSION,
    ],
    [
      "future identity",
      CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION,
      STORAGE_IDENTITY_VERSION + 1,
    ],
  ] as const)("still refuses rotation rather than replacing a %s sidecar", (_case, version, identityVersion) => {
    const { conversationKeyPath, conversationKeyGenerationsPath } = paths();
    // Mint K with a healthy sidecar, then simulate the rollback.
    store().getOrCreate(PEER);
    const keysBefore = readFileSync(conversationKeyPath);
    const before = writeRaw(
      conversationKeyGenerationsPath,
      generationsDocument(version, identityVersion),
    );
    const beforePersist = vi.fn();
    const beforeGenerationPersist = vi.fn();

    expect(() =>
      store({ _beforePersist: beforePersist, _beforeGenerationPersist: beforeGenerationPersist })
        .rotate(PEER),
    ).toThrow(/version-too-new/);

    expect(
      readFileSync(conversationKeyGenerationsPath).equals(before),
    ).toBe(true);
    expect(readFileSync(conversationKeyPath).equals(keysBefore)).toBe(true);
    expect(beforePersist).not.toHaveBeenCalled();
    expect(beforeGenerationPersist).not.toHaveBeenCalled();
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

describe("#159 non-mutating startup compatibility probe", () => {
  it.each([
    ["key", "future envelope and identity", "conversation-keys", true],
    ["generation", "future envelope and identity", "conversation-key-generations", true],
    ["key", "current envelope with future identity", "conversation-keys", false],
    ["generation", "current envelope with future identity", "conversation-key-generations", false],
  ] as const)(
    "rejects a future %s document (%s) without writes, quarantine, or lazy recovery",
    (target, _case, expectedDocument, futureEnvelope) => {
      const { conversationKeyPath, conversationKeyGenerationsPath } = paths();
      const targetPath =
        target === "key" ? conversationKeyPath : conversationKeyGenerationsPath;
      const serialized =
        target === "key"
          ? keyDocument(
              CONVERSATION_KEY_DOCUMENT_VERSION + (futureEnvelope ? 1 : 0),
              STORAGE_IDENTITY_VERSION + 1,
            )
          : generationsDocument(
              CONVERSATION_KEY_GENERATIONS_DOCUMENT_VERSION +
                (futureEnvelope ? 1 : 0),
              STORAGE_IDENTITY_VERSION + 1,
            );
      const before = writeRaw(targetPath, serialized);
      const beforePersist = vi.fn();
      const beforeGenerationPersist = vi.fn();
      const candidate = store({
        _beforePersist: beforePersist,
        _beforeGenerationPersist: beforeGenerationPersist,
      });

      let caught: unknown;
      try {
        candidate.assertNoFutureDocuments();
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        code: "version-too-new",
        document: expectedDocument,
      });
      expect(readFileSync(targetPath).equals(before)).toBe(true);
      expect(quarantineSiblings(targetPath)).toEqual([]);
      expect(beforePersist).not.toHaveBeenCalled();
      expect(beforeGenerationPersist).not.toHaveBeenCalled();
      expect(candidate["migrationPrepared"]).toBe(false);
      if (target === "generation") {
        expect(readdirSync(dirname(conversationKeyPath))).not.toContain(
          "conversation-keys.json",
        );
      }
    },
  );

  it("does not turn ordinary corruption into startup recovery or mutation", () => {
    const { conversationKeyPath, conversationKeyGenerationsPath } = paths();
    const keyBefore = writeRaw(conversationKeyPath, "{ corrupt key");
    const generationBefore = writeRaw(
      conversationKeyGenerationsPath,
      "{ corrupt generation",
    );
    const candidate = store();

    expect(() => candidate.assertNoFutureDocuments()).not.toThrow();

    expect(readFileSync(conversationKeyPath).equals(keyBefore)).toBe(true);
    expect(
      readFileSync(conversationKeyGenerationsPath).equals(generationBefore),
    ).toBe(true);
    expect(quarantineSiblings(conversationKeyPath)).toEqual([]);
    expect(quarantineSiblings(conversationKeyGenerationsPath)).toEqual([]);
    expect(candidate["migrationPrepared"]).toBe(false);

    // The probe did not consume lazy recovery: the normal first key access
    // still owns ordinary-corruption quarantine and sidecar degradation.
    expect(candidate.getOrCreate(PEER)).toHaveLength(32);
    expect(quarantineSiblings(conversationKeyPath)).toHaveLength(1);
  });
});

describe("#159 credentials and migration preflight diagnostics", () => {
  it("fails a future credential closed with downgrade guidance and byte identity", () => {
    const { credentialPath } = paths();
    const before = writeRaw(
      credentialPath,
      credentialDocument(STORAGE_IDENTITY_VERSION + 1),
    );

    let caught: unknown;
    try {
      loadPersistedCredentialDocument({
        tenant: TENANT,
        accountId: ACCOUNT,
        saasBaseUrl: "https://saas.example",
      }, { home });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      document: "credentials",
      code: "version-too-new",
    });
    const diagnostic = credentialStorageFailureDiagnostic(
      caught as StorageDocumentError,
    );
    expect(diagnostic.code).toBe("credentials-version-too-new");
    expect(diagnostic.detail).toContain("version downgrade");
    expect(diagnostic.detail).toContain(
      "Run the plugin version that wrote it (or newer)",
    );
    expect(diagnostic.detail).toContain("restore this account's state");
    expect(diagnostic.detail).not.toContain("archive");
    expect(diagnostic.detail).not.toContain("re-enroll");
    for (const forbidden of [
      "jwt-placeholder",
      "seed-placeholder",
      "peer-1",
      PEER,
      TENANT,
      ACCOUNT,
      credentialPath,
      home,
    ]) {
      expect(diagnostic.detail).not.toContain(forbidden);
    }
    expect(readFileSync(credentialPath).equals(before)).toBe(true);
    expect(quarantineSiblings(credentialPath)).toEqual([]);
  });

  it("keeps an older credential identity on the existing unsupported path", () => {
    const { credentialPath } = paths();
    const before = writeRaw(
      credentialPath,
      credentialDocument(STORAGE_IDENTITY_VERSION - 1),
    );

    const loaded = loadPersistedCredentialDocument({
      tenant: TENANT,
      accountId: ACCOUNT,
      saasBaseUrl: "https://saas.example",
    }, { home });

    expect(loaded).toMatchObject({
      status: "invalid",
      code: "unsupported-version",
    });
    expect(readFileSync(credentialPath).equals(before)).toBe(true);
  });

  it.each([
    ["future envelope", CONVERSATION_KEY_DOCUMENT_VERSION + 1, STORAGE_IDENTITY_VERSION],
    ["future identity", CONVERSATION_KEY_DOCUMENT_VERSION, STORAGE_IDENTITY_VERSION + 1],
  ] as const)("retains a key's %s diagnostic through the real credential migration gate", (_case, version, identityVersion) => {
    const { credentialPath, conversationKeyPath } = paths();
    const credentialBefore = writeRaw(
      credentialPath,
      credentialDocument(STORAGE_IDENTITY_VERSION),
    );
    const keyBefore = writeRaw(
      conversationKeyPath,
      keyDocument(version, identityVersion),
    );

    let caught: unknown;
    try {
      loadPersistedCredentialDocument({
        tenant: TENANT,
        accountId: ACCOUNT,
        saasBaseUrl: "https://saas.example",
      }, { home });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      document: "conversation-keys",
      code: "version-too-new",
    });
    const diagnostic = credentialStorageFailureDiagnostic(
      caught as StorageDocumentError,
    );
    expect(diagnostic).toMatchObject({
      code: "conversation-keys-version-too-new",
      detail: expect.stringContaining(
        "Run the plugin version that wrote it (or newer)",
      ),
    });
    expect(diagnostic.detail).not.toContain("legacy backup");
    expect(diagnostic.detail).not.toContain("retry");
    expect(readFileSync(credentialPath).equals(credentialBefore)).toBe(true);
    expect(readFileSync(conversationKeyPath).equals(keyBefore)).toBe(true);
    expect(quarantineSiblings(conversationKeyPath)).toEqual([]);
  });
});
