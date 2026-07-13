/**
 * Zero-dependency markdown → DOM renderer for agent bubbles.
 *
 * Two layers, deliberately split so the parser is testable under the root
 * (node-env) vitest with no DOM:
 *   1. `markdownToBlocks` / `parseInline` — pure functions, no `document`.
 *   2. `renderMarkdown` — walks the block tree into real elements with
 *      `createElement` + text nodes ONLY. Content only ever becomes a text
 *      node, so injected HTML (`<img onerror=…>`, `<script>`) renders as inert
 *      literal text — XSS safety by construction, not by sanitizer allowlist.
 *      Never `innerHTML` / `insertAdjacentHTML` / `outerHTML` in this file.
 *
 * The core plugin-sdk IR (`markdownToIR`) would give cross-channel parity but
 * its transitive graph pulls `node:module` (createRequire) and won't bundle for
 * the browser — hence this standalone renderer. Feature set matches P1-1 in
 * docs/gaps/P1_RICH_UX_GAPS.md.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "br" }
  | { type: "code"; value: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "strike"; children: InlineNode[] }
  | { type: "link"; label: InlineNode[]; url: string; safe: boolean; image: boolean };

export type MdListItem = { inline: InlineNode[]; sublist?: MdList };
export type MdList = { ordered: boolean; items: MdListItem[]; start?: number };

export type MdBlock =
  | { type: "paragraph"; inline: InlineNode[] }
  | { type: "heading"; level: number; inline: InlineNode[] }
  | { type: "code"; lang: string; value: string }
  | ({ type: "list" } & MdList)
  | { type: "blockquote"; blocks: MdBlock[] }
  | { type: "table"; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: "hr" };

// ── Inline parser ─────────────────────────────────────────────────────────────

// Characters a leading `\` may escape into a literal.
const PUNCT = /[\\`*_{}\[\]()#+\-.!~>|]/;

/**
 * Only http/https/mailto are rendered as anchors. Everything else — relative,
 * protocol-relative `//`, `javascript:`, `data:` — is rejected and rendered as
 * plain text (see `parseLink` / the emitter). Exposed for testing.
 */
export function isSafeUrl(url: string): boolean {
  const u = url.trim();
  if (u.startsWith("//")) return false; // protocol-relative
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
  if (!m) return false; // no scheme ⇒ relative ⇒ not an anchor
  const scheme = m[1].toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto";
}

/** Find `marker` at/after `from`, skipping backslash-escaped chars. -1 if none. */
function findClose(text: string, from: number, marker: string): number {
  let i = from;
  while (i <= text.length - marker.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text.startsWith(marker, i)) return i;
    i++;
  }
  return -1;
}

/**
 * Find a closing underscore run of length `len` (`_` or `__`) at/after `from`
 * whose following char is a word boundary — so `snake_case` and `a__b__c` never
 * open emphasis/strong. -1 if none.
 */
function findUnderscoreClose(text: string, from: number, len: number): number {
  const marker = "_".repeat(len);
  let i = from;
  while (i <= text.length - len) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text.startsWith(marker, i)) {
      // `_` counts as a word char here, so an underscore run inside a word
      // (`a__b__c`) never satisfies the boundary and stays literal.
      const next = i + len < text.length ? text[i + len] : "";
      if (!/[A-Za-z0-9_]/.test(next)) return i;
    }
    i++;
  }
  return -1;
}

/** Parse `[label](url)` / `![alt](url)` starting at the `[` (index `start`). */
function parseLink(text: string, start: number, image: boolean): { node: InlineNode; end: number } | null {
  let depth = 0;
  let labelEnd = -1;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") { if (depth === 0) { labelEnd = i; break; } depth--; }
  }
  if (labelEnd === -1 || text[labelEnd + 1] !== "(") return null;
  const urlEnd = text.indexOf(")", labelEnd + 2);
  if (urlEnd === -1) return null;
  const url = text.slice(labelEnd + 2, urlEnd).trim();
  const labelText = text.slice(start + 1, labelEnd);
  // Image alt text is plain; link labels may carry nested inline markup.
  const label: InlineNode[] = image ? [{ type: "text", value: labelText }] : parseInline(labelText);
  return { node: { type: "link", label, url, safe: isSafeUrl(url), image }, end: urlEnd + 1 };
}

/**
 * Parse a run of inline markdown. Unterminated markers (`**bold`, `` `code ``)
 * degrade to their literal text rather than swallowing the rest of the line.
 */
export function parseInline(text: string): InlineNode[] {
  const out: InlineNode[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push({ type: "text", value: buf }); buf = ""; } };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") { flush(); out.push({ type: "br" }); i++; continue; } // chat-style hard break
    if (c === "\\" && i + 1 < text.length && PUNCT.test(text[i + 1])) { buf += text[i + 1]; i += 2; continue; }
    if (c === "`") {
      const close = text.indexOf("`", i + 1);
      if (close !== -1) { flush(); out.push({ type: "code", value: text.slice(i + 1, close) }); i = close + 1; continue; }
    }
    if (c === "!" && text[i + 1] === "[") {
      const link = parseLink(text, i + 1, true);
      if (link) { flush(); out.push(link.node); i = link.end; continue; }
    }
    if (c === "[") {
      const link = parseLink(text, i, false);
      if (link) { flush(); out.push(link.node); i = link.end; continue; }
    }
    if ((c === "*" && text[i + 1] === "*") || (c === "~" && text[i + 1] === "~")) {
      const marker = c + c;
      const close = findClose(text, i + 2, marker);
      if (close !== -1) {
        flush();
        out.push({ type: c === "*" ? "strong" : "strike", children: parseInline(text.slice(i + 2, close)) });
        i = close + 2; continue;
      }
    }
    // `__strong__` (GFM) — needs the same word-boundary guards as `_em_` so
    // `a__b__c` stays literal. Checked before the single-`_` branch.
    if (c === "_" && text[i + 1] === "_") {
      const prev = i > 0 ? text[i - 1] : "";
      if (!/[A-Za-z0-9_]/.test(prev)) {
        const close = findUnderscoreClose(text, i + 2, 2);
        if (close > i + 2) {
          flush();
          out.push({ type: "strong", children: parseInline(text.slice(i + 2, close)) });
          i = close + 2; continue;
        }
      }
    }
    if (c === "*") {
      const close = findClose(text, i + 1, "*");
      if (close > i + 1) {
        flush();
        out.push({ type: "em", children: parseInline(text.slice(i + 1, close)) });
        i = close + 1; continue;
      }
    }
    if (c === "_") {
      const prev = i > 0 ? text[i - 1] : "";
      if (!/[A-Za-z0-9_]/.test(prev)) {
        const close = findUnderscoreClose(text, i + 1, 1);
        if (close > i + 1) {
          flush();
          out.push({ type: "em", children: parseInline(text.slice(i + 1, close)) });
          i = close + 1; continue;
        }
      }
    }
    buf += c; i++;
  }
  flush();
  return out;
}

// ── Block parser ──────────────────────────────────────────────────────────────

const RE_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_FENCE = /^ {0,3}(`{3,})(.*)$/;
const RE_FENCE_CLOSE = /^ {0,3}`{3,}\s*$/;
const RE_HR = /^ {0,3}([-*_])( *\1){2,} *$/;

function matchListItem(line: string): { ordered: boolean; indent: number; content: string; start?: number } | null {
  const u = /^(\s*)[-*]\s+(.*)$/.exec(line);
  if (u) return { ordered: false, indent: u[1].replace(/\t/g, "  ").length, content: u[2] };
  const o = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line);
  if (o) return { ordered: true, indent: o[1].replace(/\t/g, "  ").length, content: o[3], start: Number(o[2]) };
  return null;
}

/** Split a table row into trimmed cells, honouring `\|` escapes and outer pipes. */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) { cur += s[i + 1]; i++; continue; }
    if (s[i] === "|") { cells.push(cur); cur = ""; continue; }
    cur += s[i];
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** A `--- | :--: | ---` separator: every cell is dashes with optional colons. */
function isTableSep(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function isBlockBreak(line: string, next: string | undefined): boolean {
  return (
    line.trim() === "" ||
    RE_HEADING.test(line) ||
    RE_FENCE.test(line) ||
    RE_HR.test(line) ||
    matchListItem(line) !== null ||
    line.trimStart().startsWith(">") ||
    (line.includes("|") && next !== undefined && isTableSep(next))
  );
}

/** Parse one list (siblings at `baseIndent`); deeper items attach as a sublist. */
function parseList(lines: string[], start: number): [MdList, number] {
  const first = matchListItem(lines[start])!;
  const ordered = first.ordered;
  const baseIndent = first.indent;
  const items: MdListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const m = matchListItem(lines[i]);
    if (!m) break;
    if (m.indent >= baseIndent + 2) {
      const [sub, next] = parseList(lines, i); // one level of nesting
      if (items.length) {
        // Mixed-indent runs (`- a` / `····- b` / `··- c`) hit this branch more
        // than once for the same parent — merge, don't overwrite (which dropped
        // the earlier nested items).
        const last = items[items.length - 1];
        if (last.sublist) last.sublist.items.push(...sub.items);
        else last.sublist = sub;
      } else {
        // Defensive hoist — unreachable today (iteration 1 defines baseIndent
        // from the same line, so its indent can't exceed baseIndent), kept so
        // a future baseIndent change can't silently drop leading items.
        items.push(...sub.items);
      }
      i = next;
      continue;
    }
    if (m.indent < baseIndent) break; // dedent belongs to an outer list
    items.push({ inline: parseInline(m.content) });
    i++;
  }
  return [{ ordered, items, start: first.start }, i];
}

/**
 * Parse markdown into a block tree. Pure — never touches the DOM. Note it can
 * still throw a RangeError on pathologically deep blockquote/list nesting
 * (recursive descent overflows the stack); that is contained by the only
 * runtime caller, `renderMarkdown`, via its try/catch fallback.
 */
export function markdownToBlocks(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { i++; continue; }

    // Fenced code — an unclosed fence at EOF still yields a code block.
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const lang = fence[2].trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !RE_FENCE_CLOSE.test(lines[i])) { body.push(lines[i]); i++; }
      if (i < lines.length) i++; // consume closing fence
      blocks.push({ type: "code", lang, value: body.join("\n") });
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, inline: parseInline(heading[2]) });
      i++;
      continue;
    }

    // Pipe table: a row with a `|` immediately followed by a separator row.
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitTableRow(line);
      const sep = splitTableRow(lines[i + 1]);
      if (header.length === sep.length) {
        const rows: InlineNode[][][] = [];
        let j = i + 2;
        while (j < lines.length && lines[j].trim() !== "" && lines[j].includes("|")) {
          const cells = splitTableRow(lines[j]);
          const row: InlineNode[][] = [];
          for (let c = 0; c < header.length; c++) row.push(parseInline(cells[c] ?? ""));
          rows.push(row);
          j++;
        }
        blocks.push({ type: "table", header: header.map((h) => parseInline(h)), rows });
        i = j;
        continue;
      }
    }

    // Blockquote — strip one `> ` from each line, recurse on the remainder.
    if (line.trimStart().startsWith(">")) {
      const inner: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        inner.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", blocks: markdownToBlocks(inner.join("\n")) });
      continue;
    }

    if (RE_HR.test(line)) { blocks.push({ type: "hr" }); i++; continue; }

    if (matchListItem(line)) {
      const [list, next] = parseList(lines, i);
      blocks.push({ type: "list", ...list });
      i = next;
      continue;
    }

    // Paragraph: gather until a blank line or the start of another block.
    const para: string[] = [line];
    i++;
    while (i < lines.length && !isBlockBreak(lines[i], lines[i + 1])) { para.push(lines[i]); i++; }
    blocks.push({ type: "paragraph", inline: parseInline(para.join("\n")) });
  }
  return blocks;
}

// ── DOM emitter ───────────────────────────────────────────────────────────────

function inlineCode(value: string): HTMLElement {
  const e = document.createElement("code");
  e.style.cssText =
    "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;" +
    "background:rgba(0,0,0,.25);border:1px solid var(--border);border-radius:4px;padding:0 4px";
  e.textContent = value;
  return e;
}

function renderInline(nodes: InlineNode[]): Node[] {
  const out: Node[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case "text": out.push(document.createTextNode(n.value)); break;
      case "br": out.push(document.createElement("br")); break;
      case "code": out.push(inlineCode(n.value)); break;
      case "strong": { const e = document.createElement("strong"); e.append(...renderInline(n.children)); out.push(e); break; }
      case "em": { const e = document.createElement("em"); e.append(...renderInline(n.children)); out.push(e); break; }
      case "strike": { const e = document.createElement("s"); e.append(...renderInline(n.children)); out.push(e); break; }
      case "link": {
        if (n.safe) {
          const a = document.createElement("a");
          a.setAttribute("href", n.url);
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener noreferrer");
          a.style.color = "var(--accent)";
          a.append(...renderInline(n.label));
          out.push(a);
        } else {
          // Disallowed scheme (or an image, which we never render as media):
          // fall back to the label followed by the literal URL, no anchor.
          out.push(...renderInline(n.label));
          out.push(document.createTextNode(` ${n.url}`));
        }
        break;
      }
    }
  }
  return out;
}

const HEADING_SIZE = ["17px", "16px", "15px", "14px", "13px", "13px"];

function renderCodeBlock(lang: string, value: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:relative";
  const pre = document.createElement("pre");
  pre.style.cssText =
    "margin:0;padding:8px 10px;background:rgba(0,0,0,.25);border:1px solid var(--border);" +
    "border-radius:6px;overflow-x:auto";
  const code = document.createElement("code");
  code.style.cssText = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre";
  code.textContent = value;
  if (lang) code.setAttribute("data-lang", lang); // syntax highlighting is out of scope; keep the tag
  pre.append(code);
  const copy = document.createElement("button");
  copy.textContent = "copy";
  copy.style.cssText =
    "position:absolute;top:6px;right:6px;font-size:10px;padding:2px 6px;" +
    "border:1px solid var(--border);border-radius:4px;background:#21262d;color:var(--muted);cursor:pointer";
  copy.onclick = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      copy.textContent = "copied";
      setTimeout(() => { copy.textContent = "copy"; }, 1500);
    }).catch(() => { /* clipboard denied — leave the label as-is */ });
  };
  wrap.append(pre, copy);
  return wrap;
}

function renderList(list: MdList): HTMLElement {
  const el = document.createElement(list.ordered ? "ol" : "ul");
  if (list.ordered && list.start !== undefined && list.start !== 1) {
    el.setAttribute("start", String(list.start)); // honour `3. …` start numbers
  }
  el.style.cssText = "margin:2px 0;padding-left:20px;display:flex;flex-direction:column;gap:2px";
  for (const item of list.items) {
    const li = document.createElement("li");
    li.append(...renderInline(item.inline));
    if (item.sublist) li.append(renderList(item.sublist));
    el.append(li);
  }
  return el;
}

function renderTable(header: InlineNode[][], rows: InlineNode[][][]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = "overflow-x:auto"; // wide tables scroll inside the bubble
  const table = document.createElement("table");
  table.style.cssText = "border-collapse:collapse;font-size:12px";
  const cellStyle = "border:1px solid var(--border);padding:4px 8px;text-align:left";
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const cell of header) {
    const th = document.createElement("th");
    th.style.cssText = cellStyle + ";font-weight:600";
    th.append(...renderInline(cell));
    htr.append(th);
  }
  thead.append(htr);
  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      td.style.cssText = cellStyle;
      td.append(...renderInline(cell));
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function renderBlock(b: MdBlock): HTMLElement {
  switch (b.type) {
    case "paragraph": {
      const p = document.createElement("div");
      p.style.cssText = "line-height:1.5";
      p.append(...renderInline(b.inline));
      return p;
    }
    case "heading": {
      const h = document.createElement("div");
      h.style.cssText = `font-weight:600;font-size:${HEADING_SIZE[b.level - 1]};margin:2px 0`;
      h.append(...renderInline(b.inline));
      return h;
    }
    case "code": return renderCodeBlock(b.lang, b.value);
    case "list": return renderList(b);
    case "blockquote": {
      const q = document.createElement("div");
      q.style.cssText =
        "border-left:3px solid var(--border);padding-left:10px;color:var(--muted);" +
        "display:flex;flex-direction:column;gap:6px";
      for (const bb of b.blocks) q.append(renderBlock(bb));
      return q;
    }
    case "table": return renderTable(b.header, b.rows);
    case "hr": {
      const hr = document.createElement("hr");
      hr.style.cssText = "border:none;border-top:1px solid var(--border);margin:4px 0";
      return hr;
    }
  }
}

/**
 * Above this many characters, skip markdown parsing and render plain text.
 * The inline scanner is worst-case O(n²) — each unmatched `[` (parseLink) and
 * space-separated `_` run (findUnderscoreClose) re-scans to end-of-text. The
 * widget memoizes rendered bubbles by message text, so a settled reply parses
 * once; but a live `working` reply grows on every streaming partial, so a single
 * huge/poisoned draft re-parses on each partial (a cache miss per growth) and
 * would re-freeze the UI while it streams. Quadratic inputs don't
 * throw (the try/catch below only catches deep-nesting RangeErrors), so this
 * cap is the only guard against them.
 */
export const MARKDOWN_RENDER_MAX_CHARS = 20_000;

function plainFallback(text: string): HTMLElement {
  const fallback = document.createElement("div");
  fallback.style.cssText = "white-space:pre-wrap";
  fallback.textContent = text;
  return fallback;
}

/**
 * Render markdown `text` to a detached element for an agent bubble. Tolerates
 * partial/streaming input; any unexpected failure degrades to a plain
 * pre-wrap text node rather than crashing the caller's `render()`.
 */
export function renderMarkdown(text: string): HTMLElement {
  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;gap:6px";
  // O(n²) inline-scan guard — see MARKDOWN_RENDER_MAX_CHARS.
  if (text.length > MARKDOWN_RENDER_MAX_CHARS) {
    container.append(plainFallback(text));
    return container;
  }
  try {
    for (const block of markdownToBlocks(text)) container.append(renderBlock(block));
  } catch {
    container.replaceChildren();
    container.append(plainFallback(text));
  }
  return container;
}
