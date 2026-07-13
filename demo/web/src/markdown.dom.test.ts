// @vitest-environment jsdom
/**
 * DOM-environment tests for the markdown → DOM emitter. The pure parser is
 * covered by markdown.test.ts (node-env); these exercise `renderMarkdown`
 * itself, which the root node-env suite can't touch. The security-load-bearing
 * invariants live here: the `href` gate on links, and the by-construction XSS
 * safety of only ever emitting text nodes (never innerHTML) — so injected HTML
 * can never become a live element.
 */
import { describe, it, expect } from "vitest";
import { renderMarkdown, MARKDOWN_RENDER_MAX_CHARS } from "./markdown.js";

describe("renderMarkdown link href gate", () => {
  it("renders a safe https link as an anchor with an exact, hardened href", () => {
    const c = renderMarkdown("[ok](https://example.com/path?q=1)");
    const a = c.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("https://example.com/path?q=1");
    expect(a!.getAttribute("target")).toBe("_blank");
    expect(a!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a!.textContent).toBe("ok");
  });

  it("never emits an anchor for a javascript: URL — label + literal URL as text", () => {
    const c = renderMarkdown("[click](javascript:alert(1))");
    expect(c.querySelector("a")).toBeNull();
    // The label text survives; the disallowed URL is shown literally, not linked.
    expect(c.textContent).toContain("click");
    expect(c.textContent).toContain("javascript:alert(1)");
  });

  it("never emits an anchor for a data: URL", () => {
    const c = renderMarkdown("[d](data:text/html,<script>alert(1)</script>)");
    expect(c.querySelector("a")).toBeNull();
    expect(c.querySelector("script")).toBeNull();
    expect(c.textContent).toContain("data:text/html");
  });

  it("never emits an anchor for a protocol-relative // URL", () => {
    const c = renderMarkdown("[p](//evil.example.com/x)");
    expect(c.querySelector("a")).toBeNull();
    expect(c.textContent).toContain("//evil.example.com/x");
  });

  it("never emits an <img> media element for image syntax", () => {
    // A safe image URL becomes a plain anchor to the resource (never <img>
    // media); a disallowed-scheme image becomes inert text. Neither is media.
    const safe = renderMarkdown("![alt](https://example.com/x.png)");
    expect(safe.querySelector("img")).toBeNull();
    expect(safe.textContent).toContain("alt");

    const unsafe = renderMarkdown("![alt](javascript:alert(1))");
    expect(unsafe.querySelector("img")).toBeNull();
    expect(unsafe.querySelector("a")).toBeNull();
    expect(unsafe.textContent).toContain("javascript:alert(1)");
  });
});

describe("renderMarkdown XSS safety by construction", () => {
  it("renders injected HTML in text as inert literal text, not an element", () => {
    const c = renderMarkdown("look: <img src=x onerror=alert(1)> ok");
    expect(c.querySelector("img")).toBeNull();
    expect(c.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("keeps HTML inside a fenced code block inert inside <code>", () => {
    const c = renderMarkdown("```\n<script>alert(1)</script>\n```");
    // The injected markup is text content of a real <code>, never a live node.
    expect(c.querySelector("script")).toBeNull();
    const code = c.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("<script>alert(1)</script>");
  });

  it("keeps HTML inside inline code inert inside <code>", () => {
    const c = renderMarkdown("run `<b>x</b>` now");
    expect(c.querySelector("b")).toBeNull();
    const code = c.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("<b>x</b>");
  });
});

describe("renderMarkdown oversize guard", () => {
  it("falls back to plain text above the char cap — no parsing", () => {
    // One over the cap ⇒ the O(n²) inline-scan guard trips and we render the
    // raw text verbatim. Markdown markers stay literal (no <strong>).
    const big = "**bold** ".repeat(Math.ceil((MARKDOWN_RENDER_MAX_CHARS + 1) / 9));
    expect(big.length).toBeGreaterThan(MARKDOWN_RENDER_MAX_CHARS);
    const c = renderMarkdown(big);
    expect(c.querySelector("strong")).toBeNull();
    expect(c.textContent).toContain("**bold**");
  });

  it("still parses markdown at or below the cap", () => {
    const c = renderMarkdown("**bold**");
    const strong = c.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("bold");
  });
});
