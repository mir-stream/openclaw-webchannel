// @vitest-environment jsdom
/**
 * DOM-environment tests for the P1-3 reasoning lane UI. They exercise the exact
 * render pass the widget performs — capture open ids, rebuild details, then
 * `replaceChildren()` — so the open-state-preservation path across a rebuild is
 * genuinely driven, not just the pure builder. XSS invariants reuse the
 * text-node-only guarantee proven in markdown.dom.test.ts.
 */
import { describe, it, expect } from "vitest";

import {
  orderConversationPresentation,
  captureOpenReasoningIds,
  buildReasoningDetails,
  buildToolActivityChip,
} from "./presentation.js";
import { renderMarkdown } from "./markdown.js";
import type { ChatMessage, ReasoningItem } from "../../../packages/client/src/types.js";

/**
 * Mirror the widget's reasoning render loop against `list`: snapshot which lanes
 * the user has expanded, rebuild every presentation item's `<details>`, then swap
 * the children in one `replaceChildren()`. Returns nothing — asserts read `list`.
 */
function renderInto(
  list: HTMLElement,
  messages: readonly ChatMessage[],
  reasoning: readonly ReasoningItem[],
): void {
  const openIds = captureOpenReasoningIds(list);
  const bubbles: HTMLElement[] = [];
  for (const presentation of orderConversationPresentation(messages, reasoning)) {
    if (presentation.kind === "reasoning") {
      const item = presentation.value;
      bubbles.push(buildReasoningDetails(item, renderMarkdown(item.text), openIds.has(item.id)));
    } else if (presentation.kind === "tool_activity") {
      bubbles.push(buildToolActivityChip(presentation.value));
    } else {
      const div = document.createElement("div");
      div.textContent = presentation.value.text;
      bubbles.push(div);
    }
  }
  list.replaceChildren(...bubbles);
}

const user = (id: string, turnId: string, text = "hi"): ChatMessage => ({
  id,
  role: "user",
  text,
  turnId,
});

describe("reasoning lane DOM", () => {
  it("renders a reasoning item as a collapsed <details data-reasoning-id> with sanitized markdown body", () => {
    const list = document.createElement("div");
    renderInto(
      list,
      [user("u1", "t1")],
      [{ id: "r1", turnId: "t1", text: "the **plan** is [ok](https://example.com)" }],
    );

    const details = list.querySelector<HTMLDetailsElement>("details[data-reasoning-id]");
    expect(details).not.toBeNull();
    expect(details!.dataset.reasoningId).toBe("r1");
    // Collapsed by default.
    expect(details!.open).toBe(false);
    // Neutral summary label, no live/done claim.
    expect(details!.querySelector("summary")!.textContent).toBe("Reasoning");
    // Markdown rendered to real DOM: bold + a hardened anchor.
    expect(details!.querySelector("strong")!.textContent).toBe("plan");
    const a = details!.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("preserves a user-opened lane across a rerender with updated text", () => {
    const list = document.createElement("div");
    renderInto(list, [user("u1", "t1")], [{ id: "r1", turnId: "t1", text: "step one" }]);

    // User expands the lane.
    const details = list.querySelector<HTMLDetailsElement>("details[data-reasoning-id]")!;
    expect(details.open).toBe(false);
    details.open = true;

    // A streaming update rerenders the transcript (new text, same id).
    renderInto(list, [user("u1", "t1")], [{ id: "r1", turnId: "t1", text: "step one, step two" }]);

    const rebuilt = list.querySelector<HTMLDetailsElement>("details[data-reasoning-id]")!;
    // It is a freshly-built node (rebuild happened) but stays expanded...
    expect(rebuilt).not.toBe(details);
    expect(rebuilt.open).toBe(true);
    // ...and shows the updated text.
    expect(rebuilt.textContent).toContain("step two");
  });

  it("renders no details element when there is no reasoning", () => {
    const list = document.createElement("div");
    renderInto(list, [user("u1", "t1")], []);
    expect(list.querySelector("details[data-reasoning-id]")).toBeNull();
  });

  it("#97 renders a tool-activity chip with name/status/arg KEYS and no arg values", () => {
    const chip = buildToolActivityChip({
      id: "tc1",
      turnId: "t1",
      name: "get_weather",
      status: "completed",
      argKeys: ["city", "days"],
    });
    expect(chip.dataset.toolActivityId).toBe("tc1");
    expect(chip.textContent).toContain("get_weather");
    expect(chip.textContent).toContain("completed");
    // Argument KEY names are shown...
    expect(chip.textContent).toContain("city");
    expect(chip.textContent).toContain("days");
    // ...but no arg VALUES can appear — they never reached the client.
    expect(chip.textContent).not.toContain("Paris");
  });

  it("#97 tool-activity chip is text-only DOM (no innerHTML injection from summary)", () => {
    const chip = buildToolActivityChip({
      id: "tc1",
      turnId: "t1",
      name: "bash",
      summary: "<img src=x onerror=alert(1)>",
    });
    // The summary lands as inert text, never a live element.
    expect(chip.querySelector("img")).toBeNull();
    expect(chip.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("yields inert DOM for hostile markdown/HTML in reasoning text (no script/onerror)", () => {
    const list = document.createElement("div");
    renderInto(
      list,
      [user("u1", "t1")],
      [
        {
          id: "r1",
          turnId: "t1",
          text: "<script>alert(1)</script><img src=x onerror=alert(1)> [x](javascript:alert(1))",
        },
      ],
    );

    const details = list.querySelector<HTMLDetailsElement>("details[data-reasoning-id]")!;
    // No live script or image element — content is only ever text nodes.
    expect(details.querySelector("script")).toBeNull();
    expect(details.querySelector("img")).toBeNull();
    // The javascript: URL is never turned into an anchor.
    expect(details.querySelector("a")).toBeNull();
    // The hostile source survives as inert visible text.
    expect(details.textContent).toContain("<script>alert(1)</script>");
    expect(details.textContent).toContain("onerror");
  });
});
