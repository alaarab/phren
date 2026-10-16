import { el as node } from "./dom.js";
import { agentLabel } from "./harness.js";
import { renderHandoffLinks } from "./shell/handoff-view.js";
import { quotaInteractionPending } from "./shell/quota-warn.js";
// The chat pane: the phone's chat on the desktop. Plain browser ES module.
// Reads the transcript through @phren/desktop-kit (every harness), keeps
// history and older pages, draws interaction cards and the phone's composer.
//
//   openChat(el, computerName, child, opts) -> { close(), focus(), insert(text), attach(files) }
//   opts: { onConsole?() }   // the session tile's switch to its console

import { isShown, watchShown } from "./shown.js";
import {
  readTranscriptFrame, AgentChatHistory, ChatTranscriptPreparation, chatActivityContext, ElapsedTime,
} from "/vendor/kit/index.js";
import { hookPost, hookGet } from "./api.js";
import { createTimelineView } from "./chat/timeline-view.js";
import { createFindBar } from "./chat/find-bar.js";
import { createComposer, contextPercent } from "./chat/composer.js";
import { renderInteractions, renderSideAnswer, renderSudoRequests } from "./chat/cards.js";
import { startDictation, createTalkMode } from "./chat/talk.js";
import { openKnowsDrawer, installRememberSelection } from "./chat/knows.js";
import { renderMarkdownInto } from "./chat/markdown.js";
import { projectOf } from "./shell/store.js";
import { takePrefetched, setChatOpen } from "./shell/transcript-prefetch.js";

function providerLetter(source) {
  return agentLabel(source).charAt(0).toUpperCase();
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
function firstLine(text) {
  const line = String(text || "").split("\n")[0];
  return line.length > 80 ? `${line.slice(0, 79)}\u2026` : line;
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
 * @returns {{close:()=>void, focus:()=>void, insert:(text:string)=>void, attach:(files:FileList|File[])=>void}}
 */
export function openChat(el, computerName, child, opts = {}) {
  ensureStyle();
  opts.onInteractions?.(true);
  const target = (child && child.target) || {};
  const source = String(target.source || "").toLowerCase();
  const provider = agentLabel(source);
  const qs = new URLSearchParams(target).toString();

  el.classList.add("chat-pane");
  el.replaceChildren();

  // ---- header: one calm line, like the Codex app ----
  const ring = node("div", "chat-ring"); // hidden; keeps the status colour wiring
  const dot = node("div", "chat-status-dot");
  const title = node("div", "chat-title", (child && (child.title || child.label)) || provider);
  const where = [basename(child && child.cwd), child && child.branch, computerName].filter(Boolean).join(" \u00b7 ");
  title.title = `${where ? `${where}\n` : ""}Double-click to rename`;
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

  const handoffs = node("div", "chat-handoffs");
  const updateOverview = (row) => renderHandoffLinks(handoffs, computerName, row);
  updateOverview(child);
  const notice = node("div", "chat-notice");

  // ---- interaction cards ----
  const sideArea = node("div", "chat-side");
  const cardsArea = node("div", "chat-cards");
  const sudoArea = node("div", "chat-sudo");
  const interactions = node("div", "chat-interactions");
  interactions.append(sideArea, cardsArea, sudoArea);

  // ---- composer ----
  const composer = createComposer({
    computer: computerName, target, provider: source, branch: child && child.branch, project: projectOf(child),
    onConsole: typeof opts.onConsole === "function" ? opts.onConsole : undefined,
    onAgents: () => openWork("agents"),
    onWorkers: () => openWork("workers"),
    onDictate: () => toggleDictation(),
    onTalk: () => toggleTalk(),
    submissionCursor: () => backlogLoaded ? Math.max(history.totalLines - 1, ...history.messages.map(message => message.line)) : null,
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
  const quotaHost = node("div", "chat-quota-host");
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
  el.append(header, handoffs, notice, timelineEl, interactions, quotaHost, composerHost, error);

  // ⌘F / Ctrl+F inside this pane searches its conversation (chat/find-bar.js).
  const find = createFindBar({
    pane: el, root: timelineEl, before: timelineEl,
    focusComposer: () => composer.focus(),
    partial: () => !!history.hasMore || !!timeline.isFolded?.(),
  });

  // ---- state ----
  const history = new AgentChatHistory();
  let backlogLoaded = false;
  const preparation = new ChatTranscriptPreparation();
  let preview = null;
  let agentStatus = {};
  let harnessVerb = null;
  let agentsTree = [];
  let cardsHandle = null;
  let cardsSignature = null;
  let sideHandle = null;
  let sudoHandle = null;
  let sudoSignature = null;
  let workPopover = null;
  let workNeedsNewer = false;
  let workMessagesTimer = null;
  let workMessagesLoad = null;
  let loadingOlder = false;
  let lastSubagentsAt = 0;
  // The Hook has no subagent push: poll every 3 s while the tree changes,
  // doubling to 30 s while it stays the same, and back to 3 s when the
  // agent starts or stops working or the work popover is open.
  let subagentsInterval = 3000;
  let lastSubagentsJson = "";
  // A fetch skipped while the chat was off screen runs when it comes back.
  let subagentsSkipped = false;
  let lastSudoAt = 0;
  let closed = false;

  composer.onDelivery(render);

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
      pendingEchoes: composer.pendingEchoes(),
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
    if (history.messages.length > 0) markRendered();
  }

  // click -> first transcript paint, as a performance measure (read it with
  // performance.getEntriesByName("phren:click-to-transcript")).
  let measured = false;
  function markRendered() {
    if (measured) return;
    measured = true;
    try {
      performance.measure("phren:click-to-transcript", { start: performance.getEntriesByName("phren:chat-click").pop()?.startTime });
    } catch { /* no click mark (opened another way) */ }
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
    if (type === "delivery") { composer.applyDelivery(frame); return; }
    const read = readFrame(frame);
    if (!read) return;
    if (read.activityVerb) harnessVerb = read.activityVerb;
    if (read.updatesPreview) preview = read.preview;
    if (read.kind === "preview") { render(); return; }
    history.receive(read);
    if (read.kind === "backlog") backlogLoaded = true;
    composer.reconcileTranscript(history.messages, (id) => history.acknowledgementID(id));
    render();
  }

  // ---- status ----
  function onStatus(frame) {
    const next = frame && frame.agentStatus ? frame.agentStatus
      : frame && frame.type === "agentStatus" ? frame : null;
    if (!next) return;
    const finished = agentStatus.status === "working" && next.status !== "working";
    if (next.status !== agentStatus.status) subagentsInterval = 3000;
    agentStatus = next;
    if (finished) feedTalkReply();
    applyStatusColor(next.status);
    composer.setStatus(agentStatus);
    updateContextRing();
    renderCards();
    opts.onInteractions?.(quotaInteractionPending(agentStatus));
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

  // The status fields renderInteractions reads to build its cards. A status
  // frame arrives about every 1.5 s, so rebuilding identical cards would wipe
  // an answer the owner is typing into a question or password card.
  function cardsSignatureOf(status) {
    const s = status || {};
    const approval = s.pendingApproval;
    return JSON.stringify({
      computer: computerName,
      target,
      approval: approval ? {
        actionId: approval.actionId, toolName: approval.toolName, message: approval.message,
        title: approval.title, choice: approval.choice, request: approval.request,
        details: approval.details, options: approval.options,
      } : null,
      questions: (Array.isArray(s.pendingQuestions) ? s.pendingQuestions : []).map((prompt) => ({
        id: prompt && (prompt.toolUseId ?? prompt.id),
        questions: prompt && prompt.questions,
      })),
      terminalQuestions: s.terminalPrompt?.questions,
      password: !!s.passwordPrompt,
    });
  }

  function renderCards() {
    const signature = cardsSignatureOf(agentStatus);
    if (signature === cardsSignature) return;
    cardsSignature = signature;
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

  // The sudo poll runs every 3 s; only its content decides the cards, so an
  // unchanged set must not rebuild a card the owner is typing into.
  function sudoSignatureOf(requests) {
    return JSON.stringify((Array.isArray(requests) ? requests : []).map((request) => request && {
      id: request.id, computer: request.computer, command: request.command, user: request.user,
      cwd: request.cwd, session: request.session, expiresAt: request.expiresAt,
    }));
  }

  function renderSudo(requests) {
    const signature = sudoSignatureOf(requests);
    if (signature === sudoSignature) return;
    sudoSignature = signature;
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

  // ---- message controls: send into a resumable worker ----------------------
  function newerReason() { return `Needs a newer Phren on ${computerName}`; }
  // A 404 from resume / messages / archive-finished means the Hook predates
  // them; disable the controls with a reason rather than fail again.
  function flagNewer() {
    if (workNeedsNewer) return;
    workNeedsNewer = true;
    if (workPopover && workPopover.el) drawWork(workPopover.kind, workPopover.el, workPopover.childId);
  }
  function canMessage(agent) {
    return !!agent && agent.fanout?.resumable === true && !workNeedsNewer;
  }
  function messageReason(agent) {
    if (workNeedsNewer) return newerReason();
    if (!agent) return "This agent can't be messaged.";
    if (agent.computer) return "This worker runs on another computer.";
    if (!(agent.fanout && agent.fanout.resumable)) return "This agent isn't a resumable worker.";
    return "";
  }
  // Local fan-out workers whose turn finished: the ones archive-finished moves.
  function isFinishedWorker(agent) {
    return isWorker(agent) && !agent.computer && !agent.failed && String(agent.state || "").toLowerCase() === "completed";
  }
  function finishedWorkerCount() {
    return flattenWork(agentsTree).filter(({ agent }) => isFinishedWorker(agent)).length;
  }
  function workAgent(id) {
    const member = flattenWork(agentsTree).find(({ agent }) => agent.id === id);
    return member && member.agent;
  }
  function deliveryLabel(status) {
    if (status === "queued") return "Queued for this worker";
    if (status === "completed") return "Worker finished";
    if (status === "failed") return "Worker continuation failed";
    return "Sent to this worker";
  }
  function messageStatusText(status) {
    if (status === "queued") return "Queued until this worker finishes";
    if (status === "running") return "Continuing this worker";
    if (status === "completed") return "Worker finished";
    if (status === "failed") return "Worker continuation failed";
    return "";
  }
  function messageStatusClass(status) {
    return ["queued", "running", "completed", "failed"].includes(status) ? status : "muted";
  }

  function sendBox(agent, onSend) {
    const box = node("div", "chat-work-send");
    const row = node("div", "chat-work-send-row");
    const input = node("input", "chat-work-input");
    input.type = "text";
    input.placeholder = `Send to ${agent ? workTitle(agent) : "agent"}`;
    input.maxLength = 32768;
    const button = node("button", "chat-work-send-btn", "Send");
    button.type = "button";
    const note = node("div", "chat-work-note");
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } });
    // Typing must not open the transcript behind the box.
    box.addEventListener("click", (event) => event.stopPropagation());
    const setDisabled = () => {
      const off = !canMessage(agent);
      input.disabled = off; button.disabled = off;
      if (off) { const reason = messageReason(agent); input.title = reason; button.title = reason; if (!note.textContent) note.textContent = reason; }
    };
    const submit = () => {
      const text = input.value.trim();
      if (!text || button.disabled) return;
      button.disabled = true; input.disabled = true;
      note.className = "chat-work-note"; note.textContent = "Sending\u2026";
      onSend(text, (state, message) => {
        note.className = state === "failed" ? "chat-work-note danger" : "chat-work-note";
        note.textContent = message;
        if (state === "sent") input.value = "";
        setDisabled();
      });
    };
    button.addEventListener("click", submit);
    row.append(input, button);
    box.append(row, note);
    setDisabled();
    return box;
  }

  function sendToChild(agent, text, done) {
    hookPost(computerName, "/v1/subagents/resume", { target, child: agent.id, text }).then((res) => {
      const status = String((res && res.message && res.message.status) || "running").toLowerCase();
      done("sent", deliveryLabel(status));
      if (workMessagesLoad) workMessagesLoad();
    }).catch((err) => {
      if (err && err.status === 404) { done("failed", newerReason()); flagNewer(); return; }
      const reason = (err && err.body && err.body.error) || (err && err.message) || "the Hook refused it.";
      done("failed", `Failed: ${reason}`);
    });
  }

  function startMessagesPoll(childId, list) {
    const load = () => isShown(el) && hookGet(computerName, "/v1/subagents/messages", { ...target, child: childId }).then((res) => {
      renderMessages(list, Array.isArray(res && res.messages) ? res.messages : []);
    }).catch((err) => {
      if (err && err.status === 404) flagNewer();
      // Keep the last thread through a transient read failure.
    });
    workMessagesLoad = load;
    load();
    workMessagesTimer = setInterval(load, 5000);
  }
  function stopMessagesPoll() {
    if (workMessagesTimer) { clearInterval(workMessagesTimer); workMessagesTimer = null; }
    workMessagesLoad = null;
  }
  function renderMessages(list, messages) {
    list.replaceChildren();
    if (messages.length === 0) { list.append(node("div", "chat-work-empty", "No messages yet.")); return; }
    for (const message of messages) {
      const row = node("div", "chat-work-message");
      const text = node("div", "chat-work-message-text");
      renderMarkdownInto(text, String(message.text || ""));
      row.append(text, node("div", `chat-work-message-state ${messageStatusClass(message.status)}`, messageStatusText(message.status)));
      list.append(row);
    }
  }

  function maybeFetchSubagents(force = false) {
    if (!isShown(el)) { subagentsSkipped = true; return; }
    const interval = workPopover ? 3000 : subagentsInterval;
    if (!force && Date.now() - lastSubagentsAt < interval) return;
    lastSubagentsAt = Date.now();
    hookGet(computerName, "/v1/subagents", target).then((res) => {
      agentsTree = Array.isArray(res && res.agents) ? res.agents : [];
      const json = JSON.stringify(agentsTree);
      if (json === lastSubagentsJson) subagentsInterval = Math.min(30000, subagentsInterval * 2);
      else { subagentsInterval = 3000; lastSubagentsJson = json; }
      composer.setCounts(countWork(agentsTree));
      // Keep a redraw from wiping a message the reader is typing.
      const active = document.activeElement;
      const typing = !!(active && workPopover && workPopover.el.contains(active) && active.tagName === "INPUT");
      if (workPopover && workPopover.childId) {
        // The timeline can open a child before the tree arrives; fill the view
        // in once the child resolves.
        if (!workPopover.childReady && workAgent(workPopover.childId)) {
          workPopover.childReady = true;
          drawWork(workPopover.kind, workPopover.el, workPopover.childId);
        }
      } else if (workPopover && !typing) {
        drawWork(workPopover.kind, workPopover.el);
      }
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
    // Leaving the section or pressing Escape closes it too: it floats on the body.
    window.addEventListener("hashchange", closeWork);
    document.addEventListener("keydown", onWorkKey, true);
  }
  function onWorkKey(event) { if (event.key === "Escape" && workPopover) { event.stopPropagation(); closeWork(); } }

  function positionPopover(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    const width = pop.offsetWidth || 280;
    pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    pop.style.top = `${Math.max(8, rect.top - pop.offsetHeight - 6)}px`;
  }

  function closeWork() {
    stopMessagesPoll();
    if (!workPopover) return;
    workPopover.el.remove();
    workPopover = null;
    document.removeEventListener("pointerdown", onWorkOutside, true);
    window.removeEventListener("hashchange", closeWork);
    document.removeEventListener("keydown", onWorkKey, true);
  }
  function onWorkOutside(event) {
    if (workPopover && !workPopover.el.contains(event.target)) closeWork();
  }

  function drawWork(kind, pop, childId) {
    if (!pop) return;
    if (workPopover && workPopover.el === pop) { workPopover.childId = childId || null; workPopover.childReady = !childId; }
    stopMessagesPoll();
    pop.replaceChildren();
    if (childId) { drawChildView(kind, pop, childId); return; }
    const members = workMembers(agentsTree, kind === "workers");
    const head = node("div", "chat-pop-head");
    const title = node("div", "chat-pop-title");
    title.append(node("span", null, kind === "workers" ? "Workers" : "Subagents"), node("span", "chat-pop-count", String(members.length)));
    head.append(title);
    const finished = finishedWorkerCount();
    if (finished > 0) head.append(clearControl(finished));
    pop.append(head);
    const list = node("div", "chat-pop-list");
    if (members.length === 0) {
      list.append(node("div", "chat-work-empty", kind === "workers" ? "No workers running" : "No subagents running"));
    } else {
      for (const member of members) list.append(workRow(member, kind, pop));
    }
    pop.append(list);
  }

  // "Clear finished" behind an inline confirm; archive-finished then re-reads
  // the tree, which drops the archived rows.
  function clearControl(count) {
    const slot = node("div", "chat-pop-clear");
    const action = (label, cls, onClick) => {
      const button = node("button", cls, label);
      button.type = "button";
      button.addEventListener("click", onClick);
      return button;
    };
    const showConfirm = () => {
      const row = node("div", "chat-work-confirm");
      row.append(node("span", null, `Clear ${count} finished?`), action("Clear", "chat-work-clear", run), action("Cancel", "chat-work-cancel", showIdle));
      slot.replaceChildren(row);
    };
    const showIdle = () => {
      const idle = action("Clear finished", "chat-work-clear", showConfirm);
      if (workNeedsNewer) { idle.disabled = true; idle.title = newerReason(); }
      slot.replaceChildren(idle);
    };
    const run = () => {
      slot.replaceChildren(node("span", "chat-work-note", "Clearing\u2026"));
      hookPost(computerName, "/v1/subagents/archive-finished", { target }).then(() => maybeFetchSubagents(true)).catch((err) => {
        if (err && err.status === 404) { flagNewer(); return; }
        const reason = (err && err.body && err.body.error) || (err && err.message) || "the Hook refused it.";
        slot.replaceChildren(node("span", "chat-work-note danger", `Clear failed: ${reason}`), action("Clear finished", "chat-work-clear", showConfirm));
      });
    };
    showIdle();
    return slot;
  }

  function drawChildView(kind, pop, childId) {
    const member = flattenWork(agentsTree).find(({ agent }) => agent.id === childId);
    const agent = member && member.agent;
    if (workPopover) workPopover.childReady = !!agent;
    const head = node("div", "chat-pop-head");
    const back = node("button", "chat-pop-back", "\u2190 Back");
    back.type = "button";
    back.addEventListener("click", () => drawWork(kind, pop));
    head.append(back, node("span", null, "Transcript"));
    pop.append(head);

    const body = node("div", "chat-work-transcript");
    const lines = node("div", "chat-work-lines");
    lines.append(node("div", "chat-work-badge", "Loading\u2026"));
    body.append(lines);
    const messages = node("div", "chat-work-messages");
    messages.append(node("div", "chat-work-section", "Messages"));
    const messageList = node("div", "chat-work-message-list");
    messageList.append(node("div", "chat-work-empty", canMessage(agent) ? "No messages yet." : messageReason(agent)));
    messages.append(messageList);
    body.append(messages);
    pop.append(body);
    loadChildTranscript(childId, lines);
    if (canMessage(agent)) startMessagesPoll(childId, messageList);
    pop.append(sendBox(agent, (text, done) => sendToChild(agent, text, done)));
  }

  function workRow({ agent, depth }, kind, pop) {
    const row = node("div", "chat-work-row");
    row.style.paddingLeft = `${12 + depth * 14}px`;
    const top = node("div", "chat-work-top");
    const main = node("div", "chat-work-main");
    main.append(node("div", "chat-work-title", workTitle(agent)));
    const meta = [agentLabel(agent.provider), agent.branch, agent.computer && agent.computer.name].filter(Boolean).join(" \u00b7 ");
    if (meta) main.append(node("div", "chat-work-sub", meta));
    top.append(node("div", "chat-work-glyph", providerLetter(agent.provider)), main);
    top.append(node("div", `chat-work-state ${workStateClass(agent)}`, `${workStateText(agent)}${workElapsed(agent)}`));
    top.addEventListener("click", () => drawWork(kind, pop, agent.id));
    row.append(top, sendBox(agent, (text, done) => sendToChild(agent, text, done)));
    return row;
  }

  function loadChildTranscript(childId, lines) {
    hookGet(computerName, "/v1/subagents/transcript", { ...target, child: childId }).then((frame) => {
      const read = readFrame(frame);
      lines.replaceChildren();
      if (!read || read.messages.length === 0) {
        lines.append(node("div", "chat-work-empty", "Nothing to show yet."));
        return;
      }
      for (const message of read.messages) {
        const line = node("div", `chat-work-line ${message.role}`);
        line.textContent = message.text || (message.imageBlocks.length ? "[image]" : "");
        lines.append(line);
      }
    }).catch(() => {
      lines.replaceChildren(node("div", "chat-work-empty", "Could not read this transcript."));
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
    // The snapshot's cursor is not usable until the live backlog replaces it.
    if (!backlogLoaded || loadingOlder || !history.hasMore || history.startLine === null) return;
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
  // A snapshot read ahead while the pointer rested on the row: draw it now;
  // the stream's backlog below replaces it, as it would a fresh load's first page.
  const snapshot = takePrefetched(computerName, child);
  setChatOpen(computerName, child, true);
  const prefetched = snapshot && readFrame(snapshot);
  if (prefetched) history.receive(prefetched);
  render();

  const stopWatchingShown = watchShown(el, () => {
    if (!subagentsSkipped) return;
    subagentsSkipped = false;
    maybeFetchSubagents(true);
  });

  return {
    /** Append review text (a diff line, a selection) to the draft and focus it, without sending. */
    quotaHost,
    updateOverview,
    insert(text) { composer.insert(text); },
    /** Add dropped Files to the composer's pending attachments. */
    attach(files) { composer.attach(files); },
    focus() { composer.focus(); },
    close() {
      closed = true;
      find.destroy();
      setChatOpen(computerName, child, false);
      stopWatchingShown();
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
      el.replaceChildren();
      el.classList.remove("chat-pane");
    },
  };
}
