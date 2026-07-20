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
 *   Axis B — PEER ADMISSION: every browser peer completes authenticated
 *            registration before the agent subscribes its inbound subject.
 *
 * Before this refactor, the only ways to connect were "dev open-NATS" (no auth)
 * or "enrolled" (SaaS device-flow). There was no way to point the agent at an
 * arbitrary NATS (Synadia Cloud / NGS / self-hosted) with a URL + static user
 * credentials. This module adds that as a first-class, co-equal source and demotes
 * the SaaS issuer to ONE optional source among three:
 *
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
 * Secrets (`userJwt` / `userSeed`) accept the `string | { env }` `SecretRef`
 * shape (see `auth.ts`), so operators never have to inline a secret in
 * committed config — they can reference an env var or point at a `.creds` file.
 */
export type WebchannelNatsCredentialsConfig = {
  /** Explicit source selector. When omitted it is inferred (see resolver). */
  mode?: "static" | "enrolled";
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
  /** The only supported peer-admission mode. */
  admission?: "register-hop";
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
  /** Legacy top-level `api.config.nats.url` kept for compatibility. */
  legacyNats?: { url?: string };
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
  /**
   * Optional warning sink. The resolver is otherwise PURE (its only I/O is the
   * injectable `readFile`), and it has no logger of its own, so a diagnostic it
   * must emit — currently only the "process-wide static env creds were ignored
   * for this `mode:"enrolled"` account" notice — is pushed through here instead
   * of `console`. Defaults to a NO-OP (not `console.warn`) so unit tests stay
   * silent and can assert on the call rather than on stderr. Call sites that
   * have a logger (`index-nats.ts`) thread a real one.
   */
  warn?: (message: string) => void;
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
 * Precedence, evaluated top-to-bottom:
 *   0. EXPLICIT `credentials.mode` — an operator-declared mode is AUTHORITATIVE
 *      in BOTH directions. `"enrolled"` pins the account to the device-flow no
 *      matter what static material is lying around (see the block below for why
 *      that asymmetry against env matters); `"static"` is itself a static signal.
 *   1. STATIC — an inferred static signal (no explicit mode): `WEBCHANNEL_NATS_CREDS`,
 *               `WEBCHANNEL_NATS_USER_JWT` + `WEBCHANNEL_NATS_USER_SEED`,
 *               `credentials.credsFile`, or inline `credentials.userJwt` + `userSeed`.
 *               Within static, env OVERRIDES config for the secret VALUES.
 *   2. ENROLLED — the default (unchanged production path).
 *
 * Pure given its inputs (the only I/O is the injectable `readFile` for `.creds`),
 * so the whole decision table is unit-testable without a socket.
 */
export function resolveNatsCredentialSource(
  input: ResolveNatsCredentialSourceInput,
): NatsCredentialSource {
  const env = input.env ?? process.env;
  if (env["WEBCHANNEL_NATS_DEV_OPEN"] === "1") {
    throw new Error(
      "webchannel: WEBCHANNEL_NATS_DEV_OPEN was removed; there is no unauthenticated NATS mode. Enroll with `openclaw channels add --channel webchannel`.",
    );
  }
  const warn = input.warn ?? (() => {});
  const nats = input.natsConfig;
  const creds = nats?.credentials;

  const url =
    env["WEBCHANNEL_NATS_URL"] ??
    nats?.url ??
    input.legacyNats?.url ??
    DEFAULT_NATS_URL;

  // The three PROCESS-WIDE static env signals. Read here (not just in the static
  // block) because block 0 has to reason about whether a static signal came from
  // this ACCOUNT's config or from the ambient process environment.
  const envCredsFilePath = env["WEBCHANNEL_NATS_CREDS"];
  const envJwt = env["WEBCHANNEL_NATS_USER_JWT"];
  const envSeed = env["WEBCHANNEL_NATS_USER_SEED"];

  // ── 0. EXPLICIT `mode: "enrolled"` is AUTHORITATIVE ───────────────────────
  // Before this block, `mode` only had force in the static direction: any static
  // signal won, and `mode:"enrolled"` (which `setup.ts` writes into EVERY
  // wizard-created account) was inert. That made the documented "explicit source
  // selector" one-way, and opened a real cross-account isolation hole:
  //
  //   `WEBCHANNEL_NATS_USER_JWT` / `_SEED` / `WEBCHANNEL_NATS_CREDS` are
  //   PROCESS-WIDE. On a gateway that serves one BYO-NATS account plus several
  //   enrolled ones, exporting those env vars for the BYO account also flipped
  //   every enrolled account to static. Each flipped account then dialed the ENV
  //   url (the static branch in `consume-credentials.ts` deliberately never
  //   consults the persisted `enrollment.natsUrl`) carrying ANOTHER account's
  //   NATS user credential — silently collapsing per-account relay isolation,
  //   with no warning. An explicit `mode:"enrolled"` now forecloses that.
  //
  // The two static-material sources are treated DIFFERENTLY on purpose, because
  // they carry different operator intent:
  //
  //   - ACCOUNT CONFIG (`credentials.credsFile` / `.userJwt` / `.userSeed`) is
  //     scoped to this one account and was hand-written next to the `mode` field.
  //     "enrolled" + account-level static secrets is a contradiction the operator
  //     typed deliberately, and no silent winner is defensible (picking static
  //     ignores the declared mode; picking enrolled ignores real secrets). House
  //     rule is fail-closed ⇒ refuse to start and name both sides.
  //   - PROCESS ENV is GLOBAL and is NOT an account-level statement of intent —
  //     it is ambient. Hard-erroring on it would break the legitimate mixed
  //     BYO + enrolled gateway that motivated this fix in the first place, so
  //     enrolled simply WINS and we warn that the ambient creds were ignored here.
  if (creds?.mode === "enrolled") {
    const path = "channels.webchannel.nats.credentials";
    const contradictions = [
      creds.credsFile !== undefined && `${path}.credsFile`,
      creds.userJwt !== undefined && `${path}.userJwt`,
      creds.userSeed !== undefined && `${path}.userSeed`,
    ].filter((v): v is string => typeof v === "string");
    if (contradictions.length > 0) {
      throw new Error(
        `webchannel: account "${input.accountId}" declares ${path}.mode:"enrolled" but the SAME ` +
          `account config also carries static (bring-your-own-NATS) material: ` +
          `${contradictions.join(", ")}. ` +
          `Those select different credential sources and the config does not say which wins. ` +
          `Pick one: remove mode:"enrolled" to dial your own NATS with those secrets, or delete ` +
          `the credentials.credsFile/userJwt/userSeed fields to stay on the SaaS device-flow. ` +
          `Refusing to start.`,
      );
    }
    const ignoredEnv = [
      envCredsFilePath !== undefined && "WEBCHANNEL_NATS_CREDS",
      envJwt !== undefined && "WEBCHANNEL_NATS_USER_JWT",
      envSeed !== undefined && "WEBCHANNEL_NATS_USER_SEED",
    ].filter((v): v is string => typeof v === "string");
    if (ignoredEnv.length > 0) {
      warn(
        `webchannel: account "${input.accountId}" declares ` +
          `channels.webchannel.nats.credentials.mode:"enrolled", so the process-wide static NATS ` +
          `credentials in ${ignoredEnv.join(" + ")} were IGNORED for this account (it stays on the ` +
          `SaaS device-flow and its own SaaS-delivered relay). Those env vars are global, so they ` +
          `apply only to accounts that do NOT declare mode:"enrolled" — this is how a gateway ` +
          `serves BYO-NATS and enrolled accounts side by side without cross-wiring their relay ` +
          `credentials. If this account was MEANT to be bring-your-own-NATS, remove its ` +
          `mode:"enrolled" (or set mode:"static").`,
      );
    }
    return resolveEnrolled(input, env, creds, url);
  }

  // ── 1. STATIC (bring-your-own-NATS) ───────────────────────────────────────
  // Re-enabled in P0-3: static credentials pick the TRANSPORT (a BYO relay +
  // user JWT/seed) but are NOT an auth bypass. The resolver only produces the
  // resolved `{ mode: "static", … }` source; the attested agent identity is
  // supplied separately at consume time (`consume-credentials.ts` loads it via
  // `loadPersistedAgentIdentity` and fail-closed skips serving when it is
  // absent). Before P0-3 a static signal here threw a fail-loud migration error
  // (P0-2 landing site); that throw is now removed and this block is live.
  const credsFilePath = envCredsFilePath ?? creds?.credsFile;
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

  // An explicit `credentials.mode: "static"` is itself a static signal (documented
  // precedence #0/#1 above): honoring it means an operator who declared static but
  // supplied no secrets gets the loud "incomplete static credentials" error below
  // rather than a silent, surprising downgrade to the enrolled device-flow. This
  // matches the fail-loud guard P0-2 fenced this block with (which also keyed on
  // `mode === "static"`), now that P0-3 has removed that guard.
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

  // ── 2. ENROLLED (SaaS device-flow — the default) ──────────────────────────
  return resolveEnrolled(input, env, creds, url);
}

/**
 * Build the `enrolled` source. Extracted so the DEFAULT fall-through (block 2)
 * and the explicit `mode:"enrolled"` short-circuit (block 0) return the byte-
 * identical source — an explicit declaration must never resolve differently from
 * the inferred default, or the two paths could drift on saasBaseUrl precedence.
 *
 * The resolver owns saasBaseUrl precedence so a `nats.credentials.saasBaseUrl`
 * set by an operator is actually honored (previously it was silently ignored):
 *   env WEBCHANNEL_SAAS_BASE_URL > nats.credentials.saasBaseUrl
 *     > top-level api.config.saas?.baseUrl (input.saasBaseUrl) > default.
 */
function resolveEnrolled(
  input: ResolveNatsCredentialSourceInput,
  env: Record<string, string | undefined>,
  creds: WebchannelNatsCredentialsConfig | undefined,
  url: string,
): Extract<NatsCredentialSource, { mode: "enrolled" }> {
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
    case "static": {
      const transport = transportFactory({
        url: source.url,
        jwtCredential: source.userJwt,
        nkeySigningCallback: makeSigner(source.userSeed),
        clientName: "openclaw-webchannel-agent",
        // S1: auto-reconnect a dropped connection (replays subscriptions).
        reconnect: true,
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
