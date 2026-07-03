/**
 * JWKS fetcher with TTL cache + kid lookup + fail-closed semantics.
 *
 * AUTH.md §10: a `jwt` strategy needs asymmetric public keys, sourced either from
 * a JWKS endpoint (preferred — supports kid rotation) or from an inline JWKS / a
 * JWKS file baked into the operator's deployment. This module is the I/O seam:
 * it hides `globalThis.fetch` and the filesystem behind a tiny `KeyResolver`
 * interface so `verifyJwt` (src/jwt.ts) can ask for a key by `kid` without
 * caring about provenance.
 *
 * CONSTRAINTS:
 *  - Zero new dependencies. Uses only `globalThis.fetch` (Workers + Node 18+
 *    both expose it) and the Node `node:fs` module when `jwksFile` is set.
 *  - Fail-closed: a fetch error or non-2xx response NEVER falls back to a stale
 *    cache. The cache is cleared on any failure so a transient outage cannot
 *    mint credentials from a stale key (see kid-rotation note in AUTH.md §10).
 *  - 5-minute TTL by default. Tunable via `ttlMs` so tests can drive expiry.
 *  - Kid miss in cached JWKS → ONE immediate refetch. If still missing after
 *    refetch, THROW (so the verifier can fail closed). This is the one allowed
 *    "best-effort" revalidation because a key can be rotated between TTLs and
 *    a stale cache must not silently wedge new connections.
 */

import { readFile } from "node:fs/promises";

/**
 * A JWKS SOURCE was unreachable — network error, non-2xx response, non-JSON
 * body, or a file read/decode failure. This is a TRANSIENT infrastructure fault
 * ("I could not check the key"), distinct from a genuine key MISS ("this kid does
 * not exist", a plain `Error`) or a bad token. Callers use this to answer a
 * retryable "unavailable" instead of a terminal "unauthorized", so a momentary
 * IdP/JWKS hiccup doesn't permanently kill a session — WITHOUT becoming an oracle
 * (both outcomes are still non-admit; only the retry disposition differs).
 */
export class JwksUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "JwksUnavailableError";
  }
}

/**
 * A single JWK with the subset of fields we care about. Mirrors RFC 7517 / 7518
 * §6.3.1 (RSA public key). `kid` is optional in the spec but required here for
 * lookup; `alg` is enforced at verify-time, not here. We keep the type narrow
 * (just what we read) and ignore unknown keys silently — IdPs commonly include
 * EC keys alongside RSA in a JWKS, and we should accept the document as long as
 * the RSA keys we want are present.
 *
 * NOTE: `kty` is typed as optional to match the DOM lib's `JsonWebKey`
 * (which is what `crypto.subtle.exportKey("jwk", ...)` returns). At runtime
 * every real JWK carries `kty`; we just don't structurally enforce it because
 * the Web Crypto API types make it optional.
 */
export type JsonWebKey = {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  // Additional fields (x5c, x5t, ...) are accepted as `unknown` and ignored.
  [extra: string]: unknown;
};

/** A JWKS document — `keys` is the array the resolver iterates over. */
export type JsonWebKeySet = { keys: JsonWebKey[] };

/**
 * The lookup interface `verifyJwt` consumes. Implementations: `JWKSCache`
 * (URL / file / inline — this file), and tests can swap in their own.
 *
 * `getKey(kid)` resolves a public key for `kid`:
 *  - returns the JWK on success
 *  - THROWS on miss-after-refetch, fetch failure, or any I/O error
 *    (callers MUST treat throw as a hard auth failure)
 */
export type KeyResolver = {
  getKey(kid: string): Promise<JsonWebKey>;
};

export type JWKSCacheOptions = {
  /** How long a cached JWKS document is considered fresh. Default 5 min. */
  ttlMs?: number;
  /**
   * Override the fetch implementation. Defaults to `globalThis.fetch`. Tests
   * inject a stub; production code leaves it untouched.
   */
  fetchImpl?: typeof fetch;
  /**
   * Override the filesystem read. Defaults to `node:fs/promises.readFile`.
   * Exists for parity with `fetchImpl` — not needed today but keeps the door
   * open for runtime adapters that don't have `node:fs` (e.g. some sandboxed
   * Workers environments).
   */
  readFileImpl?: (path: string) => Promise<Uint8Array>;
};

/** Default TTL: 5 minutes, matching the spec and the OWASP JWT guidance. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * The fetch / file / inline union. Construct via the static `JWKSCache.create`
 * factory (it picks the right loader). Direct construction is reserved for
 * tests that need to control every knob.
 */
export type JWKSCacheOptionsFull = JWKSCacheOptions & {
  /** Exactly one of these three. Validated by the factory. */
  source:
    | { kind: "url"; url: string }
    | { kind: "file"; path: string }
    | { kind: "inline"; jwks: JsonWebKeySet };
};

/**
 * Fetch a JWKS document from a URL. Throws on any non-2xx status or network
 * failure. The fetch response is consumed and closed before we return so a
 * half-consumed stream can't leak the connection (Workers edge case).
 */
async function fetchJwks(
  url: string,
  fetchImpl: typeof fetch,
): Promise<JsonWebKeySet> {
  let res: Awaited<ReturnType<typeof fetchImpl>>;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    // Network-level failure (DNS, connection refused, timeout) — transient.
    throw new JwksUnavailableError(
      `webchannel: JWKS fetch failed for ${url}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (!res.ok) {
    // Consume + discard so the body isn't leaked, then throw.
    try {
      await res.text();
    } catch {
      /* ignore — we're already failing */
    }
    // A non-2xx from the JWKS endpoint is an infra fault, not a token verdict.
    throw new JwksUnavailableError(
      `webchannel: JWKS fetch failed for ${url}: HTTP ${res.status}`,
    );
  }
  let doc: unknown;
  try {
    doc = await res.json();
  } catch (err) {
    throw new JwksUnavailableError(
      `webchannel: JWKS fetch from ${url} returned non-JSON body: ${(err as Error).message}`,
      { cause: err },
    );
  }
  return parseJwks(doc);
}

/** Read + parse a JWKS file from disk. Throws on missing file or bad JSON. */
async function loadJwksFile(path: string, readFileImpl: (p: string) => Promise<Uint8Array>): Promise<JsonWebKeySet> {
  let bytes: Uint8Array;
  try {
    bytes = await readFileImpl(path);
  } catch (err) {
    // A missing/unreadable file is an infra fault (deploy/mount), not a verdict.
    throw new JwksUnavailableError(
      `webchannel: JWKS file read failed for ${path}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8").decode(bytes);
  } catch (err) {
    throw new JwksUnavailableError(
      `webchannel: JWKS file at ${path} is not valid UTF-8: ${(err as Error).message}`,
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `webchannel: JWKS file at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  return parseJwks(parsed);
}

/** Structural validation for a parsed JWKS document. */
function parseJwks(doc: unknown): JsonWebKeySet {
  if (!doc || typeof doc !== "object") {
    throw new Error("webchannel: JWKS document must be an object");
  }
  const keys = (doc as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) {
    throw new Error("webchannel: JWKS document must have a `keys` array");
  }
  return { keys: keys as JsonWebKey[] };
}

export class JWKSCache implements KeyResolver {
  private readonly source: JWKSCacheOptionsFull["source"];
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly readFileImpl: (path: string) => Promise<Uint8Array>;

  /**
   * The cached document + the wall-clock time (ms) we captured it. We store the
   * fetch time rather than the expiry time so tests can advance `Date.now`
   * without having to keep the absolute expiry in sync.
   *
   * `null` means no successful fetch has happened yet (initial state) or the
   * most recent fetch failed and we cleared the cache per the fail-closed rule.
   */
  private cache: { doc: JsonWebKeySet; fetchedAtMs: number } | null = null;

  /**
   * Per-instance guard against re-entrant fetches. A refetch triggered by a kid
   * miss should not loop forever if the kid simply doesn't exist; we also use
   * this to deduplicate concurrent misses so 100 simultaneous connections
   * arriving with an unknown kid produce ONE refetch, not 100.
   */
  private inflightRefetch: Promise<JsonWebKeySet> | null = null;

  private constructor(opts: JWKSCacheOptionsFull) {
    this.source = opts.source;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.readFileImpl =
      opts.readFileImpl ??
      (async (p) => {
        const buf = await readFile(p);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      });
  }

  /**
   * Build a cache from exactly one of `jwksUrl`, `jwksFile`, `jwks`. Throws if
   * none or more than one is supplied (fail-closed at construction — the spec
   * requires a working source, not a guessed one).
   */
  static create(
    args: {
      jwksUrl?: string;
      jwksFile?: string;
      jwks?: JsonWebKeySet;
    },
    options?: JWKSCacheOptions,
  ): JWKSCache {
    const provided: Array<keyof typeof args> = [];
    if (args.jwksUrl !== undefined) provided.push("jwksUrl");
    if (args.jwksFile !== undefined) provided.push("jwksFile");
    if (args.jwks !== undefined) provided.push("jwks");
    if (provided.length !== 1) {
      throw new Error(
        `webchannel: jwt strategy requires exactly one of jwksUrl, jwksFile, or jwks (got ${provided.length}). Refusing to start.`,
      );
    }
    let source: JWKSCacheOptionsFull["source"];
    if (args.jwksUrl !== undefined) source = { kind: "url", url: args.jwksUrl };
    else if (args.jwksFile !== undefined)
      source = { kind: "file", path: args.jwksFile };
    else source = { kind: "inline", jwks: args.jwks as JsonWebKeySet };
    return new JWKSCache({ ...(options ?? {}), source });
  }

  /**
   * Look up a public key by `kid`. Returns the JWK on hit.
   *
   * Semantics (AC4 / AC5):
   *  1. Try the freshest available doc (inline → cache → fresh fetch). If the
   *     kid is present, return it. (TTL hit = 0 additional fetches.)
   *  2. If the kid is missing from that doc, refetch ONCE (kid-rotation safety
   *     net — a key can be rotated between TTLs, and a stale cache must not
   *     silently wedge new connections).
   *  3. If the refetch STILL lacks the kid, THROW.
   *  4. On any fetch failure or non-2xx response, the cache is CLEARED and the
   *     error is rethrown (fail-closed; never serve stale).
   *
   * THROWS on miss-after-refetch, fetch error, or non-2xx response. Callers
   * MUST treat throw as a hard auth failure (the gateway rejects the upgrade).
   */
  async getKey(kid: string): Promise<JsonWebKey> {
    if (typeof kid !== "string" || kid.length === 0) {
      throw new Error("webchannel: getKey requires a non-empty kid");
    }

    // Step 1: best-effort doc. `maybeLoadFromCache` returns inline JWKS
    // directly (no fetch), or the cached doc if fresh, or null.
    const initial =
      (await this.maybeLoadFromCache()) ?? (await this.loadFresh());

    const initialHit = this.findKey(initial, kid);
    if (initialHit) return initialHit;

    // Step 2: kid miss → ONE refetch (rotation safety net). Inline JWKS has
    // no remote source to refresh, so a miss on inline is a hard miss.
    if (this.source.kind === "inline") {
      throw new Error(`webchannel: kid "${kid}" not found in JWKS`);
    }
    this.cache = null;
    const refreshed = await this.loadFresh();
    const refreshedHit = this.findKey(refreshed, kid);
    if (!refreshedHit) {
      throw new Error(
        `webchannel: kid "${kid}" not found in JWKS (after refresh)`,
      );
    }
    return refreshedHit;
  }

  /**
   * Preflight warm-up: resolve the JWKS document ONCE (honoring the TTL cache)
   * and return it, so a startup/enroll-time gate can COUNT keys or surface a
   * fetch failure eagerly — instead of the failure only appearing lazily on the
   * first browser register. This reuses the EXACT same "best-effort doc" path
   * `getKey` step 1 uses (inline → fresh cache → one fetch), so it opens no
   * second fetcher and primes the very cache the register/challenge routes read.
   *
   * THROWS `JwksUnavailableError` on a transient fetch/file failure (fail-closed;
   * never returns a stale doc). A successful resolve may legitimately return a
   * document with ZERO keys — the caller decides that is a hard preflight FAIL
   * ("cannot verify any bootstrap JWT"), which this method does NOT itself treat
   * as an error (an empty-but-served JWKS is not an I/O fault).
   */
  async warm(): Promise<JsonWebKeySet> {
    return (await this.maybeLoadFromCache()) ?? (await this.loadFresh());
  }

  /**
   * Return the cached document if it's still fresh. Returns `null` if there is
   * no cache or the cache has expired (in which case the caller will refetch).
   *
   * Exposed only via `getKey`; do not call directly.
   */
  private async maybeLoadFromCache(): Promise<JsonWebKeySet | null> {
    if (this.source.kind === "inline") {
      // Inline JWKS never changes — return it directly without caching.
      return this.source.jwks;
    }
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAtMs < this.ttlMs) {
      return this.cache.doc;
    }
    return null;
  }

  /**
   * Force a fresh fetch from the underlying source, updating the cache on
   * success and clearing it on failure. Concurrent callers share the same
   * in-flight promise so a kid miss during a fan-out triggers one fetch, not N.
   */
  private async loadFresh(): Promise<JsonWebKeySet> {
    if (this.inflightRefetch) return this.inflightRefetch;

    const promise = (async (): Promise<JsonWebKeySet> => {
      try {
        let doc: JsonWebKeySet;
        if (this.source.kind === "url") {
          doc = await fetchJwks(this.source.url, this.fetchImpl);
        } else if (this.source.kind === "file") {
          doc = await loadJwksFile(this.source.path, this.readFileImpl);
        } else {
          // Inline already handled in maybeLoadFromCache; this branch is
          // defensive only.
          doc = this.source.jwks;
        }
        // Only cache when the source can actually change (URL, file). Inline
        // docs are immutable for the life of the cache instance.
        if (this.source.kind !== "inline") {
          this.cache = { doc, fetchedAtMs: Date.now() };
        }
        return doc;
      } catch (err) {
        // Fail-closed: clear the cache so the next call re-attempts instead of
        // serving the previous (now-stale) document. Re-throw so the caller
        // surfaces the failure.
        this.cache = null;
        throw err;
      }
    })();

    this.inflightRefetch = promise;
    try {
      return await promise;
    } finally {
      this.inflightRefetch = null;
    }
  }

  /** Linear scan for a key matching `kid`. Inline JWKS may have dozens of keys;
   *  that's tiny, so we keep this simple. */
  private findKey(doc: JsonWebKeySet, kid: string): JsonWebKey | undefined {
    for (const k of doc.keys) {
      if (k && typeof k === "object" && k.kid === kid) return k;
    }
    return undefined;
  }
}