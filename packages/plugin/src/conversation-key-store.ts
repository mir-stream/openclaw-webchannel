/**
 * Conversation-key store — Phase 6 (multi-device E2E).
 *
 * The agent OWNS the per-peer conversation key K on the register-admission
 * path: K is generated ONCE per peerId (random 32 bytes), persisted, and
 * wrap-delivered to each of the user's devices (see `late-join-decryptor.ts`
 * `wrapConversationKey`) instead of being re-derived by a per-device X25519
 * handshake. That is what lets two devices of the SAME user (same peerId)
 * decrypt the SAME conversation concurrently — the second device no longer
 * overwrites the first one's key.
 *
 * Persistence
 * ───────────
 * `~/.openclaw-webchannel/<account>/conversation-keys.json` — the same
 * per-account secret directory (and the same plaintext-JSON + owner-only-perms
 * posture) as `credentials.json`, which already holds the strictly more
 * powerful NATS user seed. K must survive a gateway restart: history at rest
 * is sealed with it, and live devices hold an unwrapped copy that must stay
 * valid across agent restarts. K-at-rest encryption is deferred (a co-located
 * master key adds no real protection).
 *
 * File shape: `{ "version": 1, "keys": { "<peerId>": "<base64url 32B>" } }`.
 * Writes are atomic (tmp + rename), file mode 0600, directory mode 0700.
 *
 * A corrupt store file is renamed aside (`.corrupt-<ts>`) and the store starts
 * fresh: devices self-heal by re-registering (they receive a new K), at the
 * cost of old at-rest history becoming undecryptable — strictly better than
 * refusing to serve.
 */

import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { assertValidAccountId, credentialsRootDir } from "./account-config.js";
import { formatCapacityWarning, type CapacityStatus } from "./capacity-status.js";

export type { CapacityStatus } from "./capacity-status.js";
export { formatCapacityWarning } from "./capacity-status.js";

/**
 * S2 posture: ceiling on stored keys per account. peerIds on the register path
 * come from verified JWT `sub` claims, so real growth is bounded by real users;
 * the cap only engages under issuer abuse or routing mistakes. Hitting it is a
 * fail-closed admission error: persisted keys are cryptographic history roots
 * and must never be silently evicted.
 */
const DEFAULT_MAX_KEYS = 10_000;

const CONVERSATION_KEY_BYTES = 32;

type StoreFile = {
  version: 1;
  keys: Record<string, string>;
};

export type ConversationKeyStoreOptions = {
  /** Account whose secret dir the store lives in (validated against traversal). */
  accountId: string;
  /** Home dir override (tests). Defaults to `os.homedir()`. */
  home?: string;
  /** Key-count ceiling override (tests). Defaults to 10_000. */
  maxKeys?: number;
  /** Best-effort operational signal; does not alter the fixed ceiling. */
  onCapacityWarning?: (status: CapacityStatus) => void;
};

export class ConversationKeyCapacityError extends Error {
  readonly accountId: string;
  readonly currentKeys: number;
  readonly maxKeys: number;

  constructor(status: CapacityStatus) {
    super(
      `webchannel: account "${status.accountId}" conversation-key capacity ` +
        `${status.currentKeys}/${status.maxKeys}; existing keys preserved, new admission rejected`,
    );
    this.name = "ConversationKeyCapacityError";
    this.accountId = status.accountId;
    this.currentKeys = status.currentKeys;
    this.maxKeys = status.maxKeys;
  }
}

/**
 * Per-account persistent store of agent-owned conversation keys, keyed by
 * peerId. One instance per register-admission `NatsChannel`.
 *
 * All I/O is synchronous (matches the register hop's synchronous
 * `registerPeer` call-site and the enrollment-client credential writes).
 */
export class ConversationKeyStore {
  private readonly accountId: string;
  private readonly filePath: string;
  private readonly maxKeys: number;
  private readonly onCapacityWarning?: (status: CapacityStatus) => void;
  /** Lazily loaded on first access. Entries are never removed by this store. */
  private keys: Map<string, Uint8Array> | null = null;
  private capacityWarningEmitted = false;

  constructor(options: ConversationKeyStoreOptions) {
    assertValidAccountId(options.accountId);
    const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    if (!Number.isSafeInteger(maxKeys) || maxKeys <= 0) {
      throw new Error("webchannel: conversation-key maxKeys must be a positive safe integer");
    }
    const home = options.home ?? homedir();
    this.accountId = options.accountId;
    this.filePath = join(
      credentialsRootDir(home),
      options.accountId,
      "conversation-keys.json",
    );
    this.maxKeys = maxKeys;
    this.onCapacityWarning = options.onCapacityWarning;
  }

  /**
   * Return the stable conversation key for `peerId`, generating + persisting a
   * fresh random 32-byte key on first sight. NEVER regenerates an existing key
   * — stability across devices and restarts is the whole point.
   */
  getOrCreate(peerId: string): Uint8Array {
    if (!peerId || typeof peerId !== "string") {
      throw new Error("webchannel: peerId must be a non-empty string");
    }
    const keys = this.load();
    this.maybeWarnCapacity(keys.size);
    const existing = keys.get(peerId);
    if (existing) return existing;

    // Once this monotonic cache is full, disk cannot be below the cap under the
    // documented single-writer/no-external-edit precondition. Reject before an
    // O(n) fresh read so abuse at the boundary stays O(1).
    if (keys.size >= this.maxKeys) {
      throw this.capacityError(keys.size);
    }

    // Refresh immediately before a commit candidate is built. This preserves a
    // key committed by another sequential store instance without pretending
    // atomic rename is a cross-process CAS.
    const fresh = this.readFresh();
    this.maybeWarnCapacity(fresh.size);
    const freshExisting = fresh.get(peerId);
    if (freshExisting) {
      this.keys = fresh;
      return freshExisting;
    }
    if (fresh.size >= this.maxKeys) {
      this.keys = fresh;
      throw this.capacityError(fresh.size);
    }

    const key = new Uint8Array(randomBytes(CONVERSATION_KEY_BYTES));
    const next = new Map(fresh);
    next.set(peerId, key);
    this.persist(next);
    this.keys = next;
    this.maybeWarnCapacity(next.size);
    return key;
  }

  /** Return the stored key for `peerId`, or `null` if none exists. */
  get(peerId: string): Uint8Array | null {
    const keys = this.load();
    this.maybeWarnCapacity(keys.size);
    return keys.get(peerId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Internal persistence
  // -------------------------------------------------------------------------

  private load(): Map<string, Uint8Array> {
    if (this.keys) return this.keys;
    try {
      this.keys = this.readStoreFile();
    } catch (err) {
      if (isEnoent(err)) {
        this.keys = new Map();
        return this.keys;
      }
      // Corrupt store: move it aside and start fresh (devices self-heal via
      // re-register; see module docstring). Never serve with a half-read store.
      const aside = `${this.filePath}.corrupt-${Date.now()}`;
      console.error(
        `[conversation-key-store] corrupt store ${this.filePath} (${String(err)}); ` +
          `moving aside to ${aside} and starting fresh`,
      );
      try {
        renameSync(this.filePath, aside);
      } catch {
        /* best-effort — a failed rename still leaves us serving from empty */
      }
      this.keys = new Map();
    }
    return this.keys;
  }

  /** Read current durable state without invoking lazy-load quarantine policy. */
  private readFresh(): Map<string, Uint8Array> {
    try {
      return this.readStoreFile();
    } catch (err) {
      if (isEnoent(err)) return new Map();
      throw err;
    }
  }

  private readStoreFile(): Map<string, Uint8Array> {
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreFile;
    if (parsed.version !== 1 || typeof parsed.keys !== "object" || parsed.keys === null) {
      throw new Error("unrecognized store shape");
    }
    const keys = new Map<string, Uint8Array>();
    for (const [peerId, b64] of Object.entries(parsed.keys)) {
      if (typeof b64 !== "string") throw new Error(`key for ${peerId} is not a string`);
      const raw = new Uint8Array(Buffer.from(b64, "base64url"));
      if (raw.length !== CONVERSATION_KEY_BYTES) {
        throw new Error(`key for ${peerId} is not ${CONVERSATION_KEY_BYTES} bytes`);
      }
      keys.set(peerId, raw);
    }
    return keys;
  }

  private persist(keys: ReadonlyMap<string, Uint8Array>): void {
    const out: StoreFile = { version: 1, keys: Object.create(null) as Record<string, string> };
    for (const [peerId, key] of keys) {
      out.keys[peerId] = Buffer.from(key).toString("base64url");
    }
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Atomic replace so a crash mid-write never leaves a truncated store.
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 }); // rw-------
    renameSync(tmp, this.filePath);
  }

  private capacityError(currentKeys: number): ConversationKeyCapacityError {
    return new ConversationKeyCapacityError({
      accountId: this.accountId,
      currentKeys,
      maxKeys: this.maxKeys,
    });
  }

  private maybeWarnCapacity(currentKeys: number): void {
    if (this.capacityWarningEmitted || currentKeys * 10 < this.maxKeys * 9) return;
    this.capacityWarningEmitted = true;
    const status: CapacityStatus = {
      accountId: this.accountId,
      currentKeys,
      maxKeys: this.maxKeys,
    };
    try {
      if (this.onCapacityWarning) {
        this.onCapacityWarning(status);
      } else {
        console.warn(formatCapacityWarning(status));
      }
    } catch {
      try {
        console.warn(formatCapacityWarning(status));
      } catch {
        // Best effort only; diagnostics cannot change a durable key result.
      }
    }
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
