/**
 * Credential acquisition (config-time) — 가-1 Cycle 1.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Device-flow credential ACQUISITION (RFC 8628: print user_code, poll SaaS,
 * receive NATS creds, persist) used to run inside `registerFull` at `gateway run`
 * time. That is wrong: acquisition is CONFIG-time, not runtime. It also caused a
 * duplicate-enroll bug because `registerFull` loads in EVERY context
 * (gateway / chat / TUI / CLI).
 *
 * `acquireCredentials` is the standalone, NON-INTERACTIVE acquisition routine
 * that `openclaw channels add` (config-time) calls via the plugin's
 * `afterAccountConfigWritten` setup hook. It:
 *
 *   1. Runs the existing `EnrollmentClient` device flow (reused, unchanged).
 *   2. Prints the user_code to STDOUT/log (no TTY required — the operator
 *      approves at the SaaS `/approve` UI; in CI a harness scrapes the user_code
 *      and POSTs `/approve`).
 *   3. Persists creds to the per-account path
 *      `~/.openclaw-webchannel/<account>/credentials.json`.
 *
 * The approval MECHANISM is unchanged (operator approves at SaaS `/approve`);
 * this only moves WHERE acquisition is triggered (config-time, not runtime).
 */

import { EnrollmentClient } from "./enrollment-client.js";
import type { EnrollmentResultLike } from "./enrollment-client.js";
import { accountCredentialPath, DEFAULT_ACCOUNT_ID } from "./account-config.js";

/** A minimal log sink (the setup hook's `runtime.log`, or `console.log`). */
export type AcquireLog = (...args: unknown[]) => void;

export type AcquireCredentialsOptions = {
  /**
   * Account id the creds are acquired for. This is ALSO the wire identity
   * (JWT aud / NATS subject key) sent to the SaaS enrollment. The credential
   * path is account-scoped on the same value.
   */
  accountId?: string;
  /** SaaS issuer base URL; `/api/enroll` + `/api/poll` are derived from it. */
  saasBaseUrl: string;
  /** Deployment tenant identifier. */
  tenant: string;
  /**
   * Override the persisted credential path. Defaults to the per-account path
   * `~/.openclaw-webchannel/<account>/credentials.json`.
   */
  credentialPath?: string;
  /** Progress sink. Defaults to `console.log`. */
  log?: AcquireLog;
  /** Override the home dir for path resolution (tests). */
  home?: string;
  /**
   * @internal Test-only seam: inject an EnrollmentClient factory so tests run
   * the flow without a real SaaS. Defaults to `new EnrollmentClient(...)`.
   */
  _clientFactory?: (opts: ConstructorParameters<typeof EnrollmentClient>[0]) => EnrollmentClient;
  /**
   * @internal Test-only: floor (ms) for the poll interval. Forwarded to the
   * EnrollmentClient. Never set in production.
   */
  _minPollIntervalMs?: number;
};

/**
 * Acquire (or load existing) enrolled NATS credentials for an account,
 * persisting them to the per-account path. Resolves with the enrollment result
 * on success; rejects (propagating the EnrollmentClient error) on failure.
 *
 * Non-interactive: the user_code is printed via `log`; no prompt/TTY is read.
 * Idempotent: if creds already exist at the path, the EnrollmentClient short-
 * circuits and returns them without re-enrolling.
 */
export async function acquireCredentials(
  options: AcquireCredentialsOptions,
): Promise<EnrollmentResultLike> {
  const accountId = options.accountId ?? DEFAULT_ACCOUNT_ID;
  const log: AcquireLog = options.log ?? ((...args) => console.log(...args));
  const credentialPath =
    options.credentialPath ?? accountCredentialPath(accountId, options.home);

  const saasBaseUrl = options.saasBaseUrl.replace(/\/+$/, "");

  log(
    `[webchannel] Acquiring credentials for account "${accountId}" ` +
      `(tenant=${options.tenant}, saas=${saasBaseUrl})`,
  );

  const factory =
    options._clientFactory ?? ((opts) => new EnrollmentClient(opts));
  const client = factory({
    saasEnrollUrl: `${saasBaseUrl}/api/enroll`,
    saasPollUrl: `${saasBaseUrl}/api/poll`,
    tenant: options.tenant,
    accountId,
    credentialPath,
    // Non-interactive: the EnrollmentClient already prints the user_code +
    // verification URI to the console. Keep that on so CI/operators see it.
    displayInstructions: true,
    ...(options._minPollIntervalMs !== undefined
      ? { _minPollIntervalMs: options._minPollIntervalMs }
      : {}),
  });

  const enrollment = await client.enroll();
  log(
    `[webchannel] ✓ Credentials acquired for account "${accountId}" ` +
      `→ ${credentialPath} (peerId=${enrollment.peerId})`,
  );
  return enrollment;
}
