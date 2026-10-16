import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { openDeliveryJournal } from "./delivery-journal.js";
import { tupleStoragePaths } from "./storage-paths.js";
import { awaitCoreDispatchRetirement, prepareCoreDispatch, retireInterruptedCoreDispatches, verifiedCoreEntry } from "./dispatch-core-recovery.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
const sessionKey = "agent:main:webchannel:account:direct:peer:tenant:abc:peer-v2";
/** The journal of one account, with a previous process's started+bound batch. */
function accountJournal(dir: string, accountId: string, cfg: OpenClawConfig, key: string) {
  const paths = tupleStoragePaths({ tenant: "tenant", accountId, storageRoot: dir });
  const journal = openDeliveryJournal({ databasePath: paths.deliveryJournalPath });
  cleanups.push(() => journal.close());
  const owner = journal.dispatch!.activate();
  journal.dispatch!.accept(owner, "peer", [{ text: "A", turnId: "A", randomId: "logical-A" }]);
  const row = journal.dispatch!.claim(owner, "peer", ["logical-A"])[0]!;
  prepareCoreDispatch(cfg, "main", key, { owner, batch: row.batch!, peerId: "peer" }, journal);
  const binding = journal.dispatch!.coreBindings()[0]!;
  journal.dispatch!.bindCore({ ...binding, processId: "previous-process" });
  return { journal, paths };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dispatch369-core-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const storePath = join(dir, "sessions.json");
  // The SERVING PLAN is what the service enumerates, so the fixture supplies a
  // real `channels.webchannel` account whose resolved tuple is the directory it
  // writes — not a bare storage root.
  const cfg = { session: { store: storePath }, channels: { webchannel: { accounts: { account: { tenant: "tenant", storageRoot: dir } } } } } as unknown as OpenClawConfig;
  const { journal } = accountJournal(dir, "account", cfg, sessionKey);
  return { dir, journal, storePath, cfg, scope: { storePath, sessionKey } };
}

it.each(["original-session", "rotated-after-new", "rotated-on-expiry"])("retires explicitly restart-aborted work at the exact bound route with %s", async sessionId => {
  const h = fixture();
  // This state is injected through the real public SDK, including the core
  // persist-before-onTurnAdopted boundary. There is deliberately no plugin marker.
  await upsertSessionEntry({ ...h.scope, entry: { sessionId, updatedAt: Date.now(), status: "running", abortedLastRun: true, restartRecoveryDeliveryRunId: "core-run", restartRecoveryDeliveryContext: { channel: "webchannel", accountId: "account", to: "peer" } } });
  await retireInterruptedCoreDispatches(h.cfg);
  expect(getSessionEntry(h.scope)).toMatchObject({ sessionId, status: "failed", abortedLastRun: true });
  expect(getSessionEntry(h.scope)?.restartRecoveryDeliveryRunId).toBeUndefined();
  expect(h.journal.dispatch!.lookup("peer", "logical-A")?.state).toBe("interrupted");
  expect(h.journal.dispatch!.coreBindings()).toEqual([]);
  await retireInterruptedCoreDispatches(h.cfg);
});

it("excludes a newly active current-process run and unrelated sessions", async () => {
  const h = fixture();
  await upsertSessionEntry({ ...h.scope, entry: { sessionId: "newly-active", updatedAt: Date.now(), status: "running", abortedLastRun: false, restartRecoveryDeliveryRunId: "new-run" } });
  await upsertSessionEntry({ storePath: h.storePath, sessionKey: "agent:main:another-channel", entry: { sessionId: "unrelated", updatedAt: Date.now(), status: "running", abortedLastRun: true } });
  const before = readFileSync(h.storePath, "utf8");
  await retireInterruptedCoreDispatches(h.cfg);
  expect(readFileSync(h.storePath, "utf8")).toBe(before);
});

it("the actual SDK's swallowed parse failure cannot release the startup barrier, even when logging throws", async () => {
  const h = fixture();
  await upsertSessionEntry({ ...h.scope, entry: { sessionId: "old", updatedAt: Date.now(), status: "running", abortedLastRun: true, restartRecoveryDeliveryRunId: "core-run" } });
  const bytes = readFileSync(h.storePath, "utf8");
  writeFileSync(h.storePath, "{broken");
  expect(getSessionEntry({ ...h.scope, readConsistency: "latest" })).toBeUndefined();
  expect(() => verifiedCoreEntry(h.storePath, sessionKey)).toThrow();
  let waited = false;
  let resolved = false;
  await awaitCoreDispatchRetirement(() => retireInterruptedCoreDispatches(h.cfg), () => { throw new Error("logger failed"); }, async () => {
    expect(resolved).toBe(false);
    expect(h.journal.dispatch!.coreBindings()).toHaveLength(1);
    waited = true;
    writeFileSync(h.storePath, bytes);
  }).then(() => { resolved = true; });
  expect(waited).toBe(true);
  expect(getSessionEntry(h.scope)?.status).toBe("failed");
});

it("never opens the journal of an account this process does not serve", async () => {
  const h = fixture();
  // Another gateway process, serving a DIFFERENT account out of the SAME
  // storage root — its own live batch, its own binding, its own session entry.
  const foreignKey = "agent:main:webchannel:foreign:direct:peer:tenant:abc:peer-v2";
  const foreign = accountJournal(h.dir, "foreign", h.cfg, foreignKey);
  await upsertSessionEntry({ storePath: h.storePath, sessionKey: foreignKey, entry: { sessionId: "foreign-run", updatedAt: Date.now(), status: "running", abortedLastRun: true, restartRecoveryDeliveryRunId: "foreign-core-run" } });
  foreign.journal.close();
  const foreignBytes = readFileSync(foreign.paths.deliveryJournalPath);
  const storeBytes = readFileSync(h.storePath, "utf8");

  await retireInterruptedCoreDispatches(h.cfg);

  // The served account was retired; the foreign one was not even read.
  expect(h.journal.dispatch!.lookup("peer", "logical-A")?.state).toBe("interrupted");
  expect(readFileSync(foreign.paths.deliveryJournalPath)).toEqual(foreignBytes);
  expect(readFileSync(h.storePath, "utf8")).toBe(storeBytes);
  const reopened = openDeliveryJournal({ databasePath: foreign.paths.deliveryJournalPath });
  cleanups.push(() => reopened.close());
  expect(reopened.dispatch!.lookup("peer", "logical-A")?.state).toBe("started");
  expect(reopened.dispatch!.coreBindings()).toHaveLength(1);
});

it("a crash before the first core session write leaves no core work to resume", async () => {
  const h = fixture();
  await retireInterruptedCoreDispatches(h.cfg);
  expect(getSessionEntry(h.scope)).toBeUndefined();
  expect(h.journal.dispatch!.lookup("peer", "logical-A")?.state).toBe("interrupted");
});

it("normal completion retires its own binding while an earlier cancelled batch retains its evidence", () => {
  const h = fixture();
  const first = h.journal.dispatch!.lookup("peer", "logical-A")!;
  const owner = first.owner!;
  h.journal.dispatch!.recordStop(owner, "peer", "stop-A", [], true);
  expect(h.journal.dispatch!.settle(owner, "peer", first.batch!, "completed")).toEqual([]);
  h.journal.dispatch!.accept(owner, "peer", [{ text: "B", turnId: "B", randomId: "logical-B" }]);
  const second = h.journal.dispatch!.claim(owner, "peer", ["logical-B"])[0]!;
  prepareCoreDispatch(h.cfg, "main", sessionKey, { owner, batch: second.batch!, peerId: "peer" }, h.journal);
  expect(h.journal.dispatch!.coreBindings()).toHaveLength(2);
  expect(h.journal.dispatch!.settle(owner, "peer", second.batch!, "completed")).toHaveLength(1);
  expect(h.journal.dispatch!.coreBindings().map(binding => binding.batch)).toEqual([first.batch]);
  expect(h.journal.dispatch!.lookup("peer", "logical-A")?.state).toBe("cancelled");
  expect(h.journal.dispatch!.lookup("peer", "logical-B")?.state).toBe("completed");
});
