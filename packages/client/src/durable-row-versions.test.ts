import { describe, expect, it } from "vitest";
import { applyDurableEvent, type DurableEvent, type DurableView } from "./durable-view-reducer.js";
import { DurableRowVersions, durableRowKey } from "./durable-row-versions.js";

describe("journal modification evidence from the shared reducer", () => {
  it("records an absent removal through the canonical reducer's hidden tombstone", () => {
    const versions = new DurableRowVersions();
    const event: DurableEvent = { kind: "seal", turnId: "t", answers: [], remove: ["unseen"] };
    const view = versions.apply([], event, 10);
    expect(view).toEqual(applyDurableEvent([], event));
    expect(view).toEqual([{ kind: "text", id: "unseen", role: "agent", text: "", turnId: "t", deleted: true }]);
    expect(versions.seq(durableRowKey(view[0]!))).toBe(10);
    expect(versions.apply([], { kind: "bubble", answerId: "unseen", text: "old" }, 1)).toEqual([]);
  });
  it("observes seal updates, creations, removals and order without sorting by modification seq", () => {
    const versions = new DurableRowVersions();
    const events: DurableEvent[] = [
      { kind: "bubble", answerId: "A", text: "A", turnId: "t" },
      { kind: "bubble", answerId: "B", text: "B", turnId: "t" },
      { kind: "bubble", answerId: "gone", text: "gone", turnId: "t" },
      { kind: "seal", turnId: "t", answers: [{ id: "B", text: "final B" }, { id: "A", text: "final A" }, { id: "C", text: "new" }], remove: ["gone"] },
      { kind: "reasoning", turnId: "t", id: "R", text: "reason" },
      { kind: "bubble", answerId: "B", text: "updated B", turnId: "t" },
    ];
    let view: DurableView = [];
    let reference: DurableView = [];
    events.forEach((event, i) => {
      view = versions.apply(view, event, i + 1);
      reference = applyDurableEvent(reference, event);
      expect(view).toEqual(reference);
    });
    expect(view.map((row) => [row.id, versions.seq(durableRowKey(row))])).toEqual([
      ["B", 6], ["A", 4], ["C", 4], ["gone", 4], ["R", 5],
    ]);
    const removedKey = durableRowKey(view.find((row) => row.id === "gone")!);
    expect(versions.deleted(removedKey)).toBe(true);
    // The UI omits tombstones; the version fence must survive that projection.
    const visible = view.filter((row) => row.id !== "gone");
    expect(versions.apply(visible, events[2]!, 3)).toEqual(visible);
    expect(versions.apply(visible, events[3]!, 4)).toEqual(visible);
  });

  it("keeps tool tuple keys injective for accepted separator-containing strings", () => {
    const a: DurableEvent = { kind: "tool", turnId: "a\0b", id: "c", phase: "start" };
    const b: DurableEvent = { kind: "tool", turnId: "a", id: "b\0c", phase: "end" };
    const versions = new DurableRowVersions();
    const view = versions.apply(versions.apply([], a, 1), b, 2);
    expect(view).toHaveLength(2);
    expect(versions.seq(durableRowKey(view[0]!))).toBe(1);
    expect(versions.seq(durableRowKey(view[1]!))).toBe(2);
  });
});
