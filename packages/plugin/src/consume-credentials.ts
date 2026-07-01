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
 *                 (legacy single-file fallback for `"default"`) and connect with
 *                 those user JWT + NKEY seed. Missing/empty ⇒ a structured
 *                 "creds missing" result so the caller applies account-scoped
 *                 graceful degradation (skip the account, actionable log) — NO
 *                 runtime enroll, NO polling, NO hang.
 *   - open / static → unchanged: delegate to `connectNatsCredentialSource`
 *                 (these already carry their auth material; no SaaS issuer).
 *
 * This keeps the connection/static-creds env overrides
 * (WEBCHANNEL_NATS_URL/_USER_JWT/_USER_SEED/_CREDS/_DEV_OPEN) meaningful: the
 * resolver still classifies the source from them; only the `enrolled` branch is
 * redirected from "enroll now" to "load persisted".
 */

import {
  connectNatsCredentialSource,
  type ConnectedNats,
  type ConnectNatsDeps,
  type NatsCredentialSource,
} from "./nats-credential-source.js";
import {
  DEFAULT_ACCOUNT_ID,
  loadPersistedEnrolledCreds,
} from "./account-config.js";

/** Outcome of consuming a credential source at runtime. */
export type ConsumeResult =
  | {
      status: "connected";
      connection: ConnectedNats;
      /**
       * The URL actually dialed. For `enrolled` this is the SaaS-delivered
       * `natsUrl` when present (else the resolver fallback); for `open`/`static`
       * it is `source.url`. Surfaced so callers can log the EFFECTIVE relay,
       * which — for enrolled — may differ from the resolver's `source.url`.
       */
      dialedUrl: string;
    }
  | { status: "creds-missing"; accountId: string };

export type ConsumeCredentialSourceDeps = ConnectNatsDeps & {
  /** Injectable persisted-creds loader (tests). */
  loadPersisted?: typeof loadPersistedEnrolledCreds;
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
  accountId: string = DEFAULT_ACCOUNT_ID,
  deps: ConsumeCredentialSourceDeps = {},
): Promise<ConsumeResult> {
  if (source.mode !== "enrolled") {
    // open / static: connect directly (auth material is already present).
    const connection = await connectNatsCredentialSource(source, deps);
    return { status: "connected", connection, dialedUrl: source.url };
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
  return { status: "connected", connection, dialedUrl };
}
