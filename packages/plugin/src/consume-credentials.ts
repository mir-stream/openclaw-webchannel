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
  type ConnectedNats,
  type ConnectNatsDeps,
  type NatsCredentialSource,
} from "./nats-credential-source.js";
import {
  DEFAULT_WEBCHANNEL_ACCOUNT_ID,
  loadPersistedAgentIdentity,
  loadPersistedEnrolledCreds,
} from "./account-config.js";
import type { KeyPair } from "./e2e-crypto.js";

/** Outcome of consuming a credential source at runtime. */
export type ConsumeResult =
  | {
      status: "connected";
      connection: ConnectedNats;
      /**
       * The URL actually dialed. For `enrolled` this is the SaaS-delivered
       * `natsUrl` when present (else the resolver fallback); for `static`
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
  /**
   * P0-3 — a `static` (BYO-NATS) source resolved, but the account has NO
   * SaaS-attested agent identity persisted (no valid `identityKey`). Static
   * creds replace the TRANSPORT only; a register-hop account still needs an
   * attested identity, so we DO NOT connect (the transport factory is never
   * called) and the caller fail-closed skips serving. Distinct from
   * `creds-missing` (enrolled path) because the remediation differs: the
   * operator must ENROLL for identity even though they supplied transport creds.
   */
  | { status: "identity-missing"; accountId: string };

export type ConsumeCredentialSourceDeps = ConnectNatsDeps & {
  /** Injectable persisted enrolled-creds loader (enrolled transport path; tests). */
  loadPersisted?: typeof loadPersistedEnrolledCreds;
  /** Injectable persisted agent-identity loader (static path; tests). */
  loadIdentity?: typeof loadPersistedAgentIdentity;
  /** Override home dir for path resolution (tests). */
  home?: string;
};

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
  if (source.mode === "static") {
    // Static (BYO-NATS): the transport material is already present in `source`,
    // but the register-hop wrap still needs the SaaS-attested agent identity.
    // Load it separately (decoupled from transport material — D1). No identity ⇒
    // return `identity-missing` WITHOUT connecting (assert: the transport factory
    // is never called on this path). Static dials `source.url` — the operator
    // owns the transport fully, so we never consult the persisted `natsUrl`.
    const loadIdentity = deps.loadIdentity ?? loadPersistedAgentIdentity;
    const identity = loadIdentity(accountId, {
      ...(deps.home !== undefined ? { home: deps.home } : {}),
    });
    if (!identity) {
      return { status: "identity-missing", accountId };
    }
    const connection = await connectNatsCredentialSource(source, deps);
    return {
      status: "connected",
      connection,
      dialedUrl: source.url,
      identityKey: identity.identityKey,
    };
  }

  const loadPersisted = deps.loadPersisted ?? loadPersistedEnrolledCreds;
  const persisted = loadPersisted(accountId, {
    ...(deps.home !== undefined ? { home: deps.home } : {}),
  });
  if (!persisted) {
    return { status: "creds-missing", accountId };
  }

  // Connect with the persisted enrolled creds via the static branch — identical
  // transport primitive (jwtCredential + NKEY signing callback), no enroll.
  //
  // The SaaS is the rendezvous authority: the relay URL was delivered with the
  // minted creds (persisted as `enrollment.natsUrl`), so we dial THAT in
  // preference to the resolver's `source.url` (derived from `nats.url` /
  // `WEBCHANNEL_NATS_URL` — now a dev-only override / back-compat fallback for
  // creds enrolled before natsUrl was delivered). This is the load-bearing
  // consume-time half of "the operator does not configure the NATS URL".
  const dialedUrl = persisted.natsUrl ?? source.url;
  const connection = await connectNatsCredentialSource(
    {
      mode: "static",
      url: dialedUrl,
      userJwt: persisted.userJwt,
      userSeed: persisted.userSeed,
    },
    deps,
  );
  // F2: surface the persisted agent identity key so the entry can wrap K
  // static-static on the register-hop path. Absent for pre-F2 / malformed creds.
  return {
    status: "connected",
    connection,
    dialedUrl,
    ...(persisted.identityKey ? { identityKey: persisted.identityKey } : {}),
  };
}
