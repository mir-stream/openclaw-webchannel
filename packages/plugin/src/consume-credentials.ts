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
  | { status: "connected"; connection: ConnectedNats }
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
    return { status: "connected", connection };
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
  const connection = await connectNatsCredentialSource(
    {
      mode: "static",
      url: source.url,
      userJwt: persisted.userJwt,
      userSeed: persisted.userSeed,
    },
    deps,
  );
  return { status: "connected", connection };
}
