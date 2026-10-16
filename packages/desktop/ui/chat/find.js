// Find in chat, the matcher: walks the text a conversation shows, wraps each
// hit in a <mark> and puts the DOM back as it found it. Browser-free by design
// (it touches only the node API below), so src/ui-chat-find.test.ts runs it on
// a small fake DOM. The bar around it is find-bar.js.

export const HIT_CLASS = "ct-find-hit";
export const CURRENT_CLASS = "ct-find-current";
export const MAX_HITS = 1000;

// Chrome, not conversation: controls, icons, status marks, labels, the bar itself.
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT", "SVG"]);
const SKIP_CLASSES = [
  "ct-icon", "ct-chevron", "ct-status", "ct-md-copy", "ct-md-pre-bar", "ct-fold", "ct-jump", "ct-more",
  "ct-caret", "ct-detail-label", "ct-activity-arc", "ct-activity-time", "ct-chip", "chat-find", "ct-outline",
];
// Buttons whose text is the conversation (a tool row's title and summary, a path the agent named).
const READABLE_BUTTONS = ["ct-toolrow", "ct-path-btn"];

const has = (el, name) => !!el.classList && el.classList.contains(name);
const tag = (el) => String(el.tagName || "").toUpperCase();

/** Is this element's subtree outside the conversation? A collapsed tool body still counts: its match opens it. */
export function isChrome(el) {
  if (SKIP_TAGS.has(tag(el))) return true;
  if (tag(el) === "BUTTON" && !READABLE_BUTTONS.some((name) => has(el, name))) return true;
  if (SKIP_CLASSES.some((name) => has(el, name))) return true;
  if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return true;
  if (el.hidden && !has(el, "ct-toolbox-body")) return true;
  return false;
}

/** Every text node under `root` that is conversation text, in document order. Existing hits are looked through. */
export function textNodes(root, skip = isChrome) {
  const out = [];
  (function walk(node) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) { if (child.nodeValue) out.push(child); continue; }
      if (child.nodeType !== 1) continue;
      if (tag(child) === "MARK" && has(child, HIT_CLASS)) { walk(child); continue; }
      if (skip(child)) continue;
      walk(child);
    }
  })(root);
  return out;
}

/** Case-insensitive [start, end) offsets of `query` in `text`. */
export function ranges(text, query) {
  if (!query) return [];
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const found = [];
  for (const match of text.matchAll(re)) {
    if (match[0].length) found.push([match.index, match.index + match[0].length]);
  }
  return found;
}

/**
 * Wrap every hit under `root` in a <mark class="ct-find-hit">. Returns the
 * marks in document order (at most MAX_HITS; the rest are left unmarked).
 */
export function highlight(root, query, skip = isChrome) {
  const doc = root.ownerDocument;
  const work = [];
  let total = 0;
  for (const node of textNodes(root, skip)) {
    if (total >= MAX_HITS) break;
    const found = ranges(node.nodeValue, query).slice(0, MAX_HITS - total);
    if (found.length) { work.push([node, found]); total += found.length; }
  }
  const marks = [];
  for (const [node, found] of work) {
    const nodeMarks = [];
    // Last hit first, so the earlier offsets stay valid as the node is split.
    for (let i = found.length - 1; i >= 0; i--) {
      const [start, end] = found[i];
      if (end < node.nodeValue.length) node.splitText(end);
      const middle = start > 0 ? node.splitText(start) : node;
      const mark = doc.createElement("mark");
      mark.className = HIT_CLASS;
      middle.parentNode.insertBefore(mark, middle);
      mark.appendChild(middle);
      nodeMarks.unshift(mark);
    }
    marks.push(...nodeMarks);
  }
  return marks;
}

/** Unwrap the given marks and merge the text nodes they split, leaving the DOM as it was. */
export function restore(marks) {
  const parents = new Set();
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue; // its row was re-rendered
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parents.add(parent);
  }
  for (const parent of parents) parent.normalize();
}

/**
 * A finder over one conversation root. `search` re-runs from scratch (it
 * restores the DOM first) and can keep the current hit across a re-search:
 * the same hit in the same block, else the nearest index.
 */
export function createFinder(root, { reveal } = {}) {
  let marks = [];
  let index = -1;
  let query = "";

  function paint() {
    marks.forEach((m, i) => {
      if (i === index) m.classList.add(CURRENT_CLASS); else m.classList.remove(CURRENT_CLASS);
    });
  }

  // A hit's row: the timeline row's id (it survives the row being re-rendered), else its parent block.
  function rowKey(m) {
    for (let node = m.parentNode; node; node = node.parentNode) {
      const id = node.getAttribute && node.getAttribute("data-row-id");
      if (id) return id;
    }
    return m.parentNode;
  }

  function currentAnchor() {
    const m = marks[index];
    if (!m) return null;
    const key = rowKey(m);
    return { key, ordinal: marks.filter((other) => rowKey(other) === key).indexOf(m), fallback: index };
  }

  function select(next) {
    index = marks.length ? ((next % marks.length) + marks.length) % marks.length : -1;
    paint();
    return marks[index] || null;
  }

  return {
    get count() { return marks.length; },
    get index() { return index; },
    get query() { return query; },
    get marks() { return marks; },
    /** @param {{keep?: boolean}} opts keep: stay on the current hit (a re-search while messages stream in). */
    search(text, { keep = false } = {}) {
      const anchor = keep && text === query ? currentAnchor() : null;
      restore(marks);
      query = text;
      marks = text ? highlight(root, text) : [];
      if (!marks.length) { index = -1; return { count: 0, index: -1, mark: null }; }
      let next = 0;
      if (anchor) {
        const same = marks.filter((m) => rowKey(m) === anchor.key)[anchor.ordinal];
        next = same ? marks.indexOf(same) : Math.min(anchor.fallback, marks.length - 1);
      }
      const current = select(next);
      return { count: marks.length, index, mark: current };
    },
    /** Step to the next (1) or previous (-1) hit, opening a collapsed block that holds it. */
    step(direction) {
      if (!marks.length) return null;
      const current = select(index + direction);
      if (current && reveal) reveal(current);
      return current;
    },
    /** Reveal the current hit (opens a collapsed block) and return it. */
    current() {
      const current = marks[index] || null;
      if (current && reveal) reveal(current);
      return current;
    },
    clear() {
      restore(marks);
      marks = []; index = -1; query = "";
    },
  };
}
