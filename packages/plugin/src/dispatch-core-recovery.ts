import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolveStorePath, type OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { getSessionEntry, updateSessionStoreEntry, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { openDeliveryJournal, type DeliveryJournal } from "./delivery-journal.js";
import { planAccounts } from "./multiplex.js";
import { tupleStoragePaths } from "./storage-paths.js";
import type { CoreDispatchBinding } from "./dispatch-store.js";
import { logSafe } from "./log-safe.js";

const processSlot = Symbol.for("webchannel.dispatch-core-recovery.v1");
const globals = globalThis as unknown as Record<symbol, { processId: string; ready: Promise<void>; release: () => void; started: boolean }>;
const state = globals[processSlot] ??= (() => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { processId: randomUUID(), ready, release, started: false };
})();
export const waitForCoreDispatchRecovery = () => state.ready;
export type CoreDispatchOwnership = { owner: string; batch: string; peerId: string };

/** The pinned SDK swallows read/parse errors. Verify the backing store before its result. */
export function verifiedCoreEntry(storePath: string, sessionKey: string): SessionEntry | undefined {
  let bytes: string;
  try { bytes = readFileSync(storePath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const raw = JSON.parse(bytes) as Record<string, SessionEntry>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("webchannel: invalid core session store");
  const expected = raw[sessionKey];
  const actual = getSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
  if (readFileSync(storePath, "utf8") !== bytes) throw new Error("webchannel: core session store changed during verification");
  if (expected?.sessionId !== actual?.sessionId || expected?.restartRecoveryDeliveryRunId !== actual?.restartRecoveryDeliveryRunId || expected?.status !== actual?.status || expected?.abortedLastRun !== actual?.abortedLastRun || expected?.updatedAt !== actual?.updatedAt || expected?.lifecycleRevision !== actual?.lifecycleRevision) throw new Error("webchannel: core session read is unconfirmed");
  return actual;
}

/** The exact isolated route is owned durably BEFORE any core session/run writes.
 * Core may rotate sessionId on /new, /reset or expiry; this binding follows the
 * session key that the plugin actually dispatched, without adopting another key.
 */
export function prepareCoreDispatch(cfg: OpenClawConfig, agentId: string, sessionKey: string, ownership: CoreDispatchOwnership, journal: DeliveryJournal): void {
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const binding: CoreDispatchBinding = { ...ownership, processId: state.processId, agentId, sessionKey, storePath };
  journal.dispatch!.bindCore(binding);
}

/** Discover expected associations from our journal even if the SDK reports an empty store.
 *
 * ⚠️ ONLY THE JOURNALS OF THE ACCOUNTS THIS PROCESS SERVES. Scanning every
 * `v2_*` directory under the storage roots opened OTHER processes' journals:
 * two gateways sharing one HOME (a multi-profile host) serve different accounts
 * out of the same default root, and process B would read process A's bindings,
 * find `owns(binding.owner)` true in A's own journal, and mark A's LIVE batch
 * interrupted while retiring its binding. It also opened — and mutated — the
 * stale journals of accounts that have since been removed from the config.
 * `planAccounts` is the same pure, config-only plan the runtime serves from, so
 * this service can only ever touch what this process owns.
 */
export async function retireInterruptedCoreDispatches(cfg: OpenClawConfig): Promise<void> {
  for (const account of planAccounts(cfg, { warn: () => {} })) {
    const path = tupleStoragePaths({
      tenant: account.tenant,
      accountId: account.accountId,
      ...(account.storageRoot ? { storageRoot: account.storageRoot } : {}),
    }).deliveryJournalPath;
    // An account that has never accepted work has no journal file, and opening
    // one would create it.
    try { statSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const journal = openDeliveryJournal({ databasePath: path });
    try {
      for (;;) {
        const bindings = journal.dispatch!.coreBindings();
        let progressed = false;
        for (const binding of bindings) {
          if (binding.processId === state.processId) continue;
          const entry = verifiedCoreEntry(binding.storePath, binding.sessionKey);
          // Core marks previous-process orphaned work before plugin services.
          // A current-process active run clears abortedLastRun and is excluded.
          if (entry?.status === "running" && entry.abortedLastRun === true) {
            await updateSessionStoreEntry({ storePath: binding.storePath, sessionKey: binding.sessionKey, requireWriteSuccess: true, update: current => {
              // Recheck the complete entry under the SDK's writer lock. A
              // reset, new run, or background update requires a fresh read.
              if (JSON.stringify(current) !== JSON.stringify(entry)) throw new Error("webchannel: core retirement entry changed");
              return { status: "failed", abortedLastRun: true, endedAt: Date.now(), pendingFinalDelivery: undefined, pendingFinalDeliveryText: undefined, pendingFinalDeliveryContext: undefined, pendingFinalDeliveryIntentId: undefined, restartRecoveryDeliveryContext: undefined, restartRecoveryDeliveryRunId: undefined };
            } });
            const after = verifiedCoreEntry(binding.storePath, binding.sessionKey);
            if (after?.status === "running" && after.abortedLastRun === true) throw new Error("webchannel: core retirement was not persisted");
          }
          if (journal.dispatch!.owns(binding.owner)) journal.dispatch!.settle(binding.owner, binding.peerId, binding.batch, "interrupted");
          journal.dispatch!.retireCore(binding.batch);
          progressed = true;
        }
        if (!progressed || bindings.length < 32) break;
      }
    } finally { journal.close(); }
  }
}

export async function awaitCoreDispatchRetirement(retire: () => Promise<void>, diagnostic: (error: unknown) => void, delay: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 1000))): Promise<void> {
  for (;;) {
    try { await retire(); return; }
    catch (error) { try { diagnostic(error); } catch { /* keep barrier */ } await delay(); }
  }
}

export function registerCoreDispatchRecoveryService(api: OpenClawPluginApi): void {
  api.registerService({ id: "webchannel-dispatch-recovery", async start(ctx) {
    if (state.started) return state.ready;
    state.started = true;
    await awaitCoreDispatchRetirement(() => retireInterruptedCoreDispatches(ctx.config), error => {
      ctx.logger.error(`webchannel: core dispatch retirement pending: ${logSafe(error)}`);
    });
    state.release();
  } });
}
