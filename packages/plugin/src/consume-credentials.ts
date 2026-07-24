/**
 * Runtime credential CONSUMPTION (가-1 Cycle 1) — `gateway run` reads creds; it
 * never acquires them.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Before 가-1, the `enrolled` credential source ran the device flow inside
 * `registerFull` (= at `gateway run` time). 가-1 moves acquisition to
 * config-time (`openclaw channels add`). At runtime the enrolled path must
 * CONSUME the persisted per-account creds instead of enrolling:
 *
 *   - enrolled  → load `~/.openclaw-webchannel/<account>/credentials.json`
 *                 (account-scoped only; the legacy single-file path is retained
 *                 solely for migration/runbook cleanup) and connect with
 *                 those user JWT + NKEY seed. Missing/empty ⇒ a structured
 *                 "creds missing" result so the caller applies account-scoped
 *                 graceful degradation (skip the account, actionable log) — NO
 *                 runtime enroll, NO polling, NO hang.
 *   - static → delegate to `connectNatsCredentialSource`
 *                 (these already carry their auth material; no SaaS issuer).
 *
 * This keeps the connection/static-creds env overrides
 * (WEBCHANNEL_NATS_URL/_USER_JWT/_USER_SEED/_CREDS) meaningful: the resolver
 * still classifies the source from them; only the `enrolled` branch is
 * redirected from "enroll now" to "load persisted". (The removed unauthenticated
 * dev-open env flag is no longer an override — supplying it now throws a targeted
 * migration error in the resolver.)
 */

import {
  connectNatsCredentialSource,
  resolveNatsCredentialSource,
  type ConnectedNats,
  type ConnectNatsDeps,
  type NatsCredentialSource,
  type ResolveNatsCredentialSourceInput,
} from "./nats-credential-source.js";
import {
  DEFAULT_WEBCHANNEL_ACCOUNT_ID,
  loadPersistedCredentialDocument,
} from "./account-config.js";
import type {
  BoundCredentialLoadResult,
  CredentialDocumentFailure,
} from "./credential-document.js";
import type { KeyPair } from "./e2e-crypto.js";

/** Outcome of consuming a credential source at runtime. */
export type ConsumeResult =
  | {
      status: "connected";
      connection: ConnectedNats;
      /**
       * The URL actually dialed. For `enrolled` this is the SaaS-delivered
       * bound `natsUrl`; for `static`
       * it is `source.url`. Surfaced so callers can log the EFFECTIVE relay,
       * which — for enrolled — may differ from the resolver's `source.url`.
       */
      dialedUrl: string;
      /**
       * F2 — the agent's SaaS-attested static X25519 identity key pair, present
       * ONLY on the `enrolled` path when the persisted `credentials.json` carries
       * a valid `identityKey`. The register-hop channel wraps K under this so the
       * browser can authenticate it. Absent for static sources (no enrolled
       * identity) and for pre-F2 / malformed enrolled creds — a register-hop
       * account then fail-closed skips serving.
       */
      identityKey?: KeyPair;
    }
  | { status: "creds-missing"; accountId: string }
  | {
      status: "creds-binding-failed";
      accountId: string;
      failure: Exclude<CredentialDocumentFailure, { status: "absent" }>;
    };

export type ConsumeCredentialSourceDeps = ConnectNatsDeps & {
  /** Injectable persisted-creds loader (tests). */
  loadPersisted?: typeof loadPersistedCredentialDocument;
  /** Override home dir for path resolution (tests). */
  home?: string;
};

export type DialMaterial =
  | {
      status: "ok";
      mode: NatsCredentialSource["mode"];
      dial: { kind: "static"; url: string; userJwt: string; userSeed: string };
    }
  | { status: "creds-missing"; accountId: string }
  | {
      status: "creds-binding-failed";
      accountId: string;
      failure: Exclude<CredentialDocumentFailure, { status: "absent" }>;
    }
  | { status: "invalid"; error: string };

export type ResolveDialMaterialInput = ResolveNatsCredentialSourceInput & {
  loadCreds?: typeof loadPersistedCredentialDocument;
};

/** Resolve probe dial material without ever entering the enrollment connector. */
export function resolveDialMaterial(input: ResolveDialMaterialInput): DialMaterial {
  let source: NatsCredentialSource;
  try {
    source = resolveNatsCredentialSource(input);
  } catch (err) {
    return { status: "invalid", error: err instanceof Error ? err.message : String(err) };
  }
  if (source.mode === "static") {
    return {
      status: "ok",
      mode: source.mode,
      dial: {
        kind: "static",
        url: source.url,
        userJwt: source.userJwt,
        userSeed: source.userSeed,
      },
    };
  }
  let persisted: BoundCredentialLoadResult;
  try {
    persisted = (input.loadCreds ?? loadPersistedCredentialDocument)({
      tenant: source.tenant,
      accountId: input.accountId,
      saasBaseUrl: source.saasBaseUrl,
    });
  } catch {
    return {
      status: "invalid",
      error: "webchannel: effective credential binding identity is invalid",
    };
  }
  if (persisted.status === "absent") {
    return { status: "creds-missing", accountId: input.accountId };
  }
  if (persisted.status !== "match") {
    return {
      status: "creds-binding-failed",
      accountId: input.accountId,
      failure: persisted,
    };
  }
  const credentials = persisted.credentials;
  // Defensive for injected loaders: the real document loader already enforces
  // this, but a test/diagnostic seam must not reintroduce config fallback.
  if (!credentials.natsUrl) {
    return {
      status: "creds-binding-failed",
      accountId: input.accountId,
      failure: {
        status: "invalid",
        code: "invalid-document",
        fields: ["enrollment.natsUrl"],
      },
    };
  }
  return {
    status: "ok",
    mode: source.mode,
    dial: {
      kind: "static",
      url: credentials.natsUrl,
      userJwt: credentials.userJwt,
      userSeed: credentials.userSeed,
    },
  };
}

/**
 * Consume a resolved credential source at runtime.
 *
 * For `enrolled`, loads the persisted per-account creds and connects them via
 * the SAME static connect path (user JWT + NKEY-seed challenge-response). When
 * no usable creds are persisted, returns `{ status: "creds-missing" }` — the
 * caller logs the actionable remediation and skips serving that account.
 */
export async function consumeCredentialSource(
  source: NatsCredentialSource,
  accountId: string = DEFAULT_WEBCHANNEL_ACCOUNT_ID,
  deps: ConsumeCredentialSourceDeps = {},
): Promise<ConsumeResult> {
  if (source.mode !== "enrolled") {
    // Static: connect directly (auth material is already present).
    const connection = await connectNatsCredentialSource(source, deps);
    return { status: "connected", connection, dialedUrl: source.url };
  }

  const loadPersisted = deps.loadPersisted ?? loadPersistedCredentialDocument;
  const persisted = loadPersisted({
    tenant: source.tenant,
    accountId,
    saasBaseUrl: source.saasBaseUrl,
  }, {
    ...(deps.home !== undefined ? { home: deps.home } : {}),
  });
  if (persisted.status === "absent") {
    return { status: "creds-missing", accountId };
  }
  if (persisted.status !== "match") {
    return {
      status: "creds-binding-failed",
      accountId,
      failure: persisted,
    };
  }
  const credentials = persisted.credentials;
  // Defensive for injected loaders: never dial a current config fallback when
  // relay provenance is absent.
  if (!credentials.natsUrl) {
    return {
      status: "creds-binding-failed",
      accountId,
      failure: {
        status: "invalid",
        code: "invalid-document",
        fields: ["enrollment.natsUrl"],
      },
    };
  }

  // Connect with the persisted enrolled creds via the static branch — identical
  // transport primitive (jwtCredential + NKEY signing callback), no enroll.
  //
  // The SaaS is the rendezvous authority: the relay URL was delivered with the
  // minted creds (persisted as `enrollment.natsUrl`), so we dial THAT in
  // rather than the resolver's `source.url` (derived from `nats.url` /
  // `WEBCHANNEL_NATS_URL`). Documents from before natsUrl was delivered fail
  // the binding gate and must be re-enrolled. This is the load-bearing
  // consume-time half of "the operator does not configure the NATS URL".
  const dialedUrl = credentials.natsUrl;
  const connection = await connectNatsCredentialSource(
    {
      mode: "static",
      url: dialedUrl,
      userJwt: credentials.userJwt,
      userSeed: credentials.userSeed,
    },
    deps,
  );
  // F2: surface the persisted agent identity key so the entry can wrap K
  // static-static on the register-hop path. Absent for pre-F2 / malformed creds.
  return {
    status: "connected",
    connection,
    dialedUrl,
    identityKey: credentials.identityKey,
  };
}
