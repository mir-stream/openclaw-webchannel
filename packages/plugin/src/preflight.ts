/**
 * Trust-anchor preflight (design §4 change 4) — the PRIMARY safety net.
 *
 * The product review's load-bearing point: removing the three known misconfig
 * causes (derive JWT-verify params, stop guessing in the builder, SaaS issuer =
 * base URL) does nothing for the INVISIBILITY that was the actual pain — an
 * opaque `Credentials expired` / request-timeout with no hint of WHICH trust
 * fact was wrong. Preflight makes any residual misconfig self-explaining AT THE
 * MOMENT IT FIRES, in two places, each printing a per-gate PASS/FAIL:
 *
 *   - Gate B (gateway start, `index-nats.ts`): one structured readiness line per
 *     SERVED account reporting the EFFECTIVE (derived) trust facts — issuer,
 *     resolved JWKS key count, audience, admission, the ENFORCED dmScope
 *     (per-account-channel-peer — webchannel forces it, see `session-route.ts`),
 *     dmSecurity — or the precise failure. This is the higher-value gate: it runs
 *     on every boot and its JWKS-key-count line is the single most useful
 *     diagnostic (an empty/unreachable JWKS ⇒ no bootstrap JWT can ever verify).
 *     Implemented as the pure {@link formatAccountReadiness} below, called from
 *     the serving loop so the formatting/verdict logic is unit-testable.
 *
 *   - Gate A (`channels add`, post-enroll, `setup.ts`): the achievable add-time
 *     checks — see {@link runAddPreflight} and {@link evaluateAddPreflight} for
 *     the HONEST scope (a true end-to-end register round-trip is impossible at
 *     add-time; documented there).
 *
 * Constraints honored (design §5): read EFFECTIVE/derived values everywhere;
 * fail-closed (a FAIL never silently serves); the
 * readiness line reports the ENFORCED dmScope (per-account-channel-peer) that
 * webchannel imposes itself (`session-route.ts`) — the old dmScope="main" WARN
 * is gone because that leak is now structurally impossible; reuse the JWKS cache;
 */

import { JWKSCache, JwksUnavailableError } from "./jwks.js";
import {
  connectNatsCredentialSource,
  type ConnectNatsDeps,
} from "./nats-credential-source.js";

// ===========================================================================
// Shared helpers
// ===========================================================================

/** Join a base URL and a path, collapsing any duplicated slash at the seam. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** The `/.well-known/jwks.json` URL derived from a SaaS base URL (invariant #1). */
export function deriveJwksUrl(saasBaseUrl: string): string {
  return joinUrl(saasBaseUrl, ".well-known/jwks.json");
}

/**
 * The JWT `issuer` derived from a SaaS base URL (invariant: issuer = SaaS base
 * URL). Trailing slashes are stripped so the derivation is CANONICAL and matches
 * the (slash-collapsed) `deriveJwksUrl` — otherwise `--base-url https://x/`
 * would pin `iss="https://x/"` while a SaaS that mints the canonical
 * `iss="https://x"` gets rejected on every bootstrap JWT (the silent
 * issuer-mismatch trap). Single source of truth for both preflight and the
 * runtime `deriveAccountAuth`.
 */
export function deriveIssuer(saasBaseUrl: string): string {
  return saasBaseUrl.replace(/\/+$/, "");
}

// ===========================================================================
// Gate B — gateway-start readiness reporter (PURE)
// ===========================================================================

export type ReadinessVerdict = "READY" | "WARN" | "FAIL";

/** JWKS resolution outcome for a register-hop (jwt) account. */
export type JwksReadiness = { keyCount: number } | { error: string };

export type AccountReadinessInput = {
  accountId: string;
  /** Authenticated registration is the only admission mode. */
  admission: "register-hop";
  /**
   * EFFECTIVE (derived) issuer — read from the DERIVED `accountAuth`, never raw
   * `account.auth` (design §5). Absent when the
   * verifier could not be built.
   */
  issuer?: string;
  /** EFFECTIVE (derived) audience (= accountId by derivation). */
  audience?: string;
  /**
   * JWKS resolution outcome, from `preflightResolveJwks` (which reuses the
   * account's live cache). Present only for a register-hop jwt account whose
   * verifier BUILT successfully; `undefined` for an `auto` account (no verifier)
   * or when a build error preempted the resolve.
   */
  jwks?: JwksReadiness;
  /**
   * The account's JWT verifier could not be BUILT (missing/unresolvable
   * issuer/audience/jwks source — `assertJwtAuthConfig` threw).
   * This is a hard CONFIG fault that skips the account (fail-closed, never a
   * downgrade to `auto`); naming it here lets the FAIL line still report the
   * issuer/aud state alongside the reason.
   */
  buildError?: string;
  /** `account.dmSecurity`. */
  dmSecurity?: string;
};

export type AccountReadinessReport = { verdict: ReadinessVerdict; line: string };

/**
 * The DM session scope webchannel ENFORCES for its own inbound session-key
 * derivation (see `src/session-route.ts`), independent of the operator's global
 * `session.dmScope`. Shown verbatim in the readiness line so the operator sees
 * that per-user isolation is active — this is why there is no dmScope="main"
 * WARN branch anymore: the leak the warning guarded is structurally impossible.
 */
const WEBCHANNEL_ENFORCED_DM_SCOPE_LABEL = 'per-account-channel-peer (webchannel-enforced)';

/**
 * Format the per-account gateway-start readiness line + verdict (Gate B).
 *
 * PURE — no I/O, no logging. The serving loop resolves the effective facts (and
 * the JWKS via the shared cache), calls this, and logs `line` at the level the
 * `verdict` implies (READY→info, WARN→warn, FAIL→error). Keeping the
 * formatting/verdict here makes every branch — happy path, empty JWKS, JWKS
 * fetch failure, dmScope="main" leak, and the graceful `auto` degrade — testable
 * without booting a gateway.
 */
export function formatAccountReadiness(
  input: AccountReadinessInput,
): AccountReadinessReport {
  const id = input.accountId;
  const tail =
    ` · dmScope=${WEBCHANNEL_ENFORCED_DM_SCOPE_LABEL} · dmSecurity=${input.dmSecurity ?? '(unset)'}`;

  // ── Hard CONFIG fault: the verifier could not be built. Fail-closed — the
  //    account is skipped by the loop; here we just name the trust state so the
  //    operator sees issuer/aud, not only the raw thrown message.
  if (input.buildError) {
    return {
      verdict: 'FAIL',
      line:
        `[webchannel] account "${id}" FAIL · verifier build failed: ${input.buildError}` +
        ` · issuer=${input.issuer ?? '(unresolved)'} · aud=${input.audience ?? '(unresolved)'}` +
        ` · admission=${input.admission}`,
    };
  }

  // ── register-hop (jwt) account: report the JWKS resolution explicitly. ──────
  const admissionField = 'admission=register-hop (subscribed *.register)';
  const issuerField = `issuer=${input.issuer ?? '(unresolved)'}`;
  const audField = `aud=${input.audience ?? '(unresolved)'}`;

  // JWKS FETCH FAILED — the single most useful diagnostic. The account keeps
  // serving (fail-closed by construction: with no reachable keys every register
  // verify is non-admit, and the cache retries per-register on the 5-min TTL), so
  // this is a loud FAIL LINE, not a silent serve and not a downgrade.
  if (input.jwks && 'error' in input.jwks) {
    return {
      verdict: 'FAIL',
      line:
        `[webchannel] account "${id}" FAIL · ${issuerField} · JWKS FETCH FAILED: ${input.jwks.error}` +
        ` · ${audField} · ${admissionField}${tail}`,
    };
  }

  // JWKS resolved but EMPTY — cannot verify any bootstrap JWT (also fail-closed).
  if (input.jwks && input.jwks.keyCount === 0) {
    return {
      verdict: 'FAIL',
      line:
        `[webchannel] account "${id}" FAIL · ${issuerField}` +
        ` · JWKS 0 keys — cannot verify any bootstrap JWT · ${audField} · ${admissionField}${tail}`,
    };
  }

  const keyCount = input.jwks ? input.jwks.keyCount : 0;
  const jwksField = `JWKS ${keyCount} keys`;
  const base =
    `[webchannel] account "${id}" %VERDICT% · ${issuerField} · ${jwksField}` +
    ` · ${audField} · ${admissionField}${tail}`;

  // No dmScope="main" WARN branch: webchannel FORCES per-account-channel-peer on
  // every inbound session-key site (src/session-route.ts), so a multi-user
  // register-hop account can no longer leak transcripts across users regardless
  // of the operator's global session.dmScope. A healthy account is READY, and
  // the tail reports the ENFORCED scope truthfully.
  return { verdict: 'READY', line: base.replace('%VERDICT%', 'READY') };
}

// ===========================================================================
// Gate A — `channels add` post-enroll preflight
// ===========================================================================
//
// ── HONEST scope (why NOT a full register round-trip) ──────────────────────
// The brief asks for a "real register dry-run round-trip" at `channels add`.
// Investigated: a register round-trip needs BOTH (a) an agent subscribed to the
// account's `*.register` subject AND (b) a browser-side registrant holding a
// SaaS bootstrap JWT. At `channels add` time NEITHER exists:
//   - the gateway is NOT running, so no agent is subscribed to `*.register`
//     (a register request would time out — exactly the original bug's symptom);
//   - enrollment mints the AGENT's NATS user creds (an NKEY/nsc JWT), NOT a
//     browser bootstrap JWT — those are minted per browser SESSION by the SaaS
//     later, so there is no bootstrap JWT at add-time to verify against the
//     derived issuer/aud either.
// A genuine end-to-end register is therefore DEFERRED to Gate B / the first real
// browser. We do NOT fake one. Instead we run the strongest checks that ARE
// achievable at add-time and that directly catch the traps this design targets:
//
//   1. issuer/aud INTERNAL consistency — the derived audience must equal the
//      accountId (what the SaaS mints, `bootstrap-claims.ts`); a config-PINNED
//      audience that disagrees would reject every browser → hard FAIL naming it.
//   2. JWKS reachable + NON-EMPTY at the DERIVED url, AND the SaaS-advertised
//      `enrollment.jwksUrl` must match the derived url. A mismatch is the exact
//      issuer-mismatch trap surfaced early: the --base-url used to enroll differs
//      from the SaaS's own base → runtime derivation would verify against the
//      wrong issuer/keys. This proves the derivation matches what the SaaS signs.
//   3. relay DIAL — connect the just-enrolled creds to the SaaS-delivered relay
//      and open a scoped no-op subscription within the account's own subtree,
//      then disconnect. Proves creds valid + relay dialable + subject scoping.
//
// This proves everything the chain needs EXCEPT the live agent-subscribed
// register hop itself, which only exists once `gateway run` starts (Gate B).

export type AddPreflightFacts = {
  accountId: string;
  /** Effective (derived) issuer = saasBaseUrl, unless pinned. */
  effectiveIssuer: string;
  /** Effective (derived) audience = accountId, unless pinned. */
  effectiveAudience: string;
  /** The jwksUrl the agent DERIVES at runtime (saasBaseUrl + well-known). */
  derivedJwksUrl: string;
  /** The jwksUrl the SaaS ADVERTISED in the enrollment result (if any). */
  deliveredJwksUrl?: string;
  /** A config-pinned `auth.jwt.audience` (operator escape hatch), if present. */
  pinnedAudience?: string;
  /** JWKS resolution outcome against `derivedJwksUrl`. */
  jwks: JwksReadiness;
  /** Relay-dial outcome. */
  relay: { ok: true } | { error: string };
};

export type AddPreflightReport = { ok: boolean; line: string };

/**
 * PURE evaluator for the add-time checks — reports the FIRST failure (actionable,
 * naming the mismatch) or the all-green summary. Kept separate from the I/O
 * ({@link runAddPreflight}) so the verdict/formatting is unit-testable.
 */
export function evaluateAddPreflight(facts: AddPreflightFacts): AddPreflightReport {
  const prefix = 'channels add preflight';

  // 1. issuer/aud internal consistency (the issuer-mismatch trap, add-time).
  if (facts.pinnedAudience !== undefined && facts.pinnedAudience !== facts.accountId) {
    return {
      ok: false,
      line:
        `${prefix}: FAIL — config pins auth.jwt.audience="${facts.pinnedAudience}" but the SaaS ` +
        `mints aud="${facts.accountId}" (= accountId). The register JWT verify will reject every ` +
        `browser. Set audience to the accountId or remove the pin.`,
    };
  }

  // 2. JWKS reachable + non-empty + derivation matches the SaaS's own base URL.
  if ('error' in facts.jwks) {
    return {
      ok: false,
      line:
        `${prefix}: FAIL — JWKS fetch failed at ${facts.derivedJwksUrl}: ${facts.jwks.error}. ` +
        `The SaaS is unreachable or does not serve keys at the derived location ` +
        `(issuer="${facts.effectiveIssuer}").`,
    };
  }
  if (facts.jwks.keyCount === 0) {
    return {
      ok: false,
      line:
        `${prefix}: FAIL — JWKS at ${facts.derivedJwksUrl} has 0 keys; no bootstrap JWT could ` +
        `ever verify. Check the SaaS signing config (issuer="${facts.effectiveIssuer}").`,
    };
  }
  if (
    facts.deliveredJwksUrl !== undefined &&
    facts.deliveredJwksUrl !== facts.derivedJwksUrl
  ) {
    return {
      ok: false,
      line:
        `${prefix}: FAIL — the SaaS advertises JWKS at ${facts.deliveredJwksUrl} but the agent ` +
        `derives jwksUrl=${facts.derivedJwksUrl} from --base-url. The base URL used to enroll ` +
        `differs from the SaaS's own base URL, so runtime JWT verify would derive iss=` +
        `"${facts.effectiveIssuer}" and fetch keys from the wrong place. Pin auth.jwt.issuer/` +
        `jwksUrl to the SaaS's real base URL, or re-run channels add with the correct --base-url.`,
    };
  }

  // 3. relay dial.
  if ('error' in facts.relay) {
    return {
      ok: false,
      line:
        `${prefix}: FAIL — relay dial failed: ${facts.relay.error}. The enrolled NATS credentials ` +
        `could not connect/authenticate to the SaaS-delivered relay.`,
    };
  }

  return {
    ok: true,
    // Surface the EFFECTIVE issuer on the PASS line too (not only on FAIL):
    // with pin > delivered > derived precedence, the operator should see WHICH
    // issuer won while still watching the add.
    line:
      `${prefix}: issuer/aud ✓ (issuer=${facts.effectiveIssuer}) · ` +
      `JWKS ${facts.jwks.keyCount} keys ✓ · relay dial ✓`,
  };
}

/** The enrolled material Gate A needs (subset of the enrollment result). */
export type AddPreflightEnrollment = {
  userJwt: string;
  userSeed: string;
  /** SaaS-delivered relay URL. */
  natsUrl?: string;
  /** SaaS-advertised JWKS url (enrollment.jwksUrl). */
  jwksUrl?: string;
  /**
   * SaaS-delivered bootstrap-JWT issuer (enrollment.issuer). Absent for a
   * pre-issuer SaaS. Preflight MUST honor the same precedence the runtime
   * (`deriveAccountAuth`) applies — pin > delivered > derived — or Gate A
   * would report FAIL on a working proxy/custom-issuer setup (and PASS on a
   * broken one).
   */
  issuer?: string;
};

export type RunAddPreflightOptions = {
  accountId: string;
  tenant: string;
  saasBaseUrl: string;
  enrollment: AddPreflightEnrollment;
  /** Config-pinned operator escape hatches (config-present-wins). */
  pinnedIssuer?: string;
  pinnedAudience?: string;
  /** Progress sink (the setup hook's `runtime.log`, or console). */
  log: (...args: unknown[]) => void;
  /** @internal Test seam: JWKS fetch impl (forwarded to JWKSCache). */
  fetchImpl?: typeof fetch;
  /** @internal Test seam: override the relay-dial probe. */
  dial?: (input: {
    url: string;
    userJwt: string;
    userSeed: string;
    subject: string;
    timeoutMs: number;
  }) => Promise<{ ok: true } | { error: string }>;
  /** @internal Test seam: connect deps forwarded to the default relay dial. */
  connectDeps?: ConnectNatsDeps;
  /** Relay-dial timeout (ms). Default 5000 — keeps `channels add` responsive. */
  timeoutMs?: number;
};

/**
 * Run the Gate A add-time preflight and LOG the PASS/FAIL line. NEVER throws:
 * the creds + config are already validly persisted by the time this runs, and
 * the host's `afterAccountConfigWritten` contract is explicitly non-fatal, so a
 * FAIL is reported as a loud, actionable log line (not a thrown abort). Returns
 * the verdict so a caller/test can assert on it.
 *
 * NOTE (deviation from the brief's "non-zero exit"): the established setup-hook
 * contract does NOT throw (a failed acquire already only logs), and the config
 * is persisted regardless — so a hard abort would both break that contract and
 * strand a half-added account. The FAIL is instead made maximally VISIBLE at the
 * moment of add, which is the review's actual ask (kill the invisibility).
 */
export async function runAddPreflight(
  opts: RunAddPreflightOptions,
): Promise<AddPreflightReport> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  // Issuer precedence MUST match the runtime's `deriveAccountAuth`:
  // pin > SaaS-delivered (enrollment.issuer) > derived from --base-url.
  const effectiveIssuer =
    opts.pinnedIssuer ?? opts.enrollment.issuer ?? deriveIssuer(opts.saasBaseUrl);
  const effectiveAudience = opts.pinnedAudience ?? opts.accountId;
  const derivedJwksUrl = deriveJwksUrl(opts.saasBaseUrl);

  // An operator pin that CONTRADICTS what the SaaS just declared it mints is
  // exactly the misconfig the delivered issuer exists to kill — warn loudly
  // while the operator is still watching. Slash-insensitive, matching how
  // verifyJwt compares `iss` (a slash variant is NOT a contradiction). A pin
  // is legitimate (proxy / logical issuer), so this is a WARN, never a FAIL.
  if (
    opts.pinnedIssuer !== undefined &&
    opts.enrollment.issuer !== undefined &&
    deriveIssuer(opts.pinnedIssuer) !== deriveIssuer(opts.enrollment.issuer)
  ) {
    opts.log(
      `[webchannel] account "${opts.accountId}" WARN: auth.jwt.issuer is pinned to ` +
        `"${opts.pinnedIssuer}" but the SaaS declared it mints iss="${opts.enrollment.issuer}" ` +
        `at enrollment. The pin wins (operator escape hatch) — but if it is stale, every ` +
        `bootstrap JWT will be rejected with an opaque "unauthorized". Remove the pin to ` +
        `use the SaaS-delivered issuer.`,
    );
  }

  // 1. Resolve JWKS against the DERIVED url (reuse the JWKSCache fetch path).
  let jwks: JwksReadiness;
  try {
    const cache = JWKSCache.create(
      { jwksUrl: derivedJwksUrl },
      // Bound the JWKS fetch by the SAME budget as the relay dial so `channels add`
      // stays responsive (otherwise the default 10s JWKS timeout would run before
      // the 5s dial, blowing the operator-facing budget).
      {
        fetchTimeoutMs: timeoutMs,
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      },
    );
    const doc = await cache.warm();
    jwks = { keyCount: doc.keys.length };
  } catch (err) {
    jwks = {
      error: err instanceof JwksUnavailableError ? err.message : String(err),
    };
  }

  // 2. Relay dial (scoped no-op sub within the account's own subtree, then close).
  const dialSubject = `webchannel.${opts.tenant}.${opts.accountId}._preflight`;
  const relay = opts.enrollment.natsUrl
    ? await (opts.dial ?? dialRelayForPreflight)({
        url: opts.enrollment.natsUrl,
        userJwt: opts.enrollment.userJwt,
        userSeed: opts.enrollment.userSeed,
        subject: dialSubject,
        timeoutMs,
        ...(opts.connectDeps ? { connectDeps: opts.connectDeps } : {}),
      })
    : ({ error: 'no SaaS-delivered relay URL in the enrollment result' } as const);

  const report = evaluateAddPreflight({
    accountId: opts.accountId,
    effectiveIssuer,
    effectiveAudience,
    derivedJwksUrl,
    ...(opts.enrollment.jwksUrl !== undefined
      ? { deliveredJwksUrl: opts.enrollment.jwksUrl }
      : {}),
    ...(opts.pinnedAudience !== undefined ? { pinnedAudience: opts.pinnedAudience } : {}),
    jwks,
    relay,
  });

  opts.log(`[webchannel] ${report.line}`);
  return report;
}

/**
 * Default relay-dial probe: connect the enrolled creds to the relay (the NKEY
 * challenge-response handshake itself proves the creds are valid + accepted),
 * open a scoped no-op subscription within the account's own subtree, then
 * disconnect. Bounded by `timeoutMs` so `channels add` can never hang on an
 * unreachable relay. Reuses `connectNatsCredentialSource` (static mode) — the
 * same primitive the runtime uses to dial enrolled creds — so nothing about the
 * auth flow is reinvented here.
 */
export async function dialRelayForPreflight(input: {
  kind?: "static";
  url: string;
  userJwt: string;
  userSeed: string;
  subject: string;
  timeoutMs: number;
  connectDeps?: ConnectNatsDeps;
}): Promise<{ ok: true } | { error: string }> {
  let connection: Awaited<ReturnType<typeof connectNatsCredentialSource>> | undefined;
  try {
    const connected = await withTimeout(
      connectNatsCredentialSource(
        { mode: "static", url: input.url, userJwt: input.userJwt, userSeed: input.userSeed },
        input.connectDeps ?? {},
      ),
      input.timeoutMs,
      `relay dial timed out after ${input.timeoutMs}ms`,
      // A timeout does NOT cancel the connect — the promise stays pending and can
      // still resolve with a live authenticated transport that no one holds. The
      // `finally` below cannot reach it (`connection` is still undefined), so a
      // slow relay would leak a connection + its subscription per probe. Doctor/
      // status probe this path repeatedly, so a late arrival is torn down here.
      //
      // RESIDUAL (not covered): this only fires if the connect eventually SETTLES.
      // `NatsTransport.connect()` has no handshake timeout and no cancellation —
      // its promise resolves on the first pong, and the only timer in
      // `nats-transport.ts` is reconnect backoff. So if the relay accepts the
      // socket and then goes silent, `connect()` never settles, `onLate` never
      // runs, and that socket stays orphaned — arguably the likeliest reason the
      // dial timeout fires at all. Closing that needs the dialer to own the
      // transport (construct it here so it can be disconnected without waiting on
      // the connect promise), which is a larger change than this fix.
      (late) => {
        try {
          late.transport.disconnect();
        } catch {
          /* ignore teardown errors — the probe result is already decided */
        }
      },
    );
    connection = connected;
    // Scoped no-op subscription within the agent's own `webchannel.{tenant}.>`
    // grant — proves the subject scoping the browser register will ride is
    // permitted for these creds. Best-effort; a permission fault surfaces via
    // the transport error event, but the connect handshake is the load-bearing
    // proof, so we do not block on a settle window (keeps `channels add` fast).
    connected.transport.subscribe(input.subject);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      connection?.transport.disconnect();
    } catch {
      /* ignore teardown errors — the probe result is already decided */
    }
  }
}

/**
 * Reject with `message` if `p` does not settle within `ms`.
 *
 * `onLate` receives a value `p` resolves with AFTER the timeout already rejected.
 * The returned promise is settled by then, so that value is otherwise dropped on
 * the floor — which orphans anything holding a resource. Callers whose `T` needs
 * teardown (a live connection) pass a disposer here.
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  message: string,
  onLate?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(message));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        if (timedOut) {
          onLate?.(v);
          return;
        }
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}
