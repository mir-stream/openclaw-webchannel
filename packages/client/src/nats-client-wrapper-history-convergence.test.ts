import { describe, expect, it, vi } from "vitest";
import { WebChannelNATSClient } from "./nats-client-wrapper.js";
import type { InboundMessage } from "./nats-client.js";

function setup() {
  const wrapper = new WebChannelNATSClient({
    natsUrl: "ws://127.0.0.1:4222", bootstrapJwt: "test", accountId: "a", tenant: "t", peerId: "p",
    registration: { devicePrivateKey: {} as CryptoKey, deviceX25519PrivateKey: {} as CryptoKey },
  });
  const inner = wrapper as unknown as {
    handleMessage(m: InboundMessage): void;
    client: { getDifference: ReturnType<typeof vi.fn> };
    cursor: { state: string; afterSeq: number; nonce: string; last: number };
    resetCursorForConnection(): void;
  };
  inner.client.getDifference = vi.fn();
  return { wrapper, inner, send: (m: InboundMessage) => inner.handleMessage(m) };
}

describe("#342 history row authority", () => {
  it("fills sparse terminal tool metadata from repeated full history at the same version", () => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "tool_activity", id: "tool", turnId: "t", phase: "end", status: "ok", seq: 4 });
      const snapshot: InboundMessage = { type: "history", highWaterSeq: 4, messages: [
        { kind: "tool", id: "tool", turnId: "t", name: "read_file", argKeys: ["path", "limit"],
          summary: "Read file", phase: "end", status: "ok", seq: 4 },
      ] };
      send(snapshot); send(snapshot);
      expect(wrapper.getState().messages).toMatchObject([
        { kind: "tool", name: "read_file", argKeys: ["path", "limit"], summary: "Read file", phase: "end", status: "ok" },
      ]);
      expect(inner.cursor.last).toBe(4);
      expect(inner.client.getDifference).not.toHaveBeenCalled();
      send({ type: "tool_activity", id: "tool", turnId: "t", name: "new name", argKeys: ["new"],
        summary: "New outcome", phase: "end", status: "error", seq: 5 });
      const newer = wrapper.getState().messages;
      send(snapshot); send(snapshot);
      expect(wrapper.getState().messages).toEqual(newer);
    } finally { wrapper.close(); }
  });

  it.each([false, true])("reconstructs sparse tool content during cold recovery while fencing newer state: %s", (newerHistory) => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "tool_activity", id: "tool", turnId: "t", phase: "end", status: "ok", seq: 4 });
      const snapshot: InboundMessage = { type: "history", highWaterSeq: 4, snapshotComplete: false, messages: [] };
      send(snapshot); send(snapshot);
      if (newerHistory) {
        send({ type: "history", messages: [{ kind: "tool", id: "tool", turnId: "t", name: "new name",
          argKeys: ["new"], summary: "New outcome", phase: "end", status: "error", seq: 6 }] });
      }
      send({ type: "difference", afterSeq: 0, nonce: inner.cursor.nonce, maxSeq: 2, partial: true, events: [
        { seq: 1, event: { kind: "tool", id: "tool", turnId: "t", name: "read_file", phase: "start", argKeys: ["path", "limit"] } },
        { seq: 2, event: { kind: "tool", id: "tool", turnId: "t", phase: "update", summary: "Read file" } },
      ] });
      expect(wrapper.getState().messages[0]).toMatchObject({ phase: "end", status: newerHistory ? "error" : "ok" });
      send({ type: "difference", afterSeq: 2, nonce: inner.cursor.nonce, maxSeq: 4, partial: false, events: [
        { seq: 3, event: { kind: "bubble", answerId: "a3", text: "done" } },
        { seq: 4, event: { kind: "tool", id: "tool", turnId: "t", phase: "end", status: "ok" } },
      ] });
      const expected = wrapper.getState().messages;
      expect(expected.map((row) => row.id)).toEqual(["tool", "a3"]);
      expect(expected[0]).toMatchObject(newerHistory
        ? { name: "new name", argKeys: ["new"], summary: "New outcome", phase: "end", status: "error" }
        : { name: "read_file", argKeys: ["path", "limit"], summary: "Read file", phase: "end", status: "ok" });
      send(snapshot); send(snapshot);
      expect(wrapper.getState().messages).toEqual(expected);
      expect(inner.cursor.last).toBe(4);
      expect(inner.client.getDifference).toHaveBeenCalledTimes(2);
    } finally { wrapper.close(); }
  });

  it("skips a null history member and hydrates the valid following row", () => {
    const { wrapper, send } = setup();
    try {
      const snapshot = { type: "history", messages: [null, { id: "valid", role: "agent", text: "valid" }] } as unknown as InboundMessage;
      send(snapshot); send(snapshot);
      expect(wrapper.getState().messages).toMatchObject([{ id: "valid", text: "valid" }]);
    } finally { wrapper.close(); }
  });

  it("retains a complete snapshot's older prefix after a live frame seeded the cursor", () => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "agent_message", id: "a99", text: "live", seq: 99 });
      const snapshot: InboundMessage = { type: "history", highWaterSeq: 100, messages: [98, 99, 100]
        .map((seq) => ({ id: `a${seq}`, role: "agent" as const, text: `a${seq}`, seq })) };
      send(snapshot); send(snapshot);
      expect(inner.client.getDifference.mock.calls.map(([afterSeq]) => afterSeq)).toEqual([99]);
      send({ type: "difference", afterSeq: 99, nonce: inner.cursor.nonce, maxSeq: 100, partial: false,
        events: [{ seq: 100, event: { kind: "bubble", answerId: "a100", text: "a100" } }] });
      const expected = wrapper.getState().messages;
      expect(expected.map((m) => m.id)).toEqual(["a98", "a99", "a100"]);
      expect(expected[1].text).toBe("live");
      send(snapshot); send(snapshot);
      expect(wrapper.getState().messages).toEqual(expected);
      expect(inner.cursor.last).toBe(100);
    } finally { wrapper.close(); }
  });

  it.each([98, 99, 100])("recovers an incomplete first snapshot at %i after live99 in journal order", (highWaterSeq) => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "agent_message", id: "a99", text: "live", seq: 99 });
      const snapshot: InboundMessage = { type: "history", highWaterSeq, snapshotComplete: false,
        messages: [{ id: `a${highWaterSeq}`, role: "agent", text: "snapshot", seq: highWaterSeq }] };
      send(snapshot); send(snapshot);
      expect(inner.cursor.afterSeq).toBe(0);
      const maxSeq = Math.max(99, highWaterSeq);
      send({ type: "difference", afterSeq: 0, nonce: inner.cursor.nonce, maxSeq, partial: false,
        events: Array.from({ length: maxSeq }, (_, i) => ({ seq: i + 1,
          event: { kind: "bubble", answerId: `a${i + 1}`, text: `${i + 1}` } })) });
      const expected = wrapper.getState().messages;
      expect(expected.map((m) => m.id)).toEqual(Array.from({ length: maxSeq }, (_, i) => `a${i + 1}`));
      expect(expected[98].text).toBe("live");
      send(snapshot);
      expect(wrapper.getState().messages).toEqual(expected);
      expect(inner.cursor.last).toBe(maxSeq);
      expect(inner.client.getDifference).toHaveBeenCalledTimes(1);
    } finally { wrapper.close(); }
  });

  it("restarts an existing live-seeded catch-up at zero for the first incomplete snapshot", () => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "agent_message", id: "a99", text: "99", seq: 99 });
      send({ type: "agent_message", id: "a101", text: "101", seq: 101 });
      const oldNonce = inner.cursor.nonce;
      send({ type: "history", highWaterSeq: 99, snapshotComplete: false, messages: [] });
      expect(inner.client.getDifference.mock.calls.map(([afterSeq]) => afterSeq)).toEqual([99, 0]);
      send({ type: "difference", afterSeq: 99, nonce: oldNonce, maxSeq: 101, partial: false, events: [] });
      expect(inner.cursor.afterSeq).toBe(0);
      send({ type: "difference", afterSeq: 0, nonce: inner.cursor.nonce, maxSeq: 100, partial: false,
        events: Array.from({ length: 100 }, (_, i) => ({ seq: i + 1,
          event: { kind: "bubble", answerId: `a${i + 1}`, text: `${i + 1}` } })) });
      expect(wrapper.getState().messages.map((m) => m.id)).toEqual(Array.from({ length: 101 }, (_, i) => `a${i + 1}`));
      expect(inner.cursor.last).toBe(101);
    } finally { wrapper.close(); }
  });

  it("keeps cold recovery order through paging and a higher snapshot received between pages", () => {
    const { wrapper, inner, send } = setup();
    const reply = (afterSeq: number, maxSeq: number, partial: boolean) => send({ type: "difference",
      afterSeq, nonce: inner.cursor.nonce, maxSeq, partial,
      events: Array.from({ length: maxSeq - afterSeq }, (_, i) => ({ seq: afterSeq + i + 1,
        event: { kind: "bubble", answerId: `a${afterSeq + i + 1}`, text: `${afterSeq + i + 1}` } })) });
    try {
      send({ type: "agent_message", id: "a99", text: "99", seq: 99 });
      send({ type: "history", highWaterSeq: 100, snapshotComplete: false, messages: [] });
      reply(0, 50, true);
      expect(wrapper.getState().messages.map((m) => m.id)).toEqual([...Array.from({ length: 50 }, (_, i) => `a${i + 1}`), "a99"]);
      send({ type: "history", highWaterSeq: 102, messages: [{ id: "a102", role: "agent", text: "102", seq: 102 }] });
      reply(50, 100, false);
      expect(inner.cursor.afterSeq).toBe(100);
      reply(100, 102, false);
      expect(wrapper.getState().messages.map((m) => m.id)).toEqual(Array.from({ length: 102 }, (_, i) => `a${i + 1}`));
      expect(inner.cursor.last).toBe(102);
    } finally { wrapper.close(); }
  });

  it("uses canonical seal order during cold recovery while retaining newer live text", () => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "agent_message", id: "A", text: "new A", turnId: "t", seq: 4 });
      send({ type: "history", highWaterSeq: 4, snapshotComplete: false, messages: [] });
      send({ type: "difference", afterSeq: 0, nonce: inner.cursor.nonce, maxSeq: 4, partial: false, events: [
        { seq: 1, event: { kind: "bubble", answerId: "A", text: "old A", turnId: "t" } },
        { seq: 2, event: { kind: "bubble", answerId: "B", text: "B", turnId: "t" } },
        { seq: 3, event: { kind: "seal", turnId: "t", answers: [{ id: "B", text: "final B" }, { id: "A", text: "old A" }], remove: [] } },
        { seq: 4, event: { kind: "bubble", answerId: "A", text: "new A", turnId: "t" } },
      ] });
      expect(wrapper.getState().messages.map((m) => [m.id, m.text])).toEqual([["B", "final B"], ["A", "new A"]]);
    } finally { wrapper.close(); }
  });

  it("hydrates retained snapshot rows on timeout without renewing the retry budget", () => {
    vi.useFakeTimers();
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "agent_message", id: "a99", text: "99", seq: 99 });
      send({ type: "history", highWaterSeq: 100, messages: [98, 99, 100]
        .map((seq) => ({ id: `a${seq}`, role: "agent" as const, text: `${seq}`, seq })) });
      vi.advanceTimersByTime(60_000);
      expect(inner.client.getDifference).toHaveBeenCalledTimes(4);
      expect(inner.cursor).toMatchObject({ state: "synced", last: 99 });
      expect(wrapper.getState().messages.map((m) => m.id)).toEqual(["a98", "a99", "a100"]);
    } finally { wrapper.close(); vi.useRealTimers(); }
  });

  it("retains a received snapshot prefix across reconnect and a narrower replacement snapshot", () => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "agent_message", id: "a99", text: "99", seq: 99 });
      send({ type: "history", highWaterSeq: 100, messages: [98, 99, 100]
        .map((seq) => ({ id: `a${seq}`, role: "agent" as const, text: `${seq}`, seq })) });
      inner.resetCursorForConnection();
      send({ type: "history", highWaterSeq: 101, messages: [{ id: "a101", role: "agent", text: "101", seq: 101 }] });
      send({ type: "difference", afterSeq: 99, nonce: inner.cursor.nonce, maxSeq: 101, partial: false,
        events: [100, 101].map((seq) => ({ seq, event: { kind: "bubble", answerId: `a${seq}`, text: `${seq}` } })) });
      expect(wrapper.getState().messages.map((m) => m.id)).toEqual(["a98", "a99", "a100", "a101"]);
    } finally { wrapper.close(); }
  });

  it("retains partially reconstructed cold order across timeout and reconnect", () => {
    vi.useFakeTimers();
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "agent_message", id: "a4", text: "4", seq: 4 });
      send({ type: "history", highWaterSeq: 5, snapshotComplete: false, messages: [] });
      send({ type: "difference", afterSeq: 0, nonce: inner.cursor.nonce, maxSeq: 2, partial: true,
        events: [1, 2].map((seq) => ({ seq, event: { kind: "bubble", answerId: `a${seq}`, text: `${seq}` } })) });
      vi.advanceTimersByTime(60_000);
      expect(inner.client.getDifference).toHaveBeenCalledTimes(5);
      expect(inner.cursor).toMatchObject({ state: "synced", last: 2 });
      inner.resetCursorForConnection();
      send({ type: "history", highWaterSeq: 2, messages: [] });
      expect(inner.cursor.afterSeq).toBe(2);
      send({ type: "difference", afterSeq: 2, nonce: inner.cursor.nonce, maxSeq: 5, partial: false,
        events: [3, 4, 5].map((seq) => ({ seq, event: { kind: "bubble", answerId: `a${seq}`, text: `${seq}` } })) });
      expect(wrapper.getState().messages.map((m) => m.id)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
      expect(inner.cursor.last).toBe(5);
    } finally { wrapper.close(); vi.useRealTimers(); }
  });
  it("refreshes a newer approval outcome without rearming it on stale history", () => {
    const { wrapper, send } = setup();
    try {
      send({ type: "approval_request", id: "approval", kind: "exec", title: "Old title", prompt: "old", options: [], seq: 1 });
      send({ type: "history", messages: [{ kind: "approval", id: "approval", approvalKind: "exec",
        title: "Final title", prompt: "new", options: [], resolvedDecision: "deny", seq: 3 }] });
      const expected = wrapper.getState().messages;
      expect(expected[0]).toMatchObject({ title: "Final title", prompt: "new", resolvedDecision: "deny", resolutionConfirmed: true });
      const stale: InboundMessage = { type: "history", messages: [{ kind: "approval", id: "approval", approvalKind: "exec",
        title: "Old title", prompt: "old", options: [], seq: 1 }] };
      send(stale); send(stale);
      expect(wrapper.getState().messages).toEqual(expected);
      expect(wrapper.getState().approvals).toMatchObject([{ id: "approval", actionable: false, resolvedDecision: "deny" }]);
    } finally { wrapper.close(); }
  });
  it("remembers a newer seal removing an absent ID before a delayed page or difference tries to create it", () => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "turn_snapshot", turnId: "t", answers: [], remove: ["unpaged"], seq: 5 });
      expect(wrapper.getState().messages).toEqual([]);
      const page: InboundMessage = { type: "history", messages: [
        { id: "unpaged", role: "agent", text: "old", turnId: "t", seq: 1 },
      ] };
      send(page); send(page);
      expect(wrapper.getState().messages).toEqual([]);
      send({ type: "agent_message", id: "trigger", text: "new", seq: 7 });
      send({ type: "difference", afterSeq: 5, nonce: inner.cursor.nonce, maxSeq: 7, partial: false, events: [
        { seq: 6, event: { kind: "bubble", answerId: "unpaged", text: "late retry", turnId: "t" } },
        { seq: 7, event: { kind: "bubble", answerId: "trigger", text: "new" } },
      ] });
      expect(wrapper.getState().messages.map((m) => m.id)).toEqual(["trigger"]);
    } finally { wrapper.close(); }
  });
  it("retains snapshot high-water observed during catch-up across partial and completed pages", () => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "user_committed", id: "old", text: "old", seq: 1 });
      send({ type: "history", highWaterSeq: 4, messages: [] });
      send({ type: "history", highWaterSeq: 8, messages: [{ id: "a8", role: "agent", text: "8", seq: 8 }] });
      send({ type: "difference", afterSeq: 1, nonce: inner.cursor.nonce, partial: true, maxSeq: 3,
        events: [2, 3].map((seq) => ({ seq, event: { kind: "bubble", answerId: `a${seq}`, text: `${seq}` } })) });
      expect(inner.cursor.afterSeq).toBe(3);
      // This completed response was read before the newer snapshot's journal tail.
      send({ type: "difference", afterSeq: 3, nonce: inner.cursor.nonce, partial: false, maxSeq: 4,
        events: [{ seq: 4, event: { kind: "bubble", answerId: "a4", text: "4" } }] });
      expect(inner.cursor.afterSeq).toBe(4);
      send({ type: "difference", afterSeq: 4, nonce: inner.cursor.nonce, partial: false, maxSeq: 8,
        events: [5, 6, 7, 8].map((seq) => ({ seq, event: { kind: "bubble", answerId: `a${seq}`, text: `${seq}` } })) });
      expect(inner.cursor.last).toBe(8);
      expect(wrapper.getState().messages.map((m) => m.id)).toEqual(["old", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]);
    } finally { wrapper.close(); }
  });
  it("rejects repeated stale pages after newer live content and seal removal", () => {
    const { wrapper, send } = setup();
    try {
      send({ type: "progress", id: "a", text: "partial", turnId: "t", seq: 1 });
      send({ type: "agent_message", id: "gone", text: "remove me", turnId: "t", seq: 2 });
      send({ type: "tool_activity", id: "a", turnId: "t", phase: "end", status: "ok", seq: 3 });
      send({ type: "reasoning", id: "a", turnId: "t", text: "final reasoning", seq: 4 });
      send({ type: "turn_snapshot", turnId: "t", answers: [{ id: "a", text: "final" }], remove: ["gone"], seq: 5 });
      const stale: InboundMessage = { type: "history", highWaterSeq: 4, messages: [
        { id: "a", role: "agent", text: "old", seq: 1 },
        { id: "gone", role: "agent", text: "remove me", seq: 2 },
        { kind: "tool", id: "a", turnId: "t", phase: "start", seq: 2 },
        { kind: "reasoning", id: "a", turnId: "t", text: "old reasoning", seq: 3 },
      ] };
      const expected = wrapper.getState().messages;
      send(stale); send(stale);
      expect(wrapper.getState().messages).toEqual(expected);
      expect(expected.map((m) => m.id)).toEqual(["a", "a", "a"]);
      expect(expected[0]).toMatchObject({ text: "final", working: false });
      expect(expected[0].draftOnly).toBeUndefined();
    } finally { wrapper.close(); }
  });

  it("keeps a newer page authoritative when older difference content arrives later", () => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "tool_activity", id: "x", turnId: "t", phase: "start", seq: 1 });
      send({ type: "history", messages: [{ kind: "tool", id: "x", turnId: "t", phase: "end", status: "ok", seq: 4 }] });
      send({ type: "agent_message", id: "trigger", text: "trigger", seq: 5 });
      send({ type: "difference", afterSeq: 1, nonce: inner.cursor.nonce, maxSeq: 5, partial: false, events: [
        { seq: 2, event: { kind: "tool", id: "x", turnId: "t", phase: "update" } },
        { seq: 4, event: { kind: "tool", id: "x", turnId: "t", phase: "end", status: "ok" } },
        { seq: 5, event: { kind: "bubble", answerId: "trigger", text: "trigger" } },
      ] });
      expect(wrapper.getState().messages[0]).toMatchObject({ phase: "end", status: "ok" });
      expect(inner.cursor.last).toBe(5);
    } finally { wrapper.close(); }
  });

  it("uses tuple identities for live and repeated history tool merges", () => {
    const { wrapper, send } = setup();
    try {
      send({ type: "tool_activity", turnId: "a\0b", id: "c", phase: "start", seq: 1 });
      send({ type: "tool_activity", turnId: "a", id: "b\0c", phase: "start", seq: 2 });
      const page: InboundMessage = { type: "history", messages: [
        { kind: "tool", turnId: "a\0b", id: "c", phase: "end", status: "ok", seq: 3 },
        { kind: "tool", turnId: "a", id: "b\0c", phase: "end", status: "error", seq: 4 },
      ] };
      send(page); send(page);
      expect(wrapper.getState().messages.map((m) => m.kind === "tool" ? m.status : undefined)).toEqual(["ok", "error"]);
    } finally { wrapper.close(); }
  });

  it("recovers even a one-event warm snapshot gap instead of acknowledging missing content", () => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "progress", id: "a", text: "partial", seq: 1 });
      send({ type: "history", highWaterSeq: 2, messages: [{ id: "a", role: "agent", text: "final", seq: 2 }] });
      expect(inner.cursor.afterSeq).toBe(1);
      expect(wrapper.getState().messages[0].text).toBe("partial");
      send({ type: "difference", afterSeq: 1, nonce: inner.cursor.nonce, maxSeq: 2, partial: false,
        events: [{ seq: 2, event: { kind: "bubble", answerId: "a", text: "final" } }] });
      expect(wrapper.getState().messages[0].text).toBe("final");
      expect(inner.cursor.last).toBe(2);
    } finally { wrapper.close(); }
  });

  it("starts an incomplete cold snapshot at zero and keeps recreated state unseeded", () => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "history", highWaterSeq: 9, snapshotComplete: false, messages: [{ id: "tail", role: "agent", text: "tail", seq: 9 }] });
      expect(inner.cursor.afterSeq).toBe(0);
      expect(wrapper.getState().messages).toEqual([]);
      const fresh = setup();
      try {
        expect(fresh.inner.cursor.state).toBe("unseeded");
        expect(fresh.wrapper.getState().messages).toEqual([]);
      } finally { fresh.wrapper.close(); }
    } finally { wrapper.close(); }
  });
  it("refreshes held agent, tool and reasoning rows from newer pages", () => {
    const { wrapper, send } = setup();
    try {
      send({ type: "progress", id: "a", turnId: "t", text: "partial", seq: 1 });
      send({ type: "tool_activity", id: "tool", turnId: "t", phase: "start", seq: 2 });
      send({ type: "reasoning", id: "r", turnId: "t", text: "prefix", seq: 3 });
      const page = { type: "history", messages: [
        { id: "a", role: "agent", text: "complete", turnId: "t", seq: 4 },
        { kind: "tool", id: "tool", turnId: "t", phase: "end", status: "ok", seq: 5 },
        { kind: "reasoning", id: "r", turnId: "t", text: "complete reasoning", seq: 6 },
      ] } as InboundMessage;
      send(page); send(page);
      expect(wrapper.getState().messages[0]).toMatchObject({ text: "complete", working: false });
      expect(wrapper.getState().messages[0].draftOnly).toBeUndefined();
      expect(wrapper.getState().messages[1]).toMatchObject({ phase: "end", status: "ok" });
      expect(wrapper.getState().messages[2].text).toBe("complete reasoning");
    } finally { wrapper.close(); }
  });

  it("recovers a warm zero-overlap snapshot through ordered difference", () => {
    const { wrapper, inner, send } = setup();
    try {
      send({ type: "user_committed", id: "old", text: "old", seq: 1 });
      send({ type: "history", highWaterSeq: 70, messages: [{ id: "newest", role: "agent", text: "newest" }] });
      expect(wrapper.getState().messages.map((m) => m.id)).toEqual(["old"]);
      expect(inner.cursor.afterSeq).toBe(1);
      send({ type: "difference", afterSeq: 1, nonce: inner.cursor.nonce, partial: false, maxSeq: 70,
        events: Array.from({ length: 69 }, (_, i) => ({ seq: i + 2,
          event: { kind: "bubble", answerId: i === 68 ? "newest" : `a${i}`, text: `${i}` } })),
      });
      expect(wrapper.getState().messages).toHaveLength(70);
      expect(wrapper.getState().messages[0].id).toBe("old");
      expect(wrapper.getState().messages.at(-1)!.id).toBe("newest");
      expect(inner.cursor.last).toBe(70);
    } finally { wrapper.close(); }
  });
});
