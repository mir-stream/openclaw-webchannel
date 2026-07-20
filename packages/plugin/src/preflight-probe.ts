/**
 * Add-time NATS permission probe (P0-3 D4a) — PING-barrier, strictly sequential.
 *
 * A NATS permission violation is an ASYNC `-ERR 'Permissions Violation for
 * {Publish|Subscription} to "<subject>"'` event (nats-transport.ts) — `subscribe()`
 * and `publish()` return synchronously and say nothing about whether the broker
 * accepted the grant. So we can't judge a probe from the call's return value.
 *
 * Instead each probe:
 *   1. attaches a temporary `error` listener that correlates a `-ERR` on BOTH the
 *      operation kind (Publish vs Subscription) AND the exact subject — subject
 *      alone is insufficient because P1 (sub) and P2 (pub) share the `_preflight`
 *      subject;
 *   2. sends the SUB/PUB, then `await transport.flush()` — a PING→PONG BARRIER: the
 *      server emits the op's `-ERR` (if any) before it replies PONG;
 *   3. verdict: a correlated `-ERR` arrived before PONG ⇒ DENIED; a clean PONG ⇒
 *      ALLOWED;
 *   4. cleans up (remove the listener, UNSUB) after ITS OWN barrier.
 * Probes run STRICTLY SEQUENTIALLY on one transport — a shared error channel means
 * concurrent probes would cross-attribute `-ERR`s. The caller disconnects after
 * the last probe.
 *
 * The three probes (every source mode benefits — enrolled too):
 *   - P1 self-subtree SUB   `webchannel.{tenant}.{accountId}._preflight` — DENIED ⇒ FAIL.
 *   - P2 self-subtree PUB   same subject                                 — DENIED ⇒ FAIL.
 *   - P3 foreign-tenant SUB `webchannel.{randomTenant}._preflight` — ALLOWED ⇒
 *     cross-tenant grant, WARN.
 *   - P4 foreign-namespace SUB `_webchannel_preflight_foreign.{rand}` — ALLOWED ⇒
 *     globally over-broad grant, WARN.
 */

import { randomBytes } from "node:crypto";

import { preflightSubject } from "./subjects.js";
import { formatPermissionTemplate } from "./nats-permission-template.js";

/** The transport surface the probe needs — `NatsTransport` satisfies it structurally. */
export type ProbeTransport = {
  subscribe(subject: string): number;
  unsubscribe(sid: number): void;
  publish(subject: string, payload: string | Buffer): void;
  flush(timeoutMs?: number): Promise<void>;
  on(event: "error", listener: (err: Error) => void): unknown;
  off(event: "error", listener: (err: Error) => void): unknown;
};

export type ProbeOperation = "Publish" | "Subscription";

export type PermissionProbeResult = {
  probe: "P1-agent-sub" | "P2-agent-pub" | "P3-foreign-tenant-sub" | "P4-foreign-namespace-sub";
  operation: ProbeOperation;
  subject: string;
  /** true = the broker permitted the operation (no correlated -ERR before PONG). */
  allowed: boolean;
};

export type PermissionProbeReport = {
  results: PermissionProbeResult[];
  /** PASS = P1+P2 allowed & P3 denied; WARN = P3 allowed (over-broad); FAIL = P1 or P2 denied. */
  verdict: "PASS" | "WARN" | "FAIL";
  line: string;
};

const PERMISSION_VIOLATION_RE =
  /Permissions Violation for (Publish|Subscription) to "([^"]+)"/;

/** Parse a transport `-ERR` message into (operation, subject), or null if not a violation. */
export function parsePermissionViolation(
  message: string,
): { operation: ProbeOperation; subject: string } | null {
  const m = PERMISSION_VIOLATION_RE.exec(message);
  if (!m) return null;
  return { operation: m[1] as ProbeOperation, subject: m[2]! };
}

/**
 * Run one probe: attach a correlated error listener, perform the op, cross the
 * PING/PONG barrier, then clean up. Returns whether the op was ALLOWED.
 */
async function runProbe(
  transport: ProbeTransport,
  op: { operation: ProbeOperation; subject: string; kind: "sub" | "pub" },
  timeoutMs: number,
): Promise<boolean> {
  let denied = false;
  const onError = (err: Error): void => {
    const v = parsePermissionViolation(err.message);
    if (v && v.operation === op.operation && v.subject === op.subject) denied = true;
  };
  transport.on("error", onError);
  let sid: number | undefined;
  try {
    if (op.kind === "sub") {
      sid = transport.subscribe(op.subject);
    } else {
      transport.publish(op.subject, "");
    }
    // Barrier: the server has processed the op (and emitted any -ERR) by PONG.
    await transport.flush(timeoutMs);
  } finally {
    if (sid !== undefined) {
      try {
        transport.unsubscribe(sid);
      } catch {
        /* best-effort cleanup — the verdict is already decided */
      }
    }
    transport.off("error", onError);
  }
  return !denied;
}

export type RunPermissionProbesOptions = {
  /** Per-probe PING/PONG barrier timeout (ms). Default 2000. */
  timeoutMs?: number;
  /** Override the foreign-tenant probe subject (tests). */
  foreignSubject?: string;
  /** Override the outside-webchannel namespace probe subject (tests). */
  foreignNamespaceSubject?: string;
  /** Tenant used in the FAIL template hint (defaults to the probe tenant). */
  tenant?: string;
};

/**
 * Run the three permission probes sequentially on one connected transport and
 * return a verdict + human-readable line. The caller owns disconnecting the
 * transport after this resolves.
 */
export async function runPermissionProbes(
  transport: ProbeTransport,
  ids: { tenant: string; accountId: string },
  opts: RunPermissionProbesOptions = {},
): Promise<PermissionProbeReport> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const selfSubject = preflightSubject(ids.tenant, ids.accountId);
  const foreignSubject =
    opts.foreignSubject ?? `webchannel._preflight_${randomBytes(8).toString("hex")}._probe`;
  const foreignNamespaceSubject =
    opts.foreignNamespaceSubject ?? `_webchannel_preflight_foreign.${randomBytes(8).toString("hex")}`;

  // STRICTLY SEQUENTIAL — one shared error channel.
  const p1Allowed = await runProbe(
    transport,
    { operation: "Subscription", subject: selfSubject, kind: "sub" },
    timeoutMs,
  );
  const p2Allowed = await runProbe(
    transport,
    { operation: "Publish", subject: selfSubject, kind: "pub" },
    timeoutMs,
  );
  const p3Allowed = await runProbe(
    transport,
    { operation: "Subscription", subject: foreignSubject, kind: "sub" },
    timeoutMs,
  );
  const p4Allowed = await runProbe(
    transport,
    { operation: "Subscription", subject: foreignNamespaceSubject, kind: "sub" },
    timeoutMs,
  );

  const results: PermissionProbeResult[] = [
    { probe: "P1-agent-sub", operation: "Subscription", subject: selfSubject, allowed: p1Allowed },
    { probe: "P2-agent-pub", operation: "Publish", subject: selfSubject, allowed: p2Allowed },
    { probe: "P3-foreign-tenant-sub", operation: "Subscription", subject: foreignSubject, allowed: p3Allowed },
    { probe: "P4-foreign-namespace-sub", operation: "Subscription", subject: foreignNamespaceSubject, allowed: p4Allowed },
  ];

  if (!p1Allowed || !p2Allowed) {
    const missing = [!p1Allowed && "sub", !p2Allowed && "pub"].filter(Boolean).join(" + ");
    return {
      results,
      verdict: "FAIL",
      line:
        `NATS permission probe FAIL — the enrolled agent creds are DENIED ${missing} on the account's ` +
        `own subtree (${selfSubject}); no browser could ever register/serve. Configure the required grants:\n` +
        formatPermissionTemplate(opts.tenant ?? ids.tenant),
    };
  }
  if (p3Allowed || p4Allowed) {
    const scope = p3Allowed && p4Allowed
      ? `another tenant (${foreignSubject}) and outside the webchannel namespace (${foreignNamespaceSubject})`
      : p3Allowed
        ? `another tenant (${foreignSubject})`
        : `outside the webchannel namespace (${foreignNamespaceSubject})`;
    return {
      results,
      verdict: "WARN",
      line:
        `NATS permission probe WARN — the agent creds are OVER-BROAD: they permit subscribing to ${scope}. ` +
        `Serving works, but the isolation guarantee is weakened — ` +
        `scope the creds to webchannel.${ids.tenant}.> per the template.`,
    };
  }
  return {
    results,
    verdict: "PASS",
    line: `NATS permission probe PASS — self-subtree sub+pub allowed, foreign-namespace sub denied.`,
  };
}
