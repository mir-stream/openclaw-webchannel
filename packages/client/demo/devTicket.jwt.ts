/**
 * DEMO-ONLY browser-side RS256 / JWKS JWT issuer (vanilla; no framework).
 *
 * ⚠️ Mints the `jwt` (RS256) ticket IN THE BROWSER using a self-generated
 * RSA-2048 keypair, exposing the private key to every visitor — NOT secure.
 * It exists only so the `jwt` auth strategy can be exercised without a real
 * IdP. In production the IdP (Auth0 / Clerk / Keycloak / your own backend)
 * issues JWTs server-side and the app receives them via `getTicket`
 * (AUTH.md §10).
 *
 * Mirrors the React example's `devTicket.ts`, kept framework-free. Uses the
 * Web Crypto API (`crypto.subtle`) — the same byte-compatible verification
 * path the server's `verifyJwt` (src/jwt.ts) uses, so a token minted here
 * round-trips against `verifyJwt` exactly as a real IdP-issued token would.
 *
 * USAGE:
 *   import { initDevJwtIssuer, makeDevGetJwtTicket } from "./devTicket.jwt.js";
 *   const issuer = await initDevJwtIssuer({
 *     issuer: "https://demo.local/",
 *     audience: "webchannel-demo",
 *   });
 *   const getTicket = makeDevGetJwtTicket(issuer, "alice");
 *   new WebChannelClient({ getTicket, ... });
 */

const encoder = new TextEncoder();

/**
 * Extended `JsonWebKey` with the lookup-by-`kid` fields we need. The DOM lib's
 * `JsonWebKey` doesn't expose `kid`/`alg`/`use` as known properties (RFC 7517
 * §4.5 marks `kid` as OPTIONAL with arbitrary semantics), so we declare a
 * narrow structural type that mirrors what `crypto.subtle.importKey("jwk", …)`
 * actually accepts — anything beyond `kty`+`alg`+`use`+key-material is extra.
 */
export type DemoJsonWebKey = JsonWebKey & {
  kid?: string;
  alg?: string;
  use?: string;
};

/**
 * Filesystem cache locations for the demo keypair. In a real deployment the
 * IdP holds the private key; here we lazily generate an RSA-2048 keypair on
 * first run and persist it to localStorage (browser) or the configured cache
 * dir (Node-side smoke). The cache is keyed by `cacheKey` so multiple demo
 * configurations (different issuer / audience) don't collide.
 */

export type InitDevJwtIssuerOptions = {
  /** `iss` claim to embed in demo tokens. */
  issuer: string;
  /** `aud` claim to embed in demo tokens. */
  audience: string;
  /** Override the `kid` header. Default `"demo-kid-1"`. */
  kid?: string;
  /**
   * Override the localStorage key (browser) or file path (Node). The default
   * is `<issuer>|<audience>` — multiple configs don't collide.
   */
  cacheKey?: string;
  /**
   * Default token TTL in seconds. Default 60. Mirrors the hmac-ticket demo so
   * a user swapping strategies doesn't have to think about lifetimes.
   */
  ttlSeconds?: number;
  /**
   * Inject a custom storage backend (e.g. for tests that want an in-memory
   * store). Defaults to `globalThis.localStorage` when available, falling
   * back to a Node-side file in `demo/.cache/jwt-private.json`.
   */
  storage?: DevJwtStorage;
};

export type DevJwtStorage = {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
};

/**
 * Active issuer instance. The same keypair can mint unlimited tickets; the
 * `signJwt` method carries the `iss` / `aud` from the config.
 */
export type DevJwtIssuer = {
  issuer: string;
  audience: string;
  kid: string;
  ttlSeconds: number;
  privateKey: CryptoKey;
  /** Public JWK form, suitable for handing to a JWKS-publishing endpoint. */
  publicJwk: DemoJsonWebKey;
  /** Convenience: sign a ticket for `sub` with default TTL. */
  signJwt(sub: string, ttlSeconds?: number): Promise<string>;
};

/**
 * Build a `getTicket` callback suitable for `WebChannelClient`. Mints a fresh
 * ticket on every (re)connect so a reconnect gets a non-expired token (same
 * pattern as `makeDevGetTicket` for hmac-ticket).
 */
export function makeDevGetJwtTicket(
  dev: DevJwtIssuer,
  sub: string,
  ttlSeconds?: number,
): () => Promise<string> {
  return () => dev.signJwt(sub, ttlSeconds);
}

/**
 * Initialize the demo JWT issuer. Generates an RSA-2048 keypair if no cached
 * one is available; otherwise loads the cached private key (JWK form) and
 * re-imports it. Idempotent across reloads: subsequent calls reuse the same
 * keypair so a browser refresh during a chat doesn't yank identity.
 *
 * Returns the active issuer; callers should also retain the JWKS form (via
 * `dev.publicJwk`) for any operator-facing debug view.
 */
export async function initDevJwtIssuer(
  opts: InitDevJwtIssuerOptions,
): Promise<DevJwtIssuer> {
  const kid = opts.kid ?? "demo-kid-1";
  const ttlSeconds = opts.ttlSeconds ?? 60;
  const storage = opts.storage ?? defaultStorage(opts);

  const cached = await storage.read();
  let privateKey: CryptoKey;
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as JsonWebKey;
      privateKey = await crypto.subtle.importKey(
        "jwk",
        parsed,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        true,
        ["sign"],
      );
    } catch {
      // Cached entry was corrupted; fall through and regenerate.
      privateKey = await generateAndPersist(storage);
    }
  } else {
    privateKey = await generateAndPersist(storage);
  }

  // Derive the public JWK by exporting the private key and STRIPPING the
  // private fields (`d`, `p`, `q`, `dp`, `dq`, `qi`, `key_ops`). The Web Crypto
  // API refuses to import a JWK as `verify`-usage if it still carries
  // private-key material ("Unsupported key usage for an RSASSA-PKCS1-v1_5 key").
  const privJwk = await crypto.subtle.exportKey("jwk", privateKey);
  const publicJwkRaw: JsonWebKey = {
    kty: privJwk.kty,
    n: privJwk.n,
    e: privJwk.e,
  };
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicJwkRaw,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"],
  );
  void publicKey; // exported below for symmetry; the raw JWK is what consumers want
  const typedPublicJwk: DemoJsonWebKey = {
    ...publicJwkRaw,
    kid,
    alg: "RS256",
    use: "sig",
  };

  return {
    issuer: opts.issuer,
    audience: opts.audience,
    kid,
    ttlSeconds,
    privateKey,
    publicJwk: typedPublicJwk,
    async signJwt(sub: string, ttlOverride?: number) {
      const iat = Math.floor(Date.now() / 1000);
      const exp = iat + (ttlOverride ?? ttlSeconds);
      const header = b64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid })));
      const payload = b64url(
        encoder.encode(
          JSON.stringify({
            iss: opts.issuer,
            aud: opts.audience,
            sub,
            iat,
            exp,
          }),
        ),
      );
      const signingInput = `${header}.${payload}`;
      const sig = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        privateKey,
        encoder.encode(signingInput),
      );
      return `${signingInput}.${b64url(new Uint8Array(sig))}`;
    },
  };
}

/**
 * Default storage: `globalThis.localStorage` when available (browser /
 * Vite dev), otherwise a Node-side file in `demo/.cache/jwt-private.json`.
 * Tests inject their own `storage` so they don't touch the real fs.
 */
function defaultStorage(opts: InitDevJwtIssuerOptions): DevJwtStorage {
  if (typeof globalThis.localStorage !== "undefined") {
    const key = `webchannel-demo-jwt:${opts.cacheKey ?? `${opts.issuer}|${opts.audience}`}`;
    return {
      async read() {
        return globalThis.localStorage.getItem(key);
      },
      async write(value: string) {
        globalThis.localStorage.setItem(key, value);
      },
    };
  }
  // Node fallback. The cache lives next to the demo so the dev can inspect
  // it; the path is stable so a restart picks up the same keypair.
  // Lazy import so the browser bundle stays free of `node:fs/promises`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = "./.cache/jwt-private.json";
  return {
    async read() {
      const fs = await import("node:fs/promises");
      try {
        return await fs.readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    async write(value: string) {
      const fs = await import("node:fs/promises");
      const dir = "./.cache";
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path, value, "utf8");
    },
  };
}

async function generateAndPersist(storage: DevJwtStorage): Promise<CryptoKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  await storage.write(JSON.stringify(jwk));
  return pair.privateKey;
}

/** RFC 4648 §5 base64url encode (no padding) of a Uint8Array. */
function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}