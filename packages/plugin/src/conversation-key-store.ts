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
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { assertValidAccountId, credentialsRootDir } from "./account-config.js";

/**
 * S2 posture: ceiling on stored keys per account. peerIds on the register path
 * come from verified JWT `sub` claims, so real growth is bounded by real users;
 * the cap only engages under issuer abuse, evicting the least-recently-created
 * key (insertion order). High enough that real single-tenant load never trips it.
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
};

/**
 * Per-account persistent store of agent-owned conversation keys, keyed by
 * peerId. One instance per register-admission `NatsChannel`.
 *
 * All I/O is synchronous (matches the register hop's synchronous
 * `registerPeer` call-site and the enrollment-client credential writes).
 */
export class ConversationKeyStore {
  private readonly filePath: string;
  private readonly maxKeys: number;
  /** Lazily loaded on first access; insertion-ordered for cap eviction. */
  private keys: Map<string, Uint8Array> | null = null;

  constructor(options: ConversationKeyStoreOptions) {
    assertValidAccountId(options.accountId);
    const home = options.home ?? homedir();
    this.filePath = join(
      credentialsRootDir(home),
      options.accountId,
      "conversation-keys.json",
    );
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
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
    const existing = keys.get(peerId);
    if (existing) return existing;

    const key = new Uint8Array(randomBytes(CONVERSATION_KEY_BYTES));
    // S2: enforce the ceiling BEFORE adding; evict the oldest-created key.
    while (keys.size >= this.maxKeys) {
      const oldest = keys.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      console.warn(
        `[conversation-key-store] key cap ${this.maxKeys} reached; evicting oldest peer ${oldest}`,
      );
      keys.delete(oldest);
    }
    keys.set(peerId, key);
    this.persist();
    return key;
  }

  /** Return the stored key for `peerId`, or `null` if none exists. */
  get(peerId: string): Uint8Array | null {
    return this.load().get(peerId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Internal persistence
  // -------------------------------------------------------------------------

  private load(): Map<string, Uint8Array> {
    if (this.keys) return this.keys;
    this.keys = new Map();
    if (!existsSync(this.filePath)) return this.keys;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreFile;
      if (parsed.version !== 1 || typeof parsed.keys !== "object" || parsed.keys === null) {
        throw new Error("unrecognized store shape");
      }
      for (const [peerId, b64] of Object.entries(parsed.keys)) {
        const raw = new Uint8Array(Buffer.from(b64, "base64url"));
        if (raw.length !== CONVERSATION_KEY_BYTES) {
          throw new Error(`key for ${peerId} is not ${CONVERSATION_KEY_BYTES} bytes`);
        }
        this.keys.set(peerId, raw);
      }
    } catch (err) {
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

  private persist(): void {
    const keys = this.keys ?? new Map<string, Uint8Array>();
    const out: StoreFile = { version: 1, keys: {} };
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
}
