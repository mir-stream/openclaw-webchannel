import { applyDurableEvent, type DurableEvent, type DurableMessage, type DurableView } from "./durable-view-reducer.js";

/** Identity follows the reducer: tools are turn-scoped; other kinds use their ID. */
export function durableRowKey(row: DurableMessage): string {
  switch (row.kind) {
    case "text": return JSON.stringify(["text", row.id]);
    case "reasoning": return JSON.stringify(["reasoning", row.id]);
    case "tool": return JSON.stringify(["tool", row.turnId, row.id]);
    case "approval": return JSON.stringify(["approval", row.id]);
  }
}

/**
 * Modification evidence, never a position/sort key. Content and ordering still
 * come from applyDurableEvent. Comparing its output references also observes
 * seal-created answers and tombstones without a second event transition table.
 * Instances live with their view; a cursor alone cannot restore this state.
 */
export class DurableRowVersions {
  private rows = new Map<string, { seq: number; deleted: boolean }>();
  private sealSeq = -1;
  private previousView: DurableView | undefined;
  private unchangedRows = new WeakSet<DurableMessage>();

  /** Restore a canonical journal prefix, including permanent deletion fences. */
  restore(row: DurableMessage, seq: number): void {
    this.rows.set(durableRowKey(row), { seq, deleted: row.kind === "text" && row.deleted === true });
  }

  seq(key: string): number | undefined { return this.rows.get(key)?.seq; }
  deleted(key: string): boolean { return this.rows.get(key)?.deleted === true; }
  remember(key: string, seq: number): void {
    if (this.allows(key, seq)) this.rows.set(key, { seq, deleted: false });
  }
  allows(key: string, seq?: number): boolean {
    const prior = this.rows.get(key);
    return !prior?.deleted && (seq === undefined || prior === undefined || seq > prior.seq);
  }

  apply(view: DurableView, event: DurableEvent, seq?: number, unsequencedFloor = 0): DurableView {
    // Sequential journal replay reuses the returned view and all unchanged row
    // objects. Only changed objects need identity/version work. The client may
    // supply a newly projected view instead, so seed its references on entry.
    if (view !== this.previousView) this.unchangedRows = new WeakSet(view);
    let prior: Map<string, DurableMessage> | undefined;
    const priorRows = () => prior ??= new Map(view.map((row) => [durableRowKey(row), row]));
    let next = applyDurableEvent(view, event);
    let adjusted: DurableMessage[] | undefined;
    let rejected: Set<DurableMessage> | undefined;
    for (let i = 0; i < next.length; i++) {
      const row = next[i]!;
      if (row === view[i] || this.unchangedRows.has(row)) continue;
      const key = durableRowKey(row);
      if (!this.allows(key, seq)) {
        const held = priorRows().get(key);
        if (held === undefined) (rejected ??= new Set()).add(row);
        else (adjusted ??= [...next])[i] = held;
        continue;
      }
      this.rows.set(key, {
        seq: Math.max(seq ?? unsequencedFloor, this.seq(key) ?? 0),
        deleted: row.kind === "text" && row.deleted === true,
      });
      this.unchangedRows.add(row);
    }
    if (adjusted !== undefined) next = adjusted;
    if (rejected !== undefined) {
      const rejectedRows = rejected;
      next = next.filter((row) => !rejectedRows.has(row));
    }
    if (event.kind === "seal" && seq !== undefined) {
      if (seq < this.sealSeq) {
        // An older seal may fill unseen content, but cannot undo a later seal's
        // order. Retain occupied slots, then append genuinely new identities.
        const byKey = new Map(next.map((row) => [durableRowKey(row), row]));
        next = view.map((row) => byKey.get(durableRowKey(row)) ?? row)
          .concat(next.filter((row) => !priorRows().has(durableRowKey(row))));
      } else this.sealSeq = seq;
    }
    this.previousView = next;
    return next;
  }
}

/** A persisted reducer row. Order belongs to storage; it is never a row version. */
export type DurableWindowEntry = { row: DurableMessage; seq: number; order: string };
export interface DurableWindowReader {
  get(key: string): DurableWindowEntry | undefined;
  neighbor(order: string, direction: "before" | "after"): DurableWindowEntry | undefined;
  last(): DurableWindowEntry | undefined;
}

/** The identities an event can change. Keep this exhaustive with the reducer. */
function eventRowKeys(event: DurableEvent): string[] {
  const text = (id: string) => JSON.stringify(["text", id]);
  switch (event.kind) {
    case "requestState": case "user": case "messageEdited": case "messageDeleted": return [text(event.id)];
    case "placement": case "bubble": return [text(event.answerId)];
    case "reasoning": return [JSON.stringify(["reasoning", event.id])];
    case "tool": return [JSON.stringify(["tool", event.turnId, event.id])];
    case "approval": case "approvalResolution": return [JSON.stringify(["approval", event.id])];
    case "seal": return [...new Set([
      ...(Array.isArray(event.answers) ? event.answers.flatMap(a =>
        a && typeof a.id === "string" ? [text(a.id)] : []) : []),
      ...(Array.isArray(event.remove) ? event.remove.flatMap(id =>
        typeof id === "string" ? [text(id)] : []) : []),
    ])];
  }
}

/**
 * Apply the SAME canonical reducer to an event's complete dependency window.
 *
 * Every transition addresses explicit typed identities. Seal additionally uses
 * their relative slots, adjacent insertion positions, and the tail for absent
 * removals/new answers. Immediate neighbors anchor omitted intervals: no event
 * can read or move their interiors. Loading those anchors lets the canonical
 * array reducer decide all content/order without hydrating an unrelated row.
 *
 * This interface is for strictly increasing journal prefixes. Live out-of-order
 * delivery continues to use DurableRowVersions over its full in-memory view.
 */
export function applyDurableEventWindow(reader: DurableWindowReader, event: DurableEvent, seq: number): {
  before: DurableWindowEntry[]; after: DurableView; versions: DurableRowVersions;
} {
  const entries = new Map<string, DurableWindowEntry>();
  const add = (entry: DurableWindowEntry | undefined) => {
    if (entry !== undefined) entries.set(durableRowKey(entry.row), entry);
  };
  for (const key of eventRowKeys(event)) {
    const entry = reader.get(key);
    if (entry === undefined) continue;
    add(entry);
    add(reader.neighbor(entry.order, "before"));
    add(reader.neighbor(entry.order, "after"));
  }
  add(reader.last());
  const before = [...entries.values()].sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
  const versions = new DurableRowVersions();
  for (const entry of before) versions.restore(entry.row, entry.seq);
  return { before, after: versions.apply(before.map(entry => entry.row), event, seq), versions };
}
