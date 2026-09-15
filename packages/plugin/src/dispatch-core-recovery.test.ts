import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { openDeliveryJournal } from "./delivery-journal.js";
import { tupleStoragePaths } from "./storage-paths.js";
import { awaitCoreDispatchRetirement, prepareCoreDispatch, retireInterruptedCoreDispatches, verifiedCoreEntry } from "./dispatch-core-recovery.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
const sessionKey = "agent:main:webchannel:account:direct:peer:tenant:abc:peer-v2";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dispatch369-core-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const paths = tupleStoragePaths({ tenant: "tenant", accountId: "account", storageRoot: dir });
  const journal = openDeliveryJournal({ databasePath: paths.deliveryJournalPath });
  cleanups.push(() => journal.close());
  const owner = journal.dispatch!.activate();
  journal.dispatch!.accept(owner, "peer", [{ text: "A", turnId: "A", randomId: "logical-A" }]);
  const row = journal.dispatch!.claim(owner, "peer", ["logical-A"])[0]!;
  const storePath = join(dir, "sessions.json");
  const cfg = { session: { store: storePath } };
  prepareCoreDispatch(cfg, "main", sessionKey, { owner, batch: row.batch!, peerId: "peer" }, journal);
  const binding = journal.dispatch!.coreBindings()[0]!;
  journal.dispatch!.bindCore({ ...binding, processId: "previous-process" });
  return { dir, journal, storePath, cfg, scope: { storePath, sessionKey } };
}

it.each(["original-session", "rotated-after-new", "rotated-on-expiry"])("retires explicitly restart-aborted work at the exact bound route with %s", async sessionId => {
  const h = fixture();
  // This state is injected through the real public SDK, including the core
  // persist-before-onTurnAdopted boundary. There is deliberately no plugin marker.
  await upsertSessionEntry({ ...h.scope, entry: { sessionId, updatedAt: Date.now(), status: "running", abortedLastRun: true, restartRecoveryDeliveryRunId: "core-run", restartRecoveryDeliveryContext: { channel: "webchannel", accountId: "account", to: "peer" } } });
  await retireInterruptedCoreDispatches(h.cfg, [h.dir]);
  expect(getSessionEntry(h.scope)).toMatchObject({ sessionId, status: "failed", abortedLastRun: true });
  expect(getSessionEntry(h.scope)?.restartRecoveryDeliveryRunId).toBeUndefined();
  expect(h.journal.dispatch!.lookup("peer", "logical-A")?.state).toBe("interrupted");
  expect(h.journal.dispatch!.coreBindings()).toEqual([]);
  await retireInterruptedCoreDispatches(h.cfg, [h.dir]);
});

it("excludes a newly active current-process run and unrelated sessions", async () => {
  const h = fixture();
  await upsertSessionEntry({ ...h.scope, entry: { sessionId: "newly-active", updatedAt: Date.now(), status: "running", abortedLastRun: false, restartRecoveryDeliveryRunId: "new-run" } });
  await upsertSessionEntry({ storePath: h.storePath, sessionKey: "agent:main:another-channel", entry: { sessionId: "unrelated", updatedAt: Date.now(), status: "running", abortedLastRun: true } });
  const before = readFileSync(h.storePath, "utf8");
  await retireInterruptedCoreDispatches(h.cfg, [h.dir]);
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
  await awaitCoreDispatchRetirement(() => retireInterruptedCoreDispatches(h.cfg, [h.dir]), () => { throw new Error("logger failed"); }, async () => {
    expect(resolved).toBe(false);
    expect(h.journal.dispatch!.coreBindings()).toHaveLength(1);
    waited = true;
    writeFileSync(h.storePath, bytes);
  }).then(() => { resolved = true; });
  expect(waited).toBe(true);
  expect(getSessionEntry(h.scope)?.status).toBe("failed");
});

it("a crash before the first core session write leaves no core work to resume", async () => {
  const h = fixture();
  await retireInterruptedCoreDispatches(h.cfg, [h.dir]);
  expect(getSessionEntry(h.scope)).toBeUndefined();
  expect(h.journal.dispatch!.lookup("peer", "logical-A")?.state).toBe("interrupted");
});
