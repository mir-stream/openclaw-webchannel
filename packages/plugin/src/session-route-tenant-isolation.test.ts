/**
 * #112 (P1, confidentiality) — the session key MUST be scoped by TENANT.
 *
 * ── The defect these tests lock out ─────────────────────────────────────────
 * Tenant is a separately verified authorization namespace: it is the NATS
 * subject namespace (`webchannel.{tenant}.{accountId}.…`), the scope of the
 * relay credentials and the conversation-key store, and a MANDATORY signed JWT
 * claim that register admission checks. The protocol permits the SAME account
 * id to exist under different tenants. But `resolveWebchannelSessionRoute` used
 * to derive its key from (agent, channel, account, peer) only — no tenant. So:
 *
 *   1. serve an active session as `(tenant=T1, accountId=A, peerId=P)`;
 *   2. hot-reload the same local account as `(tenant=T2, accountId=A)`, keeping
 *      the agent binding, the verifier issuer/JWKS/audience, and the peer
 *      string `P`;
 *   3. register with a VALID JWT whose signed tenant claim is `T2`.
 *
 * T2's browser then resolved the SAME core session key T1 wrote under, and read
 * T1's transcript back through the register-time history snapshot or
 * `load_history`. Register admission cannot catch it — it compares the JWT
 * tenant against the CONFIGURED tenant, and after the reload T2 is legitimately
 * the configured tenant. `test("… is ADMITTED …")` below asserts exactly that,
 * so the coverage does not quietly come to rest on the wrong guard.
 *
 * ── Why these tests are shaped this way ─────────────────────────────────────
 * The leak is at the seam between key derivation and the session store, so the
 * store here is a `Map` keyed by session key — which is faithful: the real read
 * path bottoms out at `api.runtime.subagent.getSessionMessages({ sessionKey })`
 * (see `history.ts` `readFromStore`), and core's on-disk `sessions.json` is a
 * flat map whose top-level keys ARE session keys. The snapshot and
 * `load_history` bodies below are transcribed from the two production READ
 * sites in `nats-account-runtime.ts` (`sendHistorySnapshot` and
 * `setLoadHistoryHandler`); keep them in step if those change.
 *
 * CRITICALLY, the store is keyed by the key core would actually PERSIST, not by
 * the string the derivation returns — see `storeKey` below. An earlier revision
 * of this file asserted on derived strings, and that is exactly how it came to
 * certify a case-sensitivity property the system did not have: core folds the
 * whole key to lowercase on the way into the store, so two derived strings that
 * differ only in case are ONE stored key. Every assertion here now goes through
 * that fold. Do not add an assertion that stops at the derivation.
 *
 * EVERY isolation assertion is paired with a CONTROL that runs the identical
 * read as T1 and DOES get the transcript. Without the control an assertion of
 * "T2 sees nothing" passes just as happily against a harness that is broken and
 * shows nobody anything.
 */

import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";

import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";

import {
  recent as historyRecent,
  pageBefore as historyPageBefore,
  planHistoryFetch,
  type HistoryMessage,
} from "./history.js";
import {
  handleRegisterRequest,
  type RegisterHandlerDeps,
} from "./nats-register.js";
import { PopChallengeStore } from "./pop-challenge.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "./protocol.js";
import { resolveWebchannelSessionRoute } from "./session-route.js";
import type { JwtIdentity } from "./jwt.js";
import type { WrappedConversationKey } from "./late-join-decryptor.js";

const ACCOUNT = "acme";
const PEER = "user-42";
const T1 = "tenant-one";
const T2 = "tenant-two";
/** base64url, ≥16 bytes of entropy — the v3 browser freshness anchor. */
const CLIENT_NONCE = "Y2xpZW50LW5vbmNlLWZpeHR1cmUtMDE";

/**
 * The core session store: a flat map from session key to raw transcript, which
 * is the shape `getSessionMessages` reads and the shape `sessions.json` has on
 * disk. ONE instance is shared by the T1 and T2 apis — that sharing is the
 * whole point, because on a hot-reload the store on disk does not change.
 */
type SessionStore = Map<string, unknown[]>;

/**
 * The key core would PERSIST for a derived session key — i.e. the derivation run
 * through core's store-boundary canonicalization.
 *
 * Core's boundary is `canonicalizeSessionKeyForAgent`, which for a key already
 * starting with `agent:` is exactly `normalizeSessionKeyPreservingOpaquePeerIds`
 * (`raw.toLowerCase()` for every channel outside the `CASE_PRESERVING_PEERS`
 * registry — webchannel is not in it). Neither function is exported from
 * `plugin-sdk`, but `parseAgentSessionKey` IS, and it applies that same
 * normalization before splitting, so `agent:<agentId>:<rest>` reconstructs the
 * canonical form byte-for-byte. Binding to the exported symbol keeps this test
 * on the plugin-sdk CONTRACT rather than on an internal bundle path.
 */
/**
 * The expected `:tenant:` token, reimplemented INDEPENDENTLY of the production
 * helper (which is module-private anyway). Written out longhand on purpose: if
 * this called the real function, the format assertions below would co-vary with
 * a change to the format and stop asserting anything.
 */
function scopeToken(tenant: string): string {
  const digest = createHash("sha256").update(tenant, "utf8").digest("hex").slice(0, 16);
  return `${tenant.toLowerCase()}-${digest}`;
}

function storeKey(sessionKey: string): string {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) throw new Error(`not an agent-scoped session key: ${sessionKey}`);
  return `agent:${parsed.agentId}:${parsed.rest}`;
}

/** Raw transcript role labels are OpenAI chat-format (`assistant`, not `agent`). */
function rawMessage(id: string, role: "user" | "assistant", text: string, ts: number) {
  return { role, content: text, timestamp: ts, __openclaw: { id } };
}

/**
 * A plugin api serving `accountId` under `tenant`. `resolveAgentRoute` is a
 * stub (the helper discards its session key and rebuilds one with the REAL
 * `buildAgentSessionKey`), but the tenant is read from the config exactly as
 * production reads it, so flipping `tenant` here IS the hot-reload.
 */
function makeApi(tenant: string, store: SessionStore) {
  return {
    config: {
      channels: { webchannel: { accounts: { [ACCOUNT]: { tenant } } } },
      session: {},
    },
    logger: { warn: () => {}, error: () => {} },
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute: (input: any) => ({
            agentId: "main",
            channel: input.channel,
            accountId: input.accountId ?? "",
            sessionKey: "agent:main:main",
            mainSessionKey: "agent:main:main",
            lastRoutePolicy: "main" as const,
            matchedBy: "default" as const,
          }),
        },
      },
      subagent: {
        getSessionMessages: async ({
          sessionKey,
          limit,
        }: {
          sessionKey: string;
          limit?: number;
        }) => {
          // Read through core's canonicalization, exactly as the real store does.
          const all = store.get(storeKey(sessionKey)) ?? [];
          return { messages: limit ? all.slice(-limit) : all };
        },
      },
    },
  } as any;
}

/** Transcribed from `nats-account-runtime.ts` `sendHistorySnapshot`. */
async function readSnapshot(api: any, peerId: string, limit = 50): Promise<HistoryMessage[]> {
  const route = resolveWebchannelSessionRoute(api, ACCOUNT, peerId);
  return await historyRecent(api, route.sessionKey, limit, api.logger);
}

/** Transcribed from `nats-account-runtime.ts` `setLoadHistoryHandler`. */
async function readLoadHistory(
  api: any,
  peerId: string,
  request: { before?: string; limit?: number },
  pageSize = 50,
): Promise<HistoryMessage[]> {
  const route = resolveWebchannelSessionRoute(api, ACCOUNT, peerId);
  const plan = planHistoryFetch(request, pageSize);
  return plan.kind === "page"
    ? await historyPageBefore(api, route.sessionKey, plan.beforeId, plan.limit, api.logger)
    : await historyRecent(api, route.sessionKey, plan.limit, api.logger);
}

const T1_TRANSCRIPT = ["t1 secret question", "t1 secret answer", "t1 follow-up"];

/**
 * Seed the transcript of the tenant `served` under the key its WRITE site would
 * have PERSISTED, then hand back an api reloaded onto `then` against the SAME
 * store — the store on disk does not change across a reload.
 */
function seedThenReload(
  served: string,
  then: string,
): { api: any; store: SessionStore; storedKey: string } {
  const store: SessionStore = new Map();
  const apiServed = makeApi(served, store);
  const storedKey = storeKey(
    resolveWebchannelSessionRoute(apiServed, ACCOUNT, PEER).sessionKey,
  );
  store.set(storedKey, [
    rawMessage("m1", "user", T1_TRANSCRIPT[0]!, 1_000),
    rawMessage("m2", "assistant", T1_TRANSCRIPT[1]!, 2_000),
    rawMessage("m3", "user", T1_TRANSCRIPT[2]!, 3_000),
  ]);
  return { api: makeApi(then, store), store, storedKey };
}

/** The common case: T1 served, then reloaded onto `tenant`. */
function seedT1Then(tenant: string): { api: any; store: SessionStore; storedKey: string } {
  return seedThenReload(T1, tenant);
}

/**
 * Run a full register through the REAL admission handler for an account served
 * under `tenant`, with a valid JWT carrying that same tenant claim, and return
 * the history snapshot the handler asked for.
 */
async function registerAndSnapshot(api: any, tenant: string): Promise<{
  replies: string[];
  snapshotPeers: string[];
  snapshot: HistoryMessage[];
}> {
  const replies: string[] = [];
  const snapshotPeers: string[] = [];
  let snapshot: HistoryMessage[] = [];

  const identity: JwtIdentity = {
    peerId: PEER,
    tenant,
    devicePublicKey: randomBytes(32).toString("base64url"),
  } as JwtIdentity;

  const deps: RegisterHandlerDeps = {
    tenant,
    subjectPeerId: PEER,
    payload: JSON.stringify({
      op: "register",
      token: "jwt",
      protocolVersion: WEBCHANNEL_PROTOCOL_VERSION,
      clientNonce: CLIENT_NONCE,
    }),
    reply: (r) => replies.push(r),
    verifyIdentity: async () => identity,
    // PoP is exercised in nats-register.test.ts; this test is about what the
    // admitted peer can then READ, so keep the admission body minimal.
    requirePoP: false,
    popChallenges: new PopChallengeStore(),
    registerPeer: () => {},
    wrapConversationKeyForDevice: () =>
      ({
        ephemeralPublicKey: "e",
        nonce: "n",
        ciphertext: "c",
        tag: "t",
      }) as WrappedConversationKey,
    unregisterPeer: () => {},
    sendHistorySnapshot: (pid) => {
      snapshotPeers.push(pid);
      // The production dep resolves the route and reads; do the same, so the
      // snapshot this test inspects came through the real admission path.
      void readSnapshot(api, pid).then((m) => {
        snapshot = m;
      });
    },
    sendApprovalSnapshot: () => {},
    logger: { error: () => {} },
  };

  await handleRegisterRequest(deps);
  // `sendHistorySnapshot` is fire-and-forget in production too; drain it.
  await new Promise((r) => setImmediate(r));
  return { replies, snapshotPeers, snapshot };
}

describe("#112 — tenant scoping of the webchannel session key", () => {
  it("gives DIFFERENT STORED keys to the same (account, peer) in two tenants", () => {
    const store: SessionStore = new Map();
    const t1 = resolveWebchannelSessionRoute(makeApi(T1, store), ACCOUNT, PEER).sessionKey;
    const t2 = resolveWebchannelSessionRoute(makeApi(T2, store), ACCOUNT, PEER).sessionKey;

    // Asserted after core's canonicalization, not on the derived string: two
    // derived strings differing only in case are ONE stored key.
    expect(storeKey(t1)).not.toBe(storeKey(t2));
    expect(storeKey(t1)).toBe(
      `agent:main:webchannel:${ACCOUNT}:direct:${PEER}:tenant:${scopeToken(T1)}`,
    );
    expect(storeKey(t2)).toBe(
      `agent:main:webchannel:${ACCOUNT}:direct:${PEER}:tenant:${scopeToken(T2)}`,
    );
  });

  it("survives core's lowercase fold: the tenant component is already canonical", () => {
    // If the component were verbatim, this is the assertion that would fail —
    // the derived string would still carry `Acme` while the stored key did not.
    const store: SessionStore = new Map();
    const derived = resolveWebchannelSessionRoute(makeApi("Acme", store), ACCOUNT, PEER).sessionKey;
    expect(storeKey(derived)).toBe(derived);
  });

  it("keeps case-distinct tenants apart IN THE STORE, not just in the string", () => {
    // NATS subjects are case-sensitive: `Acme` and `acme` are different tenants
    // holding different credentials. Core folds the whole session key to
    // lowercase on the way into the store, so a verbatim tenant component would
    // merge these two authorization scopes onto one stored key — #112 again.
    const store: SessionStore = new Map();
    const lower = resolveWebchannelSessionRoute(makeApi("acme", store), ACCOUNT, PEER).sessionKey;
    const upper = resolveWebchannelSessionRoute(makeApi("Acme", store), ACCOUNT, PEER).sessionKey;
    expect(storeKey(lower)).not.toBe(storeKey(upper));
  });

  it("denies a case-flipped reload the previous tenant's history (end-to-end)", async () => {
    // The literal #112 sequence with a case change and nothing else: serve
    // `Acme`, reload the same account as `acme`, register with a valid `acme`
    // token. Admission passes — it is an exact match against the now-configured
    // tenant — so only the key can hold the boundary.
    const { api } = seedThenReload("Acme", "acme");
    const { snapshotPeers, snapshot } = await registerAndSnapshot(api, "acme");
    expect(snapshotPeers).toEqual([PEER]);
    expect(snapshot).toEqual([]);
    expect(await readLoadHistory(api, PEER, {})).toEqual([]);
    expect(await readLoadHistory(api, PEER, { before: "m3" })).toEqual([]);
  });

  it("CONTROL: reloading onto the SAME case does return the transcript", async () => {
    // Proves the case test above is not passing merely because the harness is
    // broken for mixed-case tenants.
    const { api } = seedThenReload("Acme", "Acme");
    const { snapshot } = await registerAndSnapshot(api, "Acme");
    expect(snapshot.map((m) => m.text)).toEqual(T1_TRANSCRIPT);
  });

  it("refuses a tenant that could forge another tenant's key", () => {
    // `:` is the key separator. A tenant carrying one would let a mis-configured
    // (or hostile) tenant string address a scope that is not its own, so the
    // splice asserts rather than trusting upstream validation alone.
    const store: SessionStore = new Map();
    expect(() =>
      resolveWebchannelSessionRoute(makeApi(`${T2}:direct:${PEER}`, store), ACCOUNT, PEER),
    ).toThrow(/tenant/);
  });

  it("ADMITS the T2 register — the tenant boundary cannot rest on admission", async () => {
    // The premise of #112: after the reload, T2's signed tenant claim matches the
    // configured tenant, so admission legitimately succeeds. If this ever starts
    // failing, the isolation tests below stop proving what they claim to prove.
    const { api } = seedT1Then(T2);
    const { replies, snapshotPeers } = await registerAndSnapshot(api, T2);
    expect(snapshotPeers).toEqual([PEER]);
    expect(replies).toHaveLength(1);
    expect(JSON.parse(replies[0]!)).not.toHaveProperty("error");
  });

  it("denies an admitted T2 peer T1's register-time history snapshot", async () => {
    const { api } = seedT1Then(T2);
    const { snapshot } = await registerAndSnapshot(api, T2);
    expect(snapshot).toEqual([]);
  });

  it("CONTROL: the same register under T1 does return T1's snapshot", async () => {
    // Proves the harness can leak, so the assertion above is load-bearing.
    const { api } = seedT1Then(T1);
    const { snapshot } = await registerAndSnapshot(api, T1);
    expect(snapshot.map((m) => m.text)).toEqual(T1_TRANSCRIPT);
  });

  it("denies a T2 peer T1's load_history tail fetch", async () => {
    const { api } = seedT1Then(T2);
    expect(await readLoadHistory(api, PEER, {})).toEqual([]);
  });

  it("denies a T2 peer T1's load_history page fetch", async () => {
    // Even holding a real cursor id out of T1's transcript.
    const { api } = seedT1Then(T2);
    expect(await readLoadHistory(api, PEER, { before: "m3" })).toEqual([]);
  });

  it("CONTROL: the same load_history reads under T1 do return T1's messages", async () => {
    const { api } = seedT1Then(T1);
    expect((await readLoadHistory(api, PEER, {})).map((m) => m.text)).toEqual(T1_TRANSCRIPT);
    expect((await readLoadHistory(api, PEER, { before: "m3" })).map((m) => m.text)).toEqual(
      T1_TRANSCRIPT.slice(0, 2),
    );
  });

  it("does not partition users who share a tenant (no over-isolation)", async () => {
    // The fix must scope by tenant, not accidentally re-scope by anything else:
    // the SAME (tenant, account, peer) must still resolve the SAME key across
    // two independently constructed apis, or every reload would orphan history.
    const { api, storedKey } = seedT1Then(T1);
    expect(storeKey(resolveWebchannelSessionRoute(api, ACCOUNT, PEER).sessionKey)).toBe(storedKey);
  });
});
