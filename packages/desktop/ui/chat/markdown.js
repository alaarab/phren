// A small, safe Markdown renderer for the chat transcript. `parseMarkdown`
// is pure and returns a node-description tree (no DOM), so it runs under Node
// in src/ui-markdown.test.ts; the render helpers below build DOM nodes from it
// and never assign innerHTML, so transcript text can never inject markup.

/** @typedef {{ type: "text", text: string }} MdText
 *  @typedef {{ type: "code", text: string }} MdCode
 *  @typedef {{ type: "strong", children: MdInline[] }} MdStrong
 *  @typedef {{ type: "em", children: MdInline[] }} MdEm
 *  @typedef {{ type: "link", href: string, children: MdInline[] }} MdLink
 *  @typedef {MdText | MdCode | MdStrong | MdEm | MdLink} MdInline
 *  @typedef {{ type: "paragraph", children: MdInline[] }} MdParagraph
 *  @typedef {{ type: "heading", level: number, children: MdInline[] }} MdHeading
 *  @typedef {{ type: "list", ordered: boolean, items: MdInline[][] }} MdList
 *  @typedef {{ type: "code", language: string | null, text: string }} MdFence
 *  @typedef {{ type: "table", header: MdInline[][], rows: MdInline[][][] }} MdTable
 *  @typedef {MdParagraph | MdHeading | MdList | MdFence | MdTable} MdNode */

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*```(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Split a table row on pipes, dropping the empty leading/trailing cells. */
function tableCells(line) {
  let cells = line.trim().split("|");
  if (cells.length && cells[0].trim() === "") cells = cells.slice(1);
  if (cells.length && cells[cells.length - 1].trim() === "") cells = cells.slice(0, -1);
  return cells.map((cell) => cell.trim());
}

/** Where a single `*` or `_` emphasis run ends, or -1 when it does not. */
function emphasisEnd(text, start, marker) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== marker) continue;
    if (text[i + 1] === marker) { i++; continue; }
    const before = text[i - 1];
    const after = text[i + 1];
    if (marker === "_" && /[\w]/.test(before ?? "") && /[\w]/.test(after ?? "")) continue;
    if (/\s/.test(after ?? "")) continue;
    return i;
  }
  return -1;
}

/** Inline spans: code, links, bold, italic; all else is literal text. */
export function parseInline(text) {
  /** @type {MdInline[]} */ const out = [];
  let buffer = "";
  const flush = () => { if (buffer) { out.push({ type: "text", text: buffer }); buffer = ""; } };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) { flush(); out.push({ type: "code", text: text.slice(i + 1, end) }); i = end + 1; continue; }
    } else if (ch === "[") {
      const close = text.indexOf("](", i + 1);
      const paren = close >= 0 ? text.indexOf(")", close + 2) : -1;
      if (paren >= 0) {
        flush();
        out.push({ type: "link", href: text.slice(close + 2, paren), children: parseInline(text.slice(i + 1, close)) });
        i = paren + 1; continue;
      }
    } else if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end > i) { flush(); out.push({ type: "strong", children: parseInline(text.slice(i + 2, end)) }); i = end + 2; continue; }
    } else if (ch === "*" || ch === "_") {
      const end = emphasisEnd(text, i, ch);
      if (end > i) { flush(); out.push({ type: "em", children: parseInline(text.slice(i + 1, end)) }); i = end + 1; continue; }
    }
    buffer += ch;
    i++;
  }
  flush();
  return out;
}

/** Markdown into a block tree: paragraphs, headings, lists, fenced code, tables. */
export function parseMarkdown(text) {
  /** @type {MdNode[]} */ const nodes = [];
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let paragraph = [];
  let fence = null;
  let fenceLanguage = null;
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const body = paragraph.join("\n").replace(/^\s+|\s+$/g, "");
    paragraph = [];
    if (body) nodes.push({ type: "paragraph", children: parseInline(body) });
  };
  const flushList = () => { if (list) { nodes.push(list); list = null; } };
  const flushFence = () => {
    if (fence === null) return;
    nodes.push({ type: "code", language: fenceLanguage, text: fence.join("\n") });
    fence = null; fenceLanguage = null;
  };
  const flushAll = () => { flushParagraph(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = FENCE.exec(line);
    if (fence !== null) {
      if (open) flushFence();
      else fence.push(line);
      continue;
    }
    if (open) { flushAll(); fence = []; fenceLanguage = open[1].trim() || null; continue; }
    if (line.trim() === "") { flushAll(); continue; }
    const heading = HEADING.exec(line);
    if (heading) { flushAll(); nodes.push({ type: "heading", level: heading[1].length, children: parseInline(heading[2]) }); continue; }
    // A table needs a header row followed by its `---` divider.
    if (line.trim().startsWith("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      flushAll();
      const header = tableCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { rows.push(tableCells(lines[i])); i++; }
      i--;
      const width = Math.max(header.length, ...rows.map((r) => r.length), 0);
      const pad = (cells) => cells.concat(Array(Math.max(0, width - cells.length)).fill(""));
      nodes.push({ type: "table", header: pad(header).map(parseInline), rows: rows.map((r) => pad(r).map(parseInline)) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = ordered !== null;
      if (!list || list.ordered !== isOrdered) { flushList(); list = { type: "list", ordered: isOrdered, items: [] }; }
      list.items.push(parseInline((bullet ?? ordered)[1]));
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushAll();
  flushFence();
  return nodes;
}

const SAFE_HREF = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function inlineNodes(inline, out) {
  for (const node of inline) {
    if (node.type === "text") out.append(document.createTextNode(node.text));
    else if (node.type === "code") out.append(h("code", "ct-md-code", node.text));
    else if (node.type === "strong") { const el = h("strong"); inlineNodes(node.children, el); out.append(el); }
    else if (node.type === "em") { const el = h("em"); inlineNodes(node.children, el); out.append(el); }
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

function inlineFragment(inline) {
  return inlineNodes(inline, document.createDocumentFragment());
}

function codeBlock(node) {
  const figure = h("figure", "ct-md-pre");
  const bar = h("div", "ct-md-pre-bar");
  bar.append(h("span", "ct-md-lang", node.language || "code"));
  const copy = h("button", "ct-md-copy", "Copy");
  copy.type = "button";
  copy.addEventListener("click", () => {
    const value = node.text;
    const done = () => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1200); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(value).then(done, done);
    else done();
  });
  bar.append(copy);
  figure.append(bar);
  const pre = h("pre");
  pre.append(h("code", null, node.text));
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

/** Build the DOM for one parsed node. */
export function renderNode(node) {
  switch (node.type) {
    case "paragraph": { const p = h("p", "ct-md-p"); p.append(inlineFragment(node.children)); return p; }
    case "heading": { const el = h("h" + Math.min(node.level, 6), `ct-md-h ct-md-h${Math.min(node.level, 3)}`); el.append(inlineFragment(node.children)); return el; }
    case "list": {
      const el = h(node.ordered ? "ol" : "ul", "ct-md-list");
      for (const item of node.items) { const li = h("li"); li.append(inlineFragment(item)); el.append(li); }
      return el;
    }
    case "code": return codeBlock(node);
    case "table": return tableBlock(node);
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
