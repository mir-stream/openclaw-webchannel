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
    const prior = new Map(view.map((row) => [durableRowKey(row), row]));
    let next = applyDurableEvent(view, event).flatMap((row) => {
      const key = durableRowKey(row);
      const held = prior.get(key);
      if (row === held) return [row];
      if (!this.allows(key, seq)) return held === undefined ? [] : [held];
      this.rows.set(key, {
        seq: Math.max(seq ?? unsequencedFloor, this.seq(key) ?? 0),
        deleted: row.kind === "text" && row.deleted === true,
      });
      return [row];
    });
    if (event.kind === "seal" && seq !== undefined) {
      if (seq < this.sealSeq) {
        // An older seal may fill unseen content, but cannot undo a later seal's
        // order. Retain occupied slots, then append genuinely new identities.
        const byKey = new Map(next.map((row) => [durableRowKey(row), row]));
        next = view.map((row) => byKey.get(durableRowKey(row)) ?? row)
          .concat(next.filter((row) => !prior.has(durableRowKey(row))));
      } else this.sealSeq = seq;
    }
    return next;
  }
}
