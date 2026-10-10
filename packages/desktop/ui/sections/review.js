// Review: the review station. Every finished worker return across the online
// computers becomes a queue item; each opens to its report and its diff, where
// the owner leaves line comments that go back to that worker as one prompt, or
// marks the work reviewed. Reads each computer's Hook through the daemon proxy.
import { hookGet, hookPost, readRepoFile } from "../api.js";
import { sessions, store } from "../shell/store.js";
import { sectionHandle, showSection } from "../shell/sections.js";
import { additionHunks, parsePatch } from "../patch.js";
import { renderMarkdown } from "../chat/markdown.js";
import { mountTrains } from "./trains.js";

const CSS_ID = "review-css";
const POLL_MS = 15_000;
const MAX_ITEMS = 100;
const PREFETCH = 3;
const REVIEWED_KEY = "phren.desktop.review.reviewed";

/** Add this section's stylesheet once (index.html does not load it). */
function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement("link");
  link.id = CSS_ID;
  link.rel = "stylesheet";
  link.href = "./sections/review.css";
  document.head.append(link);
  // The Queue | Trains switch and the Trains view share trains.css.
  if (!document.getElementById("trains-css")) {
    const trains = document.createElement("link");
    trains.id = "trains-css";
    trains.rel = "stylesheet";
    trains.href = "./sections/trains.css";
    document.head.append(trains);
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A short age: "now", "5m", "3h", "2d". */
function age(iso) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The word a return state shows, and its chip class. */
function stateChip(state) {
  switch (String(state)) {
    case "done": return { label: "done", cls: "done" };
    case "needs-you": return { label: "needs you", cls: "needs" };
    case "blocked": return { label: "blocked", cls: "needs" };
    case "stalled": return { label: "stalled", cls: "needs" };
    case "failed": return { label: "failed", cls: "failed" };
    case "gone": return { label: "gone", cls: "gone" };
    default: return { label: String(state ?? "unknown"), cls: "" };
  }
}

function loadReviewed() {
  try {
    const raw = JSON.parse(localStorage.getItem(REVIEWED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}

function saveReviewed(set) {
  try { localStorage.setItem(REVIEWED_KEY, JSON.stringify([...set].slice(-500))); } catch { /* storage is best effort */ }
}

function stamp(receipt) {
  const at = receipt?.returned?.at ?? receipt?.updatedAt ?? receipt?.createdAt ?? "";
  const value = Date.parse(at);
  return Number.isFinite(value) ? value : 0;
}

/** One return's stable key: its receipt and the moment it returned. */
function keyOf(receipt) {
  return `${receipt.id}@${receipt.returned?.at ?? ""}`;
}

/** The report text a return carries, in the order the phone shows it. */
function reportText(receipt) {
  const r = receipt.returned ?? {};
  return String(r.reply ?? r.question ?? r.error ?? "").trim();
}

export function mountReview(root) {
  ensureCss();
  root.innerHTML = `
    <div class="review">
      <aside class="review-queue">
        <div class="review-queue-head">
          <span class="review-title">Review</span>
          <span class="review-sub" data-sub></span>
        </div>
        <div class="segments review-switch" data-mode role="tablist">
          <button class="segment selected" role="tab" aria-selected="true" data-mode="queue">Queue</button>
          <button class="segment" role="tab" aria-selected="false" data-mode="trains">Trains</button>
        </div>
        <div class="review-queue-list" data-queue></div>
      </aside>
      <section class="review-detail" data-detail>
        <div class="review-detail-head" data-head></div>
        <div class="review-detail-body" data-body></div>
        <div class="review-tray" data-tray></div>
      </section>
      <section class="review-trains" data-trains hidden></section>
    </div>`;

  const reviewEl = root.querySelector(".review");
  const modeEl = root.querySelector("[data-mode]");
  const trainsEl = root.querySelector("[data-trains]");
  const subEl = root.querySelector("[data-sub]");
  const queueEl = root.querySelector("[data-queue]");
  const headEl = root.querySelector("[data-head]");
  const bodyEl = root.querySelector("[data-body]");
  const trayEl = root.querySelector("[data-tray]");

  const state = {
    receipts: new Map(),   // computer -> [{ receipt, computer }]
    items: [],             // [{ receipt, computer, key, group }]
    selected: null,        // item key
    comments: new Map(),   // item key -> [{ path, line, side, text, comment }]
    reviewed: loadReviewed(),
    diffs: new Map(),      // key -> { loading, files, error }
    pulls: new Map(),      // key -> { loading, pulls, available, error }
    cursor: { file: 0, line: 0 },
    diffView: null,        // { files: [{ path, el, lines: [{ el, path, line, side, text }] }] }
    editor: null,
    send: null,            // { key, status, note }
    visible: false,
    detailSig: "",
    error: "",
    mode: "queue",         // "queue" | "trains"
    trains: null,          // the Trains view's handle once mounted
  };

  const onlineComputers = () => (store.merged?.computers ?? []).filter((c) => c.state === "online");

  // ---- queue ----------------------------------------------------------

  function groupOf(item) {
    if (state.reviewed.has(item.key)) return "done";
    const s = String(item.receipt.returned?.state ?? "");
    return s === "failed" || s === "gone" ? "failed" : "review";
  }

  function buildItems() {
    const items = [];
    const seen = new Set();
    for (const list of state.receipts.values()) {
      for (const entry of list) {
        const r = entry.receipt;
        if (!r?.returned || !r.id || seen.has(keyOf(r))) continue;
        seen.add(keyOf(r));
        const item = { receipt: r, computer: entry.computer, key: keyOf(r) };
        item.group = groupOf(item);
        items.push(item);
      }
    }
    items.sort((a, b) => stamp(b.receipt) - stamp(a.receipt));
    return items;
  }

  const selectedItem = () => state.items.find((i) => i.key === state.selected) ?? null;

  /** The overview child whose target matches a return's, so a row opens its chat. */
  function overviewChild(target) {
    if (!target) return null;
    for (const row of sessions()) {
      const t = row.child.target;
      if (t && t.server === target.server && t.workspace === target.workspace && t.tab === target.tab
        && t.pane === target.pane && t.session === target.session) return row;
    }
    return null;
  }

  function filesLabel(item) {
    const diff = state.diffs.get(item.key);
    if (!diff || diff.error || diff.loading) return "";
    const n = diff.files.length;
    return n ? `${n} file${n === 1 ? "" : "s"}` : "no changes";
  }

  function queueRow(item) {
    const r = item.receipt;
    const chip = stateChip(r.returned?.state);
    const row = el("button", `review-row${item.key === state.selected ? " selected" : ""}`);
    row.dataset.key = item.key;
    const main = el("div", "review-row-main");
    main.append(el("div", "review-row-title", r.label || r.project || r.id || "Worker"));
    const meta = el("div", "review-row-meta");
    meta.append(el("span", `review-chip ${chip.cls}`, chip.label));
    if (r.project) meta.append(el("span", "review-project mono", r.project));
    meta.append(el("span", "review-host", item.computer));
    const stampText = age(r.returned?.at);
    if (stampText) meta.append(el("span", "review-age", stampText));
    const files = filesLabel(item);
    if (files) meta.append(el("span", "review-files", files));
    main.append(meta);
    row.append(main);
    row.addEventListener("click", () => select(item.key));
    return row;
  }

  function renderQueue() {
    const groups = [["review", "Needs review"], ["done", "Done"], ["failed", "Failed"]];
    queueEl.replaceChildren();
    const shown = state.items.slice(0, MAX_ITEMS);
    let any = false;
    for (const [id, label] of groups) {
      const rows = shown.filter((i) => i.group === id);
      if (!rows.length) continue;
      any = true;
      const total = state.items.filter((i) => i.group === id).length;
      const head = el("div", "review-group");
      head.append(el("span", "review-group-label", label), el("span", "review-group-count", String(total)));
      queueEl.append(head, ...rows.map(queueRow));
      if (total > rows.length) queueEl.append(el("div", "review-more", `${total - rows.length} older not shown`));
    }
    if (!any) queueEl.append(el("div", "review-empty", state.receipts.size ? "Nothing to review." : "No computer online."));
  }

  function select(key) {
    if (state.selected === key) return;
    state.selected = key;
    state.detailSig = "";
    state.cursor = { file: 0, line: 0 };
    closeComment();
    const item = selectedItem();
    if (item) void loadDiff(item);
    renderQueue();
    renderDetail();
  }

  function updateSub() {
    const online = onlineComputers().length;
    const count = state.items.filter((i) => i.group === "review").length;
    subEl.textContent = online ? `${count} to review · ${online} online` : "No computer online";
  }

  // ---- data -----------------------------------------------------------

  async function poll() {
    if (state.mode !== "queue") return;
    const results = await Promise.all(onlineComputers().map(async (c) => {
      const body = await hookGet(c.computer, "/v1/dispatch").catch(() => null);
      return [c.computer, Array.isArray(body?.dispatches) ? body.dispatches : []];
    }));
    state.receipts = new Map(results.map(([computer, list]) =>
      [computer, list.map((receipt) => ({ receipt, computer: receipt.computer || computer }))]));
    render();
    prefetch();
  }

  async function loadDiff(item) {
    if (state.diffs.has(item.key)) return state.diffs.get(item.key);
    const entry = { loading: true, files: [], error: "" };
    state.diffs.set(item.key, entry);
    renderQueue();
    const target = item.receipt.target;
    if (!target) { entry.loading = false; entry.error = "This return has no worker target."; }
    else {
      try {
        const body = await hookPost(item.computer, "/v1/diff", { target });
        entry.files = Array.isArray(body.files) ? body.files : [];
        await Promise.all(entry.files.map(async (file) => {
          if (!String(file.status ?? "").includes("?") || (file.sections ?? []).length) return;
          try {
            const read = await readRepoFile(item.computer, target, file.path);
            if (!read.binary && read.text) file.addedHunks = additionHunks(read.text).hunks;
          } catch { /* leave the untracked file without a body */ }
        }));
      } catch (err) { entry.error = err?.message || String(err); }
      entry.loading = false;
    }
    renderQueue();
    if (state.selected === item.key) { state.detailSig = ""; renderDetail(); }
    return entry;
  }

  function prefetch() {
    const loading = [...state.diffs.values()].filter((d) => d.loading).length;
    const slots = Math.max(0, PREFETCH - loading);
    const pending = state.items.filter((i) => i.group === "review" && !state.diffs.has(i.key)).slice(0, slots);
    for (const item of pending) void loadDiff(item);
  }

  async function loadPulls(item) {
    if (state.pulls.has(item.key)) return state.pulls.get(item.key);
    const entry = { loading: true, pulls: [], available: false };
    state.pulls.set(item.key, entry);
    const target = item.receipt.target;
    if (target) {
      try {
        const body = await hookPost(item.computer, "/v1/git/pulls", { target });
        entry.available = body?.available === true;
        entry.pulls = Array.isArray(body?.pulls) ? body.pulls : [];
      } catch { /* no gh or no repository: nothing to show */ }
    }
    entry.loading = false;
    if (state.selected === item.key) renderHead(selectedItem());
    return entry;
  }

  // ---- render ---------------------------------------------------------

  function render() {
    state.items = buildItems();
    if (state.selected && !state.items.some((i) => i.key === state.selected)) state.selected = null;
    if (!state.selected && state.items.length) {
      state.selected = state.items[0].key;
      state.detailSig = "";
      state.cursor = { file: 0, line: 0 };
      void loadDiff(state.items[0]);
    }
    renderQueue();
    const item = selectedItem();
    const sig = item ? `${item.key}:${item.receipt.returned?.at ?? ""}` : "";
    if (sig !== state.detailSig) { state.detailSig = sig; renderDetail(); }
    updateSub();
  }

  function renderDetail() {
    const item = selectedItem();
    closeComment();
    if (!item) {
      headEl.replaceChildren();
      bodyEl.replaceChildren(el("div", "review-empty", "Select a return to review."));
      renderTray();
      return;
    }
    renderHead(item);
    renderBody(item);
    renderTray();
  }

  function renderHead(item) {
    headEl.replaceChildren();
    const r = item.receipt;
    const chip = stateChip(r.returned?.state);
    const wrap = el("div", "review-head");
    const top = el("div", "review-head-top");
    top.append(el("div", "review-head-title", r.label || r.project || r.id || "Worker"));
    const actions = el("div", "review-head-actions");
    const good = el("button", "review-btn accent", "Looks good");
    good.disabled = state.reviewed.has(item.key);
    good.addEventListener("click", () => looksGood(item));
    actions.append(good);
    const match = overviewChild(r.target);
    if (match) {
      const open = el("button", "review-btn ghost", "Open session");
      open.addEventListener("click", () => { showSection("agents"); sectionHandle("agents")?.openSession(match.computer, match.child); });
      actions.append(open);
    }
    top.append(actions);
    wrap.append(top);
    const meta = el("div", "review-head-meta");
    meta.append(el("span", `review-chip ${chip.cls}`, chip.label));
    if (r.project) meta.append(el("span", "review-project mono", r.project));
    meta.append(el("span", "review-host", item.computer));
    if (r.harness) meta.append(el("span", "review-harness", r.harness));
    const stampText = age(r.returned?.at);
    if (stampText) meta.append(el("span", "review-age", stampText));
    wrap.append(meta);
    const prs = el("div", "review-prs");
    prs.dataset.prs = "";
    wrap.append(prs);
    headEl.append(wrap);
    updatePrs(item);
  }

  function updatePrs(item) {
    const host = headEl.querySelector("[data-prs]");
    if (!host) return;
    const returned = Array.isArray(item.receipt.returned?.prs) ? item.receipt.returned.prs : [];
    const entry = state.pulls.get(item.key);
    const nodes = [];
    const seen = new Set();
    const push = (pr) => {
      if (!pr || pr.number === undefined || seen.has(pr.number)) return;
      seen.add(pr.number);
      const a = el("a", "review-pr mono");
      a.href = pr.url || "#";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = `#${pr.number}${pr.title ? ` ${pr.title}` : ""}`;
      if (pr.draft) a.classList.add("draft");
      if (pr.checks) a.classList.add(`checks-${pr.checks}`);
      a.addEventListener("click", (event) => { if (!pr.url) event.preventDefault(); });
      nodes.push(a);
    };
    for (const pr of returned) push(pr);
    if (entry?.available) for (const pr of entry.pulls) push(pr);
    if (nodes.length) { host.hidden = false; host.replaceChildren(...nodes); }
    else host.hidden = true;
    if (!state.pulls.has(item.key)) void loadPulls(item);
  }

  function fileStatus(code) {
    const c = String(code ?? "").trim() || "?";
    if (c.includes("?")) return { letter: "?", cls: "untracked" };
    if (c.includes("A")) return { letter: "A", cls: "add" };
    if (c.includes("D")) return { letter: "D", cls: "del" };
    if (c.includes("R")) return { letter: "R", cls: "ren" };
    return { letter: "M", cls: "mod" };
  }

  function renderBody(item) {
    bodyEl.replaceChildren();
    state.diffView = null;

    const reportBox = el("section", "review-report");
    reportBox.append(el("h3", "review-section-label", "Report"));
    const text = el("div", "review-report-text");
    const report = reportText(item.receipt);
    if (report) text.append(renderMarkdown(report));
    else text.append(el("div", "review-note", "No report text."));
    reportBox.append(text);
    bodyEl.append(reportBox);

    const diff = state.diffs.get(item.key);
    const diffBox = el("section", "review-diff");
    const diffHead = el("h3", "review-section-label");
    diffHead.append(document.createTextNode("Changes"));
    if (diff && !diff.loading && !diff.error && diff.files.length) diffHead.append(el("span", "review-section-count", String(diff.files.length)));
    diffBox.append(diffHead);

    if (!diff || diff.loading) diffBox.append(el("div", "review-note", "Loading diff…"));
    else if (diff.error) diffBox.append(el("div", "review-note", /conversation changed/i.test(diff.error)
      ? "The worker's pane has moved on to another conversation, so this return's diff is no longer available."
      : `Could not read the diff: ${diff.error}`));
    else if (!diff.files.length) diffBox.append(el("div", "review-note", "No uncommitted changes."));
    else {
      const fileList = el("div", "review-files-list");
      diff.files.forEach((file, index) => {
        const row = el("button", "review-files-row");
        const s = fileStatus(file.status);
        row.append(el("span", `review-status ${s.cls}`, s.letter), el("span", "review-file-name mono", file.path));
        row.addEventListener("click", () => focusFile(index));
        fileList.append(row);
      });
      diffBox.append(fileList);
      const view = { files: [] };
      diff.files.forEach((file, index) => {
        const rendered = renderFileDiff(file);
        // A file or folder with nothing to show stays in the list only.
        if (rendered.empty) fileList.children[index]?.classList.add("empty");
        else diffBox.append(rendered.wrap);
        view.files.push({ path: file.path, el: rendered.wrap, lines: rendered.lines });
      });
      state.diffView = view;
      applyFocus(false);
      markCommentedLines();
    }
    bodyEl.append(diffBox);
  }

  function renderFileDiff(file) {
    const wrap = el("div", "review-file");
    wrap.dataset.path = file.path;
    const head = el("div", "review-file-head");
    const s = fileStatus(file.status);
    head.append(el("span", `review-status ${s.cls}`, s.letter), el("span", "review-file-path mono", file.path));
    wrap.append(head);
    const body = el("div", "review-file-body");
    const lines = [];
    const hunks = [];
    if (Array.isArray(file.addedHunks)) hunks.push(...file.addedHunks);
    const sections = Array.isArray(file.sections) ? file.sections : [];
    let binary = false;
    for (const section of sections) {
      if (section.binary) { binary = true; continue; }
      if (section.patch) hunks.push(...parsePatch(section.patch));
    }
    if (binary && !hunks.length) body.append(el("div", "review-note", "Binary file."));
    else if (!hunks.length) body.append(el("div", "review-note", "No diff for this file."));
    const empty = !binary && !hunks.length;
    for (const hunk of hunks) {
      if (hunk.oldStart !== undefined) body.append(el("div", "review-hunk", `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${hunk.header ?? ""}`));
      for (const line of hunk.lines) {
        const lineEl = el("div", `review-line ${line.kind}`);
        const oldN = line.kind === "add" ? "" : String(line.oldLine ?? "");
        const newN = line.kind === "del" ? "" : String(line.newLine ?? "");
        lineEl.append(el("span", "review-old", oldN), el("span", "review-new", newN));
        lineEl.append(el("span", "review-code mono", line.text === "" ? " " : line.text));
        const lineNo = line.newLine ?? line.oldLine ?? 0;
        const side = line.kind === "del" ? "old" : "new";
        lineEl.dataset.path = file.path;
        lineEl.dataset.line = String(lineNo);
        lineEl.dataset.side = side;
        lineEl.dataset.text = line.text;
        lineEl.addEventListener("click", () => openComment(lineEl));
        body.append(lineEl);
        lines.push({ el: lineEl, path: file.path, line: lineNo, side, text: line.text });
      }
    }
    wrap.append(body);
    return { wrap, lines, empty };
  }

  function focusFile(index) {
    state.cursor = { file: index, line: 0 };
    applyFocus();
  }

  function applyFocus(scroll = true) {
    const view = state.diffView;
    if (!view?.files.length) return;
    const fi = Math.max(0, Math.min(view.files.length - 1, state.cursor.file));
    state.cursor.file = fi;
    const file = view.files[fi];
    const li = Math.max(0, Math.min(Math.max(0, file.lines.length - 1), state.cursor.line));
    state.cursor.line = li;
    for (const node of bodyEl.querySelectorAll(".review-line.focused")) node.classList.remove("focused");
    const lineEl = file.lines[li]?.el;
    if (lineEl) {
      lineEl.classList.add("focused");
      if (scroll) lineEl.scrollIntoView({ block: "center" });
    }
  }

  // ---- line comments --------------------------------------------------

  const cssEscape = (value) => (window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&"));

  function commentsFor(item) {
    return (item && state.comments.get(item.key)) || [];
  }

  function setComments(item, list) {
    if (!item) return;
    if (list.length) state.comments.set(item.key, list);
    else state.comments.delete(item.key);
  }

  function closeComment() {
    if (state.editor) { state.editor.remove(); state.editor = null; }
  }

  function openComment(lineEl) {
    closeComment();
    const path = lineEl.dataset.path;
    const line = Number(lineEl.dataset.line) || 0;
    const side = lineEl.dataset.side || "new";
    const text = lineEl.dataset.text ?? "";
    const editor = el("div", "review-editor");
    const ta = el("textarea", "review-editor-input");
    ta.placeholder = "Comment on this line";
    ta.rows = 2;
    const actions = el("div", "review-editor-actions");
    const save = el("button", "review-btn accent small", "Comment");
    const cancel = el("button", "review-btn ghost small", "Cancel");
    const commit = () => {
      const value = ta.value.trim();
      if (value) addComment({ path, line, side, text, comment: value });
      closeComment();
    };
    save.addEventListener("click", commit);
    cancel.addEventListener("click", () => closeComment());
    ta.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); commit(); }
      else if (event.key === "Escape") { event.preventDefault(); closeComment(); }
    });
    actions.append(save, cancel);
    editor.append(ta, actions);
    lineEl.after(editor);
    state.editor = editor;
    ta.focus();
  }

  function addComment(comment) {
    const item = selectedItem();
    if (!item) return;
    const list = [...commentsFor(item)];
    const existing = list.findIndex((c) => c.path === comment.path && c.line === comment.line && c.side === comment.side);
    if (existing >= 0) list[existing] = comment;
    else list.push(comment);
    setComments(item, list);
    renderTray();
    markCommentedLines();
  }

  function removeComment(index) {
    const item = selectedItem();
    if (!item) return;
    const list = [...commentsFor(item)];
    list.splice(index, 1);
    setComments(item, list);
    renderTray();
    markCommentedLines();
  }

  function markCommentedLines() {
    for (const node of bodyEl.querySelectorAll(".review-line.commented")) node.classList.remove("commented");
    for (const c of commentsFor(selectedItem())) {
      const node = bodyEl.querySelector(`.review-line[data-path="${cssEscape(c.path)}"][data-line="${c.line}"][data-side="${c.side}"]`);
      node?.classList.add("commented");
    }
  }

  function canSend(item) {
    const target = item?.receipt?.target;
    return Boolean(item?.computer && target && target.session);
  }

  function composePrompt(label, comments) {
    const lines = [`Review comments on your changes${label ? ` (${label})` : ""}:`, ""];
    comments.forEach((c, index) => {
      lines.push(`${index + 1}. ${c.path}:${c.line}`);
      if (c.text) lines.push(`   ${c.text}`);
      lines.push(`   ${c.comment}`);
      lines.push("");
    });
    lines.push("Please address these and report back.");
    return lines.join("\n");
  }

  function sendNote(status) {
    if (status === "delivered") return "Delivered to the worker.";
    if (status === "queued") return "Queued; the worker takes it when idle.";
    if (status === "uncertain") return "Delivery uncertain; check the worker.";
    if (status === "failed") return "Delivery failed.";
    return "Sent.";
  }

  function renderTray() {
    trayEl.replaceChildren();
    const item = selectedItem();
    const comments = commentsFor(item);
    if (!comments.length) {
      trayEl.append(el("div", "review-tray-hint", "Click a diff line or press c to comment. j/k items · n/p files · Enter sends."));
      return;
    }
    const list = el("div", "review-tray-list");
    comments.forEach((c, index) => {
      const row = el("div", "review-tray-row");
      const head = el("div", "review-tray-head");
      head.append(el("span", "review-tray-path mono", `${c.path}:${c.line}`));
      const remove = el("button", "review-tray-remove", "\u00d7");
      remove.title = "Remove";
      remove.addEventListener("click", () => removeComment(index));
      head.append(remove);
      row.append(head);
      if (c.text) row.append(el("div", "review-tray-quote mono", c.text));
      row.append(el("div", "review-tray-comment", c.comment));
      list.append(row);
    });
    trayEl.append(list);
    const foot = el("div", "review-tray-foot");
    const worker = item?.receipt?.label || item?.receipt?.project || "the worker";
    const send = el("button", "review-btn accent", `Send ${comments.length} comment${comments.length === 1 ? "" : "s"} to ${worker}`);
    send.disabled = !item || !canSend(item) || state.send?.status === "sending";
    send.addEventListener("click", () => { if (item) void sendComments(item); });
    foot.append(send);
    if (item && state.send?.key === item.key && state.send.note) foot.append(el("span", `review-tray-state ${state.send.status}`, state.send.note));
    if (item && !canSend(item)) foot.append(el("span", "review-tray-state failed", "This worker has no live session."));
    trayEl.append(foot);
  }

  async function sendComments(item) {
    const comments = commentsFor(item);
    if (!comments.length) return;
    const target = item.receipt.target;
    const deliveryId = crypto.randomUUID().replaceAll("-", "");
    const text = composePrompt(item.receipt.label || item.receipt.project, comments);
    state.send = { key: item.key, status: "sending", note: "Sending…", deliveryId };
    renderTray();
    try {
      const body = await hookPost(item.computer, "/v1/hand-off", { target, text, deliveryId });
      const status = body?.delivered ? "delivered" : body?.queued ? "queued" : body?.deliveryUncertain ? "uncertain" : (body?.state ?? "sent");
      state.send = { key: item.key, status, note: sendNote(status), deliveryId };
      if (status === "delivered") { setComments(item, []); markCommentedLines(); }
      renderTray();
      if (status === "queued" || status === "uncertain") void pollDelivery(item, deliveryId, target);
    } catch (err) {
      state.send = { key: item.key, status: "failed", note: err?.message || "Could not send.", deliveryId };
      renderTray();
    }
  }

  async function pollDelivery(item, deliveryId, target) {
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      try {
        const body = await hookPost(item.computer, "/v1/hand-off/status", { deliveryId, target });
        const status = body?.delivered ? "delivered" : body?.queued ? "queued" : body?.deliveryUncertain ? "uncertain" : (body?.state ?? "queued");
        state.send = { key: item.key, status, note: sendNote(status), deliveryId };
        if (status === "delivered") { setComments(item, []); markCommentedLines(); }
        if (state.selected === item.key) renderTray();
        if (status === "delivered" || status === "failed") return;
      } catch { /* keep waiting */ }
    }
  }

  function looksGood(item) {
    state.reviewed.add(item.key);
    saveReviewed(state.reviewed);
    state.items = buildItems();
    renderQueue();
    renderHead(item);
    updateSub();
  }

  // ---- keyboard -------------------------------------------------------

  function onKeydown(event) {
    if (!state.visible) return;
    if (state.mode !== "queue") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = (document.activeElement?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const key = event.key;
    if (key === "j" || key === "k") {
      if (!state.items.length) return;
      const at = state.items.findIndex((i) => i.key === state.selected);
      const step = key === "j" ? 1 : -1;
      const next = Math.max(0, Math.min(state.items.length - 1, (at < 0 ? 0 : at) + step));
      select(state.items[next].key);
      queueEl.querySelector(".review-row.selected")?.scrollIntoView({ block: "nearest" });
      event.preventDefault();
    } else if (key === "n" || key === "p") {
      if (!state.diffView?.files.length) return;
      const count = state.diffView.files.length;
      const step = key === "n" ? 1 : -1;
      state.cursor = { file: (state.cursor.file + step + count) % count, line: 0 };
      applyFocus();
      event.preventDefault();
    } else if (key === "c") {
      const lineEl = state.diffView?.files[state.cursor.file]?.lines[state.cursor.line]?.el;
      if (lineEl) { lineEl.scrollIntoView({ block: "center" }); openComment(lineEl); }
      event.preventDefault();
    } else if (key === "Enter") {
      const item = selectedItem();
      if (item && commentsFor(item).length && canSend(item) && state.send?.status !== "sending") { void sendComments(item); event.preventDefault(); }
    }
  }

  // ---- mode switch ----------------------------------------------------

  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    reviewEl.classList.toggle("trains-mode", mode === "trains");
    for (const button of modeEl.querySelectorAll(".segment")) {
      const active = button.dataset.mode === mode;
      button.classList.toggle("selected", active);
      button.setAttribute("aria-selected", String(active));
    }
    trainsEl.hidden = mode !== "trains";
    if (mode === "trains") {
      if (!state.trains) state.trains = mountTrains(trainsEl);
      state.trains?.show?.();
    } else {
      state.trains?.hide?.();
      void poll();
    }
  }

  for (const button of modeEl.querySelectorAll(".segment")) {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  }

  // ---- wiring ---------------------------------------------------------

  let timer = null;
  function startPoll() { if (!timer) timer = setInterval(() => { void poll(); }, POLL_MS); }
  function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

  let onlineSig = "";
  const unsubscribe = store.subscribe(() => {
    const sig = onlineComputers().map((c) => c.computer).join(",");
    updateSub();
    if (sig !== onlineSig) { onlineSig = sig; if (state.visible) void poll(); }
  });

  document.addEventListener("keydown", onKeydown);

  return {
    show() { state.visible = true; startPoll(); if (state.mode === "trains") state.trains?.show?.(); else void poll(); },
    hide() { state.visible = false; stopPoll(); closeComment(); state.trains?.hide?.(); },
    focus() { if (state.mode === "trains") state.trains?.focus?.(); else queueEl.querySelector(".review-row.selected")?.focus(); },
    destroy() { stopPoll(); unsubscribe(); document.removeEventListener("keydown", onKeydown); closeComment(); state.trains?.destroy?.(); },
  };
}
