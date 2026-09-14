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
  };
  inner.client.getDifference = vi.fn();
  return { wrapper, inner, send: (m: InboundMessage) => inner.handleMessage(m) };
}

describe("#342 history row authority", () => {
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
      send({ type: "history", highWaterSeq: 8, messages: [{ id: "tail", role: "agent", text: "tail", seq: 8 }] });
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
