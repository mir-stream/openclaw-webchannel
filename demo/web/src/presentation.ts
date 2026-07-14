import type { ChatMessage, ReasoningItem } from "../../../packages/client/src/types.js";

export type ConversationPresentationItem =
  | { kind: "message"; value: ChatMessage }
  | { kind: "reasoning"; value: ReasoningItem };

/** Place ephemeral reasoning after its user anchor and before its turn answer. */
export function orderConversationPresentation(
  messages: readonly ChatMessage[],
  reasoning: readonly ReasoningItem[],
): ConversationPresentationItem[] {
  const byTurn = new Map<string, ReasoningItem[]>();
  for (const item of reasoning) {
    const items = byTurn.get(item.turnId) ?? [];
    items.push(item);
    byTurn.set(item.turnId, items);
  }
  const emitted = new Set<string>();
  const result: ConversationPresentationItem[] = [];
  const emitReasoning = (turnId: string): void => {
    if (emitted.has(turnId)) return;
    const items = byTurn.get(turnId);
    if (!items) return;
    emitted.add(turnId);
    result.push(...items.map((value) => ({ kind: "reasoning" as const, value })));
  };

  for (const message of messages) {
    if (message.role === "agent" && message.turnId) emitReasoning(message.turnId);
    result.push({ kind: "message", value: message });
    if (message.role === "user" && message.turnId) emitReasoning(message.turnId);
  }
  for (const turnId of byTurn.keys()) emitReasoning(turnId);
  return result;
}
