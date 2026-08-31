/**
 * #112 (P1, confidentiality) — cross-tenant isolation, at BOTH ends.
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
 * T2's browser then resolved the SAME storage scope T1 wrote under, and read
 * T1's messages back through the register-time history snapshot or
 * `load_history`. Register admission cannot catch it — it compares the JWT
 * tenant against the CONFIGURED tenant, and after the reload T2 is legitimately
 * the configured tenant. `test("… is ADMITTED …")` below asserts exactly that,
 * so the coverage does not quietly come to rest on the wrong guard.
 *
 * ── ⚠️ THE READ HALF NOW RESTS ON A DIFFERENT MECHANISM. READ THIS FIRST. ────
 *
 * Until #240 half 2, a history read went through
 * `api.runtime.subagent`'s `{ sessionKey }`-scoped session-message read, so the property
 * "T2 cannot read T1's history" was a COROLLARY of the session key being
 * tenant-scoped, and this file asserted it that way — with a `Map` standing in
 * for core's session store.
 *
 * That mechanism is GONE. The plugin is the SSOT (doc §0, NOT-list N2): history
 * is projected out of the plugin's own delivery journal by
 * `journal-history.ts`, and a read takes a `peerId` and nothing else. So the
 * isolation now comes from two facts, and the tests below assert THOSE rather
 * than restating a session-key argument that no longer reaches the read path:
 *
 *  1. THE FILE. The journal lives at
 *     `tupleStoragePaths({ tenant, accountId }).deliveryJournalPath`, whose
 *     directory is a namespace id derived by hashing (tenant, accountId)
 *     verbatim — no case fold, no other input. Two tenants are two DATABASE
 *     FILES, so a cross-tenant read is not "scoped", it is unreachable.
 *  2. THE ROW. Inside one file, rows are keyed by `conversationId`, and every
 *     write seam passes `peerId` as that id (`nats-channel.ts` at egress,
 *     `ingress-dedupe.ts` at the accept). `peerId` is the authenticated JWT
 *     `sub`, so a peer can only ever name itself.
 *
 * These tests therefore use a REAL `openDeliveryJournal` under a temp storage
 * root, and derive its path exactly as `nats-account-runtime.ts` does. That is
 * faithful to the boundary that actually holds the property: an in-memory fake
 * keyed by peerId would assert the fake's own filter, and — worse — could not
 * see fact 1 at all.
 *
 * The WRITE half of this file is unchanged. `resolveWebchannelSessionRoute` is
 * still what scopes the INBOUND path into core (`inbound.ts`), so the key
 * derivation tests below still assert a live property, still through core's
 * store-boundary canonicalization (`storeKey`), and still must not be reduced to
 * assertions on the derived string — an earlier revision did that and came to
 * certify a case-sensitivity property the system did not have.
 *
 * EVERY isolation assertion is paired with a CONTROL that runs the identical
 * read as T1 and DOES get the messages. Without the control an assertion of
 * "T2 sees nothing" passes just as happily against a harness that is broken and
 * shows nobody anything.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, expect, vi } from "vitest";

import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";

import { openDeliveryJournal, type DeliveryJournal } from "./delivery-journal.js";
import type { JournalEvent } from "./delivery-journal-event.js";
import type { HistoryConfig, HistoryMessage } from "./history.js";
import {
  createHistoryServer,
  type HistoryServer,
} from "./history-serve.js";
import {
  handleRegisterRequest,
  type RegisterHandlerDeps,
} from "./nats-register.js";
import { PopChallengeStore } from "./pop-challenge.js";
import { WEBCHANNEL_PROTOCOL_VERSION } from "./protocol.js";
import { resolveWebchannelSessionRoute } from "./session-route.js";
import { tupleStoragePaths } from "./storage-paths.js";
import { planWebchannelAccount } from "./multiplex.js";
import type { JwtIdentity } from "./jwt.js";
import type { WrappedConversationKey } from "./late-join-decryptor.js";

const ACCOUNT = "acme";
const PEER = "user-42";
const OTHER_PEER = "user-99";
const T1 = "tenant-one";
const T2 = "tenant-two";
/** base64url, ≥16 bytes of entropy — the v3 browser freshness anchor. */
const CLIENT_NONCE = "Y2xpZW50LW5vbmNlLWZpeHR1cmUtMDE";

// ---------------------------------------------------------------------------
// Storage root + journal handles. One temp root per test, torn down after.
// ---------------------------------------------------------------------------

let storageRoot: string | undefined;
const openJournals: DeliveryJournal[] = [];

function root(): string {
  storageRoot ??= mkdtempSync(join(tmpdir(), "webchannel-tenant-iso-"));
  return storageRoot;
}

afterEach(() => {
  while (openJournals.length > 0) {
    try {
      openJournals.pop()!.close();
    } catch {
      // A test that already closed a handle must not fail the teardown.
    }
  }
  if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  storageRoot = undefined;
});

/**
 * The journal path a serving runtime would open, derived EXACTLY as
 * `nats-account-runtime.ts` derives it — that call is the mechanism under test,
 * so it is made here rather than modelled.
 */
function journalPath(tenant: string, accountId = ACCOUNT): string {
  return tupleStoragePaths({ tenant, accountId, storageRoot: root() })
    .deliveryJournalPath;
}

/**
 * Open (or reopen) the journal a `(tenant, accountId)` runtime would serve.
 * Deterministic clock so `ts` values below are stable and readable.
 */
function openJournalFor(tenant: string, accountId = ACCOUNT): DeliveryJournal {
  let clock = 1_000;
  const journal = openDeliveryJournal({
    databasePath: journalPath(tenant, accountId),
    now: () => (clock += 1_000),
  });
  openJournals.push(journal);
  return journal;
}

const T1_TRANSCRIPT = ["t1 secret question", "t1 secret answer", "t1 follow-up"];

/** The three events that produce `T1_TRANSCRIPT` as a user/agent/user thread. */
function transcriptEvents(prefix = "m"): JournalEvent[] {
  return [
    { kind: "user", id: `${prefix}1`, text: T1_TRANSCRIPT[0]!, turnId: "w-1" },
    {
      kind: "bubble",
      answerId: `${prefix}2`,
      turnId: "turn-1",
      text: T1_TRANSCRIPT[1]!,
    },
    { kind: "user", id: `${prefix}3`, text: T1_TRANSCRIPT[2]!, turnId: "w-2" },
  ];
}

// ---------------------------------------------------------------------------
// The two production READ bodies — REACHED, NOT TRANSCRIBED.
//
// ⚠️ THESE USED TO BE COPIES, AND THE COPY CERTIFIED NOTHING. While both read
// bodies were closures inside `buildNatsAccount`, this file could only restate
// them; MEASURED, changing the production call to pass `accountId` instead of
// `peerId` — every peer under one tuple reading every other peer's history —
// left all 21 tests here GREEN. #240 half 2's review moved the bodies into
// `history-serve.ts` precisely so these helpers could call the real thing.
//
// ⚠️ BUT BE EXACT ABOUT WHICH OF THIS FILE'S TWO FACTS THAT COVERS — the
// distinction matters here more than anywhere, since the paragraph above spends
// its length on why a copy "certified nothing":
//
//  - FACT 2, the PEER lookup (`conversationId === peerId`): covered by
//    production code. These helpers call `createHistoryServer`, and the
//    `peerId`→`accountId` mutation is caught here (6 failures) as well as in
//    `history-serve.test.ts`.
//  - FACT 1, the FILE PATH (`tupleStoragePaths({tenant, accountId})`): NOT
//    covered by production code, and no assertion in this file makes it look
//    like it is. `journalPath()` below makes its own `tupleStoragePaths` call,
//    so dropping `tenant` from the production derivation leaves every tenant
//    test here GREEN. What actually holds that half is the source assertion in
//    `index-nats-wiring.test.ts`, which pins the production `tupleStoragePaths({
//    tenant, accountId, … }).deliveryJournalPath` call shape. That mechanism is
//    sound — a path is a pure function of the tuple, and there is no behavioural
//    seam between the derivation and the open to observe — but it is a DIFFERENT
//    mechanism, and reading the tenant tests below as production coverage of it
//    is exactly the mistake this file was rewritten to stop making.
//
// The scheduler is injected and flushed synchronously: production defers with
// `setImmediate`, and these helpers want an answer, not a race.
// ---------------------------------------------------------------------------

function serveVia(
  journal: DeliveryJournal,
  call: (server: HistoryServer) => void,
  config: HistoryConfig = { limit: 50, pageSize: 50 },
): HistoryMessage[] {
  const sent: HistoryMessage[][] = [];
  const queue: Array<() => void> = [];
  const server = createHistoryServer({
    journal,
    channel: {
      sendHistory(_peerId: string, messages: HistoryMessage[]) {
        sent.push(messages);
        return true;
      },
      // #311's byte budget. Plaintext sizing against a limit no test here can
      // reach, so every page takes the fast path and the assertions below are
      // about SCOPE, exactly as before.
      outboundWireSize: (_peerId, payload) =>
        Buffer.byteLength(JSON.stringify(payload), "utf8"),
      effectiveOutboundLimit: () => 8 * 1024 * 1024,
    },
    config,
    logger: { error: () => {}, warn: () => {} },
    schedule: (fn) => void queue.push(fn),
  });
  call(server);
  while (queue.length > 0) queue.shift()!();
  // A suppressed empty snapshot sends no frame; for these assertions that and
  // "sent an empty list" mean the same thing — nothing was disclosed.
  return sent.length === 0 ? [] : sent[sent.length - 1]!;
}

/**
 * The `text` of every row a read returned, in order — what the CONTROL cases
 * compare against `T1_TRANSCRIPT`.
 *
 * ⚠️ IT NARROWS ON `kind` AND THROWS, RATHER THAN FILTERING. `HistoryMessage`'s
 * `tool` variant carries no `text` (#242 half 3), so `m.text` over the bare union
 * stopped type-checking. (The `reasoning` variant is NOT the reason: it HAS
 * `text: string` — see `channel-contract.ts`'s `HistoryReasoningMessage`. What
 * both tagged variants lack is `role`.) But the fix is not to drop the untagged
 * rows. These are ISOLATION controls: their job is to prove the harness CAN
 * leak, so the negative assertions beside them are load-bearing. A filter would
 * make a tagged row vanish from the comparison and could shrink a leaked
 * transcript back down to the expected list. The fixtures here write only text
 * bubbles, so anything else means the harness changed, and it should say so.
 */
function transcriptTexts(messages: readonly HistoryMessage[]): string[] {
  return messages.map((m) => {
    if (m.kind !== undefined) {
      throw new Error(`expected a text history row, received kind=${m.kind} (id=${m.id})`);
    }
    return m.text;
  });
}

/** The production register-time snapshot. */
function readSnapshot(
  journal: DeliveryJournal,
  peerId: string,
  limit = 50,
): HistoryMessage[] {
  return serveVia(journal, (s) => s.sendSnapshot(peerId), { limit, pageSize: 50 });
}

/** The production `load_history` handler. */
function readLoadHistory(
  journal: DeliveryJournal,
  peerId: string,
  request: { before?: string; limit?: number },
  pageSize = 50,
): HistoryMessage[] {
  return serveVia(journal, (s) => s.servePage(peerId, request), {
    limit: 50,
    pageSize,
  });
}

// ---------------------------------------------------------------------------
// Session-key derivation harness (WRITE path — unchanged by #240).
// ---------------------------------------------------------------------------

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
function storeKey(sessionKey: string): string {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) throw new Error(`not an agent-scoped session key: ${sessionKey}`);
  return `agent:${parsed.agentId}:${parsed.rest}`;
}

/**
 * The expected `:tenant:` token, reimplemented INDEPENDENTLY of the production
 * helper (which is module-private anyway). Written out longhand on purpose: if
 * this called the real function, the format assertions below would co-vary with
 * a change to the format and stop asserting anything.
 */
function scopeToken(tenant: string): string {
  return createHash("sha256").update(tenant, "utf8").digest("hex");
}

/**
 * A plugin api serving `accountId` under `tenant`. `resolveAgentRoute` is a
 * stub (the helper discards its session key and rebuilds one with the REAL
 * `buildAgentSessionKey`). The tenant is also present in config so the fixtures
 * model a real account, but session routing receives the immutable serving-plan
 * tenant explicitly, exactly as production does.
 */
function makeApi(tenant: string) {
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
    },
  } as any;
}

/**
 * Seed the journal of the tenant `served` — under the path its WRITE site would
 * have opened — then hand back the journal a runtime reloaded onto `then` would
 * open against the SAME storage root. The disk does not change across a reload;
 * what changes is which file the new tenant addresses.
 */
function seedThenReload(served: string, then: string): DeliveryJournal {
  const servedJournal = openJournalFor(served);
  for (const event of transcriptEvents()) servedJournal.append(PEER, event);
  servedJournal.close();
  openJournals.pop();
  return openJournalFor(then);
}

/** The common case: T1 served, then reloaded onto `tenant`. */
function seedT1Then(tenant: string): DeliveryJournal {
  return seedThenReload(T1, tenant);
}

/**
 * Run a full register through the REAL admission handler for an account served
 * under `tenant`, with a valid JWT carrying that same tenant claim, and return
 * the history snapshot the handler asked for.
 */
async function registerAndSnapshot(
  journal: DeliveryJournal,
  tenant: string,
): Promise<{
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
      // Production defers the projection with `setImmediate` (it is synchronous
      // and expensive, and the register reply must publish first); mirror that
      // so this exercises the real ordering rather than a simplified one.
      setImmediate(() => {
        snapshot = readSnapshot(journal, pid);
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

describe("#112 — tenant scoping of the webchannel session key (WRITE path)", () => {
  it("gives DIFFERENT STORED keys to the same (account, peer) in two tenants", () => {
    const t1 = resolveWebchannelSessionRoute(makeApi(T1), ACCOUNT, PEER, T1).sessionKey;
    const t2 = resolveWebchannelSessionRoute(makeApi(T2), ACCOUNT, PEER, T2).sessionKey;

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
    const derived = resolveWebchannelSessionRoute(
      makeApi("Acme"),
      ACCOUNT,
      PEER,
      "Acme",
    ).sessionKey;
    expect(derived).toBe(
      `agent:main:webchannel:${ACCOUNT}:direct:${PEER}:tenant:` +
        "37036cd8f9746d335038eca92f8a73ae5f1bca4779a1e55e5812e37743b2f5bf",
    );
    expect(storeKey(derived)).toBe(derived);
  });

  it("keeps case-distinct tenants apart IN THE STORE, not just in the string", () => {
    // NATS subjects are case-sensitive: `Acme` and `acme` are different tenants
    // holding different credentials. Core folds the whole session key to
    // lowercase on the way into the store, so a verbatim tenant component would
    // merge these two authorization scopes onto one stored key — #112 again.
    const lower = resolveWebchannelSessionRoute(makeApi("acme"), ACCOUNT, PEER, "acme")
      .sessionKey;
    const upper = resolveWebchannelSessionRoute(makeApi("Acme"), ACCOUNT, PEER, "Acme")
      .sessionKey;
    expect(storeKey(lower)).not.toBe(storeKey(upper));
  });

  it("refuses a tenant that could forge another tenant's key", () => {
    // `:` is the key separator. A tenant carrying one would let a mis-configured
    // (or hostile) tenant string address a scope that is not its own, so the
    // splice asserts rather than trusting upstream validation alone.
    expect(() =>
      resolveWebchannelSessionRoute(
        makeApi(`${T2}:direct:${PEER}`),
        ACCOUNT,
        PEER,
        `${T2}:direct:${PEER}`,
      ),
    ).toThrow(/tenant/);
  });

  it("does not partition users who share a tenant (no over-isolation)", () => {
    // The fix must scope by tenant, not accidentally re-scope by anything else:
    // the SAME (tenant, account, peer) must still resolve the SAME key across
    // two independently constructed apis, or every reload would orphan history.
    expect(
      storeKey(resolveWebchannelSessionRoute(makeApi(T1), ACCOUNT, PEER, T1).sessionKey),
    ).toBe(
      storeKey(resolveWebchannelSessionRoute(makeApi(T1), ACCOUNT, PEER, T1).sessionKey),
    );
  });
});

describe("#112 — tenant scoping of the delivery journal (READ path, #240)", () => {
  it("gives DIFFERENT journal FILES to the same (account, peer) in two tenants", () => {
    // Fact 1. This is the whole isolation argument for the read path: a
    // cross-tenant history read is not filtered, it addresses another file.
    expect(journalPath(T1)).not.toBe(journalPath(T2));
    // The accountId is in the namespace too — two accounts under one tenant are
    // also two files. (That the SAME tenant reaches the SAME file is the
    // no-over-isolation property, and it is asserted where it can actually fail:
    // the reload CONTROLs below, which read a transcript back after reopening.)
    expect(journalPath(T1, "other-account")).not.toBe(journalPath(T1));
  });

  it("keeps case-distinct tenants on distinct journal files", () => {
    // The storage namespace hashes the tenant VERBATIM (no lowercase fold, see
    // `deriveStorageNamespaceId`), which is what makes the case-flip reload
    // below a genuine boundary rather than an accident.
    expect(journalPath("Acme")).not.toBe(journalPath("acme"));
  });

  it("denies an admitted T2 peer T1's register-time history snapshot", async () => {
    const journal = seedT1Then(T2);
    const { snapshot } = await registerAndSnapshot(journal, T2);
    expect(snapshot).toEqual([]);
  });

  it("CONTROL: the same register under T1 does return T1's snapshot", async () => {
    // Proves the harness can leak, so the assertion above is load-bearing.
    const journal = seedT1Then(T1);
    const { snapshot } = await registerAndSnapshot(journal, T1);
    expect(transcriptTexts(snapshot)).toEqual(T1_TRANSCRIPT);
  });

  it("ADMITS the T2 register — the tenant boundary cannot rest on admission", async () => {
    // The premise of #112: after the reload, T2's signed tenant claim matches the
    // configured tenant, so admission legitimately succeeds. If this ever starts
    // failing, the isolation tests here stop proving what they claim to prove.
    const journal = seedT1Then(T2);
    const { replies, snapshotPeers } = await registerAndSnapshot(journal, T2);
    expect(snapshotPeers).toEqual([PEER]);
    expect(replies).toHaveLength(1);
    expect(JSON.parse(replies[0]!)).not.toHaveProperty("error");
  });

  it("denies a case-flipped reload the previous tenant's history (end-to-end)", async () => {
    // The literal #112 sequence with a case change and nothing else: serve
    // `Acme`, reload the same account as `acme`, register with a valid `acme`
    // token. Admission passes — it is an exact match against the now-configured
    // tenant — so only the storage scope can hold the boundary.
    const journal = seedThenReload("Acme", "acme");
    const { snapshotPeers, snapshot } = await registerAndSnapshot(journal, "acme");
    expect(snapshotPeers).toEqual([PEER]);
    expect(snapshot).toEqual([]);
    expect(readLoadHistory(journal, PEER, {})).toEqual([]);
    expect(readLoadHistory(journal, PEER, { before: "m3" })).toEqual([]);
  });

  it("CONTROL: reloading onto the SAME case does return the transcript", async () => {
    // Proves the case test above is not passing merely because the harness is
    // broken for mixed-case tenants.
    const journal = seedThenReload("Acme", "Acme");
    const { snapshot } = await registerAndSnapshot(journal, "Acme");
    expect(transcriptTexts(snapshot)).toEqual(T1_TRANSCRIPT);
  });

  it("denies a T2 peer T1's load_history tail fetch", () => {
    expect(readLoadHistory(seedT1Then(T2), PEER, {})).toEqual([]);
  });

  it("denies a T2 peer T1's load_history page fetch", () => {
    // Even holding a real cursor id out of T1's conversation.
    expect(readLoadHistory(seedT1Then(T2), PEER, { before: "m3" })).toEqual([]);
  });

  it("CONTROL: the same load_history reads under T1 do return T1's messages", () => {
    const journal = seedT1Then(T1);
    expect(transcriptTexts(readLoadHistory(journal, PEER, {}))).toEqual(T1_TRANSCRIPT);
    expect(transcriptTexts(readLoadHistory(journal, PEER, { before: "m3" }))).toEqual(
      T1_TRANSCRIPT.slice(0, 2),
    );
  });
});

describe("#112 — peer scoping INSIDE one tenant's journal (READ path, #240)", () => {
  /**
   * Fact 2, and the one the file-path argument cannot cover: peers who SHARE a
   * tenant and an account share one database file, so here the boundary really
   * is a lookup. `conversationId === peerId` at both write seams, and `peerId`
   * is the authenticated JWT `sub`, so a peer can only ever name itself.
   */
  function seedTwoPeers(): DeliveryJournal {
    const journal = openJournalFor(T1);
    for (const event of transcriptEvents()) journal.append(PEER, event);
    for (const event of transcriptEvents("n")) journal.append(OTHER_PEER, event);
    return journal;
  }

  it("gives each peer only its own rows, from the SAME file", () => {
    const journal = seedTwoPeers();
    expect(readSnapshot(journal, PEER).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    // CONTROL: the other peer's rows really are in this file and really are
    // readable — so the assertion above is a scope, not an empty harness.
    expect(readSnapshot(journal, OTHER_PEER).map((m) => m.id)).toEqual([
      "n1",
      "n2",
      "n3",
    ]);
  });

  it("does not let a peer page into another peer's rows with THEIR cursor", () => {
    const journal = seedTwoPeers();
    // `n3` is a real id, in this file, belonging to the other peer. It is not in
    // this peer's projection, so the page is empty — never the other peer's tail.
    expect(readLoadHistory(journal, PEER, { before: "n3" })).toEqual([]);
    // CONTROL: the same cursor read as its OWNER pages normally.
    expect(
      readLoadHistory(journal, OTHER_PEER, { before: "n3" }).map((m) => m.id),
    ).toEqual(["n1", "n2"]);
  });

  it("gives an unknown peer nothing, not the file's first conversation", () => {
    expect(readSnapshot(seedTwoPeers(), "peer-who-never-spoke")).toEqual([]);
  });
});

describe("#112 — the live read path takes a peerId and nothing else (#240)", () => {
  /**
   * The behavioural half of this property is asserted above, against the real
   * `createHistoryServer`. What source can add is the NEGATIVE: that no route
   * resolution has crept back into either module on the read path.
   *
   * ⚠️ ASSERTED AT THE MODULES, NOT AT A CLOSURE. Before #240 the ONLY uses of
   * `resolveWebchannelSessionRoute` in the account runtime were the two history
   * reads; the write path resolves its route in `inbound.ts` instead. So "these
   * two files do not depend on session-route" is both the strongest available
   * statement and exactly what would have to change to reintroduce the
   * core-scoped read. If a genuinely unrelated use ever arrives in the runtime,
   * narrow this to `history-serve.ts` rather than deleting it.
   */
  const sourceOf = (name: string) =>
    readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

  it("neither the account runtime nor history-serve.ts resolves a session route", () => {
    for (const name of ["nats-account-runtime.ts", "history-serve.ts"]) {
      const source = sourceOf(name);
      expect(source, name).not.toContain("resolveWebchannelSessionRoute");
      // ⚠️ MATCHED AS AN IMPORT, NOT AS A SUBSTRING. An earlier revision asserted
      // `not.toContain("session-route.js")` and passed only on a suffix
      // difference — `nats-account-runtime.ts` legitimately mentions
      // "src/session-route.ts" in a comment about the WRITE path, so the bare
      // string check was one character away from being permanently red for a
      // reason that has nothing to do with the property. The property is "no
      // dependency", so match the dependency.
      expect(source, name).not.toMatch(/from\s+["']\.\/session-route\.js["']/);
    }
  });

  it("and no history read in the package reaches core's transcript", () => {
    // N2, stated where a regression would be caught: the read path is the
    // journal projection.
    //
    // ⚠️ THE SYMBOL IS SPELLED IN PIECES ON PURPOSE. #240's acceptance check is
    // a repo-wide grep for the core session-message read, which must now match
    // NOTHING under `packages/` — and a test asserting its absence would
    // otherwise be the one hit that makes that check lie about itself.
    const coreTranscriptRead = ["get", "Session", "Messages"].join("");
    for (const name of ["nats-account-runtime.ts", "history-serve.ts"]) {
      expect(sourceOf(name), name).not.toContain(coreTranscriptRead);
    }
    // And the runtime really does reach the journal path — a negative-only test
    // would also pass against a runtime that served no history at all.
    expect(sourceOf("nats-account-runtime.ts")).toContain("createHistoryServer");
    expect(sourceOf("history-serve.ts")).toContain("serveHistoryRequest");
  });
});

describe("#112 — startup-tenant binding survives an env mutation", () => {
  it("keeps config-less inbound routing AND the journal on the startup-planned tenant", () => {
    vi.stubEnv("WEBCHANNEL_TENANT", "startup-tenant");
    try {
      const api = makeApi("unused-config-tenant");
      api.config = { channels: {}, session: {} };

      // This is the one startup read made by `buildNatsAccount`. The resulting
      // tenant is also captured by its NATS channel, its admission verifier and
      // — since #240 — the journal path it opens.
      const plan = planWebchannelAccount(api.config, "default");
      expect(plan?.tenant).toBe("startup-tenant");
      const servingTenant = plan!.tenant;

      const inboundRoute = resolveWebchannelSessionRoute(
        api,
        "default",
        PEER,
        servingTenant,
      );
      const journal = openJournalFor(servingTenant, "default");
      for (const event of transcriptEvents()) journal.append(PEER, event);

      // Model OpenClaw's temporary per-skill environment override after this
      // account has started. The live runtime must remain wholly startup-bound.
      vi.stubEnv("WEBCHANNEL_TENANT", "skill-override-tenant");
      const overrideTenant = process.env.WEBCHANNEL_TENANT!;
      // WRITE path: the session key still derives from the startup tenant.
      expect(
        resolveWebchannelSessionRoute(api, "default", PEER, overrideTenant).sessionKey,
      ).not.toBe(inboundRoute.sessionKey);
      // READ path: the override addresses a DIFFERENT journal file.
      // ⚠️ SAME SCOPE CAVEAT AS FACT 1 IN THE HEADER — this compares two
      // `tupleStoragePaths` calls THIS FILE makes, so it shows the derivation
      // is env-sensitive; it does NOT observe the runtime choosing one. Read it
      // as "an env-derived path would be a different file", not as "the runtime
      // would serve an empty conversation" — that the runtime derives from the
      // startup tuple is pinned by the source assertion in
      // `index-nats-wiring.test.ts`, not here.
      expect(journalPath(overrideTenant, "default")).not.toBe(
        journalPath(servingTenant, "default"),
      );

      expect(transcriptTexts(readSnapshot(journal, PEER))).toEqual(T1_TRANSCRIPT);
      expect(transcriptTexts(readLoadHistory(journal, PEER, {}))).toEqual(
        T1_TRANSCRIPT,
      );
      expect(
        transcriptTexts(readLoadHistory(journal, PEER, { before: "m3" })),
      ).toEqual(T1_TRANSCRIPT.slice(0, 2));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
