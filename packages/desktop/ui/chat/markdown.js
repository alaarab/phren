import { el as h } from "../dom.js";
// A small, safe Markdown renderer for the chat transcript. `parseMarkdown`
// is pure and returns a node-description tree (no DOM), so it runs under Node
// in src/ui-markdown.test.ts; the render helpers below build DOM nodes from it
// and never assign innerHTML, so transcript text can never inject markup.
//
// It reads what agents write: paragraphs, headings, nested and numbered lists,
// task lists, quotes, rules, fenced code, pipe tables, and inline code, links
// (written or bare), bold, italic and strikethrough. `{ partial: true }` is for a
// reply still arriving: an emphasis or code span whose end has not come yet is
// drawn as if it had, so its markers never show and then vanish.

/** @typedef {{ type: "text", text: string }} MdText
 *  @typedef {{ type: "code", text: string }} MdCode
 *  @typedef {{ type: "strong", children: MdInline[] }} MdStrong
 *  @typedef {{ type: "em", children: MdInline[] }} MdEm
 *  @typedef {{ type: "del", children: MdInline[] }} MdDel
 *  @typedef {{ type: "link", href: string, children: MdInline[] }} MdLink
 *  @typedef {MdText | MdCode | MdStrong | MdEm | MdDel | MdLink} MdInline
 *  @typedef {{ type: "paragraph", children: MdInline[] }} MdParagraph
 *  @typedef {{ type: "heading", level: number, children: MdInline[] }} MdHeading
 *  @typedef {{ type: "list", ordered: boolean, start: number, items: MdInline[][], nested: MdNode[][], checked: (boolean | null)[] }} MdList
 *  @typedef {{ type: "code", language: string | null, text: string }} MdFence
 *  @typedef {{ type: "table", header: MdInline[][], rows: MdInline[][][] }} MdTable
 *  @typedef {{ type: "quote", children: MdNode[] }} MdQuote
 *  @typedef {{ type: "rule" }} MdRule
 *  @typedef {MdParagraph | MdHeading | MdList | MdFence | MdTable | MdQuote | MdRule} MdNode */

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const TASK = /^\[([ xX])\][ \t]+/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

// Lists in lists and quotes in quotes stop nesting here; deeper text is read as paragraphs.
const MAX_BLOCK_DEPTH = 6;
const MAX_INLINE_DEPTH = 6;
// How far a link's text and target may run, so a page of stray brackets stays linear to read.
const LINK_TEXT_LIMIT = 600;
const LINK_TARGET_LIMIT = 2000;
// An unfinished span in a reply still arriving is drawn as finished only this close to the end:
// a stray marker further back is a literal character, not the start of a span.
const PARTIAL_SPAN_LIMIT = 120;

const isSpace = (ch) => ch === " " || ch === "\t" || ch === "\n";
const isWord = (ch) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/** Columns of leading whitespace, a tab counting as four. */
function indentOf(line) {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4;
    else break;
  }
  return width;
}

/** `line` without up to `columns` columns of leading whitespace. */
function dedent(line, columns) {
  let width = 0;
  let i = 0;
  while (i < line.length && width < columns) {
    if (line[i] === " ") width += 1;
    else if (line[i] === "\t") width += 4;
    else break;
    i++;
  }
  return line.slice(i);
}

/** Split a table row on pipes, dropping the empty leading/trailing cells. */
function tableCells(line) {
  let cells = line.trim().split("|");
  if (cells.length && cells[0].trim() === "") cells = cells.slice(1);
  if (cells.length && cells[cells.length - 1].trim() === "") cells = cells.slice(0, -1);
  return cells.map((cell) => cell.trim());
}

/** The index of the run of exactly `length` backticks after `from`, or -1. */
function closingTicks(text, from, length) {
  let i = text.indexOf("`", from);
  while (i >= 0) {
    let end = i;
    while (text[end] === "`") end++;
    if (end - i === length) return i;
    i = text.indexOf("`", end);
  }
  return -1;
}

/** Where a `**` or `~~` span opened at `start` closes, or -1. A closer follows a non-space. */
function doubleEnd(text, start, marker) {
  let i = text.indexOf(marker, start + 2);
  while (i >= 0) {
    if (i > start + 2 && !isSpace(text[i - 1])) {
      // "***both***": the closer is the last pair of the run, so the inner `*` stays inside.
      while (text[i + 2] === marker[0] && text[i + 1] === marker[0] && text[i + 3] !== marker[0]) i++;
      return i;
    }
    i = text.indexOf(marker, i + 1);
  }
  return -1;
}

/** Where a single `*` or `_` emphasis run opened at `start` ends, or -1 when it does not. */
function emphasisEnd(text, start, marker) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== marker) continue;
    if (text[i + 1] === marker) { i++; continue; }
    // A closer sits against the text it ends and is not inside a word.
    if (i === start + 1 || isSpace(text[i - 1]) || isWord(text[i + 1])) continue;
    return i;
  }
  return -1;
}

/** The matching `]` for the `[` at `start`, or -1 within LINK_TEXT_LIMIT characters. */
function bracketEnd(text, start) {
  let depth = 0;
  const limit = Math.min(text.length, start + LINK_TEXT_LIMIT);
  for (let i = start; i < limit; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** The `)` closing a link target opened at `start` (the `(`), allowing balanced parentheses inside; -1 when it does not close. */
function targetEnd(text, start) {
  let depth = 0;
  const limit = Math.min(text.length, start + LINK_TARGET_LIMIT);
  for (let i = start; i < limit; i++) {
    const ch = text[i];
    if (ch === "\n") return -1;
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** A link target without its optional `"title"` and angle brackets. */
function linkHref(raw) {
  let href = raw.trim();
  const title = /^(\S+)\s+["'(].*["')]$/.exec(href);
  if (title) href = title[1];
  if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1);
  return href;
}

// A bare URL is read this far at most.
const URL_LIMIT = 2000;

/** The end of a bare URL starting at `start`: up to whitespace, without sentence punctuation or a bracket it never opened. */
function urlEnd(text, start) {
  let end = start;
  const limit = Math.min(text.length, start + URL_LIMIT);
  const open = { ")": 0, "]": 0 };
  const closed = { ")": 0, "]": 0 };
  while (end < limit && !/[\s<>`"]/.test(text[end])) {
    const ch = text[end];
    if (ch === "(") open[")"]++; else if (ch === "[") open["]"]++;
    else if (ch === ")" || ch === "]") closed[ch]++;
    end++;
  }
  for (;;) {
    const last = text[end - 1];
    if (/[.,;:!?'*_~]/.test(last)) { end--; continue; }
    if ((last === ")" || last === "]") && closed[last] > open[last]) { closed[last]--; end--; continue; }
    break;
  }
  return end;
}

/** Inline spans: code, links, bold, italic, strikethrough; all else is literal text. */
export function parseInline(text, options = {}) {
  return inline(String(text ?? ""), options.partial === true, 0);
}

function inline(text, partial, depth) {
  /** @type {MdInline[]} */ const out = [];
  let buffer = "";
  const flush = () => { if (buffer) { out.push({ type: "text", text: buffer }); buffer = ""; } };
  const nest = (inner) => (depth >= MAX_INLINE_DEPTH ? [{ type: "text", text: inner }] : inline(inner, partial, depth + 1));
  // A marker with nothing after it in this text never closes, so later ones are not searched again.
  const dead = new Set();
  // In a partial reply, a span left open near the end is drawn as closed.
  const openTail = (from) => partial && from < text.length && text.length - from <= PARTIAL_SPAN_LIMIT && !text.includes("\n", from);
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "\\" && next !== undefined && ESCAPABLE.test(next)) { buffer += next; i += 2; continue; }
    if (ch === "`") {
      let run = i;
      while (text[run] === "`") run++;
      const length = run - i;
      const key = "`" + length;
      const end = dead.has(key) ? -1 : closingTicks(text, run, length);
      if (end >= 0) {
        let code = text.slice(run, end);
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        flush(); out.push({ type: "code", text: code }); i = end + length; continue;
      }
      dead.add(key);
      if (partial && run === text.length) { i = run; continue; } // the opener just arrived
      // The first ticks of a longer closing run are not part of the code.
      if (openTail(run)) { flush(); out.push({ type: "code", text: text.slice(run).replace(/`+$/, "") }); i = text.length; continue; }
      buffer += text.slice(i, run); i = run; continue;
    }
    if (ch === "[" || (ch === "!" && next === "[")) {
      const open = ch === "!" ? i + 1 : i;
      const close = dead.has("[") ? -1 : bracketEnd(text, open);
      if (close < 0 && text.indexOf("](", open) < 0) dead.add("[");
      if (close >= 0 && text[close + 1] === "(") {
        const end = targetEnd(text, close + 1);
        const label = text.slice(open + 1, close);
        if (end >= 0) {
          flush();
          out.push({ type: "link", href: linkHref(text.slice(close + 2, end)), children: nest(label || "image") });
          i = end + 1; continue;
        }
        // The target is still arriving: show the words, not the brackets and half an address.
        if (partial && !text.includes("\n", close)) { flush(); out.push(...nest(label)); i = text.length; continue; }
      }
    } else if (ch === "<" && (text.startsWith("http://", i + 1) || text.startsWith("https://", i + 1))) {
      const end = text.indexOf(">", i + 1);
      const href = end > 0 ? text.slice(i + 1, end) : "";
      if (href && !/\s/.test(href)) { flush(); out.push({ type: "link", href, children: [{ type: "text", text: href }] }); i = end + 1; continue; }
    } else if (ch === "h" && (text.startsWith("http://", i) || text.startsWith("https://", i)) && !isWord(text[i - 1])) {
      const end = urlEnd(text, i);
      const href = text.slice(i, end);
      if (href.length > href.indexOf("://") + 3) { flush(); out.push({ type: "link", href, children: [{ type: "text", text: href }] }); i = end; continue; }
    } else if ((ch === "*" || ch === "~") && next === ch) {
      // `__name__` stays as written: in a coding chat it is a Python name far more often than bold.
      const marker = ch + ch;
      const opens = text[i + 2] !== undefined && !isSpace(text[i + 2]);
      if (partial && i + 2 === text.length) { i += 2; continue; } // the opener just arrived
      if (opens) {
        const end = dead.has(marker) ? -1 : doubleEnd(text, i, marker);
        const type = ch === "~" ? "del" : "strong";
        if (end >= 0) { flush(); out.push({ type, children: nest(text.slice(i + 2, end)) }); i = end + 2; continue; }
        dead.add(marker);
        // The first character of the closing pair is not part of the span.
        if (openTail(i + 2)) { flush(); out.push({ type, children: nest(text.slice(i + 2, text.endsWith(ch) ? -1 : undefined)) }); i = text.length; continue; }
      }
      buffer += marker; i += 2; continue;
    } else if (ch === "*" || ch === "_") {
      const opens = next !== undefined && !isSpace(next) && !isWord(text[i - 1]);
      if (partial && i + 1 === text.length && !isWord(text[i - 1])) { i += 1; continue; } // the opener just arrived
      if (opens) {
        const end = dead.has(ch) ? -1 : emphasisEnd(text, i, ch);
        if (end >= 0) { flush(); out.push({ type: "em", children: nest(text.slice(i + 1, end)) }); i = end + 1; continue; }
        dead.add(ch);
        if (openTail(i + 1)) { flush(); out.push({ type: "em", children: nest(text.slice(i + 1)) }); i = text.length; continue; }
      }
    }
    buffer += ch;
    i++;
  }
  flush();
  return out;
}

/** Whether `line` begins something other than paragraph text. */
function startsBlock(line, nextLine) {
  return FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || RULE.test(line)
    || (line.trim().startsWith("|") && nextLine !== undefined && TABLE_DIVIDER.test(nextLine));
}

/** Markdown into a block tree: paragraphs, headings, lists, quotes, rules, fenced code, tables. */
export function parseMarkdown(text, options = {}) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  return blocks(lines, options.partial === true, 0);
}

function blocks(lines, partial, depth) {
  /** @type {MdNode[]} */ const nodes = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const body = paragraph.join("\n").replace(/^\s+|\s+$/g, "");
    paragraph = [];
    // Only the reply's last paragraph can still be arriving.
    if (body) nodes.push({ type: "paragraph", children: inline(body, partial && atEnd, 0) });
  };
  let atEnd = false;
  const nestable = depth < MAX_BLOCK_DEPTH;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    atEnd = i === lines.length - 1;
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[2];
      const indent = indentOf(fence[1]);
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const close = FENCE.exec(lines[j]);
        if (close && close[2][0] === marker[0] && close[2].length >= marker.length && close[3].trim() === "") break;
        body.push(dedent(lines[j], indent));
      }
      nodes.push({ type: "code", language: fence[3].trim().split(/\s+/)[0] || null, text: body.join("\n") });
      i = j;
      continue;
    }
    if (line.trim() === "") { flushParagraph(); continue; }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      nodes.push({ type: "heading", level: heading[1].length, children: inline(heading[2].replace(/\s+#+\s*$/, ""), partial && atEnd, 0) });
      continue;
    }
    if (RULE.test(line)) { flushParagraph(); nodes.push({ type: "rule" }); continue; }
    if (nestable && QUOTE.test(line)) {
      flushParagraph();
      const inner = [];
      let j = i;
      for (; j < lines.length; j++) {
        const quoted = QUOTE.exec(lines[j]);
        if (!quoted) break;
        inner.push(quoted[1]);
      }
      nodes.push({ type: "quote", children: blocks(inner, partial && j === lines.length, depth + 1) });
      i = j - 1;
      continue;
    }
    // A table needs a header row followed by its `---` divider.
    if (line.trim().startsWith("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      flushParagraph();
      const header = tableCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { rows.push(tableCells(lines[i])); i++; }
      i--;
      const width = Math.max(header.length, ...rows.map((r) => r.length), 0);
      const pad = (cells) => cells.concat(Array(Math.max(0, width - cells.length)).fill(""));
      const cell = (value) => inline(value, false, 0);
      nodes.push({ type: "table", header: pad(header).map(cell), rows: rows.map((r) => pad(r).map(cell)) });
      continue;
    }
    if (nestable && LIST_ITEM.test(line)) {
      flushParagraph();
      const read = list(lines, i, partial, depth);
      nodes.push(read.node);
      i = read.next - 1;
      continue;
    }
    paragraph.push(line);
  }
  atEnd = true;
  flushParagraph();
  return nodes;
}

/** The list starting at `lines[start]`: its items, what is nested under each, and the line after it. */
function list(lines, start, partial, depth) {
  const first = LIST_ITEM.exec(lines[start]);
  const base = indentOf(first[1]);
  const ordered = /\d/.test(first[2][0]);
  /** @type {MdList} */
  const node = { type: "list", ordered, start: ordered ? Number.parseInt(first[2], 10) : 1, items: [], nested: [], checked: [] };
  // A line this far in belongs to the item above it rather than starting a new one.
  const inside = (line) => indentOf(line) >= base + 2;
  let i = start;
  while (i < lines.length) {
    const item = LIST_ITEM.exec(lines[i]);
    if (!item || inside(lines[i]) || /\d/.test(item[2][0]) !== ordered) break;
    // The column the item's text starts at: what is nested under it is indented to here.
    const contentIndent = indentOf(item[1]) + (lines[i].length - item[3].length - item[1].length);
    const body = [item[3]];
    let j = i + 1;
    while (j < lines.length) {
      if (lines[j].trim() === "") {
        let k = j;
        while (k < lines.length && lines[k].trim() === "") k++;
        // Blank lines stay in the item only when what follows them is indented under it.
        if (k < lines.length && inside(lines[k])) { for (; j < k; j++) body.push(""); continue; }
        break;
      }
      if (!inside(lines[j])) break;
      body.push(dedent(lines[j], contentIndent));
      j++;
    }
    let head = 1;
    while (head < body.length && body[head].trim() !== "" && !startsBlock(body[head], body[head + 1])) head++;
    let textLines = body.slice(0, head);
    const task = TASK.exec(textLines[0]);
    if (task) textLines = [textLines[0].slice(task[0].length), ...textLines.slice(1)];
    const rest = body.slice(head);
    const ends = j === lines.length;
    node.items.push(inline(textLines.join("\n").trim(), partial && ends && rest.length === 0, 0));
    node.nested.push(rest.some((l) => l.trim() !== "") ? blocks(rest, partial && ends, depth + 1) : []);
    node.checked.push(task ? task[1] !== " " : null);
    // Blank lines between items keep one list; anything else after them ends it.
    let k = j;
    while (k < lines.length && lines[k].trim() === "") k++;
    const sibling = k < lines.length ? LIST_ITEM.exec(lines[k]) : null;
    i = k > j && sibling && !inside(lines[k]) && /\d/.test(sibling[2][0]) === ordered ? k : j;
    if (i === j && k > j) break;
  }
  return { node, next: i };
}

const SAFE_HREF = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;

function inlineNodes(nodes, out) {
  for (const node of nodes) {
    if (node.type === "text") out.append(document.createTextNode(node.text));
    else if (node.type === "code") out.append(h("code", "ct-md-code", node.text));
    else if (node.type === "strong" || node.type === "em" || node.type === "del") { const el = h(node.type); inlineNodes(node.children, el); out.append(el); }
    else if (node.type === "link") {
      const el = h("a", "ct-md-link");
      const href = SAFE_HREF.test(node.href) ? node.href : "#";
      el.href = href;
      el.rel = "noopener noreferrer";
      el.addEventListener("click", (event) => { event.preventDefault(); window.open(href, "_blank", "noopener,noreferrer"); });
      inlineNodes(node.children, el);
      out.append(el);
    }
  }
  return out;
}

function inlineFragment(nodes) {
  return inlineNodes(nodes, document.createDocumentFragment());
}

function codeBlock(node) {
  const figure = h("figure", "ct-md-pre");
  const bar = h("div", "ct-md-pre-bar");
  bar.append(h("span", "ct-md-lang", node.language || "code"));
  const copy = h("button", "ct-md-copy", "Copy");
  copy.type = "button";
  const pre = h("pre");
  const code = h("code", null, node.text);
  copy.addEventListener("click", () => {
    // Read at the click: a block still arriving has grown since it was drawn.
    const value = code.textContent;
    const done = () => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1200); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(value).then(done, done);
    else done();
  });
  bar.append(copy);
  figure.append(bar);
  pre.append(code);
  figure.append(pre);
  return figure;
}

function tableBlock(node) {
  const wrap = h("div", "ct-md-table-wrap");
  const table = h("table", "ct-md-table");
  const head = h("thead");
  const headRow = h("tr");
  for (const cell of node.header) { const th = h("th"); th.append(inlineFragment(cell)); headRow.append(th); }
  head.append(headRow);
  table.append(head);
  const body = h("tbody");
  for (const row of node.rows) {
    const tr = h("tr");
    for (const cell of row) { const td = h("td"); td.append(inlineFragment(cell)); tr.append(td); }
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

function listBlock(node) {
  const el = h(node.ordered ? "ol" : "ul", "ct-md-list");
  if (node.ordered && node.start !== 1) el.start = node.start;
  node.items.forEach((item, index) => {
    const li = h("li");
    const checked = node.checked?.[index];
    if (checked != null) {
      li.classList.add("ct-md-task");
      const box = h("span", checked ? "ct-md-check done" : "ct-md-check");
      box.setAttribute("role", "img");
      box.setAttribute("aria-label", checked ? "Done" : "To do");
      li.append(box);
    }
    li.append(inlineFragment(item));
    for (const child of node.nested?.[index] ?? []) li.append(renderNode(child));
    el.append(li);
  });
  return el;
}

/** Build the DOM for one parsed node. */
export function renderNode(node) {
  switch (node.type) {
    case "paragraph": { const p = h("p", "ct-md-p"); p.append(inlineFragment(node.children)); return p; }
    case "heading": { const el = h("h" + Math.min(node.level, 6), `ct-md-h ct-md-h${Math.min(node.level, 3)}`); el.append(inlineFragment(node.children)); return el; }
    case "list": return listBlock(node);
    case "code": return codeBlock(node);
    case "table": return tableBlock(node);
    case "quote": { const el = h("blockquote", "ct-md-quote"); for (const child of node.children) el.append(renderNode(child)); return el; }
    case "rule": return h("hr", "ct-md-hr");
    default: return h("div");
  }
}

/** Parse `text` and return a DocumentFragment of block nodes. */
export function renderMarkdown(text) {
  const fragment = document.createDocumentFragment();
  for (const node of parseMarkdown(text)) fragment.append(renderNode(node));
  return fragment;
}

/** Replace `el`'s content with the rendered markdown. */
export function renderMarkdownInto(el, text) {
  el.replaceChildren(renderMarkdown(text));
  return el;
}

/**
 * Keeps `el` showing a text that keeps growing (a reply as it arrives): each
 * `set(text)` redraws only the blocks that changed, so what is already on
 * screen stays put. `onBlock(el)` sees every block it draws.
 */
export function createMarkdownView(el, { onBlock } = {}) {
  /** @type {{ key: string, node: MdNode, el: HTMLElement }[]} */
  let drawn = [];
  return {
    /** The element of the last block drawn, or null. */
    last() { return drawn.length ? drawn[drawn.length - 1].el : null; },
    set(text) {
      const nodes = parseMarkdown(text, { partial: true });
      const keys = nodes.map((node) => JSON.stringify(node));
      let same = 0;
      while (same < drawn.length && same < keys.length && drawn[same].key === keys[same]) same++;
      // A code block that only grew keeps its element, its scroll position and its Copy button.
      const grew = drawn[same];
      if (grew && same < nodes.length && grew.node.type === "code" && nodes[same].type === "code" && grew.node.language === nodes[same].language) {
        grew.el.querySelector("pre code").textContent = nodes[same].text;
        grew.key = keys[same]; grew.node = nodes[same];
        same++;
      }
      for (const stale of drawn.splice(same)) stale.el.remove();
      for (let i = same; i < nodes.length; i++) {
        const block = renderNode(nodes[i]);
        onBlock?.(block);
        el.append(block);
        drawn.push({ key: keys[i], node: nodes[i], el: block });
      }
    },
  };
}
