/**
 * NATS account/subject permission enforcement tests — Sub-AC 3b.
 *
 * Verifies that each tenant/user credential is bound to only its own subject
 * namespace at the bus level:
 *
 *  - A client authenticated as tenant A can pub/sub on chat.tenantA.> subjects.
 *  - A client authenticated as tenant A is DENIED pub/sub on chat.tenantB.>
 *    subjects at the NATS broker level — the broker sends -ERR 'Permissions
 *    Violation for Publish/Subscription to "<subject>"'.
 *  - Unauthenticated clients (no jwt credential) are denied all pub/sub.
 *  - Cross-tenant publish cannot reach a different tenant's subscribers.
 *
 * Architecture
 * ────────────
 * PermissionedFakeNatsBroker mirrors how a real NATS server with account/
 * subject permissions works:
 *
 *  1. The broker parses the `jwt` field from the NATS CONNECT command.
 *  2. It extracts the `tenant` claim to derive this client's allowed subject
 *     namespace: `chat.<tenant>.>` (NATS multi-token wildcard).
 *  3. On each SUB: validates the subject against the allowed namespace.
 *     Denied → sends `-ERR 'Permissions Violation for Subscription to "..."'`.
 *  4. On each PUB: validates the subject against the allowed namespace.
 *     Denied → sends `-ERR 'Permissions Violation for Publish to "..."'`.
 *
 * The PermissionedFakeNatsBroker uses the same `_wsFactory` seam as all other
 * integration tests — zero real TCP sockets.  Permission denials surface as
 * 'error' events on the NatsTransport (post-handshake -ERR handling).
 *
 * Test JWTs
 * ─────────
 * The tests use simplified credentials: a base64url-encoded JSON payload with
 * a `tenant` claim.  In production, these are SaaS-issued NATS user JWTs (with
 * `nats.pub.allow` / `nats.sub.allow` claims) verified by the NATS server's
 * NATS account resolver.  The permission logic is identical; only the JWT
 * verification step is mocked away here (that path is covered by the jwks.ts
 * and jwt.ts unit tests).
 */

import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";

import { NatsTransport } from "./nats-transport.js";
import type { NatsMessage } from "./nats-transport.js";

// ---------------------------------------------------------------------------
// Test credential helpers
// ---------------------------------------------------------------------------

/**
 * Create a simplified test NATS credential for a tenant.
 *
 * The credential is a base64url-encoded JSON payload with `{ tenant: string }`.
 * The PermissionedFakeNatsBroker parses this from the CONNECT `jwt` field.
 *
 * In production, the SaaS issues a signed NATS user JWT carrying the tenant
 * claim; the NATS server verifies the RSA signature before enforcing the
 * embedded subject permissions.  Here we stub the JWT to isolate the
 * permission-enforcement logic from the signature-verification path.
 */
function makeTestJwt(tenant: string): string {
  return Buffer.from(JSON.stringify({ tenant })).toString("base64url");
}

// ---------------------------------------------------------------------------
// Subject helpers
// ---------------------------------------------------------------------------

/**
 * Derive the expected NATS subject permission pattern for a tenant.
 * Mirrors the SaaS claim that would appear in a real NATS user JWT.
 *
 * Examples:
 *   tenantSubjectPattern("tenantA") → "chat.tenantA.>"
 *   tenantSubjectPattern("tenantB") → "chat.tenantB.>"
 */
function tenantSubjectPattern(tenant: string): string {
  return `chat.${tenant}.>`;
}

/**
 * Check if a NATS subject matches a permission pattern.
 *
 * Supported wildcard syntax (NATS subset):
 *  - `>`  at the end: matches one or more tokens from that position.
 *         "chat.tenantA.>" matches "chat.tenantA.agent1.user42.out"
 *         but NOT "chat.tenantAExtended.agent1.out" (prefix boundary is the dot).
 *  - Exact match (no wildcards).
 */
function subjectMatchesPattern(subject: string, pattern: string): boolean {
  if (pattern === subject) return true;
  if (pattern.endsWith(">")) {
    // "chat.tenantA.>" → prefix is "chat.tenantA." (trailing dot is the boundary).
    const prefix = pattern.slice(0, -1); // removes ">"
    return subject.startsWith(prefix) && subject.length > prefix.length;
  }
  return false;
}

// ---------------------------------------------------------------------------
// PermissionedFakeNatsBroker
// ---------------------------------------------------------------------------

/**
 * Per-client connection state for the permissioned broker.
 */
type ClientState = {
  /** Push a NATS text frame to this client's 'message' handlers. */
  push: (data: string) => void;
  /** Allowed subject pattern derived from the parsed credential. Null = no access. */
  allowedPattern: string | null;
};

/**
 * Parse the tenant claim from a test JWT (base64url-encoded JSON).
 * Returns null if the jwt field is absent, malformed, or missing the tenant.
 */
function parseTenantFromJwt(connectLinePayload: string): string | null {
  try {
    const connectJson = JSON.parse(connectLinePayload) as Record<string, unknown>;
    const jwt = connectJson["jwt"];
    if (typeof jwt !== "string" || jwt.length === 0) return null;
    const decoded = Buffer.from(jwt, "base64url").toString("utf8");
    const claims = JSON.parse(decoded) as Record<string, unknown>;
    if (typeof claims["tenant"] !== "string" || (claims["tenant"] as string).length === 0) {
      return null;
    }
    return claims["tenant"] as string;
  } catch {
    return null;
  }
}

/**
 * In-process NATS broker that enforces subject-level permissions based on the
 * tenant claim embedded in the CONNECT `jwt` field.
 *
 * Enforcement mirrors real NATS server behaviour:
 *  - SUB to a denied subject → `-ERR 'Permissions Violation for Subscription to "..."'`
 *  - PUB to a denied subject → `-ERR 'Permissions Violation for Publish to "..."'`
 *
 * Compliant subscriptions and publishes are routed normally (identical to
 * FakeNatsBroker from Sub-AC 2 / 3).
 *
 * Zero real TCP sockets — same `_wsFactory` seam design as all other tests.
 */
class PermissionedFakeNatsBroker {
  private readonly clients = new Map<string, ClientState>();
  private readonly buffers = new Map<string, string>();
  private subscriptions: Array<{ subject: string; clientId: string; sid: number }> = [];
  private nextClientId = 0;

  /** Create a `_wsFactory` that NatsTransport can use to connect to this broker. */
  createFactory(): (url: string) => WebSocket {
    return (_url: string) => {
      const clientId = `c${++this.nextClientId}`;
      const handlers = new Map<string, Array<(...args: unknown[]) => void>>();

      const pushToClient = (data: string): void => {
        handlers.get("message")?.forEach((fn) => fn(data));
      };

      // Default: no access until a credential is parsed from CONNECT.
      this.clients.set(clientId, { push: pushToClient, allowedPattern: null });
      this.buffers.set(clientId, "");

      const broker = this;

      const fakeWs: any = {
        readyState: WebSocket.CONNECTING as number,

        on(event: string, fn: (...args: unknown[]) => void): typeof fakeWs {
          const list = handlers.get(event) ?? [];
          list.push(fn);
          handlers.set(event, list);
          return fakeWs;
        },

        send(data: string | Buffer): void {
          const str = Buffer.isBuffer(data)
            ? data.toString("utf8")
            : (data as string);
          broker.processClientData(clientId, str, pushToClient);
        },

        close(): void {
          fakeWs.readyState = WebSocket.CLOSED;
          broker.subscriptions = broker.subscriptions.filter(
            (s) => s.clientId !== clientId,
          );
          broker.clients.delete(clientId);
          broker.buffers.delete(clientId);
          handlers.get("close")?.forEach((fn) => fn());
        },
      };

      // Fire 'open' asynchronously — same timing contract as a real TCP dial.
      queueMicrotask(() => {
        fakeWs.readyState = WebSocket.OPEN;
        handlers.get("open")?.forEach((fn) => fn());
      });

      return fakeWs as unknown as WebSocket;
    };
  }

  private processClientData(
    clientId: string,
    data: string,
    pushToClient: (s: string) => void,
  ): void {
    const existing = this.buffers.get(clientId) ?? "";
    let buffer = existing + data;
    const clientState = this.clients.get(clientId);

    let crlfPos: number;
    while ((crlfPos = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, crlfPos);
      buffer = buffer.slice(crlfPos + 2);

      if (!line) continue;

      // ── CONNECT — parse credential and bind subject permissions ─────────────
      if (line.startsWith("CONNECT ")) {
        const connectPayload = line.slice("CONNECT ".length);
        const tenant = parseTenantFromJwt(connectPayload);
        if (clientState) {
          // Derive the allowed subject pattern from the tenant claim.
          // Mirrors the NATS server extracting `nats.pub.allow` / `nats.sub.allow`
          // from the SaaS-issued user JWT.
          clientState.allowedPattern = tenant ? tenantSubjectPattern(tenant) : null;
        }
        continue;
      }

      // ── PING (client → server) ─────────────────────────────────────────────
      if (line === "PING") {
        // Complete the NATS handshake: INFO + PONG.
        pushToClient(
          `INFO {"server_id":"perm-fake-nats","version":"2.10.0"}\r\nPONG\r\n`,
        );
        continue;
      }

      if (line === "PONG") continue;

      // ── SUB subject sid ────────────────────────────────────────────────────
      if (line.startsWith("SUB ")) {
        const parts = line.split(" ");
        const subject = parts[1] ?? "";
        const sid = parseInt(parts[2] ?? "0", 10);
        if (!subject) continue;

        // Permission gate: deny if the subject is outside the allowed namespace.
        const allowed = clientState?.allowedPattern ?? null;
        if (!allowed || !subjectMatchesPattern(subject, allowed)) {
          // Bus-level rejection — mirrors real NATS `-ERR` for permissions.
          pushToClient(
            `-ERR 'Permissions Violation for Subscription to "${subject}"'\r\n`,
          );
          continue;
        }

        // Permitted: register the subscription.
        this.subscriptions.push({ subject, clientId, sid });
        continue;
      }

      // ── UNSUB sid ──────────────────────────────────────────────────────────
      if (line.startsWith("UNSUB ")) {
        const sid = parseInt(line.split(" ")[1] ?? "0", 10);
        this.subscriptions = this.subscriptions.filter(
          (s) => !(s.clientId === clientId && s.sid === sid),
        );
        continue;
      }

      // ── PUB subject byteCount ──────────────────────────────────────────────
      if (line.startsWith("PUB ")) {
        const parts = line.split(" ");
        const subject = parts[1] ?? "";
        const byteCount = parseInt(parts[2] ?? "0", 10);

        if (isNaN(byteCount) || byteCount < 0 || !subject) continue;

        if (buffer.length < byteCount + 2) {
          // Incomplete payload — wait for more data.
          buffer = `${line}\r\n${buffer}`;
          break;
        }

        const payload = buffer.slice(0, byteCount);
        buffer = buffer.slice(byteCount + 2);

        // Permission gate: deny if the subject is outside the allowed namespace.
        const allowed = clientState?.allowedPattern ?? null;
        if (!allowed || !subjectMatchesPattern(subject, allowed)) {
          pushToClient(
            `-ERR 'Permissions Violation for Publish to "${subject}"'\r\n`,
          );
          continue;
        }

        // Permitted: route the message to all matching subscribers.
        for (const sub of this.subscriptions) {
          if (sub.subject === subject) {
            const cs = this.clients.get(sub.clientId);
            if (cs) {
              cs.push(`MSG ${subject} ${sub.sid} ${byteCount}\r\n${payload}\r\n`);
            }
          }
        }
        continue;
      }

      if (line === "+OK") continue;
      // Unknown lines: ignore (forward-compat).
    }

    this.buffers.set(clientId, buffer);
  }

  /** Release all broker state (idempotent). */
  dispose(): void {
    this.clients.clear();
    this.buffers.clear();
    this.subscriptions = [];
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Connect a NatsTransport to a PermissionedFakeNatsBroker with a specific
 * tenant credential. Returns the connected transport.
 */
async function connectAs(
  broker: PermissionedFakeNatsBroker,
  tenant: string,
  clientName?: string,
): Promise<NatsTransport> {
  const t = new NatsTransport({
    url: "ws://fake-nats:4222",
    jwtCredential: makeTestJwt(tenant),
    clientName: clientName ?? `${tenant}-client`,
    _wsFactory: broker.createFactory(),
  });
  await t.connect();
  return t;
}

/**
 * Connect without any credential (unauthenticated — no jwt field).
 */
async function connectAnon(
  broker: PermissionedFakeNatsBroker,
): Promise<NatsTransport> {
  const t = new NatsTransport({
    url: "ws://fake-nats:4222",
    clientName: "anon-client",
    _wsFactory: broker.createFactory(),
  });
  await t.connect();
  return t;
}

/**
 * Capture the next 'error' event from a NatsTransport as a Promise.
 * Resolves with the error message string.
 * Callers MUST set up this listener BEFORE triggering the operation that
 * causes the error (error events are synchronous in the fake broker).
 */
function captureNextError(t: NatsTransport): Promise<string> {
  return new Promise<string>((resolve) => {
    t.once("error", (err: Error) => resolve(err.message));
  });
}

// ---------------------------------------------------------------------------
// Canonical NATS subjects for the tests
// ---------------------------------------------------------------------------

const TENANT_A = "tenantA";
const TENANT_B = "tenantB";

// Tenant A subjects
const A_INBOUND  = "chat.tenantA.agent1.user42.in";
const A_OUTBOUND = "chat.tenantA.agent1.user42.out";
const A_HISTORY  = "chat.tenantA.agent1.user42.history";
const A_APPROVAL = "chat.tenantA.agent1.user42.approval";

// Tenant B subjects
const B_INBOUND  = "chat.tenantB.agent1.user99.in";
const B_OUTBOUND = "chat.tenantB.agent1.user99.out";

// A subject whose prefix starts with "tenantA" but is NOT in tenantA's namespace
// (no dot after tenantA — must be rejected).
const A_LOOKALIKE = "chat.tenantAExtended.agent1.user42.out";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(
  "NATS subject permission enforcement (Sub-AC 3b)",
  () => {
    const teardown: NatsTransport[] = [];
    const brokers: PermissionedFakeNatsBroker[] = [];

    afterEach(() => {
      for (const t of teardown) {
        try { t.disconnect(); } catch { /* best-effort */ }
      }
      teardown.length = 0;
      for (const b of brokers) b.dispose();
      brokers.length = 0;
    });

    // ── Test 1: tenant A can subscribe to its own subjects ──────────────────

    it(
      "tenant A client can subscribe to its own subject namespace without error",
      async () => {
        const broker = new PermissionedFakeNatsBroker();
        brokers.push(broker);

        const clientA = await connectAs(broker, TENANT_A);
        teardown.push(clientA);

        const errors: string[] = [];
        clientA.on("error", (err: Error) => errors.push(err.message));

        // All tenantA subjects must be allowed without any permission error.
        const received: NatsMessage[] = [];
        clientA.on("message", (m: NatsMessage) => received.push(m));

        clientA.subscribe(A_INBOUND);
        clientA.subscribe(A_OUTBOUND);
        clientA.subscribe(A_HISTORY);
        clientA.subscribe(A_APPROVAL);

        // No permission errors should have been emitted.
        expect(errors).toHaveLength(0);
      },
    );

    // ── Test 2: tenant A is denied subscription to tenant B subjects ─────────

    it(
      "tenant A client is denied subscription to tenant B subject namespace",
      async () => {
        const broker = new PermissionedFakeNatsBroker();
        brokers.push(broker);

        const clientA = await connectAs(broker, TENANT_A);
        teardown.push(clientA);

        // Set up error listener BEFORE triggering the denied SUB.
        const errorPromise = captureNextError(clientA);

        // Attempt to subscribe to a tenant B subject — must be denied.
        clientA.subscribe(B_OUTBOUND);

        const errMsg = await errorPromise;

        // The broker must send a NATS -ERR Permissions Violation for Subscription.
        expect(errMsg).toContain("Permissions Violation for Subscription");
        expect(errMsg).toContain(B_OUTBOUND);
      },
    );

    // ── Test 3: tenant A is denied subscription to tenant B inbound subject ──

    it(
      "tenant A client is denied subscription to tenant B inbound subject",
      async () => {
        const broker = new PermissionedFakeNatsBroker();
        brokers.push(broker);

        const clientA = await connectAs(broker, TENANT_A);
        teardown.push(clientA);

        const errorPromise = captureNextError(clientA);
        clientA.subscribe(B_INBOUND);
        const errMsg = await errorPromise;

        expect(errMsg).toContain("Permissions Violation for Subscription");
        expect(errMsg).toContain(B_INBOUND);
      },
    );

    // ── Test 4: tenant A can publish to its own subjects ────────────────────

    it(
      "tenant A client can publish to its own subject namespace and messages are delivered",
      async () => {
        const broker = new PermissionedFakeNatsBroker();
        brokers.push(broker);

        const clientA = await connectAs(broker, TENANT_A, "tenantA-sender");
        const clientA2 = await connectAs(broker, TENANT_A, "tenantA-receiver");
        teardown.push(clientA, clientA2);

        const errors: string[] = [];
        clientA.on("error", (err: Error) => errors.push(err.message));

        // Receiver subscribes to tenantA outbound subject.
        const received: NatsMessage[] = [];
        clientA2.on("message", (m: NatsMessage) => received.push(m));
        clientA2.subscribe(A_OUTBOUND);

        // Sender publishes to the same tenantA subject.
        clientA.publish(A_OUTBOUND, "message from tenantA");

        // Message delivered, no permission errors.
        expect(errors).toHaveLength(0);
        expect(received).toHaveLength(1);
        expect(received[0]!.payload.toString("utf8")).toBe("message from tenantA");
      },
    );

    // ── Test 5: tenant A is denied publish to tenant B subjects ─────────────

    it(
      "tenant A client is denied publish to tenant B subject namespace",
      async () => {
        const broker = new PermissionedFakeNatsBroker();
        brokers.push(broker);

        const clientA = await connectAs(broker, TENANT_A);
        teardown.push(clientA);

        const errorPromise = captureNextError(clientA);

        // Attempt to publish to tenant B's outbound subject.
        clientA.publish(B_OUTBOUND, "cross-tenant publish attempt");

        const errMsg = await errorPromise;

        // The broker must send -ERR Permissions Violation for Publish.
        expect(errMsg).toContain("Permissions Violation for Publish");
        expect(errMsg).toContain(B_OUTBOUND);
      },
    );

    // ── Test 6: tenant A publish does NOT reach tenant B subscriber ──────────

    it(
      "tenant A publish is denied at bus level and tenant B subscriber receives nothing",
      async () => {
        const broker = new PermissionedFakeNatsBroker();
        brokers.push(broker);

        const clientA = await connectAs(broker, TENANT_A, "tenantA-publisher");
        const clientB = await connectAs(broker, TENANT_B, "tenantB-subscriber");
        teardown.push(clientA, clientB);

        // Tenant B subscribes to its own outbound subject.
        const tenantBReceived: NatsMessage[] = [];
        clientB.on("message", (m: NatsMessage) => tenantBReceived.push(m));
        clientB.subscribe(B_OUTBOUND);

        // Collect tenant A's permission errors.
        const tenantAErrors: string[] = [];
        clientA.on("error", (err: Error) => tenantAErrors.push(err.message));

        // Tenant A attempts to publish to the SAME subject tenant B subscribed to.
        // The broker MUST deny tenant A's publish — the message must NOT reach tenant B.
        clientA.publish(B_OUTBOUND, "cross-tenant payload");

        // Tenant A gets a permission violation.
        expect(tenantAErrors).toHaveLength(1);
        expect(tenantAErrors[0]).toContain("Permissions Violation for Publish");

        // Tenant B receives nothing — the denied publish was not routed.
        expect(tenantBReceived).toHaveLength(0);
      },
    );

    // ── Test 7: tenant B can pub/sub on its own namespace (independent) ───────

    it(
      "tenant B client can pub/sub on its own subject namespace independently",
      async () => {
        const broker = new PermissionedFakeNatsBroker();
        brokers.push(broker);

        const clientB1 = await connectAs(broker, TENANT_B, "tenantB-sender");
        const clientB2 = await connectAs(broker, TENANT_B, "tenantB-receiver");
        teardown.push(clientB1, clientB2);

        const errors: string[] = [];
        clientB1.on("error", (err: Error) => errors.push(err.message));
        clientB2.on("error", (err: Error) => errors.push(err.message));

        // Receiver subscribes to tenant B's outbound subject.
        const received: NatsMessage[] = [];
        clientB2.on("message", (m: NatsMessage) => received.push(m));
        clientB2.subscribe(B_OUTBOUND);

        // Sender publishes to tenant B's outbound subject.
        clientB1.publish(B_OUTBOUND, "tenantB internal message");

        // No errors, message delivered.
        expect(errors).toHaveLength(0);
        expect(received).toHaveLength(1);
        expect(received[0]!.payload.toString("utf8")).toBe("tenantB internal message");
      },
    );

    // ── Test 8: unauthenticated client is denied all pub/sub ─────────────────

    it(
      "unauthenticated client (no jwt credential) is denied both subscribe and publish",
      async () => {
        const broker = new PermissionedFakeNatsBroker();
        brokers.push(broker);

        const anon = await connectAnon(broker);
        teardown.push(anon);

        // Capture two sequential errors (one for SUB, one for PUB).
        const errors: string[] = [];
        const twoErrors = new Promise<void>((resolve) => {
          anon.on("error", (err: Error) => {
            errors.push(err.message);
            if (errors.length >= 2) resolve();
          });
        });

        // Both operations must be denied immediately (synchronous in the broker).
        anon.subscribe(A_INBOUND);
        anon.publish(A_OUTBOUND, "anon attempt");

        await twoErrors;

        // Both subscribe and publish were rejected.
        expect(errors.some((e) => e.includes("Permissions Violation for Subscription"))).toBe(true);
        expect(errors.some((e) => e.includes("Permissions Violation for Publish"))).toBe(true);
      },
    );

    // ── Test 9: subject prefix adjacency — tenantAExtended is NOT tenantA ────

    it(
      "subject with a prefix that starts with tenant name but lacks the dot separator is denied",
      async () => {
        const broker = new PermissionedFakeNatsBroker();
        brokers.push(broker);

        const clientA = await connectAs(broker, TENANT_A);
        teardown.push(clientA);

        // "chat.tenantAExtended.agent1.user42.out" starts with "chat.tenantA"
        // but NOT "chat.tenantA." — the dot is the namespace boundary in NATS.
        // TenantA's pattern is "chat.tenantA.>", which requires the full
        // "chat.tenantA." prefix.  The lookalike subject must be denied.
        const errorPromise = captureNextError(clientA);
        clientA.subscribe(A_LOOKALIKE);
        const errMsg = await errorPromise;

        expect(errMsg).toContain("Permissions Violation for Subscription");
        expect(errMsg).toContain(A_LOOKALIKE);
      },
    );

    // ── Test 10: full cross-tenant isolation — A and B coexist without bleed ─

    it(
      "full cross-tenant isolation: tenant A and tenant B pub/sub are fully separated",
      async () => {
        const broker = new PermissionedFakeNatsBroker();
        brokers.push(broker);

        // Tenant A: one sender, one receiver.
        const clientA_sender   = await connectAs(broker, TENANT_A, "tenantA-tx");
        const clientA_receiver = await connectAs(broker, TENANT_A, "tenantA-rx");

        // Tenant B: one sender, one receiver.
        const clientB_sender   = await connectAs(broker, TENANT_B, "tenantB-tx");
        const clientB_receiver = await connectAs(broker, TENANT_B, "tenantB-rx");

        teardown.push(clientA_sender, clientA_receiver, clientB_sender, clientB_receiver);

        // Collect any permission errors per tenant.
        const errorsA: string[] = [];
        const errorsB: string[] = [];
        clientA_sender.on("error",   (e: Error) => errorsA.push(e.message));
        clientA_receiver.on("error", (e: Error) => errorsA.push(e.message));
        clientB_sender.on("error",   (e: Error) => errorsB.push(e.message));
        clientB_receiver.on("error", (e: Error) => errorsB.push(e.message));

        // ── Tenant A setup ──────────────────────────────────────────────────
        const receivedByA: NatsMessage[] = [];
        clientA_receiver.on("message", (m: NatsMessage) => receivedByA.push(m));
        clientA_receiver.subscribe(A_OUTBOUND);

        // ── Tenant B setup ──────────────────────────────────────────────────
        const receivedByB: NatsMessage[] = [];
        clientB_receiver.on("message", (m: NatsMessage) => receivedByB.push(m));
        clientB_receiver.subscribe(B_OUTBOUND);

        // ── Tenant A publishes to its own namespace ─────────────────────────
        clientA_sender.publish(A_OUTBOUND, "tenantA private message");

        // ── Tenant B publishes to its own namespace ─────────────────────────
        clientB_sender.publish(B_OUTBOUND, "tenantB private message");

        // Each tenant's receiver sees only its own message.
        expect(receivedByA).toHaveLength(1);
        expect(receivedByA[0]!.payload.toString("utf8")).toBe("tenantA private message");

        expect(receivedByB).toHaveLength(1);
        expect(receivedByB[0]!.payload.toString("utf8")).toBe("tenantB private message");

        // Neither tenant produced permission errors for their own subjects.
        expect(errorsA).toHaveLength(0);
        expect(errorsB).toHaveLength(0);

        // ── Cross-tenant attempts are denied ────────────────────────────────
        const crossAtoB_subError  = captureNextError(clientA_sender);
        clientA_sender.subscribe(B_OUTBOUND);
        expect(await crossAtoB_subError).toContain("Permissions Violation for Subscription");

        const crossBtoA_pubError = captureNextError(clientB_sender);
        clientB_sender.publish(A_OUTBOUND, "cross-tenant inject attempt");
        expect(await crossBtoA_pubError).toContain("Permissions Violation for Publish");

        // The cross-tenant publish was denied — tenantA receiver still has only 1 message.
        expect(receivedByA).toHaveLength(1);
      },
    );
  },
);
