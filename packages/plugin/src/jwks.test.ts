import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webcrypto } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { JWKSCache, JwksLifecycleAbortError, type JsonWebKeySet } from "./jwks.js";

/**
 * Tests for the JWKS fetcher + TTL cache + kid lookup + fail-closed semantics.
 *
 * Mirrors the style of ticket.test.ts (vitest + zero-dep setup). Uses
 * `webcrypto.subtle.generateKey` to mint a real RSA-2048 keypair so the test
 * fixtures are byte-compatible with what a real IdP would publish.
 */

async function mintRsaJwks(kid: string): Promise<JsonWebKeySet> {
  const pair = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  return { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] };
}

function mockFetchWith(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function mockFetchThrowing(message: string): typeof fetch {
  return vi.fn(async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

function mockFetchStatus(status: number, body = "error"): typeof fetch {
  return vi.fn(async () => {
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "jwks-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("JWKSCache TTL cache (AC4)", () => {
  it("serves two getKey calls within TTL with only ONE fetch", async () => {
    const jwks = await mintRsaJwks("k1");
    const fetchImpl = mockFetchWith(jwks);
    const cache = JWKSCache.create({ jwksUrl: "https://idp.test/jwks.json" }, { fetchImpl });

    const a = await cache.getKey("k1");
    const b = await cache.getKey("k1");
    expect(a.kid).toBe("k1");
    expect(b.kid).toBe("k1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches once after the TTL expires", async () => {
    const jwksA = await mintRsaJwks("k1");
    const jwksB = await mintRsaJwks("k1");
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      const body = call === 1 ? jwksA : jwksB;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const cache = JWKSCache.create(
      { jwksUrl: "https://idp.test/jwks.json" },
      { fetchImpl, ttlMs: 50 },
    );

    await cache.getKey("k1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Wait past the TTL.
    await new Promise((r) => setTimeout(r, 70));
    await cache.getKey("k1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("JWKSCache kid miss (AC4)", () => {
  it("refetches ONCE when kid is missing from fresh cache; if still missing, throws", async () => {
    const jwksA: JsonWebKeySet = { keys: [{ kty: "RSA", kid: "k1", alg: "RS256", use: "sig", n: "n", e: "AQAB" }] };
    const jwksB: JsonWebKeySet = { keys: [{ kty: "RSA", kid: "k1", alg: "RS256", use: "sig", n: "n", e: "AQAB" }] };
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      const body = call === 1 ? jwksA : jwksB;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const cache = JWKSCache.create(
      { jwksUrl: "https://idp.test/jwks.json" },
      { fetchImpl, ttlMs: 60_000 },
    );

    await expect(cache.getKey("unknown")).rejects.toThrow(/not found in JWKS/);
    // Two fetches: one cold fetch + one refetch because kid was missing.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns the kid on the refetch (rotation: fresh JWKS now contains the new kid)", async () => {
    const jwksA: JsonWebKeySet = { keys: [{ kty: "RSA", kid: "k1", alg: "RS256", use: "sig", n: "n", e: "AQAB" }] };
    const jwksB: JsonWebKeySet = {
      keys: [
        { kty: "RSA", kid: "k1", alg: "RS256", use: "sig", n: "n", e: "AQAB" },
        { kty: "RSA", kid: "k2", alg: "RS256", use: "sig", n: "n2", e: "AQAB" },
      ],
    };
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      const body = call === 1 ? jwksA : jwksB;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const cache = JWKSCache.create(
      { jwksUrl: "https://idp.test/jwks.json" },
      { fetchImpl, ttlMs: 60_000 },
    );
    const key = await cache.getKey("k2");
    expect(key.kid).toBe("k2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent unknown-kid fetches into ONE refetch", async () => {
    const jwksA: JsonWebKeySet = { keys: [{ kty: "RSA", kid: "k1", alg: "RS256", use: "sig", n: "n", e: "AQAB" }] };
    const jwksB: JsonWebKeySet = {
      keys: [
        { kty: "RSA", kid: "k1", alg: "RS256", use: "sig", n: "n", e: "AQAB" },
        { kty: "RSA", kid: "k2", alg: "RS256", use: "sig", n: "n2", e: "AQAB" },
      ],
    };
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      // Slight delay so multiple awaiters race onto the same in-flight promise.
      await new Promise((r) => setTimeout(r, 10));
      const body = call === 1 ? jwksA : jwksB;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const cache = JWKSCache.create(
      { jwksUrl: "https://idp.test/jwks.json" },
      { fetchImpl, ttlMs: 60_000 },
    );
    const results = await Promise.allSettled([cache.getKey("k2"), cache.getKey("k2"), cache.getKey("k2")]);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
      if (r.status === "fulfilled") expect(r.value.kid).toBe("k2");
    }
    // Cold fetch + ONE refetch = 2 calls total, not 4.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("JWKSCache fail-closed (AC5)", () => {
  it("throws on a non-2xx response and clears the cache (next call refetches)", async () => {
    const goodJwks: JsonWebKeySet = { keys: [{ kty: "RSA", kid: "k1", alg: "RS256", use: "sig", n: "n", e: "AQAB" }] };
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response("internal error", { status: 500 });
      return new Response(JSON.stringify(goodJwks), { status: 200 });
    }) as unknown as typeof fetch;

    const cache = JWKSCache.create(
      { jwksUrl: "https://idp.test/jwks.json" },
      { fetchImpl, ttlMs: 60_000 },
    );

    await expect(cache.getKey("k1")).rejects.toThrow(/JWKS fetch failed.*500/);
    // The next call should NOT serve a stale cache entry — it must refetch.
    const key = await cache.getKey("k1");
    expect(key.kid).toBe("k1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws on a fetch network error and clears the cache", async () => {
    const goodJwks: JsonWebKeySet = { keys: [{ kty: "RSA", kid: "k1", alg: "RS256", use: "sig", n: "n", e: "AQAB" }] };
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify(goodJwks), { status: 200 });
    }) as unknown as typeof fetch;

    const cache = JWKSCache.create(
      { jwksUrl: "https://idp.test/jwks.json" },
      { fetchImpl, ttlMs: 60_000 },
    );

    await expect(cache.getKey("k1")).rejects.toThrow(/ECONNREFUSED/);
    const key = await cache.getKey("k1");
    expect(key.kid).toBe("k1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws on a non-JSON body and clears the cache", async () => {
    const goodJwks: JsonWebKeySet = { keys: [{ kty: "RSA", kid: "k1", alg: "RS256", use: "sig", n: "n", e: "AQAB" }] };
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response("<html>not json</html>", { status: 200 });
      return new Response(JSON.stringify(goodJwks), { status: 200 });
    }) as unknown as typeof fetch;

    const cache = JWKSCache.create(
      { jwksUrl: "https://idp.test/jwks.json" },
      { fetchImpl, ttlMs: 60_000 },
    );

    await expect(cache.getKey("k1")).rejects.toThrow(/non-JSON/);
    const key = await cache.getKey("k1");
    expect(key.kid).toBe("k1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws on a JWKS document missing a `keys` array", async () => {
    const fetchImpl = mockFetchWith({ not: "a jwks" });
    const cache = JWKSCache.create({ jwksUrl: "https://idp.test/jwks.json" }, { fetchImpl });
    await expect(cache.getKey("k1")).rejects.toThrow(/keys.*array/);
  });
});

describe("JWKSCache inline + file sources", () => {
  it("serves an inline JWKS without ever fetching", async () => {
    const jwks = await mintRsaJwks("inline-k");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const cache = JWKSCache.create({ jwks }, { fetchImpl });
    const k = await cache.getKey("inline-k");
    expect(k.kid).toBe("inline-k");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects when neither jwksUrl, jwksFile, nor jwks is provided", () => {
    expect(() => JWKSCache.create({})).toThrow(/exactly one of/);
  });

  it("rejects when more than one source is provided", () => {
    expect(() =>
      JWKSCache.create({ jwksUrl: "https://x", jwks: { keys: [] } }),
    ).toThrow(/exactly one of/);
  });

  it("reads a JWKS from disk (jwksFile) and does not call fetch", async () => {
    const jwks = await mintRsaJwks("file-k");
    const file = path.join(tmpDir, "jwks.json");
    await writeFile(file, JSON.stringify(jwks), "utf8");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const cache = JWKSCache.create({ jwksFile: file }, { fetchImpl });
    const k = await cache.getKey("file-k");
    expect(k.kid).toBe("file-k");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when the jwksFile path is missing", async () => {
    const cache = JWKSCache.create(
      { jwksFile: path.join(tmpDir, "does-not-exist.json") },
      {},
    );
    await expect(cache.getKey("k1")).rejects.toThrow(/JWKS file read failed/);
  });

  it("throws when the jwksFile content is not JSON", async () => {
    const file = path.join(tmpDir, "bad.json");
    await writeFile(file, "not json", "utf8");
    const cache = JWKSCache.create({ jwksFile: file }, {});
    await expect(cache.getKey("k1")).rejects.toThrow(/not valid JSON/);
  });

  it("throws when the jwksFile JSON is missing a `keys` array", async () => {
    const file = path.join(tmpDir, "shape.json");
    await writeFile(file, JSON.stringify({ not: "jwks" }), "utf8");
    const cache = JWKSCache.create({ jwksFile: file }, {});
    await expect(cache.getKey("k1")).rejects.toThrow(/keys.*array/);
  });
});

describe("JWKSCache input validation", () => {
  it("throws on an empty kid", async () => {
    const jwks = await mintRsaJwks("k1");
    const cache = JWKSCache.create({ jwks }, {});
    await expect(cache.getKey("")).rejects.toThrow(/non-empty kid/);
  });
});

describe("JWKSCache TTL boundary", () => {
  it("still serves from cache at exactly ttlMs - 1 (no refetch)", async () => {
    const jwks = await mintRsaJwks("k1");
    const fetchImpl = mockFetchWith(jwks);
    const cache = JWKSCache.create(
      { jwksUrl: "https://idp.test/jwks.json" },
      { fetchImpl, ttlMs: 100 },
    );
    await cache.getKey("k1");
    await new Promise((r) => setTimeout(r, 90));
    await cache.getKey("k1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches after ttlMs (expiry)", async () => {
    const jwks = await mintRsaJwks("k1");
    const fetchImpl = mockFetchWith(jwks);
    const cache = JWKSCache.create(
      { jwksUrl: "https://idp.test/jwks.json" },
      { fetchImpl, ttlMs: 50 },
    );
    await cache.getKey("k1");
    await new Promise((r) => setTimeout(r, 70));
    await cache.getKey("k1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("JWKSCache HTTP status surfaces", () => {
  it("rejects 401/403/404/500 with a descriptive message", async () => {
    for (const status of [401, 403, 404, 500]) {
      const fetchImpl = mockFetchStatus(status);
      const cache = JWKSCache.create(
        { jwksUrl: "https://idp.test/jwks.json" },
        { fetchImpl },
      );
      await expect(cache.getKey("k1")).rejects.toThrow(
        new RegExp(`JWKS fetch failed.*HTTP ${status}`),
      );
    }
  });
});

describe("JWKSCache lifecycle cancellation", () => {
  it("lets a startup subscriber abort without cancelling a surviving subscriber", async () => {
    const jwks = await mintRsaJwks("k1");
    let resolveFetch!: (response: Response) => void;
    let sourceSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      sourceSignal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    }) as unknown as typeof fetch;
    const cache = JWKSCache.create({ jwksUrl: "https://idp.test/jwks.json" }, { fetchImpl });
    const firstController = new AbortController();
    const survivorController = new AbortController();
    const first = cache.warm(10_000, firstController.signal);
    const survivor = cache.warm(10_000, survivorController.signal);
    firstController.abort();
    await expect(first).rejects.toBeInstanceOf(JwksLifecycleAbortError);
    expect(sourceSignal?.aborted).toBe(false);
    resolveFetch(new Response(JSON.stringify(jwks), { status: 200 }));
    await expect(survivor).resolves.toEqual(jwks);
  });

  it("aborts/fences the source after the last subscriber leaves and ignores a late result", async () => {
    const jwks = await mintRsaJwks("late");
    const pending: Array<(response: Response) => void> = [];
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>((resolve) => pending.push(resolve));
    }) as unknown as typeof fetch;
    const cache = JWKSCache.create({ jwksUrl: "https://idp.test/jwks.json" }, { fetchImpl });
    const controller = new AbortController();
    const abandoned = cache.warm(10_000, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(abandoned).rejects.toBeInstanceOf(JwksLifecycleAbortError);
    expect(signals[0]?.aborted).toBe(true);
    pending[0]!(new Response(JSON.stringify(jwks), { status: 200 }));
    const next = cache.warm(10_000);
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    pending[1]!(new Response(JSON.stringify(jwks), { status: 200 }));
    await expect(next).resolves.toEqual(jwks);
  });

  it("aborts during a non-cooperative response body read and fences its late JSON result", async () => {
    const jwks = await mintRsaJwks("body-late");
    const bodyResolvers: Array<(doc: JsonWebKeySet) => void> = [];
    const sourceSignals: AbortSignal[] = [];
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      sourceSignals.push(init?.signal as AbortSignal);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise<JsonWebKeySet>((resolve) => bodyResolvers.push(resolve)),
      } as Response);
    }) as unknown as typeof fetch;
    const cache = JWKSCache.create({ jwksUrl: "https://idp.test/jwks.json" }, { fetchImpl });
    const controller = new AbortController();
    const first = cache.warm(10_000, controller.signal);
    await vi.waitFor(() => expect(bodyResolvers).toHaveLength(1));
    controller.abort();
    await expect(first).rejects.toBeInstanceOf(JwksLifecycleAbortError);
    expect(sourceSignals[0]?.aborted).toBe(true);
    bodyResolvers[0]!(jwks);
    const second = cache.warm(10_000);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(bodyResolvers).toHaveLength(2));
    bodyResolvers[1]!(jwks);
    await expect(second).resolves.toEqual(jwks);
  });

  it("passes cancellation to a file read, rejects promptly, and ignores late bytes", async () => {
    const jwks = await mintRsaJwks("file-late");
    const readResolvers: Array<(bytes: Uint8Array) => void> = [];
    const sourceSignals: AbortSignal[] = [];
    const readFileImpl = vi.fn((_path: string, signal?: AbortSignal) => {
      if (signal) sourceSignals.push(signal);
      return new Promise<Uint8Array>((resolve) => readResolvers.push(resolve));
    });
    const cache = JWKSCache.create({ jwksFile: "/virtual/jwks.json" }, { readFileImpl });
    const controller = new AbortController();
    const first = cache.warm(10_000, controller.signal);
    await Promise.resolve();
    expect(readFileImpl).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(first).rejects.toBeInstanceOf(JwksLifecycleAbortError);
    expect(sourceSignals[0]?.aborted).toBe(true);
    readResolvers[0]!(new TextEncoder().encode(JSON.stringify(jwks)));
    const second = cache.warm(10_000);
    await Promise.resolve();
    expect(readFileImpl).toHaveBeenCalledTimes(2);
    readResolvers[1]!(new TextEncoder().encode(JSON.stringify(jwks)));
    await expect(second).resolves.toEqual(jwks);
  });
});
