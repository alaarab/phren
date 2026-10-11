// Phren desktop chat composer. Plain browser ES module, no framework.
// Ports the phone's ChatComposerBar behaviour: a collapsible Background strip,
// a multiline editor above one row of inline-SVG icon buttons, send with
// delivery state, a local queue while the agent works, image attachments, the
// slash-command menu, and worded footer selectors (Permission, Model, Effort,
// plus a context/Fast ring button), each opening its own small popover.
//
// createComposer({ computer, target, provider, branch, onConsole, onAgents,
//   onWorkers, onDictate, onTalk }) -> {
//   el, focus(), insert(text), setStatus(agentStatus), setBackground(jobs),
//   setCounts({ agents, workers }), onDelivery(fn), destroy()
// }
// A left-footer button whose callback is missing is hidden. jobs are
// [{ id, label, state, detail? }]; the collapsed Background strip is
// remembered per target.
// The pure helpers below carry no DOM so they import and test in Node.

import { hookPost, hookGet } from "../api.js";

const PROVIDERS = { claude: "Claude", codex: "Codex", copilot: "Copilot", phren: "Phren", opencode: "OpenCode" };

/** Provider display name. */
export function providerLabel(provider) {
  return PROVIDERS[String(provider || "").toLowerCase()] || "Agent";
}

/** The phone's suggestion catalogue (AgentSlashCommand.swift). */
export const SLASH_CATALOG = {
  codex: ["/model", "/permissions", "/diff", "/review", "/status", "/skills", "/compact", "/resume", "/new", "/mcp"],
  claude: ["/help", "/btw", "/model", "/permissions", "/context", "/usage", "/skills", "/compact", "/resume", "/clear", "/mcp"],
  copilot: ["/help", "/model", "/agent", "/context", "/usage", "/skills", "/compact", "/resume", "/clear", "/mcp"],
  phren: ["/help", "/model", "/provider", "/plan", "/context", "/cost", "/diff", "/review", "/compact", "/resume", "/permissions", "/clear"],
  opencode: ["/help", "/models", "/agents", "/new", "/sessions", "/status", "/diff", "/skills", "/mcps", "/editor", "/themes", "/exit"],
};

const SLASH_DETAILS = {
  "/model": "Choose the model",
  "/permissions": "Manage agent permissions",
  "/diff": "Show the working diff",
  "/review": "Review your changes",
  "/status": "See session status and usage",
  "/skills": "Browse available skills",
  "/compact": "Compact conversation context",
  "/resume": "Continue a previous session",
  "/new": "Start a fresh conversation",
  "/clear": "Start a fresh conversation",
  "/mcp": "Manage connected tools",
  "/help": "Browse agent commands",
  "/provider": "Switch the model provider",
  "/plan": "Plan before acting",
  "/cost": "See this session's cost",
  "/agent": "Choose an agent",
  "/context": "Inspect conversation context",
  "/usage": "See account usage",
  "/btw": "Ask a side question while it works",
  "/models": "Choose the model",
  "/sessions": "Continue a previous session",
  "/mcps": "Manage connected tools",
  "/editor": "Open the editor",
  "/themes": "Choose a theme",
  "/exit": "Exit the agent",
};

/** True when the draft is a slash command (the phone's isCommand). */
export function isSlashCommand(text) {
  return typeof text === "string" && text.startsWith("/");
}

/** /clear and /new replace the conversation and draw no menu. */
export function startsFreshConversation(text) {
  return ["/clear", "/new"].includes(String(text || "").trim().toLowerCase());
}

/** The harness's suggestion list, empty for an unknown provider. */
export function slashCatalog(provider) {
  return SLASH_CATALOG[String(provider || "").toLowerCase()] || [];
}

/** Commands matching a draft typed so far (the phone's suggestions). */
export function slashSuggestions(provider, draft) {
  if (!isSlashCommand(draft) || /\s/.test(draft)) return [];
  const lower = draft.toLowerCase();
  return slashCatalog(provider).filter((name) => name.startsWith(lower));
}

/** The menu rows: {name, detail} for each matching command. */
export function slashMenu(provider, draft) {
  return slashSuggestions(provider, draft).map((name) => ({ name, detail: SLASH_DETAILS[name] || "Open in the agent" }));
}

/** How long a refused slash command waits: 2, 4, 8, 16, then 30 seconds. */
export function busyRetryDelay(refusals) {
  if (!(refusals > 0)) return 0;
  return Math.min(30, 2 * Math.pow(2, Math.min(refusals, 6) - 1));
}

/** The Hook refuses a slash command while its agent works (409 + reason). */
export function isBusyRefusal(status, reason) {
  return status === 409 && typeof reason === "string" && reason.startsWith("This agent is working.");
}

/** A safe upload name for the Hook's zod schema (^[A-Za-z0-9_][A-Za-z0-9_ .()-]{0,199}$, no ".."). */
export function uploadName(name) {
  const cleaned = String(name || "")
    .replace(/[^A-Za-z0-9_ .()-]/g, "_")
    .replace(/\.\./g, "_")
    .slice(0, 200);
  return /^[A-Za-z0-9_]/.test(cleaned) ? cleaned : `image_${cleaned}`.slice(0, 200);
}

/** The phone's footer above uploaded file paths, as the Hook's reader expects. */
export function attachmentText(paths) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === "string" && p);
  return list.length ? `Attached files on this computer:\n${list.join("\n")}` : "";
}

/** The prompt text with the uploaded paths appended the way the phone sends it. */
export function withAttachments(text, paths) {
  const footer = attachmentText(paths);
  return footer ? `${text}\n\n${footer}` : text;
}

/** POST /v1/prompt body. */
export function promptBody(target, text, deliveryId) {
  return { target, text, deliveryId };
}

/** POST /v1/upload body: base64 bytes under the Hook's name rules. */
export function uploadBody(target, name, data) {
  return { target, name: uploadName(name), data };
}

/** POST /v1/model body (effort only where the harness takes one). */
export function modelBody(target, argument, effort) {
  return { target, model: argument, ...(effort ? { effort } : {}) };
}

/** POST /v1/settings body. */
export function settingsBody(target, patch) {
  return { target, ...patch };
}

/** POST /v1/agents/permission-mode body. */
export function permissionBody(target, mode) {
  return { target, mode };
}

/** Whether a delivery state ends the status poll. */
export function deliveryIsFinal(state) {
  return state === "delivered" || state === "failed";
}

/** The effort levels the catalogue says a model takes. */
export function effortLevels(model) {
  return Array.isArray(model && model.efforts) ? model.efforts : [];
}

/** A readable model name, the catalogue's own or the id. */
export function modelTitle(model, provider) {
  if (!model) return providerLabel(provider);
  return model.name || model.id;
}

/** Normalize a GET /v1/models reply into rows. */
export function modelRows(provider, payload) {
  const raw = payload && Array.isArray(payload.models) ? payload.models : [];
  return raw
    .filter((m) => m && typeof m.id === "string" && m.id)
    .slice(0, 64)
    .map((m) => ({
      id: m.id,
      name: typeof m.name === "string" && m.name ? m.name : m.id,
      description: typeof m.description === "string" ? m.description : "",
      isDefault: m.isDefault === true,
      efforts: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.slice(0, 8) : [],
      defaultEffort: typeof m.defaultReasoningEffort === "string" ? m.defaultReasoningEffort : null,
    }));
}

/** A context percentage from any status shape that carries one, else null. */
export function contextPercent(agentStatus) {
  if (!agentStatus) return null;
  const candidates = [agentStatus.contextPercent, agentStatus.context && agentStatus.context.percent,
    agentStatus.settingsState && agentStatus.settingsState.contextPercent];
  for (const value of candidates) {
    if (typeof value === "number" && isFinite(value)) return Math.max(0, Math.min(100, value));
  }
  return null;
}

/** The localStorage key for one target's draft. */
export function draftKey(target) {
  const t = target || {};
  return `phren.composer.draft.${[t.source, t.server, t.pane, t.session].filter(Boolean).join(":")}`;
}

/** Permission mode display labels (AgentPermissionMode.swift). */
const MODE_LABELS = { default: "Default", acceptEdits: "Accept edits", plan: "Plan", auto: "Auto", bypassPermissions: "Bypass permissions" };
export function permissionModeLabel(mode) {
  return MODE_LABELS[mode] || String(mode || "Mode");
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById("pc-style")) return;
  const link = document.createElement("link");
  link.id = "pc-style";
  link.rel = "stylesheet";
  link.href = new URL("./composer.css", import.meta.url).href;
  document.head.appendChild(link);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An inline SVG line icon (1.6 px stroke, currentColor unless coloured). */
function svgIcon(parts, { size = 20, color = "currentColor", fill = "none", width = 1.6 } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", fill);
  svg.setAttribute("stroke", color);
  svg.setAttribute("stroke-width", String(width));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const [tag, attrs] of parts) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const key in attrs) shape.setAttribute(key, String(attrs[key]));
    svg.append(shape);
  }
  return svg;
}
const P = (d) => ["path", { d }];
const L = (x1, y1, x2, y2) => ["line", { x1, y1, x2, y2 }];
const C = (cx, cy, r) => ["circle", { cx, cy, r }];

const ICON = {
  plus: () => svgIcon([P("M12 5v14"), P("M5 12h14")]),
  console: () => svgIcon([P("M5 7l4.5 5L5 17"), L(12, 17, 19, 17)]),
  agents: () => svgIcon([C(9, 8, 3), P("M3.5 20a5.5 5.5 0 0 1 11 0"), P("M16 5.5a3 3 0 0 1 0 5"), P("M17 20a6.5 6.5 0 0 0-3-5.4")]),
  workers: () => svgIcon([C(12, 5, 2), C(5, 19, 2), C(19, 19, 2), P("M12 7v4"), P("M12 11H5v6"), P("M12 11h7v6")]),
  mic: () => svgIcon([P("M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"), P("M5 11a7 7 0 0 0 14 0"), L(12, 18, 12, 21)]),
  waveform: (size = 24) => svgIcon([L(4, 10, 4, 14), L(8, 7, 8, 17), L(12, 4, 12, 20), L(16, 8, 16, 16), L(20, 11, 20, 13)], { size, width: 1.8 }),
  chevron: () => svgIcon([P("M6 9l6 6 6-6")]),
  sliders: () => svgIcon([L(4, 7, 20, 7), L(4, 12, 20, 12), L(4, 17, 20, 17)], { size: 16 }),
  history: () => svgIcon([P("M3 12a9 9 0 1 0 3-6.7L3 8"), P("M3 4v4h4"), P("M12 8v4l3 2")]),
  stop: () => svgIcon([["rect", { x: 7, y: 7, width: 10, height: 10, rx: 2 }]], { fill: "currentColor", width: 0 }),
  up: () => svgIcon([P("M12 20V5"), P("M5 12l7-7 7 7")], { width: 2 }),
};

/**
 * Build the chat composer card.
 * @param {{computer:string, target:object, provider:string, branch?:string,
 *   onConsole?:Function, onAgents?:Function, onWorkers?:Function,
 *   onDictate?:Function, onTalk?:Function}} options
 * @returns {{el:HTMLElement, focus:Function, insert:Function, setStatus:Function, setBackground:Function, setCounts:Function, onDelivery:Function, destroy:Function}}
 */
export function createComposer({ computer, target, provider, branch, onConsole, onAgents, onWorkers, onDictate, onTalk }) {
  ensureStyles();
  const source = String(provider || (target && target.source) || "").toLowerCase();
  const name = providerLabel(source);
  const supportsPicker = ["claude", "codex", "opencode"].includes(source);
  const takesEffort = ["claude", "codex"].includes(source);

  const card = node("div", "pc-card");
  card.style.position = "relative";
  const attachmentsEl = node("div", "pc-attachments"); attachmentsEl.hidden = true;
  const slashEl = node("div", "pc-slash"); slashEl.hidden = true;
  const pendingEl = node("div", "pc-pending"); pendingEl.hidden = true;
  const ghostEl = node("div", "pc-ghost"); ghostEl.hidden = true;
  const input = node("textarea", "pc-input");
  input.rows = 1;
  input.placeholder = `Message ${name}\u2026`;
  input.setAttribute("aria-label", `Message ${name}`);
  const draftError = node("div", "pc-draft-error");
  const notice = node("div", "pc-notice");
  const footer = node("div", "pc-footer");
  card.append(attachmentsEl, slashEl, pendingEl, ghostEl, input, draftError, notice, footer);

  // Background strip above the card: folded by default, remembered per target.
  const wrap = node("div", "pc-wrap");
  const backgroundEl = node("div", "pc-background"); backgroundEl.hidden = true;
  const bgCount = node("span", "pc-bg-count");
  const bgChevron = node("span", "pc-bg-chevron");
  bgChevron.append(ICON.chevron());
  const bgHead = node("button", "pc-bg-head");
  bgHead.append(ICON.history(), node("span", "pc-bg-title", "Background"), bgCount, bgChevron);
  const bgList = node("div", "pc-bg-list"); bgList.hidden = true;
  backgroundEl.append(bgHead, bgList);
  wrap.append(backgroundEl, card);

  // Where-it-runs line under the card: the computer on the left, its branch
  // (when the caller knows one) on the right.
  const where = node("div", "pc-where");
  const whereComputer = node("span", "pc-where-computer");
  whereComputer.append(node("span", "pc-where-icon", "\u2302"), node("span", "pc-where-name", computer || ""));
  const whereBranch = node("span", "pc-where-branch");
  if (branch) whereBranch.append(node("span", "pc-where-icon", "\u2387"), node("span", "pc-where-branch-name", branch));
  where.append(whereComputer, whereBranch);
  wrap.append(where);

  const fileInput = node("input"); fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.multiple = true; fileInput.hidden = true;

  // ---- state ----
  let status = {};
  let working = false;
  let attachments = [];
  let backgroundJobs = [];
  let counts = { agents: 0, workers: 0 };
  const bgKey = `phren.composer.background.${[target && target.source, target && target.server, target && target.pane, target && target.session].filter(Boolean).join(":")}`;
  let backgroundOpen = false;
  try { backgroundOpen = localStorage.getItem(bgKey) === "open"; } catch { /* storage unavailable */ }
  const pendings = new Map();
  let deliveryHandlers = [];
  let modelCache = null;
  let currentModel = "";
  let currentEffort = "";
  let popover = null;
  let popoverBuild = null;
  let slashRows = [];
  let slashIndex = -1;
  let destroyed = false;

  // ---- draft persistence ----
  try {
    const saved = localStorage.getItem(draftKey(target));
    if (saved) input.value = saved;
  } catch { /* storage unavailable */ }

  function saveDraft() {
    try { localStorage.setItem(draftKey(target), input.value); draftError.textContent = ""; }
    catch { draftError.textContent = "Couldn't save this draft on this computer."; }
  }

  // ---- delivery ----
  function emit(id, text, state, reason) {
    for (const fn of deliveryHandlers) {
      try { fn({ deliveryId: id, text, state, ...(reason ? { reason } : {}) }); } catch { /* a listener must not break the composer */ }
    }
  }

  function renderPending() {
    pendingEl.replaceChildren();
    let shown = 0;
    for (const [id, entry] of pendings) {
      if (entry.state === "delivered") continue;
      shown++;
      const row = node("div", "pc-pending-row");
      row.append(node("span", "pc-pending-msg", entry.text || "[image]"));
      row.append(node("span", `pc-pending-state ${entry.state}`, pendingLabel(entry)));
      const remove = node("button", "pc-pending-x", "\u00d7");
      remove.title = "Remove";
      remove.addEventListener("click", () => { cancelPending(id); });
      row.append(remove);
      pendingEl.append(row);
    }
    pendingEl.hidden = shown === 0;
  }

  function pendingLabel(entry) {
    if (entry.state === "failed") return entry.reason ? `Failed: ${entry.reason}` : "Failed";
    if (entry.state === "queued") return "Queued";
    return "Sending\u2026";
  }

  function setPending(id, text, state, reason) {
    const entry = pendings.get(id) || { text };
    entry.text = text;
    entry.state = state;
    entry.reason = reason;
    pendings.set(id, entry);
    renderPending();
    emit(id, entry.text, state, reason);
  }

  function cancelPending(id) {
    const entry = pendings.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    pendings.delete(id);
    renderPending();
    emit(id, entry.text, "failed", "Removed");
  }

  // ---- attachments ----
  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error("Couldn't read that image."));
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(files) {
    for (const file of Array.from(files || [])) {
      if (!file || !String(file.type || "").startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_BYTES) { draftError.textContent = "Choose an image under 8 MB."; continue; }
      try {
        const base64 = await readBase64(file);
        attachments.push({ id: crypto.randomUUID(), name: file.name || "Image", base64, url: `data:${file.type};base64,${base64}` });
      } catch (error) { draftError.textContent = error.message; }
    }
    renderAttachments();
    updateFooter();
  }

  function renderAttachments() {
    attachmentsEl.replaceChildren();
    attachmentsEl.hidden = attachments.length === 0;
    for (const att of attachments) {
      const chip = node("div", "pc-attach");
      const img = node("img"); img.src = att.url; img.alt = att.name;
      chip.append(img);
      const x = node("button", "pc-attach-x", "\u00d7");
      x.title = `Remove ${att.name}`;
      x.addEventListener("click", () => {
        attachments = attachments.filter((a) => a.id !== att.id);
        renderAttachments();
        updateFooter();
      });
      chip.append(x);
      attachmentsEl.append(chip);
    }
  }

  // ---- editor ----
  function grow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 180) + "px";
  }

  function hasDraft() {
    return input.value.trim().length > 0 || attachments.length > 0;
  }

  function onInput() {
    saveDraft();
    grow();
    updateSlash();
    updateGhost();
    updateFooter();
  }

  input.addEventListener("input", onInput);
  input.addEventListener("paste", (event) => {
    const items = event.clipboardData ? event.clipboardData.items : null;
    if (!items) return;
    const files = [];
    for (const item of items) if (item.kind === "file" && String(item.type).startsWith("image/")) files.push(item.getAsFile());
    if (files.length) { event.preventDefault(); addFiles(files); }
  });
  input.addEventListener("keydown", onKeydown);
  card.addEventListener("dragover", (event) => { event.preventDefault(); card.classList.add("pc-drag"); });
  card.addEventListener("dragleave", () => card.classList.remove("pc-drag"));
  card.addEventListener("drop", (event) => {
    event.preventDefault();
    card.classList.remove("pc-drag");
    if (event.dataTransfer && event.dataTransfer.files) addFiles(event.dataTransfer.files);
  });

  // ---- slash menu ----
  function updateSlash() {
    const rows = isSlashCommand(input.value) ? slashMenu(source, input.value) : [];
    slashRows = rows;
    slashIndex = rows.length ? Math.min(Math.max(slashIndex, 0), rows.length - 1) : -1;
    slashEl.replaceChildren();
    slashEl.hidden = rows.length === 0;
    rows.forEach((row, index) => {
      const el = node("div", `pc-slash-row${index === slashIndex ? " selected" : ""}`);
      el.append(node("span", "pc-slash-name", row.name));
      el.append(node("span", "pc-slash-detail", row.detail));
      el.addEventListener("mousedown", (event) => { event.preventDefault(); chooseCommand(row.name); });
      slashEl.append(el);
    });
  }

  function chooseCommand(commandName) {
    input.value = `${commandName} `;
    input.focus();
    onInput();
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      if (popover) { closePopover(); event.preventDefault(); return; }
      if (!slashEl.hidden) { slashEl.hidden = true; event.preventDefault(); }
      return; // never sends Stop by key alone
    }
    if (!slashEl.hidden && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      if (!slashRows.length) return;
      slashIndex = (slashIndex + (event.key === "ArrowDown" ? 1 : -1) + slashRows.length) % slashRows.length;
      updateSlash();
      return;
    }
    if (event.key !== "Enter") return;
    if (event.shiftKey) return; // newline
    const sendShortcut = event.metaKey || event.ctrlKey;
    if (sendShortcut) { event.preventDefault(); send(); return; }
    if (!slashEl.hidden) {
      event.preventDefault();
      if (slashIndex >= 0 && slashRows[slashIndex]) chooseCommand(slashRows[slashIndex].name);
      else send();
      return;
    }
    event.preventDefault();
    send();
  }

  // ---- sending ----
  async function uploadAll(list) {
    const paths = [];
    for (const att of list) {
      const res = await hookPost(computer, "/v1/upload", uploadBody(target, att.name, att.base64));
      if (res && typeof res.path === "string") paths.push(res.path);
    }
    return paths;
  }

  async function send() {
    if (!hasDraft()) return;
    if (popover) closePopover();
    const text = input.value;
    const sending = attachments.slice();
    const id = crypto.randomUUID();
    input.value = "";
    attachments = [];
    slashEl.hidden = true;
    renderAttachments();
    grow(); saveDraft(); updateSlash(); updateFooter(); updateGhost();
    setPending(id, text || "[image]", "pending");
    await deliver(id, text, sending, 1);
  }

  async function deliver(id, text, sending, refusals) {
    if (destroyed || !pendings.has(id)) return;
    try {
      const paths = await uploadAll(sending);
      const res = await hookPost(computer, "/v1/prompt", promptBody(target, withAttachments(text, paths), id));
      applyPromptReply(id, text, res);
    } catch (error) {
      const reason = (error && error.body && error.body.error) || (error && error.message);
      if (isBusyRefusal(error && error.status, reason)) {
        setPending(id, text || "[image]", "queued");
        const entry = pendings.get(id);
        if (entry) entry.timer = setTimeout(() => deliver(id, text, sending, refusals + 1), busyRetryDelay(refusals) * 1000);
        return;
      }
      setPending(id, text || "[image]", "failed", reason || "Send failed");
      if (!input.value && text) { input.value = text; onInput(); }
    }
  }

  function applyPromptReply(id, text, res) {
    if (res && (res.state === "delivered" || res.delivered === true)) { settleDelivered(id, text); return; }
    if (res && res.state === "failed") { setPending(id, text || "[image]", "failed", res.reason); return; }
    setPending(id, text || "[image]", "queued");
    pollStatus(id, text);
  }

  function pollStatus(id, text) {
    const entry = pendings.get(id);
    if (!entry) return;
    entry.timer = setTimeout(async () => {
      if (destroyed || !pendings.has(id)) return;
      try {
        const res = await hookPost(computer, "/v1/prompt/status", { target, deliveryId: id });
        const state = res && res.state;
        if (state === "delivered") { settleDelivered(id, text); return; }
        if (state === "failed") { setPending(id, text || "[image]", "failed", res.reason); return; }
        setPending(id, text || "[image]", "queued");
      } catch { /* keep the last state, ask again */ }
      pollStatus(id, text);
    }, 2000);
  }

  function settleDelivered(id, text) {
    setPending(id, text || "[image]", "delivered");
    const entry = pendings.get(id);
    if (entry) entry.timer = setTimeout(() => { pendings.delete(id); renderPending(); }, 1200);
  }

  async function stop() {
    try { await hookPost(computer, "/v1/keys", { target, keys: ["Escape"] }); notice.textContent = ""; }
    catch (error) { notice.textContent = (error && error.message) || "Stop failed"; }
  }

  // ---- footer: icon buttons, worded selectors, mic, talk, primary ----
  function iconButton(title, icon) {
    const button = node("button", "pc-icon");
    button.title = title;
    button.append(icon);
    return button;
  }
  // A small worded selector: a label with a chevron, opening its own popover.
  function selectButton(title) {
    const button = node("button", "pc-select");
    button.title = title;
    const label = node("span", "pc-select-label");
    const chevron = node("span", "pc-select-chevron");
    chevron.append(ICON.chevron());
    button.append(label, chevron);
    return { button, label };
  }
  const attachBtn = iconButton("Add attachment", ICON.plus());
  const consoleBtn = onConsole ? iconButton("Console", ICON.console()) : null;
  const agentsBtn = onAgents ? iconButton("Agents", ICON.agents()) : null;
  const workersBtn = onWorkers ? iconButton("Workers", ICON.workers()) : null;
  const workerBadge = node("span", "pc-badge"); workerBadge.hidden = true;
  if (workersBtn) workersBtn.append(workerBadge);
  const permissionSelect = selectButton("Permission mode");
  const modelSelect = selectButton("Model");
  const modelPlain = node("span", "pc-select-plain", name);
  const effortSelect = selectButton("Effort");
  effortSelect.button.hidden = true;
  const extrasBtn = node("button", "pc-ring-btn");
  extrasBtn.title = "Context and settings";
  extrasBtn.hidden = true;
  const spacer = node("div", "pc-spacer");
  const micBtn = onDictate ? iconButton("Dictate message", ICON.mic()) : null;
  const talkBtn = onTalk ? node("button", "pc-talk") : null;
  if (talkBtn) { talkBtn.title = "Talk"; talkBtn.append(ICON.waveform(22)); }
  const primaryBtn = node("button", "pc-primary");
  footer.append(attachBtn);
  if (consoleBtn) footer.append(consoleBtn);
  if (agentsBtn) footer.append(agentsBtn);
  if (workersBtn) footer.append(workersBtn);
  footer.append(spacer, permissionSelect.button);
  footer.append(supportsPicker ? modelSelect.button : modelPlain);
  footer.append(effortSelect.button, extrasBtn);
  if (micBtn) footer.append(micBtn);
  if (talkBtn) footer.append(talkBtn);
  footer.append(primaryBtn, fileInput);

  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });
  if (consoleBtn) consoleBtn.addEventListener("click", () => onConsole());
  if (agentsBtn) agentsBtn.addEventListener("click", () => onAgents());
  if (workersBtn) workersBtn.addEventListener("click", () => onWorkers());
  if (micBtn) micBtn.addEventListener("click", () => onDictate());
  if (talkBtn) talkBtn.addEventListener("click", () => onTalk());
  permissionSelect.button.addEventListener("click", (event) => { event.stopPropagation(); openPopover(permissionSelect.button, drawModes); });
  modelSelect.button.addEventListener("click", (event) => { event.stopPropagation(); openModelsMenu(modelSelect.button); });
  effortSelect.button.addEventListener("click", (event) => { event.stopPropagation(); openPopover(effortSelect.button, drawEfforts); });
  extrasBtn.addEventListener("click", (event) => { event.stopPropagation(); openPopover(extrasBtn, drawExtras); });
  primaryBtn.addEventListener("click", () => { if (working && !hasDraft()) stop(); else send(); });

  function buildRing(percent) {
    if (percent === null) return null;
    const radius = 9, circ = 2 * Math.PI * radius;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "pc-ring");
    svg.setAttribute("width", "22"); svg.setAttribute("height", "22"); svg.setAttribute("viewBox", "0 0 24 24");
    for (const [cls, dash] of [["pc-ring-bg", null], ["pc-ring-fg", circ * (1 - percent / 100)]]) {
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("class", cls);
      circle.setAttribute("cx", "12"); circle.setAttribute("cy", "12"); circle.setAttribute("r", String(radius));
      if (dash !== null) { circle.setAttribute("stroke-dasharray", String(circ)); circle.setAttribute("stroke-dashoffset", String(dash)); circle.setAttribute("transform", "rotate(-90 12 12)"); }
      svg.append(circle);
    }
    return svg;
  }

  /** The chosen model row from the loaded catalogue, when there is one. */
  function chosenModel() {
    return (modelCache && modelCache.find((m) => m.id === currentModel)) || null;
  }

  /** Whether this harness lets the popover toggle Fast. */
  function fastAvailable() {
    const settings = status.capabilities && status.capabilities.settings;
    return source === "claude" && !!(settings && settings.fast);
  }

  /** The chosen model's effort: the last pick, its default, or "" for none. */
  function currentEffortLevel() {
    const chosen = chosenModel();
    const levels = chosen && takesEffort ? effortLevels(chosen) : [];
    if (!levels.length) return "";
    if (currentEffort && levels.includes(currentEffort)) return currentEffort;
    return chosen.defaultEffort || levels[0];
  }

  /** Worded footer labels, refreshed with status and after each switch. */
  function updateSelectors() {
    const modes = Array.isArray(status.permissionModes) ? status.permissionModes : [];
    permissionSelect.button.hidden = modes.length === 0;
    permissionSelect.label.textContent = permissionModeLabel(status.permissionMode);
    permissionSelect.label.classList.toggle("warn", status.permissionMode === "bypassPermissions" || status.permissionMode === "auto");
    if (supportsPicker) modelSelect.label.textContent = modelTitle(chosenModel() || (currentModel ? { id: currentModel } : null), source);
    const chosen = chosenModel();
    const levels = chosen && takesEffort ? effortLevels(chosen) : [];
    effortSelect.button.hidden = levels.length === 0;
    effortSelect.label.textContent = currentEffortLevel();
  }

  /** The tiny ring button: the context ring, else the Fast settings glyph. */
  function renderExtras() {
    const percent = contextPercent(status);
    const show = percent !== null || fastAvailable();
    extrasBtn.hidden = !show;
    if (!show) return;
    extrasBtn.replaceChildren(percent !== null ? buildRing(percent) : ICON.sliders());
    extrasBtn.title = percent !== null ? `${Math.round(percent)}% of context used` : "Fast mode";
  }

  function updatePrimary() {
    const draft = hasDraft();
    primaryBtn.replaceChildren();
    if (working && !draft) {
      primaryBtn.classList.add("stop");
      primaryBtn.title = "Stop";
      primaryBtn.disabled = false;
      primaryBtn.append(ICON.stop());
    } else {
      primaryBtn.classList.remove("stop");
      primaryBtn.title = "Send";
      primaryBtn.disabled = !draft;
      primaryBtn.append(ICON.up());
    }
  }

  function updateFooter() {
    updatePrimary();
    updateSelectors();
    renderExtras();
    if (workerBadge) {
      const running = counts.workers || 0;
      workerBadge.textContent = String(running);
      workerBadge.hidden = running === 0;
    }
  }

  // ---- background strip ----
  function saveBgOpen() {
    try { localStorage.setItem(bgKey, backgroundOpen ? "open" : "closed"); } catch { /* storage unavailable */ }
  }

  function renderBackground() {
    const running = backgroundJobs.length;
    backgroundEl.hidden = running === 0;
    bgCount.textContent = running ? `${running} running` : "";
    bgList.hidden = !(running > 0 && backgroundOpen);
    bgChevron.classList.toggle("open", running > 0 && backgroundOpen);
    bgList.replaceChildren();
    for (const job of backgroundJobs) {
      const row = node("div", "pc-bg-row");
      row.append(node("span", `pc-bg-dot ${String(job.state || "").toLowerCase()}`));
      const main = node("div", "pc-bg-main");
      main.append(node("div", "pc-bg-label", job.label || "Job"));
      if (job.detail) main.append(node("div", "pc-bg-detail", job.detail));
      row.append(main, node("span", "pc-bg-state", String(job.state || "")));
      bgList.append(row);
    }
  }
  bgHead.addEventListener("click", () => {
    if (!backgroundJobs.length) return;
    backgroundOpen = !backgroundOpen;
    saveBgOpen();
    renderBackground();
  });

  function updateGhost() {
    const suggestion = typeof status.suggestion === "string" ? status.suggestion : "";
    const show = source === "claude" && !!suggestion && input.value === "" && attachments.length === 0 && !working && pendings.size === 0;
    ghostEl.hidden = !show;
    ghostEl.dataset.text = show ? suggestion : "";
    ghostEl.replaceChildren();
    if (show) {
      ghostEl.append(node("span", null, suggestion), node("span", "pc-ghost-hint", "  \u21b5"));
      ghostEl.title = "Use suggestion";
    }
  }
  ghostEl.addEventListener("click", () => {
    if (!ghostEl.dataset.text) return;
    input.value = ghostEl.dataset.text;
    input.focus();
    onInput();
  });

  // ---- popovers ----
  function onOutside(event) { if (popover && !popover.contains(event.target)) closePopover(); }
  function closePopover() {
    if (!popover) return;
    popover.remove();
    popover = null;
    popoverBuild = null;
    document.removeEventListener("pointerdown", onOutside, true);
  }
  function openPopover(anchor, build) {
    closePopover();
    const pop = node("div", "pc-popover");
    pop.style.position = "fixed";
    document.body.append(pop);
    popover = pop;
    popoverBuild = build;
    build(pop);
    const rect = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.max(8, rect.top - pop.offsetHeight - 6)}px`;
    setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
  }

  /** The model list, the current pick marked, or a load state. */
  function drawModels(pop) {
    pop.replaceChildren();
    pop.append(node("div", "pc-pop-head", "Model"));
    if (!modelCache) { pop.append(node("div", "pc-pop-sub", "Loading\u2026")); return; }
    if (!modelCache.length) { pop.append(node("div", "pc-pop-sub", "This computer lists no models.")); return; }
    for (const model of modelCache) {
      const row = node("div", `pc-pop-row${model.id === currentModel ? " selected" : ""}`);
      row.append(node("span", null, modelTitle(model, source)));
      if (model.description) row.append(node("span", "pc-pop-sub", model.description));
      row.addEventListener("click", () => { switchModel(model.id, model.defaultEffort); closePopover(); });
      pop.append(row);
    }
  }

  /** The effort levels the chosen model takes, the current one marked. */
  function drawEfforts(pop) {
    pop.replaceChildren();
    pop.append(node("div", "pc-pop-head", "Effort"));
    const chosen = chosenModel();
    const levels = chosen && takesEffort ? effortLevels(chosen) : [];
    if (!levels.length) { pop.append(node("div", "pc-pop-sub", "This model takes no effort levels.")); return; }
    const active = currentEffortLevel();
    const pills = node("div", "pc-pop-effort");
    for (const level of levels) {
      const pill = node("button", `pc-effort${level === active ? " on" : ""}`, level);
      pill.addEventListener("click", () => { switchModel(chosen.id, level); closePopover(); });
      pills.append(pill);
    }
    pop.append(pills);
  }

  /** The permission modes this session offers. */
  function drawModes(pop) {
    pop.replaceChildren();
    pop.append(node("div", "pc-pop-head", "Permission mode"));
    const modes = Array.isArray(status.permissionModes) ? status.permissionModes : [];
    for (const mode of modes) {
      const row = node("div", `pc-pop-row${mode === status.permissionMode ? " selected" : ""}`);
      row.append(node("span", null, permissionModeLabel(mode)));
      if (mode === "bypassPermissions") row.append(node("span", "pc-pop-sub", "Skips every prompt"));
      row.addEventListener("click", () => { setPermissionMode(mode); closePopover(); });
      pop.append(row);
    }
  }

  /** The context ring and the Fast toggle, under the tiny ring button. */
  function drawExtras(pop) {
    pop.replaceChildren();
    const percent = contextPercent(status);
    if (percent !== null) {
      const row = node("div", "pc-pop-row");
      row.append(buildRing(percent), node("span", "pc-pop-sub", `${Math.round(percent)}% of context used`));
      pop.append(row);
    }
    if (fastAvailable()) {
      const on = !!(status.settingsState && status.settingsState.fast === true);
      const row = node("div", `pc-pop-row${on ? " selected" : ""}`);
      row.append(node("span", null, "Fast mode"), node("span", "pc-pop-sub", on ? "On" : "Off"));
      row.addEventListener("click", () => { toggleFast(); closePopover(); });
      pop.append(row);
    }
  }

  async function openModelsMenu(anchor) {
    openPopover(anchor, drawModels);
    if (supportsPicker && !modelCache) {
      try { modelCache = modelRows(source, await hookGet(computer, "/v1/models", { source })); }
      catch { modelCache = []; }
      if (popover && popoverBuild) popoverBuild(popover);
    }
  }

  async function switchModel(argument, effort) {
    notice.textContent = "";
    try {
      await hookPost(computer, "/v1/model", modelBody(target, argument, effort));
      currentModel = argument;
      currentEffort = effort || "";
      updateFooter();
    } catch (error) {
      notice.textContent = (error && error.body && error.body.error) || (error && error.message) || "Model switch failed";
    }
  }

  async function setPermissionMode(mode) {
    notice.textContent = "";
    try {
      await hookPost(computer, "/v1/agents/permission-mode", permissionBody(target, mode));
      status.permissionMode = mode;
      updateFooter();
    } catch (error) {
      notice.textContent = (error && error.body && error.body.error) || (error && error.message) || "Permission mode failed";
    }
  }

  async function toggleFast() {
    const on = !(status.settingsState && status.settingsState.fast === true);
    notice.textContent = "";
    try {
      await hookPost(computer, "/v1/settings", settingsBody(target, { fast: on }));
      status.settingsState = { ...(status.settingsState || {}), fast: on };
      updateFooter();
    } catch (error) {
      notice.textContent = (error && error.body && error.body.error) || (error && error.message) || "Fast mode failed";
    }
  }

  // ---- public API ----
  onInput();
  renderBackground();

  return {
    el: wrap,
    focus() { input.focus(); },
    insert(text) {
      const start = input.selectionStart == null ? input.value.length : input.selectionStart;
      const end = input.selectionEnd == null ? start : input.selectionEnd;
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      const pos = start + String(text).length;
      input.setSelectionRange(pos, pos);
      onInput();
      input.focus();
    },
    setStatus(agentStatus) {
      status = agentStatus || {};
      working = String(status.status || "").toLowerCase() === "working";
      updateFooter();
      updateGhost();
    },
    setBackground(jobs) {
      backgroundJobs = Array.isArray(jobs) ? jobs.filter((job) => job && job.id) : [];
      renderBackground();
    },
    setCounts(next) {
      counts = { agents: 0, workers: 0, ...(next || {}) };
      updateFooter();
    },
    onDelivery(fn) {
      deliveryHandlers.push(fn);
      return () => { deliveryHandlers = deliveryHandlers.filter((f) => f !== fn); };
    },
    destroy() {
      destroyed = true;
      for (const entry of pendings.values()) if (entry.timer) clearTimeout(entry.timer);
      pendings.clear();
      closePopover();
      wrap.remove();
    },
  };
}
