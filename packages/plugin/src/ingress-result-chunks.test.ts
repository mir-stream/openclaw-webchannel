import { describe, expect, it } from "vitest";
import { createIngressResultChunkWriter, type IngressResultFrame } from "./ingress-result-chunks.js";

describe("ingress result chunks", () => {
  it("carries each cancellation proof with its own ID through count splits and duplicate upgrades", () => {
    const frames: IngressResultFrame[] = [];
    const writer = createIngressResultChunkWriter({ type: "ack", maxIds: 2,
      publish: frame => { frames.push(frame); return true; } });
    writer.add("a"); writer.add("a", true); writer.add("a", true);
    writer.add("b"); writer.add("c", true); writer.add("d", true);
    expect(writer.finish()).toBe(true);
    expect(frames).toEqual([
      { type: "ack", ids: ["a", "b"], cancelled: ["a"] },
      { type: "ack", ids: ["c", "d"], cancelled: ["c", "d"] },
    ]);
    expect(writer.retainedIds()).toBe(0);
  });

  it("measures cancellation proof on byte splits and never falls back to a bare ACK when it cannot fit", () => {
    const frames: IngressResultFrame[] = [];
    const one = { type: "ack", ids: ["한글"], cancelled: ["한글"] };
    const bytes = Buffer.byteLength(JSON.stringify(one));
    const writer = createIngressResultChunkWriter({ type: "ack", effectiveOutboundLimit: bytes,
      publish: frame => { frames.push(frame); return true; } });
    writer.add("한글", true); writer.add("다음", true);
    expect(writer.finish()).toBe(true);
    expect(frames).toEqual([one, { type: "ack", ids: ["다음"], cancelled: ["다음"] }]);
    const rejected = createIngressResultChunkWriter({ type: "ack", effectiveOutboundLimit: bytes - 1,
      publish: frame => { frames.push(frame); return true; } });
    expect(rejected.add("한글", true)).toBe(false);
    expect(rejected.finish()).toBe(false);
    expect(frames).toHaveLength(2);
  });

  it("omits invalid proof IDs and keeps later proofs after a failed chunk", () => {
    const frames: IngressResultFrame[] = [];
    const writer = createIngressResultChunkWriter({ type: "ack", maxIds: 1,
      publish: frame => { frames.push(frame); return frames.length !== 1; } });
    expect(writer.add("", true)).toBe(false);
    expect(writer.add("x".repeat(129), true)).toBe(false);
    writer.add("a", true); writer.add("b", true);
    expect(writer.finish()).toBe(false);
    expect(frames).toEqual([
      { type: "ack", ids: ["a"], cancelled: ["a"] },
      { type: "ack", ids: ["b"], cancelled: ["b"] },
    ]);
    const rejection = createIngressResultChunkWriter({ type: "inbound_rejected",
      publish: frame => { frames.push(frame); return true; } });
    rejection.add("c", true); rejection.finish();
    expect(frames.at(-1)).toEqual({ type: "inbound_rejected", ids: ["c"], reason: "overloaded" });
  });

  it("streams count-bounded ordered chunks with per-frame dedupe", () => {
    const frames: unknown[] = [];
    const writer = createIngressResultChunkWriter({
      type: "ack", maxIds: 2, publish: (frame) => { frames.push(frame); return true; },
    });
    for (const id of ["a", "a", "b", "c"]) writer.add(id);
    expect(writer.finish()).toBe(true);
    expect(frames).toEqual([{ type: "ack", ids: ["a", "b"] }, { type: "ack", ids: ["c"] }]);
  });

  it("retains no id when even one result cannot fit", () => {
    let tooSmall = 0;
    const writer = createIngressResultChunkWriter({
      type: "inbound_rejected", effectiveOutboundLimit: 1,
      measureWireBytes: () => 2, publish: () => true, onTooSmall: () => { tooSmall++; },
    });
    expect(writer.add("a")).toBe(false);
    expect(writer.retainedIds()).toBe(0);
    expect(tooSmall).toBe(1);
  });
});
