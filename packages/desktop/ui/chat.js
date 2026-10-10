// The chat pane: the phone's chat on the desktop. Plain browser ES module.
// Reads the transcript through @phren/desktop-kit (every harness), keeps
// history and older pages, draws interaction cards and the phone's composer.
//
//   openChat(el, computerName, child, opts) -> { close(), focus(), insert(text) }
//   opts: { onConsole?() }   // the session tile's switch to its console

import {
  readTranscriptFrame, AgentChatHistory, ChatTranscriptPreparation, chatActivityContext, chatPendingEcho, ElapsedTime,
} from "/vendor/kit/index.js";
import { hookPost, hookGet } from "./api.js";
import { createTimelineView } from "./chat/timeline-view.js";
import { createComposer, contextPercent } from "./chat/composer.js";
import { renderInteractions, renderSideAnswer, renderSudoRequests } from "./chat/cards.js";
import { startDictation, createTalkMode } from "./chat/talk.js";
import { openKnowsDrawer, installRememberSelection } from "./chat/knows.js";
import { projectOf } from "./shell/store.js";

const PROVIDERS = { claude: "Claude", codex: "Codex", copilot: "Copilot", phren: "Phren", opencode: "OpenCode" };

function providerName(source) {
  return PROVIDERS[String(source || "").toLowerCase()] || "Agent";
}
function providerLetter(source) {
  return providerName(source).charAt(0).toUpperCase();
}
function basename(p) {
  const parts = String(p || "").split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}
// Status ring colour: working lavender, blocked/waiting amber, else muted.
function statusColor(status) {
  const s = String(status || "").toLowerCase();
  if (s === "working") return "var(--working)";
  if (s === "blocked" || s === "waiting") return "var(--waiting)";
  return "var(--done)";
}
function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}
function firstLine(text) {
  const line = String(text || "").split("\n")[0];
  return line.length > 80 ? `${line.slice(0, 79)}\u2026` : line;
}
function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}
function ensureStyle() {
  if (document.getElementById("chat-style")) return;
  const link = document.createElement("link");
  link.id = "chat-style";
  link.rel = "stylesheet";
  link.href = new URL("./chat/chat.css", import.meta.url).href;
  document.head.appendChild(link);
}

/**
 * Open a chat view for one session.
 * @param {HTMLElement} el container to fill and own
 * @param {string} computerName Hook computer name
 * @param {{title?:string,label?:string,cwd?:string,branch?:string,agentStatus?:string,target?:object}} child overview row
 * @param {{onConsole?:Function}} opts
 * @returns {{close:()=>void, focus:()=>void, insert:(text:string)=>void}}
 */
export function openChat(el, computerName, child, opts = {}) {
  ensureStyle();
  const target = (child && child.target) || {};
  const source = String(target.source || "").toLowerCase();
  const provider = providerName(source);
  const qs = new URLSearchParams(target).toString();

  el.classList.add("chat-pane");
  el.replaceChildren();

  // ---- header: one calm line, like the Codex app ----
  const ring = node("div", "chat-ring"); // hidden; keeps the status colour wiring
  const dot = node("div", "chat-status-dot");
  const title = node("div", "chat-title", (child && (child.title || child.label)) || provider);
  title.title = "Double-click to rename";
  title.addEventListener("dblclick", startRename);
  const sub = node("div", "chat-sub");
  sub.append(node("span", "chat-project", basename(child && child.cwd)));
  sub.append(node("span", "chat-branch", (child && child.branch) || ""));
  sub.append(node("span", "chat-computer", computerName));
  const more = node("button", "chat-more", "⋯");
  more.type = "button";
  more.title = "Rename";
  more.addEventListener("click", () => startRename());
  const contextRing = node("div", "chat-context-ring");
  const knowsBtn = node("button", "chat-knows-btn", "Phren knows");
  knowsBtn.type = "button";
  knowsBtn.addEventListener("click", () => toggleKnows());
  const trailing = node("div", "chat-trailing");
  trailing.append(knowsBtn, contextRing);
  const header = node("div", "chat-header");
  header.append(ring, dot, title, sub, more, trailing);

  const notice = node("div", "chat-notice");

  // ---- interaction cards ----
  const sideArea = node("div", "chat-side");
  const cardsArea = node("div", "chat-cards");
  const sudoArea = node("div", "chat-sudo");
  const interactions = node("div", "chat-interactions");
  interactions.append(sideArea, cardsArea, sudoArea);

  // ---- composer ----
  const composer = createComposer({
    computer: computerName, target, provider: source, branch: child && child.branch,
    onConsole: typeof opts.onConsole === "function" ? opts.onConsole : undefined,
    onAgents: () => openWork("agents"),
    onWorkers: () => openWork("workers"),
    onDictate: () => toggleDictation(),
    onTalk: () => toggleTalk(),
  });

  // ---- voice: dictation into the composer, and talk mode with spoken replies ----
  let dictation = null;
  function toggleDictation() {
    if (dictation) { dictation.stop(); dictation = null; return; }
    dictation = startDictation({
      computer: computerName,
      onText: (_partial, final) => { if (final) composer.insert(`${final} `); },
      onEnd: () => { dictation = null; },
    });
  }
  let talk = null;
  let talkReplyLine = -1;
  function toggleTalk() {
    if (talk) { talk.stop(); talk = null; return; }
    talkReplyLine = lastAssistantLine();
    talk = createTalkMode({
      computer: computerName, target, provider: source, branch: child && child.branch,
      send: (text) => hookPost(computerName, "/v1/prompt", { target, text, deliveryId: crypto.randomUUID() }),
      onState: (state) => { if (state === "off") talk = null; },
    });
    talk.start();
  }
  function lastAssistantLine() {
    for (let i = history.messages.length - 1; i >= 0; i--) if (history.messages[i].role === "assistant") return history.messages[i].line;
    return -1;
  }
  /** When a turn ends in talk mode, speak the reply the agent wrote since the last one. */
  function feedTalkReply() {
    if (!talk) return;
    const replies = history.messages.filter((m) => m.role === "assistant" && !m.isNarration && m.line > talkReplyLine);
    if (!replies.length) return;
    talkReplyLine = replies[replies.length - 1].line;
    talk.feedReply(replies.map((m) => m.text).join("\n\n"));
  }
  const composerHost = node("div", "chat-composer");
  composerHost.append(composer.el);

  // ---- timeline ----
  const timelineEl = node("div", "chat-timeline");
  const timeline = createTimelineView(timelineEl, {
    computer: computerName, target, source,
    openFile: typeof opts.openFile === "function" ? opts.openFile : undefined,
    openSubagent: (id) => openSubagent(id),
    insert: (text) => composer.insert(text),
  });

  // ---- the "Phren knows" drawer and "Remember this" selection ----
  const knowsProject = projectOf(child);
  let knows = null;
  function toggleKnows() {
    if (knows) { knows.close(); return; }
    knows = openKnowsDrawer(el, {
      computer: computerName, project: knowsProject,
      onClose: () => { knows = null; knowsBtn.classList.remove("on"); },
    });
    knowsBtn.classList.add("on");
  }
  const rememberSelection = installRememberSelection(timelineEl, {
    computer: computerName, project: knowsProject,
  });

  const error = node("div", "chat-error");
  el.append(header, notice, timelineEl, interactions, composerHost, error);

  // ---- state ----
  const history = new AgentChatHistory();
  const preparation = new ChatTranscriptPreparation();
  const echoes = new Map();
  let preview = null;
  let agentStatus = {};
  let harnessVerb = null;
  let agentsTree = [];
  let cardsHandle = null;
  let sideHandle = null;
  let sudoHandle = null;
  let workPopover = null;
  let loadingOlder = false;
  let lastSubagentsAt = 0;
  let lastSudoAt = 0;
  let closed = false;

  composer.onDelivery(onComposerDelivery);

  // ---- colour from the overview row until a status frame arrives ----
  applyStatusColor((child && child.agentStatus) || "");

  // ---- rendering ----
  function activityContext() {
    const status = String(agentStatus.status || "").toLowerCase();
    const waiting = status === "blocked" || status === "waiting" || !!agentStatus.pendingApproval
      || (Array.isArray(agentStatus.pendingQuestions) && agentStatus.pendingQuestions.length > 0)
      || !!agentStatus.passwordPrompt || !!agentStatus.terminalPrompt;
    return chatActivityContext({
      busy: status === "working",
      waiting,
      harnessVerb,
      workingDirectory: (child && child.cwd) || null,
      pendingEchoes: [...echoes.values()],
    });
  }

  function composerJobs() {
    return preparation.jobs.map((job) => ({
      id: job.id,
      label: job.title,
      state: job.state && job.state.kind === "running" ? "running" : "finished",
      detail: job.worker ? `via ${job.worker}` : firstLine(job.command),
    }));
  }

  function render() {
    if (closed) return;
    const stick = timeline.isAtBottom();
    preparation.update(history.messages, activityContext());
    timeline.render(preparation, preview);
    composer.setBackground(composerJobs());
    if (stick) timeline.scrollToBottom();
  }

  function setNotice(text) {
    notice.textContent = text || "";
  }

  // ---- transcript frames ----
  // The Hook's own frames always name their source and line; the test fake and
  // older Hooks may omit them, so fill them in before the kit reads the frame.
  function normalizeFrame(frame) {
    if (!frame || typeof frame !== "object") return frame;
    const out = { ...frame };
    if (out.source === undefined) out.source = source;
    if (Array.isArray(out.entries)) {
      let missing = false;
      for (const entry of out.entries) if (entry && typeof entry === "object" && entry.line === undefined) { missing = true; break; }
      if (missing) out.entries = out.entries.map((entry, index) =>
        entry && typeof entry === "object" && entry.line === undefined ? { ...entry, line: index } : entry);
    }
    return out;
  }

  function readFrame(frame) {
    try { return readTranscriptFrame(normalizeFrame(frame), String((frame && frame.source) || source)); }
    catch { return null; }
  }

  function onTranscript(frame) {
    const type = frame && frame.type;
    if (type === "side-answer") { renderSide(frame); return; }
    if (type === "delivery") { applyDeliveryFrame(frame); return; }
    const read = readFrame(frame);
    if (!read) return;
    if (read.activityVerb) harnessVerb = read.activityVerb;
    if (read.kind === "preview") { preview = read.preview; render(); return; }
    history.receive(read);
    reconcileEchoes();
    render();
  }

  // ---- deliveries as pending echoes ----
  function onComposerDelivery({ deliveryId, text, state } = {}) {
    if (!deliveryId) return;
    const echo = echoes.get(deliveryId)
      || chatPendingEcho(deliveryId, text || "", [], { submittedAt: new Date().toISOString() });
    if (text) echo.text = text;
    echo.deliveryState = state || echo.deliveryState;
    echoes.set(deliveryId, echo);
    if (state === "delivered") scheduleEchoRemoval(deliveryId);
    render();
  }

  function applyDeliveryFrame(frame) {
    const id = String(frame.deliveryId || "");
    if (!id) return;
    const state = String(frame.state || "unknown");
    // Only messages this composer sent have a bubble; the Hook also reports
    // deliveries from the phone and from before this chat opened.
    const echo = echoes.get(id);
    if (!echo) return;
    echo.deliveryState = state;
    echoes.set(id, echo);
    if (state === "delivered") scheduleEchoRemoval(id);
    render();
  }

  function scheduleEchoRemoval(id) {
    const echo = echoes.get(id);
    if (!echo || echo.timer) return;
    echo.timer = setTimeout(() => { echoes.delete(id); render(); }, 1200);
  }

  // A real user row retires its echo, whatever the delivery state said.
  function reconcileEchoes() {
    if (echoes.size === 0) return;
    const users = history.messages
      .filter((message) => message.role === "user" && message.localCommand === null)
      .map((message) => normalizeText(message.text));
    for (const [id, echo] of [...echoes]) {
      const text = normalizeText(echo.text);
      if (text && users.some((user) => user.includes(text))) {
        if (echo.timer) clearTimeout(echo.timer);
        echoes.delete(id);
      }
    }
  }

  // ---- status ----
  function onStatus(frame) {
    const next = frame && frame.agentStatus ? frame.agentStatus
      : frame && frame.type === "agentStatus" ? frame : null;
    if (!next) return;
    const finished = agentStatus.status === "working" && next.status !== "working";
    agentStatus = next;
    if (finished) feedTalkReply();
    applyStatusColor(next.status);
    composer.setStatus(agentStatus);
    updateContextRing();
    renderCards();
    maybeFetchSudo();
    maybeFetchSubagents();
    render();
  }

  function applyStatusColor(status) {
    const color = statusColor(status);
    ring.style.borderColor = color;
    ring.style.color = color;
    dot.style.background = color;
  }

  function updateContextRing() {
    const percent = contextPercent(agentStatus);
    contextRing.replaceChildren();
    contextRing.hidden = percent === null;
    if (percent === null) return;
    contextRing.title = `${Math.round(percent)}% of context used`;
    contextRing.append(buildRing(percent));
  }

  function buildRing(percent) {
    const NS = "http://www.w3.org/2000/svg";
    const radius = 9, circ = 2 * Math.PI * radius;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "20"); svg.setAttribute("height", "20"); svg.setAttribute("viewBox", "0 0 24 24");
    for (const [stroke, dash] of [["var(--border-strong)", null], ["var(--accent)", circ * (1 - percent / 100)]]) {
      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("cx", "12"); circle.setAttribute("cy", "12"); circle.setAttribute("r", String(radius));
      circle.setAttribute("fill", "none"); circle.setAttribute("stroke", stroke); circle.setAttribute("stroke-width", "2");
      if (dash !== null) {
        circle.setAttribute("stroke-dasharray", String(circ));
        circle.setAttribute("stroke-dashoffset", String(dash));
        circle.setAttribute("transform", "rotate(-90 12 12)");
      }
      svg.append(circle);
    }
    return svg;
  }

  // ---- interaction cards ----
  function updateInteractionsFrame() {
    const has = cardsArea.childElementCount > 0 || sideArea.childElementCount > 0 || sudoArea.childElementCount > 0;
    interactions.classList.toggle("has-cards", has);
  }

  function renderCards() {
    cardsHandle?.destroy?.();
    cardsHandle = renderInteractions(cardsArea, agentStatus, {
      computer: computerName, target, onAnswered: () => maybeFetchSudo(true),
    });
    updateInteractionsFrame();
  }

  function renderSide(frame) {
    sideHandle?.destroy?.();
    sideHandle = renderSideAnswer(sideArea, frame, { computer: computerName, target });
    updateInteractionsFrame();
  }

  function renderSudo(requests) {
    sudoHandle?.destroy?.();
    sudoHandle = renderSudoRequests(sudoArea, requests, { computer: computerName, onAnswered: () => maybeFetchSudo(true) });
    updateInteractionsFrame();
  }

  function maybeFetchSudo(force = false) {
    const status = String(agentStatus.status || "").toLowerCase();
    const pending = !!agentStatus.pendingApproval || !!agentStatus.passwordPrompt
      || status === "waiting" || status === "blocked";
    if (!force && (!pending || Date.now() - lastSudoAt < 3000)) return;
    lastSudoAt = Date.now();
    hookGet(computerName, "/v1/sudo").then((res) => {
      renderSudo(Array.isArray(res && res.requests) ? res.requests : []);
    }).catch(() => {});
  }

  // ---- subagents and workers ----
  function flattenWork(nodes, depth = 0, out = []) {
    for (const agent of Array.isArray(nodes) ? nodes : []) {
      if (!agent || typeof agent !== "object") continue;
      out.push({ agent, depth });
      if (Array.isArray(agent.children) && agent.children.length) flattenWork(agent.children, depth + 1, out);
    }
    return out;
  }
  function isWorker(agent) {
    return !!agent.fanout || !!agent.computer || String(agent.callId || "").startsWith("fanout:");
  }
  function workMembers(nodes, worker) {
    return flattenWork(nodes).filter(({ agent }) => isWorker(agent) === worker);
  }
  function countWork(nodes) {
    let agents = 0, workers = 0;
    for (const { agent } of flattenWork(nodes)) { if (isWorker(agent)) workers++; else agents++; }
    return { agents, workers };
  }
  function workTitle(agent) {
    const raw = agent.worktreeName || agent.path || agent.model || "Agent";
    return String(raw).includes("/") ? basename(raw) : String(raw);
  }
  function workStateClass(agent) {
    if (agent.failed) return "failed";
    const state = String(agent.state || "").toLowerCase();
    return state === "running" || state === "completed" ? state : "muted";
  }
  function workStateText(agent) {
    return agent.failed ? "failed" : String(agent.state || "unavailable");
  }
  function workElapsed(agent) {
    const start = agent.startedAt ? Date.parse(agent.startedAt) : NaN;
    if (Number.isNaN(start)) return "";
    const end = agent.finishedAt ? Date.parse(agent.finishedAt) : Date.now();
    if (Number.isNaN(end)) return "";
    return ` \u00b7 ${ElapsedTime.text((end - start) / 1000)}`;
  }

  function maybeFetchSubagents(force = false) {
    if (!force && Date.now() - lastSubagentsAt < 3000) return;
    lastSubagentsAt = Date.now();
    hookGet(computerName, "/v1/subagents", target).then((res) => {
      agentsTree = Array.isArray(res && res.agents) ? res.agents : [];
      composer.setCounts(countWork(agentsTree));
      if (workPopover && !workPopover.childId) drawWork(workPopover.kind, workPopover.el);
    }).catch(() => {});
  }

  function openWork(kind) {
    closeWork();
    const pop = node("div", "chat-popover");
    pop.style.position = "fixed";
    document.body.append(pop);
    workPopover = { el: pop, kind };
    drawWork(kind, pop);
    positionPopover(pop, composer.el);
    maybeFetchSubagents(true);
    setTimeout(() => document.addEventListener("pointerdown", onWorkOutside, true), 0);
  }

  function positionPopover(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    const width = pop.offsetWidth || 280;
    pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    pop.style.top = `${Math.max(8, rect.top - pop.offsetHeight - 6)}px`;
  }

  function closeWork() {
    if (!workPopover) return;
    workPopover.el.remove();
    workPopover = null;
    document.removeEventListener("pointerdown", onWorkOutside, true);
  }
  function onWorkOutside(event) {
    if (workPopover && !workPopover.el.contains(event.target)) closeWork();
  }

  function drawWork(kind, pop, childId) {
    if (!pop) return;
    if (workPopover && workPopover.el === pop) workPopover.childId = childId || null;
    pop.replaceChildren();
    if (childId) {
      const head = node("div", "chat-pop-head");
      const back = node("button", "chat-pop-back", "\u2190 Back");
      back.addEventListener("click", () => drawWork(kind, pop));
      head.append(back, node("span", null, "Transcript"));
      pop.append(head);
      const body = node("div", "chat-work-transcript");
      body.append(node("div", "chat-work-badge", "Loading\u2026"));
      pop.append(body);
      loadChildTranscript(childId, body);
      return;
    }
    const members = workMembers(agentsTree, kind === "workers");
    const head = node("div", "chat-pop-head");
    head.append(node("span", null, kind === "workers" ? "Workers" : "Subagents"), node("span", null, String(members.length)));
    pop.append(head);
    const list = node("div", "chat-pop-list");
    if (members.length === 0) {
      list.append(node("div", "chat-work-empty", kind === "workers" ? "No workers running" : "No subagents running"));
    } else {
      for (const member of members) list.append(workRow(member, kind, pop));
    }
    pop.append(list);
  }

  function workRow({ agent, depth }, kind, pop) {
    const row = node("div", "chat-work-row");
    row.style.paddingLeft = `${12 + depth * 14}px`;
    const main = node("div", "chat-work-main");
    main.append(node("div", "chat-work-title", workTitle(agent)));
    const meta = [providerName(agent.provider), agent.branch, agent.computer && agent.computer.name].filter(Boolean).join(" \u00b7 ");
    if (meta) main.append(node("div", "chat-work-sub", meta));
    row.append(node("div", "chat-work-glyph", providerLetter(agent.provider)), main);
    row.append(node("div", `chat-work-state ${workStateClass(agent)}`, `${workStateText(agent)}${workElapsed(agent)}`));
    row.addEventListener("click", () => drawWork(kind, pop, agent.id));
    return row;
  }

  function loadChildTranscript(childId, body) {
    hookGet(computerName, "/v1/subagents/transcript", { ...target, child: childId }).then((frame) => {
      const read = readFrame(frame);
      body.replaceChildren();
      if (!read || read.messages.length === 0) {
        body.append(node("div", "chat-work-empty", "Nothing to show yet."));
        return;
      }
      for (const message of read.messages) {
        const line = node("div", `chat-work-line ${message.role}`);
        line.textContent = message.text || (message.imageBlocks.length ? "[image]" : "");
        body.append(line);
      }
    }).catch(() => {
      body.replaceChildren(node("div", "chat-work-empty", "Could not read this transcript."));
    });
  }

  function openSubagent(id) {
    if (!id) return;
    const worker = flattenWork(agentsTree).some(({ agent }) => agent.id === id && isWorker(agent));
    openWork(worker ? "workers" : "agents");
    if (workPopover) drawWork(workPopover.kind, workPopover.el, id);
  }

  // ---- older pages ----
  timeline.onScrollTop?.(() => {
    if (loadingOlder || !history.hasMore || history.startLine === null) return;
    loadingOlder = true;
    hookGet(computerName, "/v1/transcripts/history", { ...target, beforeLine: String(history.startLine) })
      .then((frame) => {
        const read = readFrame(frame);
        if (read) { history.receive(read); render(); }
      })
      .catch(() => {})
      .finally(() => { loadingOlder = false; });
  });

  // ---- rename ----
  function startRename() {
    if (title.dataset.editing) return;
    title.dataset.editing = "1";
    const input = node("input", "chat-rename");
    input.type = "text";
    input.value = title.textContent;
    title.replaceWith(input);
    input.focus();
    input.select();
    const finish = async (save) => {
      input.removeEventListener("keydown", onKey);
      input.removeEventListener("blur", onBlur);
      delete title.dataset.editing;
      const value = input.value.trim();
      input.replaceWith(title);
      if (!save || !value || value === title.textContent) return;
      const previous = title.textContent;
      title.textContent = value;
      try {
        await hookPost(computerName, "/v1/sessions/rename", {
          workspaceId: target.workspace, tabId: target.tab,
          ...(target.pane !== undefined ? { paneId: target.pane } : {}),
          label: value,
        });
        setNotice("");
      } catch (err) {
        title.textContent = previous;
        setNotice(`Rename failed: ${(err && err.message) || "the Hook refused it."}`);
      }
    };
    const onKey = (event) => {
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); finish(false); }
    };
    const onBlur = () => finish(true);
    input.addEventListener("keydown", onKey);
    input.addEventListener("blur", onBlur);
  }

  // ---- sockets, reconnecting with backoff ----
  function connectSocket(path, onFrame, onOpen) {
    let backoff = 500, timer = null, ws = null, stopped = false;
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/hosts/${encodeURIComponent(computerName)}${path}`;
    const open = () => {
      if (stopped) return;
      ws = new WebSocket(url);
      ws.onopen = () => { backoff = 500; if (onOpen) onOpen(); };
      ws.onmessage = (event) => { let frame; try { frame = JSON.parse(event.data); } catch { return; } onFrame(frame); };
      ws.onclose = () => {
        if (stopped) return;
        timer = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 5000);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };
    };
    open();
    return {
      close() { stopped = true; if (timer) clearTimeout(timer); try { ws && ws.close(); } catch { /* already closing */ } },
    };
  }

  const transcriptSocket = connectSocket(`/v1/transcripts?${qs}&sideAnswers=1&deliveries=1`, onTranscript, () => {
    preview = null;
    maybeFetchSubagents(true);
  });
  const statusSocket = connectSocket(`/v1/status?${qs}`, onStatus, () => {
    maybeFetchSubagents(true);
    maybeFetchSudo(true);
  });

  composer.setCounts({ agents: 0, workers: 0 });
  render();

  return {
    /** Append review text (a diff line, a selection) to the draft and focus it, without sending. */
    insert(text) { composer.insert(text); },
    focus() { composer.focus(); },
    close() {
      closed = true;
      dictation?.stop(); talk?.stop();
      transcriptSocket.close();
      statusSocket.close();
      closeWork();
      knows?.close?.();
      rememberSelection.destroy?.();
      cardsHandle?.destroy?.();
      sideHandle?.destroy?.();
      sudoHandle?.destroy?.();
      timeline.destroy?.();
      composer.destroy?.();
      for (const echo of echoes.values()) if (echo.timer) clearTimeout(echo.timer);
      echoes.clear();
      el.replaceChildren();
      el.classList.remove("chat-pane");
    },
  };
}
