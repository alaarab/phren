// Tiling for the centre: a split tree like Herdr's panes (side by side or
// stacked), each tile holding its own row of document tabs. Documents move
// between tiles without remounting. Keys follow Herdr's names: split right /
// down, focus / move / swap by direction, resize, zoom.
//
// The API mirrors shell/tabs.js (open, activate, close, step, setTitle, has,
// active, activeHandle, list), so a section can switch from tabs to tiles.
import { createTabs } from "./tabs.js";

const LAYOUT_KEY = "phren.desktop.layout";
const MIN_RATIO = 0.12;
let nextLeaf = 1;

export function createTiles(rootEl, { onActivate, onEmpty, emptyText = "Open a session, or press ⌘K." } = {}) {
  rootEl.classList.add("tiles");
  let root = null;     // node: { kind: "leaf", id, el, bar, body, tabs } | { kind: "split", dir: "row"|"col", ratio, a, b, el, gutter }
  let focused = null;  // the leaf keyboard and new documents go to
  let zoomed = false;
  let restoring = false;

  // ------------------------------------------------------------ nodes
  function makeLeaf() {
    const leaf = { kind: "leaf", id: `t${nextLeaf++}` };
    leaf.el = document.createElement("div");
    leaf.el.className = "tile";
    leaf.el.dataset.tile = leaf.id;
    leaf.bar = document.createElement("div");
    leaf.bar.className = "doc-bar tile-bar";
    leaf.body = document.createElement("div");
    leaf.body.className = "doc-body tile-body";
    const empty = document.createElement("div");
    empty.className = "empty tile-empty";
    empty.textContent = emptyText;
    leaf.body.append(empty);
    leaf.el.append(leaf.bar, leaf.body);
    leaf.tabs = createTabs(leaf.bar, leaf.body, {
      storageKey: null,
      onActivate(doc, handle) {
        empty.hidden = true;
        if (leaf === focused) onActivate?.(doc, handle);
        save();
      },
      onEmpty() { empty.hidden = false; tileEmptied(leaf); },
      onChange: () => save(),
    });
    leaf.el.addEventListener("pointerdown", () => focus(leaf), true);
    installDrop(leaf);
    return leaf;
  }

  function makeSplit(dir, a, b, ratio = 0.5) {
    const split = { kind: "split", dir, ratio, a, b };
    split.el = document.createElement("div");
    split.el.className = `tile-split tile-split-${dir}`;
    split.gutter = document.createElement("div");
    split.gutter.className = "tile-gutter";
    split.gutter.addEventListener("pointerdown", (down) => dragGutter(split, down));
    return split;
  }

  function leaves(node = root, out = []) {
    if (!node) return out;
    if (node.kind === "leaf") out.push(node); else { leaves(node.a, out); leaves(node.b, out); }
    return out;
  }

  function parentOf(target, node = root, parent = null) {
    if (!node) return null;
    if (node === target) return parent;
    if (node.kind === "split") return parentOf(target, node.a, node) ?? parentOf(target, node.b, node);
    return null;
  }

  function replace(oldNode, newNode) {
    const parent = parentOf(oldNode);
    if (!parent) root = newNode;
    else if (parent.a === oldNode) parent.a = newNode;
    else parent.b = newNode;
  }

  // ------------------------------------------------------------ rendering
  function render() {
    const place = (node) => {
      if (node.kind === "leaf") return node.el;
      node.el.replaceChildren(place(node.a), node.gutter, place(node.b));
      node.a.el.style.flex = `${node.ratio} 1 0`;
      node.b.el.style.flex = `${1 - node.ratio} 1 0`;
      return node.el;
    };
    if (!root) { root = makeLeaf(); focused = root; }
    // A node's el may move; keep inline flex only where a parent split sets it.
    for (const l of leaves()) if (l === root) l.el.style.flex = "";
    rootEl.replaceChildren(place(root));
    if (root.kind === "split") root.el.style.flex = "";
    for (const l of leaves()) l.el.classList.toggle("tile-focused", l === focused && leaves().length > 1);
    rootEl.classList.toggle("tiles-zoomed", zoomed);
    for (const l of leaves()) l.el.classList.toggle("tile-zoom-target", zoomed && l === focused);
  }

  function focus(leaf) {
    if (!leaf || leaf === focused) return;
    focused = leaf;
    for (const l of leaves()) l.el.classList.toggle("tile-focused", l === focused && leaves().length > 1);
    if (zoomed) render();
    const doc = leaf.tabs.active();
    if (doc) onActivate?.(doc, leaf.tabs.activeHandle());
  }

  // ------------------------------------------------------------ splitting
  /** Split `leaf` toward `side` ("right"|"left"|"down"|"up"|"auto"); returns the new empty leaf. */
  function split(leaf, side = "auto") {
    if (side === "auto") {
      const r = leaf.el.getBoundingClientRect();
      side = r.width >= r.height * 1.4 ? "right" : "down"; // dwindle: cut the longer side
    }
    const fresh = makeLeaf();
    const dir = side === "right" || side === "left" ? "row" : "col";
    const first = side === "left" || side === "up";
    const node = makeSplit(dir, first ? fresh : leaf, first ? leaf : fresh);
    replace(leaf, node);
    focused = fresh;
    render();
    save();
    return fresh;
  }

  function tileEmptied(leaf) {
    if (restoring) return;
    const all = leaves();
    if (all.length === 1) { onEmpty?.(); save(); return; }
    // Collapse an empty tile into its sibling.
    const parent = parentOf(leaf);
    const sibling = parent.a === leaf ? parent.b : parent.a;
    replace(parent, sibling);
    if (focused === leaf) focused = leaves(sibling)[0];
    render();
    const doc = focused.tabs.active();
    if (doc) onActivate?.(doc, focused.tabs.activeHandle());
    save();
  }

  // ------------------------------------------------------------ documents
  function find(docId) { return leaves().find((l) => l.tabs.has(docId)) ?? null; }

  function open(doc, { background = false, split: side } = {}) {
    const home = find(doc.id);
    if (home) {
      if (!background) { focus(home); home.tabs.activate(doc.id); }
      return home.tabs.handle(doc.id);
    }
    if (!root) render();
    let target = focused;
    if (side) target = split(focused, side);
    const handle = target.tabs.open(doc, { background });
    if (!background) focus(target);
    return handle;
  }

  /** Move a document to `leaf`, or to a new tile split off `leaf` toward `side`. */
  function moveDoc(docId, leaf, side) {
    const from = find(docId);
    if (!from) return;
    if (!side && from === leaf) return;
    if (side && from === leaf && from.tabs.size() === 1) return; // splitting a lone doc off itself does nothing
    // Detaching may empty `from` and collapse it; split first so the target exists.
    const target = side ? split(leaf, side) : leaf;
    restoring = true; // do not collapse while the entry is in flight
    const entry = from.tabs.detach(docId);
    restoring = false;
    target.tabs.adopt(entry);
    focus(target);
    if (from.tabs.size() === 0 && from !== target) tileEmptied(from);
    render();
    save();
  }

  // ------------------------------------------------------------ directions
  function neighbor(leaf, dir) {
    const r = leaf.el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let best = null, bestScore = Infinity;
    for (const l of leaves()) {
      if (l === leaf) continue;
      const o = l.el.getBoundingClientRect();
      const ox = o.left + o.width / 2, oy = o.top + o.height / 2;
      const ok = dir === "left" ? o.right <= r.left + 2 : dir === "right" ? o.left >= r.right - 2
        : dir === "up" ? o.bottom <= r.top + 2 : o.top >= r.bottom - 2;
      if (!ok) continue;
      const score = dir === "left" || dir === "right" ? Math.abs(ox - cx) + 2 * Math.abs(oy - cy) : Math.abs(oy - cy) + 2 * Math.abs(ox - cx);
      if (score < bestScore) { best = l; bestScore = score; }
    }
    return best;
  }

  function focusDir(dir) { const n = neighbor(focused, dir); if (n) { focus(n); n.tabs.activeHandle()?.focus?.(); } return !!n; }

  /** Move the focused document toward `dir`: into the neighbour, or into a new split when there is none. */
  function moveDir(dir) {
    const doc = focused.tabs.active();
    if (!doc) return;
    const n = neighbor(focused, dir);
    if (n) moveDoc(doc.id, n);
    else moveDoc(doc.id, focused, dir);
  }

  /** Swap the focused tile with its neighbour toward `dir`. */
  function swapDir(dir) {
    const n = neighbor(focused, dir);
    if (!n) return;
    const pa = parentOf(focused), pb = parentOf(n);
    const setChild = (parent, oldNode, newNode) => { if (parent.a === oldNode) parent.a = newNode; else parent.b = newNode; };
    if (pa === pb) { [pa.a, pa.b] = [pa.b, pa.a]; }
    else { setChild(pa, focused, n); setChild(pb, n, focused); }
    render();
    save();
  }

  /** Move the nearest divider on `dir`'s axis toward `dir` (Herdr's resize). */
  function resize(dir, delta = 0.05) {
    const axis = dir === "left" || dir === "right" ? "row" : "col";
    let child = focused, parent = parentOf(child);
    while (parent && parent.dir !== axis) { child = parent; parent = parentOf(child); }
    if (!parent) return;
    const step = dir === "right" || dir === "down" ? delta : -delta;
    parent.ratio = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, parent.ratio + step));
    render();
    save();
  }

  function zoom() { zoomed = !zoomed && leaves().length > 1; render(); }

  function dragGutter(split, down) {
    down.preventDefault();
    split.gutter.setPointerCapture(down.pointerId);
    const move = (ev) => {
      const r = split.el.getBoundingClientRect();
      const ratio = split.dir === "row" ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      split.ratio = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
      split.a.el.style.flex = `${split.ratio} 1 0`;
      split.b.el.style.flex = `${1 - split.ratio} 1 0`;
    };
    const up = () => { split.gutter.removeEventListener("pointermove", move); split.gutter.removeEventListener("pointerup", up); save(); };
    split.gutter.addEventListener("pointermove", move);
    split.gutter.addEventListener("pointerup", up);
  }

  // ------------------------------------------------------------ drag and drop
  function installDrop(leaf) {
    const overlay = document.createElement("div");
    overlay.className = "tile-drop";
    overlay.hidden = true;
    leaf.el.append(overlay);
    const zoneAt = (ev) => {
      const r = leaf.body.getBoundingClientRect();
      const x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
      if (x < 0.25) return "left";
      if (x > 0.75) return "right";
      if (y < 0.25) return "up";
      if (y > 0.75) return "down";
      return "center";
    };
    leaf.body.addEventListener("dragover", (ev) => {
      if (!ev.dataTransfer.types.includes("text/phren-tab")) return;
      ev.preventDefault();
      overlay.hidden = false;
      overlay.dataset.zone = zoneAt(ev);
    });
    leaf.body.addEventListener("dragleave", (ev) => { if (!leaf.body.contains(ev.relatedTarget)) overlay.hidden = true; });
    leaf.body.addEventListener("drop", (ev) => {
      const id = ev.dataTransfer.getData("text/phren-tab");
      overlay.hidden = true;
      if (!id) return;
      ev.preventDefault();
      const zone = zoneAt(ev);
      moveDoc(id, leaf, zone === "center" ? undefined : zone);
    });
    // Dropping on a tile's tab bar moves the document into that tile.
    leaf.bar.addEventListener("dragover", (ev) => { if (ev.dataTransfer.types.includes("text/phren-tab")) ev.preventDefault(); });
    leaf.bar.addEventListener("drop", (ev) => {
      const id = ev.dataTransfer.getData("text/phren-tab");
      if (id && !leaf.tabs.has(id)) { ev.preventDefault(); moveDoc(id, leaf); }
    });
  }

  // ------------------------------------------------------------ persistence
  function serialize(node = root) {
    if (!node) return null;
    if (node.kind === "split") return { dir: node.dir, ratio: Number(node.ratio.toFixed(3)), a: serialize(node.a), b: serialize(node.b) };
    const docs = node.tabs.list().filter((d) => d.persist).map((d) => ({ kind: d.kind, ...d.persist }));
    const active = node.tabs.active();
    return { docs, active: active?.persist ? { kind: active.kind, ...active.persist } : null, focused: node === focused };
  }

  function save() {
    if (restoring) return;
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(serialize())); } catch { /* storage unavailable */ }
  }

  function saved() {
    try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null"); } catch { return null; }
  }

  /**
   * Rebuild a saved layout. `resolve(item)` returns a document for a saved
   * `{ kind, ...persist }`, or null when it cannot be opened (yet). Tiles left
   * empty collapse. Returns the items that could not be resolved.
   */
  function restore(layout, resolve) {
    if (!layout) return [];
    const missing = [];
    restoring = true;
    let focusLeaf = null;
    const build = (s) => {
      if (s && s.dir && s.a && s.b) {
        const a = build(s.a), b = build(s.b);
        if (!a) return b;
        if (!b) return a;
        return makeSplit(s.dir === "col" ? "col" : "row", a, b, Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, Number(s.ratio) || 0.5)));
      }
      const leaf = makeLeaf();
      let activeId = null;
      for (const item of s?.docs ?? []) {
        const doc = resolve(item);
        if (!doc) { missing.push(item); continue; }
        leaf.tabs.open(doc, { background: true });
        if (s.active && JSON.stringify(s.active) === JSON.stringify(item)) activeId = doc.id;
      }
      if (!leaf.tabs.size()) return null;
      leaf.tabs.activate(activeId ?? leaf.tabs.list()[0].id);
      if (s.focused) focusLeaf = leaf;
      return leaf;
    };
    const built = build(layout);
    restoring = false;
    if (built) {
      root = built;
      focused = focusLeaf ?? leaves()[0];
      render();
      const doc = focused.tabs.active();
      if (doc) onActivate?.(doc, focused.tabs.activeHandle());
    }
    return missing;
  }

  render();

  return {
    open, moveDoc, split: (side = "auto") => split(focused, side), focusDir, moveDir, swapDir, resize, zoom, restore, saved,
    activate(docId) { const l = find(docId); if (l) { focus(l); l.tabs.activate(docId); } },
    close(docId) { const l = docId ? find(docId) : focused; if (l) l.tabs.close(docId ?? l.tabs.activeId()); },
    step(delta) { focused.tabs.step(delta); },
    setTitle(docId, title, subtitle) { find(docId)?.tabs.setTitle(docId, title, subtitle); },
    has: (docId) => !!find(docId),
    active: () => focused?.tabs.active() ?? null,
    activeHandle: () => focused?.tabs.activeHandle() ?? null,
    handle: (docId) => find(docId)?.tabs.handle(docId) ?? null,
    list: () => leaves().flatMap((l) => l.tabs.list()),
    tileCount: () => leaves().length,
  };
}
