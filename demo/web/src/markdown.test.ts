/**
 * Pure-parser tests for the markdown renderer. These NEVER touch `document`
 * (the root vitest runs in node with no DOM), so they only exercise
 * `markdownToBlocks`, `parseInline`, and `isSafeUrl`, plus a source guard that
 * pins the no-HTML-injection invariant.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  markdownToBlocks,
  parseInline,
  isSafeUrl,
  MARKDOWN_RENDER_MAX_CHARS,
  type InlineNode,
  type MdBlock,
} from "./markdown.js";

const here = fileURLToPath(new URL(".", import.meta.url));

/** First block, asserted to be of `type`. */
function firstBlock(md: string): MdBlock {
  const blocks = markdownToBlocks(md);
  expect(blocks.length).toBeGreaterThan(0);
  return blocks[0];
}

describe("block parsing", () => {
  it("parses paragraphs with a hard break", () => {
    const b = firstBlock("hello\nworld");
    expect(b.type).toBe("paragraph");
    if (b.type !== "paragraph") return;
    expect(b.inline.map((n) => n.type)).toEqual(["text", "br", "text"]);
  });

  it("parses headings at every level", () => {
    for (let level = 1; level <= 6; level++) {
      const b = firstBlock("#".repeat(level) + " Title");
      expect(b.type).toBe("heading");
      if (b.type === "heading") {
        expect(b.level).toBe(level);
        expect(b.inline).toEqual([{ type: "text", value: "Title" }]);
      }
    }
  });

  it("parses a fenced code block with a language tag", () => {
    const b = firstBlock("```ts\nconst x = 1;\nconst y = 2;\n```");
    expect(b.type).toBe("code");
    if (b.type === "code") {
      expect(b.lang).toBe("ts");
      expect(b.value).toBe("const x = 1;\nconst y = 2;");
    }
  });

  it("parses unordered and ordered lists", () => {
    const ul = firstBlock("- a\n- b");
    expect(ul.type).toBe("list");
    if (ul.type === "list") {
      expect(ul.ordered).toBe(false);
      expect(ul.items.length).toBe(2);
    }
    const ol = firstBlock("1. a\n2. b");
    expect(ol.type).toBe("list");
    if (ol.type === "list") expect(ol.ordered).toBe(true);
  });

  it("nests a list one level via indentation", () => {
    const b = firstBlock("- top\n  - nested");
    expect(b.type).toBe("list");
    if (b.type !== "list") return;
    expect(b.items.length).toBe(1);
    expect(b.items[0].sublist?.items.length).toBe(1);
  });

  it("merges (does not drop) mixed-indent nested items", () => {
    // `- a` / 4-space `- b` / 2-space `- c` — both b and c nest under a.
    const b = firstBlock("- a\n    - b\n  - c");
    expect(b.type).toBe("list");
    if (b.type !== "list") return;
    expect(b.items.length).toBe(1);
    expect(b.items[0].sublist?.items.length).toBe(2);
  });

  it("does not silently lose an indented leading list line", () => {
    // No parent item precedes the indented lines — content must survive.
    const blocks = markdownToBlocks("    - b\n  - c");
    const total = blocks.reduce(
      (n, blk) => n + (blk.type === "list" ? blk.items.length : 0),
      0,
    );
    expect(total).toBe(2);
  });

  it("honours the start number of an ordered list", () => {
    const b = firstBlock("3. a\n4. b");
    expect(b.type).toBe("list");
    if (b.type === "list") {
      expect(b.ordered).toBe(true);
      expect(b.start).toBe(3);
    }
    const one = firstBlock("1. a");
    if (one.type === "list") expect(one.start).toBe(1);
  });

  it("parses a blockquote", () => {
    const b = firstBlock("> quoted line");
    expect(b.type).toBe("blockquote");
    if (b.type === "blockquote") expect(b.blocks[0].type).toBe("paragraph");
  });

  it("parses a GFM pipe table", () => {
    const b = firstBlock("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(b.type).toBe("table");
    if (b.type !== "table") return;
    expect(b.header.length).toBe(2);
    expect(b.rows.length).toBe(1);
    expect(b.rows[0].length).toBe(2);
  });

  it("parses a horizontal rule", () => {
    expect(firstBlock("---").type).toBe("hr");
    expect(firstBlock("***").type).toBe("hr");
  });

  it("returns no blocks for the empty string", () => {
    expect(markdownToBlocks("")).toEqual([]);
    expect(markdownToBlocks("   \n\n")).toEqual([]);
  });
});

describe("inline parsing", () => {
  it("parses bold, italic, strike, and inline code", () => {
    expect(parseInline("**b**")).toEqual([{ type: "strong", children: [{ type: "text", value: "b" }] }]);
    expect(parseInline("*i*")).toEqual([{ type: "em", children: [{ type: "text", value: "i" }] }]);
    expect(parseInline("_i_")).toEqual([{ type: "em", children: [{ type: "text", value: "i" }] }]);
    expect(parseInline("~~s~~")).toEqual([{ type: "strike", children: [{ type: "text", value: "s" }] }]);
    expect(parseInline("`c`")).toEqual([{ type: "code", value: "c" }]);
  });

  it("does not treat snake_case as emphasis", () => {
    expect(parseInline("a_b_c")).toEqual([{ type: "text", value: "a_b_c" }]);
  });

  it("parses __strong__ but leaves a__b__c literal", () => {
    expect(parseInline("__b__")).toEqual([{ type: "strong", children: [{ type: "text", value: "b" }] }]);
    expect(parseInline("a__b__c")).toEqual([{ type: "text", value: "a__b__c" }]);
  });

  it("parses bold containing inline code", () => {
    const nodes = parseInline("**bold `code`**");
    expect(nodes.length).toBe(1);
    expect(nodes[0].type).toBe("strong");
    if (nodes[0].type === "strong") {
      expect(nodes[0].children.map((n) => n.type)).toEqual(["text", "code"]);
    }
  });

  it("parses a link with a bold label", () => {
    const nodes = parseInline("[**x**](https://a.com)");
    expect(nodes.length).toBe(1);
    const link = nodes[0];
    expect(link.type).toBe("link");
    if (link.type !== "link") return;
    expect(link.url).toBe("https://a.com");
    expect(link.safe).toBe(true);
    expect(link.label[0].type).toBe("strong");
  });

  it("renders an image as a link node, never media", () => {
    const nodes = parseInline("![alt](https://a.com/x.png)");
    expect(nodes[0].type).toBe("link");
    if (nodes[0].type === "link") {
      expect(nodes[0].image).toBe(true);
      expect(nodes[0].label).toEqual([{ type: "text", value: "alt" }]);
    }
  });
});

describe("XSS safety by construction", () => {
  it("keeps injected HTML as a single literal text node", () => {
    for (const payload of ["<img src=x onerror=alert(1)>", "<script>alert(1)</script>"]) {
      const b = firstBlock(payload);
      expect(b.type).toBe("paragraph");
      if (b.type !== "paragraph") continue;
      expect(b.inline).toEqual([{ type: "text", value: payload }] satisfies InlineNode[]);
    }
  });

  it("rejects disallowed link schemes via the allowlist", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("data:text/html,<h1>x")).toBe(false);
    expect(isSafeUrl("//evil.example")).toBe(false);
    expect(isSafeUrl("/relative/path")).toBe(false);
    expect(isSafeUrl("http://ok.example")).toBe(true);
    expect(isSafeUrl("https://ok.example")).toBe(true);
    expect(isSafeUrl("mailto:a@b.com")).toBe(true);
  });

  it("marks a javascript: link as unsafe on the parsed node", () => {
    const nodes = parseInline("[click](javascript:alert(1))");
    const link = nodes.find((n) => n.type === "link");
    expect(link).toBeDefined();
    if (link && link.type === "link") expect(link.safe).toBe(false);
  });
});

describe("streaming tolerance", () => {
  it("treats an unclosed fence as a code block", () => {
    const b = firstBlock("```js\nlet a = 1");
    expect(b.type).toBe("code");
    if (b.type === "code") {
      expect(b.lang).toBe("js");
      expect(b.value).toBe("let a = 1");
    }
  });

  it("renders unterminated emphasis literally", () => {
    expect(parseInline("**bold")).toEqual([{ type: "text", value: "**bold" }]);
    expect(parseInline("`code")).toEqual([{ type: "text", value: "`code" }]);
  });

  it("falls back to paragraphs for a table with no separator row", () => {
    const blocks = markdownToBlocks("a | b\nc | d");
    expect(blocks.every((b) => b.type === "paragraph")).toBe(true);
  });
});

describe("render cap (O(n²) inline-scan guard)", () => {
  it("exposes the expected max-chars cap", () => {
    // renderMarkdown skips parsing above this; guards against the quadratic
    // inline scan re-freezing the UI on a huge/poisoned reply.
    expect(MARKDOWN_RENDER_MAX_CHARS).toBe(20_000);
  });
});

describe("no-HTML-injection source guard", () => {
  it("neither markdown.ts nor widget.ts uses HTML-string sinks", () => {
    for (const file of ["markdown.ts", "widget.ts"]) {
      const src = readFileSync(here + file, "utf8");
      // Match the sink as it would appear in code (a property/method access),
      // so the invariant is pinned without tripping on the doc comment that
      // names these APIs to say they are never used.
      expect(src).not.toMatch(/\.innerHTML\b/);
      expect(src).not.toMatch(/\.insertAdjacentHTML\b/);
      expect(src).not.toMatch(/\.outerHTML\b/);
      expect(src).not.toMatch(/\.setHTMLUnsafe\b/);
      expect(src).not.toMatch(/document\.write/); // document.write / document.writeln
      expect(src).not.toMatch(/\.createContextualFragment\b/);
    }
  });
});
