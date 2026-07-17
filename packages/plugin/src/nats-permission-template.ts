/**
 * BYO-NATS permission template (P0-3 D3) — the subject-grant contract an operator
 * must configure on their own NATS broker so webchannel serves correctly.
 *
 * This is the SINGLE source of truth for the required subject grants, mirroring
 * what the SaaS mint (`packages/saas/src/nats-user-creds.ts`) actually stamps into
 * each role's user JWT. Three tests lock the three copies together:
 *   - plugin parity: `requiredNatsPermissions("t1")` === `contracts/nats-permissions.v1.json`.
 *   - saas parity: the DECODED minted-JWT claims === the same fixture.
 *   - subject-coverage: every runtime subject (from `subjects.ts`) matches a grant.
 * So a drift in the mint breaks the saas test; a drift in this template breaks the
 * plugin test; a drift in the runtime subjects breaks the coverage test.
 *
 * The grant shape is the FULL nats-server permissions claim: `allow` AND `deny`
 * for both `pub` and `sub`. The observer's deny-all publish MUST be expressed as
 * `pub.deny: [">"]` — an empty `pub.allow` is NOT deny-all in nats-server (an
 * absent/empty allow-list means UNRESTRICTED), so the explicit deny is what
 * actually refuses every publish.
 */

/** A nats-server permissions claim — allow + deny for both pub and sub. */
export type SubjectPermissionSet = {
  pub: { allow: string[]; deny: string[] };
  sub: { allow: string[]; deny: string[] };
};

/** The three role grants a BYO-NATS operator must configure for a tenant. */
export type RequiredNatsPermissions = {
  /** The enrolled agent: tenant-wide pub+sub (`webchannel.{tenant}.>`). */
  agent: SubjectPermissionSet;
  /** A browser peer: pinned to its OWN subtree (`webchannel.{tenant}.*.{peerId}.>`). */
  browser: (peerId: string) => SubjectPermissionSet;
  /** The demo observer: tenant-wide SUB, deny-all PUB (`pub.deny:[">"]`). */
  observer: SubjectPermissionSet;
};

/**
 * The required NATS subject grants for a tenant, per role. Mirrors
 * `mintNatsUserCreds` (nats-user-creds.ts:152-176) byte-for-byte in the subjects
 * and the observer deny-all.
 */
export function requiredNatsPermissions(tenant: string): RequiredNatsPermissions {
  const tenantWide = `webchannel.${tenant}.>`;
  return {
    agent: {
      pub: { allow: [tenantWide], deny: [] },
      sub: { allow: [tenantWide], deny: [] },
    },
    browser: (peerId: string): SubjectPermissionSet => {
      const peerSubtree = `webchannel.${tenant}.*.${peerId}.>`;
      return {
        pub: { allow: [peerSubtree], deny: [] },
        sub: { allow: [peerSubtree], deny: [] },
      };
    },
    observer: {
      // Deny-all publish is EXPLICIT (empty allow is not deny-all in nats-server).
      pub: { allow: [], deny: [">"] },
      sub: { allow: [tenantWide], deny: [] },
    },
  };
}

/**
 * Does a concrete subject match a NATS grant pattern? NATS wildcard semantics:
 *   - `*` matches EXACTLY one token,
 *   - `>` matches ONE OR MORE trailing tokens (only valid as the last token),
 *   - every other token is a literal.
 * Used by the subject-coverage test to prove each runtime subject falls within a
 * role grant, without hand-copying the subject strings.
 */
export function subjectMatchesNatsGrant(subject: string, pattern: string): boolean {
  const s = subject.split(".");
  const p = pattern.split(".");
  for (let i = 0; i < p.length; i++) {
    const pt = p[i];
    if (pt === ">") {
      // `>` must be last and matches one-or-more remaining tokens.
      return i === p.length - 1 && s.length > i;
    }
    if (i >= s.length) return false;
    if (pt === "*") continue;
    if (pt !== s[i]) return false;
  }
  return s.length === p.length;
}

/**
 * Human-readable rendering of the permission template for a tenant — used by the
 * `channels add` static-mode notice, the preflight FAIL/WARN diagnostics, and the
 * BYO-NATS docs. `{peerId}` is left as a literal placeholder in the browser grant
 * (it is per-session), matching how an operator configures a wildcard grant.
 */
export function formatPermissionTemplate(tenant: string): string {
  const perms = requiredNatsPermissions(tenant);
  const browser = perms.browser("{peerId}");
  const line = (label: string, set: SubjectPermissionSet): string => {
    const fmt = (arr: string[]): string => (arr.length ? arr.join(", ") : "(none)");
    return (
      `  ${label}:\n` +
      `    pub allow: ${fmt(set.pub.allow)}\n` +
      `    pub deny:  ${fmt(set.pub.deny)}\n` +
      `    sub allow: ${fmt(set.sub.allow)}\n` +
      `    sub deny:  ${fmt(set.sub.deny)}`
    );
  };
  return (
    `BYO-NATS subject permissions required for tenant "${tenant}"\n` +
    `(configure these grants on your NATS broker; an empty pub.allow is NOT\n` +
    ` deny-all in nats-server, so the observer needs the explicit pub.deny [">"]):\n` +
    `${line("agent (enrolled gateway, tenant-wide)", perms.agent)}\n` +
    `${line("browser (per-peer; {peerId} = authenticated session subject)", browser)}\n` +
    `${line("observer (demo wiretap, read-only)", perms.observer)}`
  );
}
