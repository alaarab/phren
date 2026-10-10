// The "Phren knows" drawer for a session's project and "Remember this" for a
// selected line of text. Plain browser ES module. Reads the project's summary,
// findings, tasks and topics; saves a finding with or without a code location.

import { hookGet, hookPost } from "../api.js";
import { renderMarkdownInto } from "./markdown.js";

let styleLinked = false;
function ensureStyle() {
  if (styleLinked) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./knows.css", import.meta.url).href;
  document.head.appendChild(link);
  styleLinked = true;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function memoryGet(computer, route, query) {
  const qs = new URLSearchParams(query).toString();
  return fetch(`/api/memory/${encodeURIComponent(computer)}${route}${qs ? `?${qs}` : ""}`, { cache: "no-store" })
    .then(async (res) => {
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if (!res.ok) throw Object.assign(new Error(body.error || `The daemon answered ${res.status}.`), { status: res.status, body });
      return body;
    });
}

// ---- finding shape helpers (same shapes as sections/memory.js) ------------
function citationData(item) {
  if (item?.citationData && typeof item.citationData === "object") return item.citationData;
  const match = String(item?.citation ?? "").match(/phren:cite\s+(\{[\s\S]*\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}
function citeInfo(item) {
  const data = citationData(item);
  const file = String(data?.file ?? "").trim();
  const line = data?.line;
  const commit = String(data?.commit ?? "").trim();
  if (!file) return commit ? { label: commit.slice(0, 7), title: commit, copy: commit } : null;
  const base = file.split("/").filter(Boolean).pop() || file;
  const full = line != null ? `${file}:${line}` : file;
  return { label: line != null ? `${base}:${line}` : base, title: full, copy: full };
}
function findingBody(item) {
  return String(item?.text ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^\[[A-Za-z][A-Za-z0-9_-]*\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}
function shortDate(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  return `${MONTHS[Number(match[2]) - 1] ?? "?"} ${Number(match[3])}`;
}
function topicLabel(item) {
  const label = String(item?.label ?? item?.title ?? "").trim();
  if (label) return label;
  const slug = String(item?.slug ?? item?.topic ?? item?.id ?? "").trim();
  return slug ? slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Topic";
}
function stripTags(line) {
  return String(line ?? "")
    .replace(/\s*\[pinned\]/gi, "")
    .replace(/(\s*\[(high|medium|low)\])+\s*$/gi, "")
    .trim();
}

// ---- toast ---------------------------------------------------------------
let toastHost = null;
export function knowsToast(text, kind = "") {
  if (!toastHost) {
    toastHost = el("div", "knows-toasts");
    document.body.append(toastHost);
  }
  const note = el("div", `knows-toast${kind ? ` ${kind}` : ""}`, text);
  toastHost.append(note);
  setTimeout(() => note.remove(), 4000);
}

function copyText(text) {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
}

// ---- tasks ---------------------------------------------------------------
/** Active (all) and Queue (top 5) for a project, through its task store. */
async function loadTasks(computer, project) {
  const directory = await hookGet(computer, "/v1/tasks/stores");
  const stores = Array.isArray(directory.stores) ? directory.stores : [];
  const has = (s) => s.available !== false && Array.isArray(s.projects) && s.projects.includes(project);
  const store = stores.find((s) => has(s) && !s.readonly) || stores.find(has);
  if (!store || !store.id) return { active: [], queue: [] };
  const doc = await hookGet(computer, "/v1/tasks", { storeId: store.id, project });
  const items = doc.items || {};
  return { active: items.Active || [], queue: (items.Queue || []).slice(0, 5) };
}

/** The prose inside a store's marked "What phren knows" block, or "". */
export function extractKnowsBlock(content) {
  const text = String(content || "");
  const end = text.indexOf("<!-- phren:knows:end -->");
  // The innermost block: a store can hold a newer start marker left unreplaced above an older one.
  const start = end === -1 ? -1 : text.lastIndexOf("<!-- phren:knows:start", end);
  if (start === -1 || end === -1 || end < start) return "";
  const inner = text.slice(start, end).split("\n").slice(1).join("\n").trim();
  return inner.replace(/^##\s+What phren knows\s*/i, "").trim();
}

/** Summary prose for the drawer: the memory API when it has it, else summary.md. */
async function loadKnowsSummary(computer, project) {
  try {
    const file = await readStoreFile(computer, `${project}/summary.md`);
    return extractKnowsBlock(file.content);
  } catch {
    return "";
  }
}

// ---- drawer --------------------------------------------------------------
/**
 * Open the "Phren knows" drawer inside a chat pane.
 * @returns {{ close: () => void }}
 */
export function openKnowsDrawer(container, { computer, project, onClose } = {}) {
  ensureStyle();
  const drawer = el("div", "knows-drawer");

  const head = el("div", "knows-head");
  const headMain = el("div", "knows-head-main");
  headMain.append(el("div", "knows-title", "Phren knows"), el("div", "knows-sub", project || ""));
  const close = el("button", "knows-close", "\u00d7");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  head.append(headMain, close);
  const body = el("div", "knows-body");
  body.append(el("div", "knows-empty", "Loading\u2026"));
  drawer.append(head, body);
  container.append(drawer);
  container.classList.add("knows-open");

  let closed = false;
  function destroy() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    drawer.remove();
    container.classList.remove("knows-open");
    if (typeof onClose === "function") onClose();
  }
  function onKey(event) { if (event.key === "Escape") { event.preventDefault(); destroy(); } }
  close.addEventListener("click", destroy);
  document.addEventListener("keydown", onKey, true);

  if (!project) {
    body.replaceChildren(el("div", "knows-empty", "This session has no project yet."));
  } else {
    void fill(body, computer, project);
  }
  return { close: destroy };
}

/** A titled section whose body is filled by the caller; returns the body. */
function section(parent, label, count) {
  const box = el("div", "knows-section");
  const labelEl = el("div", "knows-label");
  labelEl.append(el("span", null, label));
  if (count != null) labelEl.append(el("span", "knows-label-count", String(count)));
  const inner = el("div", "knows-section-body");
  box.append(labelEl, inner);
  parent.append(box);
  return inner;
}

async function fill(body, computer, project) {
  const [findingsR, topicsR, tasksR, summaryR] = await Promise.allSettled([
    memoryGet(computer, "/findings", { project }),
    memoryGet(computer, "/topics", { project }),
    loadTasks(computer, project),
    loadKnowsSummary(computer, project),
  ]);
  if (!body.isConnected) return;
  body.replaceChildren();

  // The "What phren knows" prose, from the memory API or the store's summary.md.
  const summary = summaryR.status === "fulfilled" ? String(summaryR.value || "").trim() : "";
  if (summary) {
    const prose = section(body, "Summary");
    const proseEl = el("div", "knows-prose");
    renderMarkdownInto(proseEl, summary.replace(/<!--[\s\S]*?-->/g, "").replace(/\*\*([^*]+)\*\* — ## Now\s*/g, "**$1** — "));
    prose.append(proseEl);
  }

  const findings = findingsR.status === "fulfilled" && Array.isArray(findingsR.value.items) ? findingsR.value.items.slice() : [];
  findings.sort((a, b) => (String(b.date ?? "") < String(a.date ?? "") ? -1 : String(b.date ?? "") > String(a.date ?? "") ? 1 : 0));
  renderFindings(section(body, "Recent findings", findings.length || undefined), findings.slice(0, 8));

  const tasks = tasksR.status === "fulfilled" ? tasksR.value : { active: [], queue: [] };
  const open = section(body, "Open tasks", tasks.active.length + tasks.queue.length || undefined);
  if (!tasks.active.length && !tasks.queue.length) open.append(el("div", "knows-empty", "No open tasks."));
  else {
    for (const item of tasks.active) open.append(taskRow(item, false));
    for (const item of tasks.queue) open.append(taskRow(item, true));
  }

  const topics = topicsR.status === "fulfilled" && Array.isArray(topicsR.value.topics) ? topicsR.value.topics.slice() : [];
  topics.sort((a, b) => topicCount(b) - topicCount(a));
  const topicBox = section(body, "Topics", topics.length || undefined);
  if (!topics.length) topicBox.append(el("div", "knows-empty", "No topics yet."));
  else for (const topic of topics.slice(0, 14)) topicBox.append(topicRow(topic));
}

function topicCount(item) {
  if (typeof item?.bullets === "number") return item.bullets;
  if (typeof item?.findings === "number") return item.findings;
  return 0;
}

function taskRow(item, queued) {
  const row = el("div", `knows-task${queued ? " queued" : ""}`);
  row.append(el("span", "knows-task-dot"));
  row.append(el("div", "knows-task-text", stripTags(item?.line ?? item?.text ?? "")));
  return row;
}

function topicRow(item) {
  const row = el("div", "knows-topic");
  row.append(el("span", "knows-topic-name", topicLabel(item)));
  const count = topicCount(item);
  if (count) row.append(el("span", "knows-topic-count", `${count} finding${count === 1 ? "" : "s"}`));
  return row;
}

function renderFindings(box, items) {
  if (!items.length) { box.append(el("div", "knows-empty", "No findings in this project yet.")); return; }
  for (const item of items) {
    const row = el("div", "knows-row");
    row.append(el("div", "knows-find-text", findingBody(item)));
    const meta = el("div", "knows-meta");
    const date = shortDate(item.date) || shortDate(citationData(item)?.created_at);
    if (date) meta.append(el("span", null, date));
    const cite = citeInfo(item);
    if (cite) {
      const chip = el("button", "knows-cite", cite.label);
      chip.type = "button";
      chip.title = cite.title;
      chip.addEventListener("click", () => { copyText(cite.copy); knowsToast(`Copied ${cite.copy}`); });
      meta.append(chip);
    }
    if (meta.childElementCount) row.append(meta);
    box.append(row);
  }
}

// ---- remember this -------------------------------------------------------
function decodeBase64(data) {
  const binary = atob(String(data || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}


async function readStoreFile(computer, path) {
  const head = await hookGet(computer, "/v1/store/head");
  const tree = await hookGet(computer, "/v1/store/tree", { sha: head.sha });
  const entry = (Array.isArray(tree.tree) ? tree.tree : []).find((e) => e && e.path === path && e.type === "blob");
  if (!entry || !entry.sha) return { sha: null, content: "" };
  const blob = await hookGet(computer, "/v1/store/blob", { sha: entry.sha });
  return { sha: entry.sha, content: decodeBase64(blob.content) };
}

/** Save the finding through the daemon, which runs the CLI's own finding writer
 * (stable id, duplicate check, file conventions) on that computer's store. */
async function writeFindingToStore(computer, project, text) {
  const res = await fetch(`/api/memory/${encodeURIComponent(computer)}/findings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Phren-Desktop": "1" },
    body: JSON.stringify({ project, text }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Saving failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
}

/**
 * Save selected text as a finding, linked to a code location when one is given.
 * @param {{computer:string, project:string, text:string, file?:string, line?:number, name?:string}} opts
 * @returns {Promise<{path:"code"|"store", project:string}>}
 */
export async function rememberThis({ computer, project, text, file, line, name } = {}) {
  const body = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!body) throw new Error("Select some text first.");
  if (!project) throw new Error("This session has no project yet.");
  if (!computer) throw new Error("This session has no computer yet.");
  if (file && line && name) {
    try {
      await hookPost(computer, "/v1/code/note", { project, name, file, line, text: body });
      return { path: "code", project };
    } catch (err) {
      console.warn("code note failed, saving to FINDINGS.md", err);
    }
  }
  await writeFindingToStore(computer, project, body);
  return { path: "store", project };
}

/**
 * Show a "Remember this" button over text selected inside `scopeEl`; clicking
 * opens an inline confirm with the text editable, then saves it.
 * @returns {{ destroy: () => void }}
 */
export function installRememberSelection(scopeEl, { computer, project } = {}) {
  ensureStyle();
  let button = null;
  let confirm = null;
  let pending = "";

  function removeButton() { button?.remove(); button = null; }
  function removeConfirm() { confirm?.remove(); confirm = null; }
  function hideAll() { removeButton(); removeConfirm(); }

  function onMouseUp() {
    // Let the browser settle the selection before reading it.
    setTimeout(() => {
      if (confirm) return;
      const selection = window.getSelection();
      const text = selection ? String(selection).replace(/\s+/g, " ").trim() : "";
      if (!text || !selection || selection.rangeCount === 0 || selection.isCollapsed || !scopeEl.contains(selection.anchorNode)) {
        removeButton();
        return;
      }
      pending = text;
      showButton(selection.getRangeAt(0).getBoundingClientRect());
    }, 0);
  }

  function showButton(rect) {
    removeButton();
    button = el("button", "knows-sel-btn", "Remember this");
    button.type = "button";
    document.body.append(button);
    button.style.left = `${Math.max(8, Math.min(rect.right + 4, window.innerWidth - button.offsetWidth - 8))}px`;
    button.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 40))}px`;
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const at = { left: button.getBoundingClientRect().left, top: button.getBoundingClientRect().bottom + 6 };
      removeButton();
      showConfirm(pending, at);
    });
  }

  function showConfirm(text, at) {
    removeConfirm();
    confirm = el("div", "knows-confirm");
    confirm.append(el("div", "knows-confirm-head", "Remember this"));
    const area = el("textarea", "knows-confirm-text");
    area.value = text;
    const actions = el("div", "knows-confirm-actions");
    const cancel = el("button", "knows-btn", "Cancel");
    cancel.type = "button";
    const save = el("button", "knows-btn primary", "Save");
    save.type = "button";
    actions.append(cancel, save);
    confirm.append(area, actions);
    document.body.append(confirm);
    confirm.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - confirm.offsetWidth - 8))}px`;
    confirm.style.top = `${Math.max(8, Math.min(at.top, window.innerHeight - confirm.offsetHeight - 8))}px`;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);

    cancel.addEventListener("click", hideAll);
    area.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); hideAll(); }
      else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
    });
    save.addEventListener("click", () => void submit());

    async function submit() {
      const value = area.value.trim();
      if (!value) return;
      save.disabled = true;
      try {
        await rememberThis({ computer, project, text: value });
        knowsToast(`Saved to ${project}`);
        hideAll();
      } catch (err) {
        save.disabled = false;
        knowsToast((err && err.message) || "Could not save this.", "error");
      }
    }
  }

  function onPointerDown(event) {
    if (button && button.contains(event.target)) return;
    if (confirm && confirm.contains(event.target)) return;
    hideAll();
  }
  function onSelectionChange() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !scopeEl.contains(selection.anchorNode)) removeButton();
  }

  scopeEl.addEventListener("mouseup", onMouseUp);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("selectionchange", onSelectionChange);

  return {
    destroy() {
      hideAll();
      scopeEl.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("selectionchange", onSelectionChange);
    },
  };
}
