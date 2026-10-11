// The desktop chat timeline: draws the kit's prepared transcript rows the way
// the phone does. Plain browser ES module. `render` is incremental: rows are
// keyed by their stable id and only rebuilt when their render key changes; the
// scroll stays anchored at the bottom when the reader is there, otherwise their
// place is kept and a "Jump to latest" pill appears.

import * as kit from "/vendor/kit/index.js";
import { parsePatch, wordSegments } from "../patch.js";
import { renderMarkdownInto } from "./markdown.js";
import { hookGet } from "../api.js";

let styleLinked = false;
function ensureStyle() {
  if (styleLinked) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./timeline.css", import.meta.url).href;
  document.head.appendChild(link);
  styleLinked = true;
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// SF Symbols the kit names, as text glyphs (there is no icon font here).
const ICONS = {
  terminal: "❯", globe: "◍", "pencil.line": "✎", "doc.badge.plus": "＋", "doc.text": "▤",
  folder: "▸", "wrench.and.screwdriver": "⚙", "doc.text.magnifyingglass": "⌕", checklist: "☑",
  map: "◇", "server.rack": "▤", "arrow.triangle.2.circlepath": "↻", plusminus: "±",
  clock: "◷", "clock.arrow.circlepath": "↻", checkmark: "✓", "checkmark.circle.fill": "●",
  "circle.lefthalf.filled": "◐", circle: "○", "exclamationmark.circle.fill": "✕",
  chevron_right: "›", "doc.on.doc": "⧉", person: "◈", sparkles: "✧",
};
function glyph(symbol, fallback = "•") { return ICONS[symbol] ?? fallback; }

function statusMark(status) {
  const el = h("span", `ct-status ct-status-${status}`);
  el.textContent = status === "failed" ? glyph("exclamationmark.circle.fill") : status === "running" ? "…" : glyph("checkmark");
  el.setAttribute("aria-label", status === "failed" ? "Failed" : status === "running" ? "Running" : "Completed");
  return el;
}

function chip(text, className = "") {
  return h("span", `ct-chip ${className}`.trim(), text);
}

const PATH_WITH_LINE = /^((?:[~.]{0,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)+?)(?::(\d+))?$/;

/** A file path the transcript named, as a button that opens it in the workbench. */
function pathButton(text, openFile, className = "") {
  const match = PATH_WITH_LINE.exec(text);
  if (!match || !openFile) return null;
  const button = h("button", `ct-path-btn ${className}`.trim(), text);
  button.type = "button";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openFile(match[1], { line: match[2] ? Number(match[2]) : null });
  });
  return button;
}

// The same proxy prefix api.js builds, for binary reads that cannot go through
// hookGet (which parses JSON).
const hostBase = (computer) => `/hosts/${encodeURIComponent(computer)}`;

// A code span names a file when it has a slash, or a known extension and a
// base name. An optional trailing `:line` rides along to the opener.
const KNOWN_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "md", "markdown",
  "css", "scss", "less", "html", "htm", "xml", "svg", "py", "rb", "go", "rs", "java", "kt", "kts", "swift",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "fish", "yml", "yaml", "toml", "ini",
  "cfg", "conf", "sql", "graphql", "gql", "proto", "txt", "lock"]);
const CODE_REFERENCE = /^([\w.@+~-]+(?:\/[\w.@+~-]+)*)(?::(\d+))?$/;

/** The file an inline code span names, or null when it is not one. */
function fileReference(text) {
  if (!text || text.length > 4096 || /[\s\\\u0000]/.test(text)) return null;
  const match = CODE_REFERENCE.exec(text);
  if (!match) return null;
  const file = match[1];
  if (!file.includes("/")) {
    const dot = file.lastIndexOf(".");
    if (dot <= 0 || !KNOWN_EXTENSIONS.has(file.slice(dot + 1).toLowerCase())) return null;
  }
  return { path: file, line: match[2] ? Number(match[2]) : null };
}

// One lightbox for the whole app, opened by clicking a loaded thumbnail.
let lightboxEl = null;
function lightboxKey(event) { if (event.key === "Escape") { event.preventDefault(); closeLightbox(); } }
function closeLightbox() {
  if (!lightboxEl) return;
  lightboxEl.remove();
  document.removeEventListener("keydown", lightboxKey, true);
}
function openLightbox(src, alt) {
  if (!lightboxEl) {
    lightboxEl = h("div", "ct-lightbox");
    lightboxEl.setAttribute("role", "dialog");
    lightboxEl.addEventListener("click", closeLightbox);
    lightboxEl._img = h("img", "ct-lightbox-img");
    lightboxEl.append(lightboxEl._img);
  }
  lightboxEl._img.src = src;
  lightboxEl._img.alt = alt || "Image";
  document.body.append(lightboxEl);
  document.removeEventListener("keydown", lightboxKey, true);
  document.addEventListener("keydown", lightboxKey, true);
}

/** The key that decides whether a row must be rebuilt. */
function entryKey(entry) {
  if (entry.turnActivity) {
    const a = entry.turnActivity;
    return `activity|${a.ownerID}|${a.phase}|${a.startedAt}|${a.finishedAt ?? ""}|${a.verb}`;
  }
  if (entry.turnChanges) return `changes|${entry.turnChanges.ownerID}|${entry.turnChanges.files.map((f) => f.path + f.patch.length).join(",")}`;
  if (entry.pendingEcho) return `pending|${entry.pendingEcho.id}|${entry.pendingEcho.deliveryState}|${entry.pendingEcho.text}`;
  const parts = entry.messages.map((m) => kit.renderKey(m) + `|i${(m.imageBlocks || []).length},${(m.resultImages || []).length},${(m.uploadImages || []).length}`);
  if (entry.isReadRun && entry.readRun) parts.push(entry.readRun.title, entry.readRun.preview);
  if (entry.phren) parts.push(`p:${entry.phren.verb}:${entry.phren.status}:${entry.phren.resultSummary ?? ""}`);
  if (entry.card) parts.push(`c:${entry.card.kind}:${JSON.stringify(entry.card.value ?? null)}`);
  parts.push(entry.kind, entry.cardSuperseded ? "sup" : "");
  return parts.join("\n");
}

/** Entries split into turns, each starting at a user message. Entries before
 *  the first user message ride along with that first turn. */
function groupTurns(entries) {
  const turns = [];
  let leading = [];
  for (const entry of entries) {
    const first = entry.messages && entry.messages[0];
    const startsTurn = !entry.pendingEcho && !!first && first.role === "user";
    if (startsTurn) { turns.push([...leading, entry]); leading = []; }
    else if (turns.length) turns[turns.length - 1].push(entry);
    else leading.push(entry);
  }
  if (leading.length) turns.push(leading);
  return turns;
}

/** Whether buildMessage would draw this entry as a user bubble or assistant
 *  text; tool rows and the other special rows do not count. */
function countsAsMessage(entry) {
  if (entry.turnActivity || entry.pendingEcho || entry.turnChanges) return false;
  if (entry.phren || entry.card || entry.isReadRun || entry.isActivity) return false;
  const message = entry.messages && entry.messages[0];
  if (!message) return false;
  if (message.isHookContext || message.isNarration || message.isScheduled || message.isCompaction) return false;
  if (message.localCommand) return false;
  return message.role === "user" || message.role === "assistant";
}

/**
 * The timeline view.
 * @param {HTMLElement} container element to fill and own
 * @param {{computer:string, source?:string, target?:object,
 *          openFile?:(path:string, opts?:object)=>void,
 *          openSubagent?:(child:any)=>void, insert?:(text:string)=>void}} ctx
 */
export function createTimelineView(container, ctx = {}) {
  ensureStyle();
  container.classList.add("ct-root");
  container.replaceChildren();

  const scroll = h("div", "ct-scroll");
  const column = h("div", "ct-column");
  scroll.append(column);
  const jump = h("button", "ct-jump", "Jump to latest");
  jump.type = "button";
  jump.hidden = true;
  container.append(scroll, jump);

  /** @type {Map<string, { el: HTMLElement, key: string, live?: () => void }>} */
  const rows = new Map();
  let jobsEl = null;
  let previewRow = null;
  let atBottom = true;
  let reachTopFired = false;
  const onTop = [];
  let expandedAll = false;    // the fold is open, every turn drawn
  let foldHidden = false;     // this render hid turns behind the fold
  let lastPreparation = null; // re-render arguments for the fold's click
  let lastPreview = null;

  const distanceFromBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
  const isAtBottom = () => distanceFromBottom() < 40;
  const scrollToBottom = () => { scroll.scrollTop = scroll.scrollHeight; };

  function updateJump() {
    atBottom = isAtBottom();
    jump.hidden = atBottom;
  }

  scroll.addEventListener("scroll", () => {
    updateJump();
    // Collapsed, the fold is the top: nothing hidden above it to load.
    if (foldHidden) { reachTopFired = false; return; }
    if (scroll.scrollTop <= 24) {
      if (!reachTopFired) { reachTopFired = true; for (const fn of onTop) fn(); }
    } else {
      reachTopFired = false;
    }
  });
  jump.addEventListener("click", () => { scrollToBottom(); updateJump(); });

  // Images: transcript attachments and tool-result pictures, fetched through the
  // daemon only once their row scrolls into view. Object URLs are revoked with
  // the row that owns them.
  const imageObserver = new IntersectionObserver((visible) => {
    for (const entry of visible) if (entry.isIntersecting) {
      imageObserver.unobserve(entry.target);
      entry.target._load?.();
    }
  }, { root: scroll, rootMargin: "200px" });

  function imageUrl(ref) {
    if (ref.kind === "upload") return `${hostBase(ctx.computer)}/v1/uploads/image?${new URLSearchParams({ path: ref.path })}`;
    const query = { ...(ctx.target || {}), line: String(ref.line), block: String(ref.block) };
    if (ref.inner != null) query.inner = String(ref.inner);
    return `${hostBase(ctx.computer)}/v1/transcripts/blob?${new URLSearchParams(query)}`;
  }

  function imageThumb(ref, cleanups) {
    const button = h("button", "ct-image");
    button.type = "button";
    button.setAttribute("aria-label", "Image");
    button._load = async () => {
      try {
        const response = await fetch(imageUrl(ref));
        if (!response.ok) throw new Error(String(response.status));
        const objectUrl = URL.createObjectURL(await response.blob());
        cleanups.push(() => URL.revokeObjectURL(objectUrl));
        const img = h("img", "ct-image-img");
        img.alt = "Transcript image";
        img.src = objectUrl;
        // Bytes that are not a picture the browser can draw show as unavailable.
        await img.decode();
        button.replaceChildren(img);
        button.classList.add("loaded");
        button.addEventListener("click", () => openLightbox(objectUrl, img.alt));
      } catch {
        button.classList.add("failed");
        button.replaceChildren(h("span", "ct-image-fail", "Image unavailable"));
      }
    };
    imageObserver.observe(button);
    cleanups.push(() => imageObserver.unobserve(button));
    return button;
  }

  /** Thumbnails for the images across `messages`, or null when there are none. */
  function buildImageStrip(messages) {
    const refs = [];
    const seen = new Set();
    for (const message of messages || []) {
      for (const block of message.imageBlocks || []) refs.push({ kind: "block", line: message.line, block, inner: null });
      for (const ref of message.resultImages || []) refs.push({ kind: "block", line: message.line, block: ref.block, inner: ref.inner });
      for (const path of message.uploadImages || []) refs.push({ kind: "upload", path });
    }
    const unique = refs.filter((ref) => {
      const key = ref.kind === "upload" ? `u:${ref.path}` : `b:${ref.line}:${ref.block}:${ref.inner ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length === 0) return null;
    const strip = h("div", "ct-images");
    const cleanups = [];
    for (const ref of unique) strip.append(imageThumb(ref, cleanups));
    strip._cleanup = () => { for (const fn of cleanups) fn(); };
    return strip;
  }

  /** Rendered markdown, with path-like inline code made clickable. */
  function renderMarkdown(el, text) {
    renderMarkdownInto(el, text);
    if (ctx.openFile) for (const code of el.querySelectorAll("code.ct-md-code")) linkCodePath(code);
    return el;
  }

  /** Turn one path-like code span into a button that resolves before opening. */
  function linkCodePath(code) {
    const ref = fileReference(code.textContent);
    if (!ref) return;
    code.classList.add("ct-md-code-path");
    code.setAttribute("role", "button");
    code.tabIndex = 0;
    const open = () => resolveFileReference(code, ref);
    code.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); open(); });
    code.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  }

  async function resolveFileReference(code, ref) {
    code.classList.add("ct-path-resolving");
    try {
      const resolved = await hookGet(ctx.computer, "/v1/files/resolve", { ...(ctx.target || {}), path: ref.path });
      code.classList.remove("ct-path-resolving");
      ctx.openFile(resolved.path, { line: ref.line });
    } catch {
      code.classList.remove("ct-path-resolving");
      code.classList.add("ct-path-missing");
      code.title = "Not found in this repository";
      setTimeout(() => code.classList.remove("ct-path-missing"), 1_200);
    }
  }

  function reconcile(ordered) {
    const wanted = new Set(ordered);
    for (const child of [...column.children]) if (!wanted.has(child)) child.remove();
    let ref = column.firstChild;
    for (const el of ordered) {
      if (el === ref) { ref = ref.nextSibling; }
      else { column.insertBefore(el, ref); }
    }
  }

  function render(preparation, preview) {
    lastPreparation = preparation;
    lastPreview = preview;
    const entries = (preparation && preparation.entries) || [];
    const jobs = (preparation && preparation.jobs) || [];
    const stick = isAtBottom();
    const beforeHeight = scroll.scrollHeight;
    const beforeTop = scroll.scrollTop;

    const ordered = [];
    jobsEl = updateJobs(jobsEl, jobs);
    if (jobsEl) ordered.push(jobsEl);

    const ids = entries.map((entry, index) => entry.id || entry.placeholderIdentifier || `row:${index}`);
    const turns = groupTurns(entries);
    foldHidden = turns.length > 2 && !expandedAll;
    const hidden = new Set();
    if (turns.length > 2) {
      let count = 0;
      const hiddenTurns = expandedAll ? [] : turns.slice(0, turns.length - 2);
      for (const turn of hiddenTurns) for (const entry of turn) {
        hidden.add(entry);
        if (countsAsMessage(entry)) count += 1;
      }
      ordered.push(buildFold(count));
    }

    const live = [];
    const seen = new Set();
    entries.forEach((entry, index) => {
      const id = ids[index];
      seen.add(id); // hidden rows keep their cache so expanding is instant
      if (hidden.has(entry)) return;
      const key = entryKey(entry);
      let row = rows.get(id);
      if (!row || row.key !== key) {
        const built = buildEntry(entry);
        if (row) {
          row.cleanup?.();
          if (row.el.parentNode) row.el.replaceWith(built.el);
        }
        row = built;
        rows.set(id, row);
      }
      if (row.live) live.push(row.live);
      ordered.push(row.el);
    });
    for (const [id, row] of [...rows]) if (!seen.has(id)) { row.cleanup?.(); row.el.remove(); rows.delete(id); }

    if (previewRow) { previewRow.remove(); previewRow = null; }
    if (preview && preview.text) {
      previewRow = buildPreview(preview);
      ordered.push(previewRow);
    }
    reconcile(ordered);

    liveUpdaters = live;
    if (stick) {
      scrollToBottom();
    } else {
      scroll.scrollTop = beforeTop + (scroll.scrollHeight - beforeHeight);
    }
    updateJump();
  }

  /** The fold row at the top of the column: N previous messages, or hide earlier. */
  function buildFold(count) {
    const button = h("button", "ct-fold");
    button.type = "button";
    button.textContent = expandedAll
      ? "Hide earlier messages ‹"
      : `${count} previous message${count === 1 ? "" : "s"} ›`;
    button.addEventListener("click", () => {
      expandedAll = !expandedAll;
      render(lastPreparation, lastPreview);
    });
    return button;
  }

  /** Rendered markdown, cut to a bounded preview with a Show more toggle. */
  function limitedMarkdown(text, lines = 40, characters = 6_000) {
    const wrap = h("div", "ct-md");
    const preview = new kit.ToolOutputPreview(text, lines, characters);
    renderMarkdown(wrap, preview.text);
    if (!preview.truncated) return wrap;
    const more = h("button", "ct-more", "Show more");
    more.type = "button";
    let open = false;
    more.addEventListener("click", () => {
      open = !open;
      renderMarkdown(wrap, open ? text : preview.text);
      more.textContent = open ? "Show less" : "Show more";
    });
    const holder = h("div", "ct-md-wrap");
    holder.append(wrap, more);
    return holder;
  }

  function buildEntry(entry) {
    let el; let live;
    if (entry.turnActivity) el = buildActivity(entry.turnActivity, (fn) => { live = fn; });
    else if (entry.pendingEcho) el = buildPendingEcho(entry.pendingEcho);
    else if (entry.turnChanges) el = buildTurnChanges(entry.turnChanges);
    else if (entry.messages[0] && entry.messages[0].isHookContext) el = buildHookContext(entry.messages[0]);
    else if (entry.messages[0] && entry.messages[0].isNarration) el = buildNarration(entry.messages[0]);
    else if (entry.messages[0] && entry.messages[0].isScheduled) el = buildScheduled(entry.messages[0]);
    else if (entry.messages[0] && entry.messages[0].isCompaction) el = buildCompaction(entry.messages[0]);
    else if (entry.phren) el = buildPhrenCard(entry.phren, entry);
    else if (entry.card) el = buildToolCard(entry);
    else if (entry.isReadRun) el = buildReadRun(entry);
    else if (entry.isActivity) el = buildToolRow(entry.messages);
    else el = buildMessage(entry);
    const cleanup = () => { for (const strip of el.querySelectorAll(".ct-images")) strip._cleanup?.(); };
    return { el, key: entryKey(entry), live, cleanup };
  }

  function buildMessage(entry) {
    const message = entry.messages[0];
    if (!message) return h("div", "ct-empty");
    if (message.localCommand) return buildLocalCommand(message);
    if (message.role === "user") return buildUserBubble(message);
    return buildAssistant(message);
  }

  function buildUserBubble(message) {
    const row = h("div", "ct-msg-row ct-user-row");
    const spoken = /^\s*\[voice\]/i.test(message.text);
    if (spoken) row.append(h("span", "ct-spoken", "mic"));
    const bubble = h("div", "ct-user-bubble");
    renderMarkdown(bubble, kit.VoiceMarker.hidden(message.text));
    if (message.isQueued) bubble.append(h("div", "ct-queued", "Queued in the agent"));
    const images = buildImageStrip([message]);
    if (images) bubble.append(images);
    row.append(bubble);
    return row;
  }

  function buildAssistant(message) {
    const row = h("div", "ct-msg-row ct-assistant-row");
    row.append(limitedMarkdown(message.text));
    const images = buildImageStrip([message]);
    if (images) row.append(images);
    return row;
  }

  function buildLocalCommand(message) {
    const command = message.localCommand;
    if (command.kind === "output" && !command.text) return h("div", "ct-empty");
    const row = h("div", "ct-command");
    const icon = command.kind === "command" ? "❯" : command.kind === "shell" ? "❯" : "↳";
    row.append(h("span", "ct-command-icon", icon));
    row.append(h("span", "ct-command-text", new kit.ToolOutputPreview(command.text, 12, 2_000).text));
    return row;
  }

  function diffLine(line, kind, segments) {
    const row = h("div", `ct-diff-line ct-diff-${kind}`);
    row.append(h("span", "ct-diff-num", line.oldLine != null ? String(line.oldLine) : ""));
    row.append(h("span", "ct-diff-num", line.newLine != null ? String(line.newLine) : ""));
    const text = h("span", "ct-diff-text");
    text.append(h("span", "ct-diff-sign", kind === "add" ? "+" : kind === "del" ? "−" : " "));
    if (segments) {
      for (const segment of segments) text.append(h("span", segment.changed ? "ct-diff-changed" : null, segment.text));
    } else {
      text.append(document.createTextNode(line.text));
    }
    row.append(text);
    return row;
  }

  /** A unified diff as numbered rows, pairing removed and added lines for word tints. */
  function buildDiff(patch, limit = 40) {
    const box = h("div", "ct-diff");
    let shown = 0;
    for (const hunk of parsePatch(patch || "")) {
      if (shown >= limit) break;
      box.append(h("div", "ct-diff-hunk", `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`));
      let i = 0;
      while (i < hunk.lines.length && shown < limit) {
        const line = hunk.lines[i];
        const next = hunk.lines[i + 1];
        if (line.kind === "del" && next && next.kind === "add") {
          const segments = wordSegments(line.text, next.text);
          box.append(diffLine(line, "del", segments.old));
          box.append(diffLine(next, "add", segments.new));
          i += 2; shown += 2; continue;
        }
        box.append(diffLine(line, line.kind, null));
        i++; shown++;
      }
    }
    if (shown >= limit) box.append(h("div", "ct-diff-cut", "Preview truncated."));
    return box;
  }

  /** One call and its output, in full, inside an expanded pill or run. */
  function toolDetailRows(messages) {
    const wrap = h("div", "ct-tool-detail");
    for (const message of messages) {
      const presentation = message.isToolResult ? null : kit.ToolPresentationCache.value(message);
      if (message.isChange) {
        wrap.append(h("div", "ct-detail-label", "Changes"));
        wrap.append(buildDiff(message.text, 12));
        continue;
      }
      if (presentation && presentation.patch) {
        wrap.append(buildDiff(presentation.patch, message.isChange ? 12 : 8));
        continue;
      }
      wrap.append(h("div", "ct-detail-label", message.isToolResult ? "Output" : (presentation?.title ?? "Input")));
      const body = presentation && !message.isToolResult ? presentation.body : kit.ToolPresentation.unwrap(message.text);
      const pre = h("pre", "ct-pre");
      pre.textContent = body === "" ? (message.isToolResult ? "No output" : "No input") : new kit.ToolOutputPreview(body, 12, 2_000).text;
      wrap.append(pre);
      if (presentation && presentation.path && ctx.openFile) {
        const open = h("button", "ct-link-btn", `Open ${presentation.path.split("/").pop()}`);
        open.type = "button";
        open.addEventListener("click", () => ctx.openFile(presentation.path, { line: null }));
        wrap.append(open);
      }
    }
    return wrap;
  }

  function buildToolRow(messages, withImages = true) {
    const summary = new kit.ChatToolSummary(messages);
    const box = h("div", "ct-toolbox");
    const button = h("button", "ct-toolrow");
    button.type = "button";
    button.append(h("span", "ct-icon", glyph(summary.icon)));
    button.append(h("span", "ct-toolrow-title", summary.title));
    if (summary.count > 1) button.append(h("span", "ct-toolrow-count", `×${summary.count}`));
    const preview = h("span", `ct-toolrow-preview${summary.previewIsPath ? " is-path" : ""}`);
    const previewPath = summary.previewIsPath ? pathButton(summary.preview, ctx.openFile) : null;
    if (previewPath) preview.append(previewPath); else preview.textContent = summary.preview;
    button.append(preview);
    button.append(statusMark(summary.status));
    const chevron = h("span", "ct-chevron", "⌄");
    button.append(chevron);
    box.append(button);
    const detail = h("div", "ct-toolbox-body");
    detail.hidden = true;
    box.append(detail);
    const images = withImages ? buildImageStrip(messages) : null;
    if (images) box.append(images);
    let filled = false;
    button.addEventListener("click", () => {
      const open = detail.hidden;
      detail.hidden = !open;
      chevron.classList.toggle("open", open);
      if (open && !filled) { detail.append(toolDetailRows(messages)); filled = true; }
    });
    return box;
  }

  function buildReadRun(entry) {
    const run = entry.readRun;
    const box = h("div", "ct-toolbox ct-run");
    const button = h("button", "ct-toolrow");
    button.type = "button";
    button.append(h("span", "ct-icon", run.sameTool ? glyph(kit.ChatToolSummary.icon(run.sameTool)) : glyph("doc.text.magnifyingglass")));
    button.append(h("span", "ct-toolrow-title", run.title));
    const runPreview = h("span", "ct-toolrow-preview");
    const runPath = pathButton(run.preview, ctx.openFile);
    if (runPath) runPreview.append(runPath); else runPreview.textContent = run.preview;
    button.append(runPreview);
    button.append(statusMark(run.status));
    const chevron = h("span", "ct-chevron", "⌄");
    button.append(chevron);
    box.append(button);
    const body = h("div", "ct-toolbox-body");
    body.hidden = true;
    box.append(body);
    const images = buildImageStrip(run.groups.flatMap((group) => group.messages || []));
    if (images) box.append(images);
    let filled = false;
    button.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      chevron.classList.toggle("open", open);
      if (open && !filled) {
        for (const group of run.groups) {
          if (group.card) body.append(buildToolCard(group));
          else body.append(buildToolRow(group.messages, false));
        }
        filled = true;
      }
    });
    return box;
  }

  function buildPreview(preview) {
    const row = h("div", "ct-msg-row ct-assistant-row ct-preview");
    const body = h("div", "ct-md ct-preview-md");
    renderMarkdown(body, preview.text);
    body.append(h("span", "ct-caret", "▍"));
    row.append(body);
    return row;
  }

  function buildActivity(activity, registerLive) {
    const row = h("div", "ct-activity");
    if (activity.isLive) {
      row.classList.add("is-live");
      row.append(h("span", "ct-activity-arc", "◜"));
      row.append(h("span", "ct-activity-verb", activity.verb));
      const time = h("span", "ct-activity-time");
      row.append(time);
      const update = () => {
        const elapsed = kit.AgentChatProgress.elapsed(activity.startedAt, activity.finishedAt, activity.phase, new Date().toISOString());
        time.textContent = kit.ChatTurnActivity.duration(elapsed === null ? 0 : elapsed / 1000);
      };
      update();
      registerLive(update);
    } else {
      row.classList.add("is-finished");
      const note = h("span", "ct-activity-note", activity.label(activity.finishedAt ?? activity.startedAt));
      row.append(note);
      row.title = activity.label(activity.finishedAt ?? activity.startedAt);
    }
    return row;
  }

  function pendingNote(message, echo) {
    const note = h("div", "ct-pending-note");
    note.append(h("div", "ct-pending-warning", message));
    const actions = h("div", "ct-pending-actions");
    const remove = h("button", "ct-link-btn", "Remove copy");
    remove.type = "button";
    remove.addEventListener("click", () => note.remove());
    actions.append(remove);
    if (echo && ctx.insert) {
      const review = h("button", "ct-link-btn accent", "Review");
      review.type = "button";
      review.addEventListener("click", () => ctx.insert(echo.text));
      actions.append(review);
    }
    note.append(actions);
    return note;
  }

  function buildPendingEcho(echo) {
    const row = h("div", "ct-msg-row ct-user-row ct-pending");
    const bubble = h("div", "ct-user-bubble");
    renderMarkdown(bubble, kit.VoiceMarker.hidden(echo.text));
    row.append(bubble);
    if (echo.deliveryState === "queued") bubble.append(h("div", "ct-queued", "Queued — sends when the agent is ready"));
    else if (echo.deliveryState === "blocked") row.append(pendingNote("Not delivered. Review and send again.", echo));
    else if (echo.submittedAt && Date.now() - Date.parse(echo.submittedAt) >= kit.CHAT_PENDING_ECHO_STALE_AFTER_SECONDS * 1000) {
      row.append(pendingNote("Not confirmed in chat. Check the terminal before sending again.", echo));
    }
    return row;
  }

  function diffCounts(added, removed) {
    const counts = h("span", "ct-counts");
    counts.append(h("span", "ct-added", `+${added}`), h("span", "ct-removed", `−${removed}`));
    return counts;
  }

  function buildTurnChanges(changes) {
    const box = h("div", "ct-changes");
    const button = h("button", "ct-changes-row");
    button.type = "button";
    button.append(h("span", "ct-icon", "±"));
    button.append(h("span", "ct-changes-title", changes.title));
    button.append(diffCounts(changes.added, changes.removed));
    button.append(h("span", "ct-chevron", "›"));
    box.append(button);
    const body = h("div", "ct-changes-body");
    body.hidden = true;
    box.append(body);
    let filled = false;
    button.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      button.querySelector(".ct-chevron").classList.toggle("open", open);
      if (open && !filled) {
        for (const file of changes.files) {
          const head = h("div", "ct-diff-file");
          head.append(h("span", `ct-badge ct-badge-${file.status}`, file.status));
          const path = h("button", "ct-path-btn", file.path);
          path.type = "button";
          if (ctx.openFile) path.addEventListener("click", () => ctx.openFile(file.path, { diff: true }));
          head.append(path, diffCounts(file.added, file.removed));
          body.append(head, buildDiff(file.patch, 60));
        }
        filled = true;
      }
    });
    return box;
  }

  function expandable(header, body, className) {
    const box = h("div", className);
    header.type = "button";
    box.append(header);
    body.hidden = true;
    box.append(body);
    header.addEventListener("click", () => {
      body.hidden = !body.hidden;
      header.querySelector(".ct-chevron")?.classList.toggle("open", !body.hidden);
    });
    return box;
  }

  function buildHookContext(message) {
    const first = message.text.split("\n", 1)[0].replace(/◆/g, "").trim();
    const header = h("button", "ct-note-row");
    header.append(h("span", "ct-note-mark", "◆"));
    header.append(h("span", "ct-note-text", first || "phren context"));
    header.append(h("span", "ct-chevron", "⌄"));
    const body = h("pre", "ct-pre ct-note-body");
    body.textContent = message.text;
    return expandable(header, body, "ct-hook-context");
  }

  function buildNarration(message) {
    const note = message.text.replace(/^\s+|\s+$/g, "");
    const line = h("button", "ct-narration");
    line.append(h("span", "ct-narration-label", "Thinking: "));
    line.append(h("span", "ct-narration-text", note));
    let open = false;
    line.addEventListener("click", () => {
      open = !open;
      line.querySelector(".ct-narration-text").textContent = open ? note : note.replace(/\n/g, " ");
      line.classList.toggle("open", open);
    });
    return line;
  }

  function buildScheduled(message) {
    const header = h("button", "ct-note-row");
    header.append(h("span", "ct-note-mark", "◷"));
    header.append(h("span", "ct-note-text", "Scheduled check"));
    header.append(h("span", "ct-chevron", "⌄"));
    const body = h("div", "ct-note-body");
    body.append(h("pre", "ct-pre", new kit.ToolOutputPreview(message.text, 40, 6_000).text));
    return expandable(header, body, "ct-scheduled");
  }

  function buildCompaction(message) {
    const line = h("button", "ct-compaction");
    line.append(h("span", "ct-note-mark", "↻"));
    line.append(h("span", null, "Conversation compacted"));
    if (!message.text) { line.disabled = true; return line; }
    const body = h("pre", "ct-pre ct-note-body");
    body.textContent = message.text;
    return expandable(line, body, "ct-compaction-box");
  }

  function buildToolCard(entry) {
    const card = entry.card;
    switch (card.kind) {
      case "agent": return buildAgentCard(card.value, entry);
      case "todos": return buildTodoCard(card.value, entry);
      case "plan": return buildPlanCard(card.value, entry);
      case "planMode": return buildPlanMode();
      case "web": return buildWebCard(card.value, entry);
      case "skill": return buildSkillChip(card.value, entry);
      case "mcp": return buildMcpCard(card.value, entry);
      default: return h("div", "ct-empty");
    }
  }

  function buildAgentCard(agent, entry) {
    const card = h("div", "ct-card ct-agent-card");
    const head = h("div", "ct-card-head");
    head.append(h("span", "ct-icon", glyph("person")));
    head.append(h("span", "ct-card-title", agent.name));
    if (agent.background) head.append(chip("background"));
    if (agent.model) head.append(chip(agent.model));
    if (agent.description) head.append(h("span", "ct-card-summary", agent.description));
    head.append(statusMark(agent.state === "failed" ? "failed" : agent.state === "running" ? "running" : "done"));
    card.append(head);
    if (agent.report) card.append(limitedMarkdown(agent.report, 8, 1_000));
    if (ctx.openSubagent && entry.messages[0]) {
      const open = h("button", "ct-link-btn accent", "Open");
      open.type = "button";
      open.addEventListener("click", () => ctx.openSubagent(entry));
      card.append(open);
    }
    return card;
  }

  function buildTodoCard(list, entry) {
    const card = h("div", "ct-card ct-todo-card");
    let expanded = false;
    const folded = () => entry.cardSuperseded && !expanded;
    const header = h("button", "ct-card-head ct-card-toggle");
    header.type = "button";
    header.append(h("span", "ct-icon", glyph("checklist")));
    header.append(h("span", "ct-card-title", list.title));
    header.append(h("span", "ct-card-summary", list.summary));
    if (entry.cardSuperseded) header.append(h("span", "ct-chevron", "⌄"));
    card.append(header);
    const body = h("div", "ct-card-body");
    card.append(body);
    const paint = () => {
      const show = !folded();
      body.hidden = !show;
      header.querySelector(".ct-chevron")?.classList.toggle("open", show);
      body.replaceChildren();
      if (!show) return;
      if (list.note) body.append(h("div", "ct-card-note", list.note));
      const limit = expanded ? list.items.length : 12;
      list.items.slice(0, limit).forEach((item) => {
        const row = h("div", `ct-todo-item is-${item.status}`);
        row.append(h("span", "ct-todo-glyph", item.status === "done" ? glyph("checkmark.circle.fill") : item.status === "active" ? glyph("circle.lefthalf.filled") : glyph("circle")));
        row.append(h("span", "ct-todo-text", item.text));
        body.append(row);
      });
      if (!expanded && list.items.length > 12) {
        const more = h("button", "ct-more", `+${list.items.length - 12} more`);
        more.type = "button";
        more.addEventListener("click", () => { expanded = true; paint(); });
        body.append(more);
      }
    };
    header.addEventListener("click", () => { if (entry.cardSuperseded) { expanded = !expanded; paint(); } });
    paint();
    return card;
  }

  function buildPlanCard(plan, entry) {
    const card = h("div", "ct-card ct-plan-card");
    let opened = false;
    const header = h("button", "ct-card-head ct-card-toggle");
    header.type = "button";
    header.append(h("span", "ct-icon", glyph("map")));
    header.append(h("span", "ct-card-title", "Plan ready for review"));
    const stateLabel = plan.state === "pending" ? "Awaiting your answer" : plan.state === "approved" ? "Approved" : "Kept planning";
    header.append(h("span", `ct-card-summary${plan.state === "pending" ? " warning" : ""}`, stateLabel));
    if (plan.state === "pending") header.append(h("span", "ct-chevron", "⌄"));
    card.append(header);
    const body = h("div", "ct-card-body");
    card.append(body);
    const paint = () => {
      const folded = plan.state === "pending" && !opened;
      body.hidden = folded;
      header.querySelector(".ct-chevron")?.classList.toggle("open", !folded);
      body.replaceChildren();
      if (folded) return;
      body.append(limitedMarkdown(plan.plan, 14, 2_000));
    };
    header.addEventListener("click", () => { if (plan.state === "pending") { opened = !opened; paint(); } });
    paint();
    return card;
  }

  function buildPlanMode() {
    const row = h("div", "ct-command");
    row.append(h("span", "ct-command-icon", glyph("map")));
    row.append(h("span", "ct-command-text", "Entered plan mode"));
    return row;
  }

  function callStatusMark(status) {
    return statusMark(status === "failed" ? "failed" : status === "running" ? "running" : "done");
  }

  function buildWebCard(web, entry) {
    const card = h("div", "ct-card ct-web-card");
    const header = h("button", "ct-card-head ct-card-toggle");
    header.type = "button";
    header.append(h("span", "ct-icon", glyph("globe")));
    header.append(h("span", "ct-card-title", web.location));
    header.append(callStatusMark(web.status));
    header.append(h("span", "ct-chevron", "⌄"));
    card.append(header);
    const body = h("div", "ct-card-body");
    body.hidden = true;
    card.append(body);
    let filled = false;
    header.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      header.querySelector(".ct-chevron").classList.toggle("open", open);
      if (!open || filled) return;
      filled = true;
      if (web.url && web.url !== web.location) body.append(h("div", "ct-card-url", web.url));
      if (web.prompt) body.append(h("div", "ct-card-note", web.prompt));
      if (web.status === "running") body.append(h("div", "ct-card-note", web.kind === "fetch" ? "Fetching…" : "Searching…"));
      else if (web.resultMarkdown) body.append(limitedMarkdown(web.resultMarkdown, kit.WebToolPresentation.PREVIEW_LINES, 4_000));
      else body.append(h("div", "ct-card-note", "No result"));
    });
    return card;
  }

  function buildSkillChip(skill, entry) {
    const card = h("div", "ct-card ct-skill-card");
    const header = h("button", "ct-card-head ct-card-toggle");
    header.type = "button";
    header.append(h("span", "ct-icon", glyph("sparkles")));
    header.append(h("span", "ct-card-title", skill.command));
    if (skill.args) header.append(h("span", "ct-card-summary", skill.args));
    header.append(callStatusMark(skill.status));
    header.append(h("span", "ct-chevron", "⌄"));
    card.append(header);
    const body = h("div", "ct-card-body");
    body.hidden = true;
    card.append(body);
    let filled = false;
    header.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      header.querySelector(".ct-chevron").classList.toggle("open", open);
      if (!open || filled) return;
      filled = true;
      if (skill.result) body.append(limitedMarkdown(skill.result, 40, 6_000));
      else body.append(h("div", "ct-card-note", "No result"));
    });
    return card;
  }

  function buildMcpCard(mcp, entry) {
    const card = h("div", "ct-card ct-mcp-card");
    const header = h("button", "ct-card-head ct-card-toggle");
    header.type = "button";
    header.append(h("span", "ct-icon", glyph("server.rack")));
    header.append(h("span", "ct-card-title", mcp.verb));
    header.append(h("span", "ct-card-summary", mcp.server));
    const summary = mcp.resultLines[0] ?? (mcp.fields[0] ? `${mcp.fields[0].name}: ${mcp.fields[0].value}` : "");
    if (summary) header.append(h("span", "ct-card-summary", summary));
    header.append(callStatusMark(mcp.status));
    header.append(h("span", "ct-chevron", "⌄"));
    card.append(header);
    const body = h("div", "ct-card-body");
    body.hidden = true;
    card.append(body);
    let filled = false;
    header.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      header.querySelector(".ct-chevron").classList.toggle("open", open);
      if (!open || filled) return;
      filled = true;
      for (const field of mcp.fields) {
        const row = h("div", "ct-field");
        row.append(h("span", "ct-field-name", field.name), h("span", "ct-field-value", field.value));
        body.append(row);
      }
      if (mcp.hiddenFields > 0) body.append(h("div", "ct-card-note", `+${mcp.hiddenFields} more`));
      if (mcp.resultLines.length) {
        const lines = h("pre", `ct-pre${mcp.status === "failed" ? " danger" : ""}`);
        lines.textContent = mcp.resultLines.join("\n") + (mcp.resultTruncated ? "\n…" : "");
        body.append(lines);
      }
    });
    return card;
  }

  function phrenStatusMark(status) {
    if (status === "failed") {
      const failed = h("span", "ct-status ct-status-failed");
      failed.textContent = "Failed";
      return failed;
    }
    return statusMark(status === "running" ? "running" : "done");
  }

  function phrenFoldedSummary(phren) {
    if (phren.status === "failed" && phren.issues.length) return phren.issues[0];
    if (phren.conductor && phren.conductor.kind === "handOff" && phren.status !== "failed") return `→ ${phren.conductor.target}`;
    if (phren.items.length) return `${phren.items.length} ${/finding/i.test(phren.verb) ? "findings" : "tasks"}`;
    return phren.resultSummary ?? (phren.body.split("\n")[0] || phren.titles[0] || "");
  }

  function usageBar(account) {
    const wrap = h("div", "ct-usage-account");
    const head = h("div", "ct-usage-head");
    head.append(h("span", "ct-usage-name", account.name));
    if (account.account) head.append(h("span", "ct-usage-sub", account.account));
    if (account.exhausted) head.append(h("span", "ct-usage-out", account.availableIn ? `Out · back in ${account.availableIn}` : "Out of quota"));
    else if (account.stale && account.age) head.append(h("span", "ct-usage-sub", `${account.age} old`));
    wrap.append(head);
    for (const window of account.windows) {
      const row = h("div", "ct-usage-row");
      row.append(h("span", "ct-usage-window", window.name));
      if (window.usedPercent !== null) {
        const bar = h("span", "ct-usage-bar");
        const fill = h("span", `ct-usage-fill${window.exhausted || window.usedPercent >= 90 ? " danger" : window.usedPercent >= 70 ? " warning" : ""}`);
        fill.style.width = `${Math.max(0, Math.min(100, window.usedPercent))}%`;
        bar.append(fill);
        row.append(bar, h("span", "ct-usage-percent", `${window.usedPercent}%`));
      } else {
        row.append(h("span", "ct-usage-sub", window.reset ? "Reset" : "No percent"));
      }
      if (window.resetsIn) row.append(h("span", "ct-usage-reset", window.resetsIn));
      wrap.append(row);
    }
    if (account.windows.length === 0 && account.spend) wrap.append(h("div", "ct-usage-sub", account.spend));
    return wrap;
  }

  function phrenRows(groups) {
    const wrap = h("div", "ct-rows");
    for (const group of groups) {
      if (group.header) wrap.append(h("div", "ct-rows-header", group.header));
      for (const row of group.rows) {
        const line = h("div", "ct-rows-row");
        const top = h("div", "ct-rows-top");
        top.append(h("span", "ct-rows-title", row.title));
        if (row.trailing) top.append(h("span", "ct-rows-trailing", row.trailing));
        line.append(top);
        if (row.detail) line.append(h("div", "ct-rows-detail", row.detail));
        wrap.append(line);
      }
    }
    return wrap;
  }

  function conductorView(conductor) {
    const wrap = h("div", "ct-conductor");
    if (conductor.kind === "handOff") {
      wrap.append(h("div", "ct-card-summary accent", `→ ${conductor.target}`));
      return wrap;
    }
    if (conductor.kind === "sessions") {
      for (const group of conductor.groups) {
        wrap.append(h("div", "ct-rows-header", group.computer));
        for (const row of group.rows) {
          const line = h("div", "ct-conductor-row");
          line.append(h("span", `ct-dot ct-dot-${row.status}`));
          line.append(h("span", "ct-conductor-name", row.project ?? row.label ?? "Session"));
          if (row.title) line.append(h("span", "ct-conductor-title", row.title));
          if (row.idleFor !== null && row.status !== "working") line.append(h("span", "ct-conductor-idle", idleText(row.idleFor)));
          wrap.append(line);
        }
      }
      for (const missing of conductor.missing) wrap.append(h("div", "ct-card-note", missing));
      return wrap;
    }
    for (const row of conductor.rows) {
      const line = h("div", "ct-return-row");
      const top = h("div", "ct-conductor-row");
      top.append(h("span", `ct-dot ct-dot-${row.state}`));
      top.append(h("span", "ct-conductor-name", row.project ?? row.label ?? "Worker"));
      top.append(h("span", "ct-conductor-title", row.computer));
      top.append(h("span", `ct-return-state is-${row.state}`, returnState(row.state)));
      line.append(top);
      if (row.excerpt) line.append(h("div", "ct-return-excerpt", row.excerpt));
      wrap.append(line);
    }
    return wrap;
  }

  function idleText(seconds) {
    if (seconds < 60) return "now";
    if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
    return `${Math.floor(seconds / 86_400)}d`;
  }

  function returnState(state) {
    return ({ done: "Done", "needs-you": "Needs you", failed: "Failed", blocked: "Blocked" })[state] ?? "Gone";
  }

  function buildPhrenCard(phren, entry) {
    const card = h("div", "ct-card ct-phren-card");
    let expanded = false;
    const header = h("button", "ct-card-head ct-card-toggle");
    header.type = "button";
    header.append(h("span", "ct-mascot", "◆"));
    header.append(h("span", "ct-card-title", phren.verb));
    if (phren.project) header.append(chip(phren.project));
    if (phren.tag) header.append(h("span", "ct-card-tag", phren.tag));
    const summary = h("span", "ct-card-summary", phrenFoldedSummary(phren));
    header.append(summary);
    header.append(phrenStatusMark(phren.status));
    header.append(h("span", "ct-chevron", "⌄"));
    card.append(header);
    const body = h("div", "ct-card-body");
    body.hidden = true;
    card.append(body);
    let filled = false;
    header.addEventListener("click", () => {
      expanded = !expanded;
      body.hidden = !expanded;
      header.querySelector(".ct-chevron").classList.toggle("open", expanded);
      if (expanded && !filled) { fillPhrenBody(body, phren, entry); filled = true; }
    });
    return card;
  }

  function fillPhrenBody(body, phren, entry) {
    if (phren.conductor) body.append(conductorView(phren.conductor));
    else if (phren.items.length) {
      const list = h("div", "ct-items");
      phren.items.forEach((item, index) => {
        const row = h("div", "ct-item");
        row.append(h("span", "ct-item-index", String(index + 1)));
        row.append(h("span", "ct-item-text", item));
        list.append(row);
      });
      body.append(list);
    } else if (phren.body) body.append(h("pre", "ct-pre", phren.body));
    if (phren.detail && phren.detail.kind === "rows") body.append(phrenRows(phren.detail.groups));
    if (phren.detail && phren.detail.kind === "usage") {
      for (const account of phren.detail.accounts) body.append(usageBar(account));
      for (const missing of phren.detail.missing) body.append(h("div", "ct-card-note", missing));
    }
    for (const field of phren.fields) {
      const row = h("div", "ct-field");
      row.append(h("span", "ct-field-name", field.name), h("span", "ct-field-value", field.value));
      body.append(row);
    }
    if (phren.resultSummary) body.append(h("div", `ct-card-summary${phren.status === "failed" ? " danger" : " accent"}`, phren.resultSummary));
    for (const issue of phren.issues) body.append(h("div", "ct-card-note danger", issue));
    for (const title of phren.titles) body.append(h("div", "ct-card-note", `· ${title}`));
    const raw = h("details", "ct-raw");
    raw.append(h("summary", null, "Raw call"));
    raw.append(h("div", "ct-raw-name", phren.toolName));
    raw.append(h("pre", "ct-pre", phren.fullInput));
    if (phren.fullOutput) raw.append(h("pre", "ct-pre", phren.fullOutput));
    body.append(raw);
  }

  function updateJobs(tray, jobs) {
    if (!jobs || jobs.length === 0) { if (tray) tray.remove(); return null; }
    if (!tray) {
      tray = h("div", "ct-jobs");
      tray.dataset.open = "0";
      const head = h("button", "ct-jobs-head");
      head.type = "button";
      tray._head = head;
      tray.append(head);
      const list = h("div", "ct-jobs-list");
      list.hidden = true;
      tray._list = list;
      tray.append(list);
      head.addEventListener("click", () => {
        const open = tray.dataset.open !== "1";
        tray.dataset.open = open ? "1" : "0";
        list.hidden = !open;
        head.querySelector(".ct-chevron").classList.toggle("open", open);
      });
    }
    const running = jobs.filter((job) => job.state.kind === "running").length;
    const head = tray._head;
    head.replaceChildren();
    head.append(h("span", "ct-note-mark", "↻"));
    head.append(h("span", "ct-jobs-title", "Background"));
    head.append(h("span", "ct-jobs-count", running > 0 ? `${running} running` : "done"));
    head.append(h("span", "ct-chevron", tray.dataset.open === "1" ? "open" : ""));
    const list = tray._list;
    list.replaceChildren();
    for (const job of jobs) {
      const row = h("div", "ct-job");
      const top = h("div", "ct-job-top");
      top.append(h("span", `ct-dot ct-dot-${job.state.kind === "running" ? "working" : "done"}`));
      top.append(h("span", "ct-job-title", job.title));
      top.append(h("span", "ct-job-status", jobStatus(job)));
      row.append(top);
      row.append(h("div", "ct-job-command", new kit.ToolOutputPreview(job.command, 4, 640).text));
      if (job.state.kind === "running") { /* ticks via title only */ }
      else if (job.output) row.append(h("pre", "ct-pre", new kit.ToolOutputPreview(job.output, 8, 1_200).text));
      list.append(row);
    }
    return tray;
  }

  function jobStatus(job) {
    const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
    const duration = kit.ElapsedTime.text(Math.max(0, Math.trunc((end - Date.parse(job.startedAt)) / 1000)));
    if (job.state.kind === "running") return `running · ${duration}`;
    const exit = job.state.exitCode !== null && job.state.exitCode !== undefined ? ` · exit ${job.state.exitCode}` : "";
    return `finished${exit} · ${duration}`;
  }

  let liveUpdaters = [];
  const tick = setInterval(() => { for (const fn of liveUpdaters) fn(); if (!atBottom) { /* leave position */ } }, 1000);

  return {
    render,
    scrollToBottom,
    isAtBottom,
    onScrollTop(fn) { onTop.push(fn); },
    destroy() {
      clearInterval(tick);
      imageObserver.disconnect();
      for (const row of rows.values()) row.cleanup?.();
      rows.clear();
      closeLightbox();
      container.classList.remove("ct-root");
      container.replaceChildren();
    },
  };
}
