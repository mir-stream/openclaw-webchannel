import { describe, expect, it } from "vitest";
import { createIngressResultChunkWriter } from "./ingress-result-chunks.js";

describe("ingress result chunks", () => {
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
