/**
 * NATS credential source — Axis A of the agent↔NATS decoupling.
 *
 * ── Separation of concerns ─────────────────────────────────────────────────
 * Connecting the agent to NATS has TWO orthogonal axes that used to be fused
 * inside `index-nats.ts`:
 *
 *   Axis A — CREDENTIAL SOURCE (this module): *how* the agent authenticates to
 *            the NATS server. This is purely about acquiring a connected
 *            `NatsTransport`. It says nothing about which browser peers are served.
 *
 *   Axis B — PEER ADMISSION (`nats-admission.ts`): *which* browser peers the agent
 *            serves once connected (register-hop vs. wildcard auto-subscribe).
 *
 * Before this refactor, the only ways to connect were "dev open-NATS" (no auth)
 * or "enrolled" (SaaS device-flow). There was no way to point the agent at an
 * arbitrary NATS (Synadia Cloud / NGS / self-hosted) with a URL + static user
 * credentials. This module adds that as a first-class, co-equal source and demotes
 * the SaaS issuer to ONE optional source among three:
 *
 *   - `open`     — no auth. Dev/local only (the legacy `devOpen`).
 *   - `static`   — url + user JWT + NKEY seed given DIRECTLY (bring-your-own-NATS).
 *                  The plugin is GIVEN these credentials; it never mints them and
 *                  never imports from `packages/saas`. A standard NATS `.creds`
 *                  file (JWT + seed) is also accepted and parsed.
 *   - `enrolled` — the existing SaaS device-flow via `createEnrolledNatsConnection`
 *                  (behaviour unchanged; it remains the production default).
 *
 * The transport/connection primitive itself was already clean: `NatsTransport`
 * accepts `{ url, jwtCredential, nkeySigningCallback }` and `makeNkeySigningCallback`
 * derives the challenge-response signer from an NKEY seed. Only the *acquisition*
 * was coupled — this module is exactly that resolver + connector, nothing more.
 */

import { readFileSync } from "node:fs";

import type { SecretRef } from "./auth.js";
import { NatsTransport } from "./nats-transport.js";
import { makeNkeySigningCallback } from "./nkey-sign.js";
import {
  createEnrolledNatsConnection,
  type EnrolledNatsConnection,
} from "./enrolled-nats-connection.js";

// ---------------------------------------------------------------------------
// Config shape (mirrors the `channels.webchannel.nats` schema block)
// ---------------------------------------------------------------------------

/**
 * Credential-source config under `channels.webchannel.nats.credentials`.
 *
 * Secrets (`userJwt` / `userSeed`) accept the same `string | { env }` SecretRef
 * shape as `auth.ticketSecret`, so operators never have to inline a secret in
 * committed config — they can reference an env var or point at a `.creds` file.
 */
export type WebchannelNatsCredentialsConfig = {
  /** Explicit source selector. When omitted it is inferred (see resolver). */
  mode?: "static" | "enrolled" | "open";
  /** Static mode: NATS user JWT (compact). SecretRef. */
  userJwt?: SecretRef;
  /** Static mode: NATS user NKEY seed ("SU…", base32). SecretRef. */
  userSeed?: SecretRef;
  /** Static mode: path to a standard NATS `.creds` file (JWT + seed). */
  credsFile?: string;
  /** Enrolled mode: SaaS issuer base URL (device-flow endpoints derived from it). */
  saasBaseUrl?: string;
};

/** The `channels.webchannel.nats` config block. */
export type WebchannelNatsConfig = {
  /** NATS WebSocket URL. Env override: `WEBCHANNEL_NATS_URL`. */
  url?: string;
  /** Dev-only open NATS (no auth). Env override: `WEBCHANNEL_NATS_DEV_OPEN=1`. */
  devOpen?: boolean;
  /** Explicit peer-admission override (Axis B — consumed by `nats-admission.ts`). */
  admission?: "auto" | "register-hop";
  /** Credential source (Axis A). */
  credentials?: WebchannelNatsCredentialsConfig;
};

// ---------------------------------------------------------------------------
// Resolved discriminated source
// ---------------------------------------------------------------------------

/** Static (bring-your-own-NATS) credentials: user JWT + NKEY seed. */
export type StaticNatsCredentials = {
  /** NATS user JWT (compact), placed in CONNECT.jwt. */
  userJwt: string;
  /** NATS user NKEY seed ("SU…") used to sign the server's INFO nonce. */
  userSeed: string;
};

/**
 * A fully-resolved credential source — a discriminated union. The connector
 * (`connectNatsCredentialSource`) turns one of these into a connected transport.
 */
export type NatsCredentialSource =
  | { mode: "open"; url: string }
  | ({ mode: "static"; url: string } & StaticNatsCredentials)
  | {
      mode: "enrolled";
      url: string;
      saasBaseUrl: string;
      tenant: string;
      accountId: string;
    };

// ---------------------------------------------------------------------------
// Resolver inputs
// ---------------------------------------------------------------------------

export type ResolveNatsCredentialSourceInput = {
  /** The `channels.webchannel.nats` config block (schema-validated). */
  natsConfig?: WebchannelNatsConfig;
  /** Legacy top-level `api.config.nats` (url + devOpen) kept for compatibility. */
  legacyNats?: { url?: string; devOpen?: boolean };
  /**
   * Enrolled-mode SaaS base URL from the top-level `api.config.saas?.baseUrl`,
   * passed RAW (not env-collapsed). The resolver OWNS the full precedence:
   *   env `WEBCHANNEL_SAAS_BASE_URL` > `nats.credentials.saasBaseUrl` > this >
   *   the built-in default. Pass the lowest-precedence config-level value here and
   *   let the resolver layer env + the `credentials.saasBaseUrl` field on top.
   */
  saasBaseUrl?: string;
  /** Tenant + account id (enrolled mode; accountId is the wire identity). */
  tenant: string;
  accountId: string;
  /** Env bag (defaults to `process.env`). Injectable for tests. */
  env?: Record<string, string | undefined>;
  /** File reader for `.creds` files (defaults to `fs.readFileSync`). Injectable. */
  readFile?: (path: string) => string;
};

const DEFAULT_NATS_URL = "ws://127.0.0.1:4222";
const DEFAULT_SAAS_BASE_URL = "http://localhost:3001";

// ---------------------------------------------------------------------------
// Secret + creds-file helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a `SecretRef` (string OR `{ env }`) to a concrete value, or `undefined`
 * if the ref is absent. Throws on a present-but-empty/unresolvable ref so a
 * misconfigured secret fails loudly rather than silently producing bad creds.
 */
function resolveSecretRef(
  ref: SecretRef | undefined,
  label: string,
  env: Record<string, string | undefined>,
): string | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref === "string") {
    if (ref.length === 0) {
      throw new Error(`webchannel: ${label} is an empty string. Refusing to start.`);
    }
    return ref;
  }
  if (ref && typeof ref === "object" && typeof ref.env === "string") {
    const value = env[ref.env];
    if (!value) {
      throw new Error(
        `webchannel: ${label} env "${ref.env}" is unset or empty. Refusing to start.`,
      );
    }
    return value;
  }
  throw new Error(
    `webchannel: ${label} must be a string or { env: "VAR_NAME" }. Refusing to start.`,
  );
}

/**
 * Parse a standard NATS `.creds` file into its JWT + NKEY seed.
 *
 * The canonical format (as emitted by `nsc generate creds`) is:
 *
 *   -----BEGIN NATS USER JWT-----
 *   eyJ0eXAiOiJKV1QiLCJ...
 *   ------END NATS USER JWT------
 *   ...
 *   -----BEGIN USER NKEY SEED-----
 *   SUAGM...
 *   ------END USER NKEY SEED------
 *
 * The dash counts differ between BEGIN (5) and END (6) markers, so the matcher
 * is tolerant of any run of 3+ dashes. Intra-block whitespace is stripped to
 * yield a single contiguous token (both the JWT and the seed are single-line).
 */
export function parseNatsCredsFile(content: string): StaticNatsCredentials {
  const userJwt = extractCredsBlock(content, "NATS USER JWT");
  const userSeed = extractCredsBlock(content, "USER NKEY SEED");
  if (!userJwt) {
    throw new Error("webchannel: NATS .creds file is missing a 'NATS USER JWT' block.");
  }
  if (!userSeed) {
    throw new Error("webchannel: NATS .creds file is missing a 'USER NKEY SEED' block.");
  }
  return { userJwt, userSeed };
}

function extractCredsBlock(content: string, label: string): string | undefined {
  const re = new RegExp(
    `-{3,}\\s*BEGIN ${label}\\s*-{3,}([\\s\\S]*?)-{3,}\\s*END ${label}\\s*-{3,}`,
  );
  const m = re.exec(content);
  if (!m || !m[1]) return undefined;
  const token = m[1].replace(/\s+/g, "");
  return token.length > 0 ? token : undefined;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a discriminated `NatsCredentialSource` from config + env.
 *
 * Precedence (env OVERRIDES config), evaluated top-to-bottom:
 *   1. OPEN   — `WEBCHANNEL_NATS_DEV_OPEN=1`, `legacyNats.devOpen`,
 *               `nats.devOpen`, or `credentials.mode === "open"`.
 *   2. STATIC — any static secret is present: `WEBCHANNEL_NATS_CREDS`,
 *               `WEBCHANNEL_NATS_USER_JWT` + `WEBCHANNEL_NATS_USER_SEED`,
 *               `credentials.mode === "static"`, `credentials.credsFile`, or
 *               inline `credentials.userJwt` + `userSeed`.
 *   3. ENROLLED — the default (unchanged production path).
 *
 * Pure given its inputs (the only I/O is the injectable `readFile` for `.creds`),
 * so the whole decision table is unit-testable without a socket.
 */
export function resolveNatsCredentialSource(
  input: ResolveNatsCredentialSourceInput,
): NatsCredentialSource {
  const env = input.env ?? process.env;
  const nats = input.natsConfig;
  const creds = nats?.credentials;

  const url =
    env["WEBCHANNEL_NATS_URL"] ??
    nats?.url ??
    input.legacyNats?.url ??
    DEFAULT_NATS_URL;

  // ── 1. OPEN (dev, no auth) ────────────────────────────────────────────────
  const openByEnv = env["WEBCHANNEL_NATS_DEV_OPEN"] === "1";
  const openByConfig =
    input.legacyNats?.devOpen === true ||
    nats?.devOpen === true ||
    creds?.mode === "open";
  if (openByEnv || openByConfig) {
    return { mode: "open", url };
  }

  // ── 2. STATIC (bring-your-own-NATS) ───────────────────────────────────────
  const credsFilePath = env["WEBCHANNEL_NATS_CREDS"] ?? creds?.credsFile;
  const envJwt = env["WEBCHANNEL_NATS_USER_JWT"];
  const envSeed = env["WEBCHANNEL_NATS_USER_SEED"];
  const configJwt = resolveSecretRef(
    creds?.userJwt,
    "channels.webchannel.nats.credentials.userJwt",
    env,
  );
  const configSeed = resolveSecretRef(
    creds?.userSeed,
    "channels.webchannel.nats.credentials.userSeed",
    env,
  );

  const staticSignalled =
    creds?.mode === "static" ||
    credsFilePath !== undefined ||
    envJwt !== undefined ||
    envSeed !== undefined ||
    configJwt !== undefined ||
    configSeed !== undefined;

  if (staticSignalled) {
    // Start from a `.creds` file (if any), then let explicit JWT/seed (env first,
    // then inline config) override the file's values.
    let fileCreds: StaticNatsCredentials | undefined;
    if (credsFilePath !== undefined) {
      const read = input.readFile ?? defaultReadFile;
      let content: string;
      try {
        content = read(credsFilePath);
      } catch (err) {
        throw new Error(
          `webchannel: failed to read NATS creds file "${credsFilePath}": ${(err as Error).message}`,
        );
      }
      fileCreds = parseNatsCredsFile(content);
    }

    const userJwt = envJwt ?? configJwt ?? fileCreds?.userJwt;
    const userSeed = envSeed ?? configSeed ?? fileCreds?.userSeed;

    if (!userJwt || !userSeed) {
      const missing = [!userJwt && "userJwt", !userSeed && "userSeed"]
        .filter(Boolean)
        .join(" + ");
      throw new Error(
        `webchannel: static NATS credentials are incomplete (missing ${missing}). ` +
          `Provide a credsFile, WEBCHANNEL_NATS_USER_JWT + WEBCHANNEL_NATS_USER_SEED, ` +
          `or credentials.userJwt + credentials.userSeed.`,
      );
    }
    return { mode: "static", url, userJwt, userSeed };
  }

  // ── 3. ENROLLED (SaaS device-flow — the default) ──────────────────────────
  // The resolver owns saasBaseUrl precedence so a `nats.credentials.saasBaseUrl`
  // set by an operator is actually honored (previously it was silently ignored):
  //   env WEBCHANNEL_SAAS_BASE_URL > nats.credentials.saasBaseUrl
  //     > top-level api.config.saas?.baseUrl (input.saasBaseUrl) > default.
  const saasBaseUrl =
    env["WEBCHANNEL_SAAS_BASE_URL"] ??
    creds?.saasBaseUrl ??
    input.saasBaseUrl ??
    DEFAULT_SAAS_BASE_URL;
  return {
    mode: "enrolled",
    url,
    saasBaseUrl,
    tenant: input.tenant,
    accountId: input.accountId,
  };
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

/** Result of connecting a credential source. */
export type ConnectedNats = {
  /** The connected NATS transport (ready to pub/sub). */
  transport: NatsTransport;
  /**
   * Present only for the `enrolled` source — the full enrollment connection
   * (identity key, persisted credentials, enrollment metadata). `index-nats`
   * holds onto this so the rest of the wiring is identical to the legacy path.
   */
  enrolled?: EnrolledNatsConnection;
};

/** Injectable seams for `connectNatsCredentialSource` (tests). */
export type ConnectNatsDeps = {
  /** Factory for a `NatsTransport` (defaults to `new NatsTransport`). */
  transportFactory?: (opts: ConstructorParameters<typeof NatsTransport>[0]) => NatsTransport;
  /** Enrolled-connection factory (defaults to `createEnrolledNatsConnection`). */
  createEnrolled?: typeof createEnrolledNatsConnection;
  /** NKEY signing-callback factory (defaults to `makeNkeySigningCallback`). */
  makeSigner?: typeof makeNkeySigningCallback;
};

/**
 * Connect a resolved credential source and return a live transport.
 *
 * Every branch produces the SAME `NatsTransport` primitive — only the auth
 * material differs:
 *   - open     → no jwt, no signer.
 *   - static   → user JWT + NKEY-seed signing callback (challenge-response).
 *   - enrolled → delegated to `createEnrolledNatsConnection` (device-flow).
 *
 * Connection failures propagate to the caller, which is responsible for the
 * graceful-degradation behaviour (warn + disable the channel for this process,
 * not crash) — applied uniformly to ALL sources.
 */
export async function connectNatsCredentialSource(
  source: NatsCredentialSource,
  deps: ConnectNatsDeps = {},
): Promise<ConnectedNats> {
  const transportFactory =
    deps.transportFactory ?? ((opts) => new NatsTransport(opts));
  const makeSigner = deps.makeSigner ?? makeNkeySigningCallback;

  switch (source.mode) {
    case "open": {
      const transport = transportFactory({
        url: source.url,
        clientName: "openclaw-webchannel-agent-dev",
      });
      await transport.connect();
      return { transport };
    }
    case "static": {
      const transport = transportFactory({
        url: source.url,
        jwtCredential: source.userJwt,
        nkeySigningCallback: makeSigner(source.userSeed),
        clientName: "openclaw-webchannel-agent",
      });
      await transport.connect();
      return { transport };
    }
    case "enrolled": {
      const createEnrolled = deps.createEnrolled ?? createEnrolledNatsConnection;
      const enrolled = await createEnrolled({
        saasEnrollUrl: `${source.saasBaseUrl}/api/enroll`,
        saasPollUrl: `${source.saasBaseUrl}/api/poll`,
        natsUrl: source.url,
        tenant: source.tenant,
        accountId: source.accountId,
        displayInstructions: true,
      });
      return { transport: enrolled.transport, enrolled };
    }
  }
}
