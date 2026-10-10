// Chat pane for the Phren desktop phase 0 spike. Plain browser ES module.
// Owns one chat view inside `el`; talks to the Hook through the desktop proxy.

const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const PROVIDERS = { claude: "Claude", codex: "Codex", copilot: "Copilot", phren: "Phren", opencode: "OpenCode" };

const CSS = `
.chat-pane { display:flex; flex-direction:column; gap:12px; height:100%; min-height:0; }
.chat-headings { min-width:0; flex:1; }
.chat-sub, .chat-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.chat-header { display:flex; gap:12px; align-items:center; min-width:0; padding:12px 16px; background:var(--card); border:1px solid var(--border); border-radius:10px; }
.chat-ring { flex:0 0 auto; width:32px; height:32px; border-radius:999px; border:2px solid var(--muted); display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:600; }
.chat-headings { min-width:0; display:flex; flex-direction:column; gap:2px; }
.chat-title { color:var(--text); font-size:15px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.chat-sub { display:flex; gap:8px; align-items:baseline; min-width:0; font-size:12px; }
.chat-project { color:var(--accent); white-space:nowrap; }
.chat-branch { color:var(--muted); font-family:${MONO}; white-space:nowrap; }
.chat-computer { color:var(--muted); white-space:nowrap; }
.chat-transcript { flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding:4px; }
.chat-user { align-self:flex-end; max-width:80%; padding:8px 12px; background:rgba(255,255,255,0.08); border-radius:12px; color:var(--text); font-size:13px; white-space:pre-wrap; overflow-wrap:anywhere; }
.chat-assistant { align-self:stretch; color:var(--text); font-family:${MONO}; font-size:13px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; }
.chat-assistant code, .chat-assistant .code { color:var(--path); font-family:inherit; }
.chat-preview { color:var(--dim); font-style:italic; font-family:${MONO}; font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
.tool { display:flex; gap:8px; align-items:baseline; min-width:0; padding:6px 10px; background:var(--tool); border-radius:10px; font-size:12px; }
.tool-name { flex:0 0 auto; color:var(--text-2); font-weight:600; white-space:nowrap; }
.tool-sum { min-width:0; color:var(--muted); font-family:${MONO}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.chat-status { display:flex; flex-direction:column; gap:8px; min-height:18px; padding:0 4px; font-size:13px; }
.chat-status-text.working { color:var(--working); }
.chat-status-text.waiting { color:var(--waiting); }
.chat-approval { display:flex; flex-direction:column; gap:8px; padding:12px; background:var(--surface); border:1px solid var(--border-strong); border-radius:10px; }
.chat-approval-title { color:var(--text); font-size:13px; font-weight:600; }
.chat-approval-detail { color:var(--text-2); font-family:${MONO}; font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
.chat-approval-detail code { color:var(--path); font-family:inherit; }
.chat-approval-actions { display:flex; gap:8px; }
.chat-pill { padding:6px 16px; border:none; border-radius:999px; font-size:12px; cursor:pointer; }
.chat-approve { background:var(--accent-solid); color:#fff; }
.chat-approve:hover { background:var(--accent); }
.chat-deny { background:var(--raised); color:var(--text-2); }
.chat-deny:hover { background:var(--card); }
.chat-composer-wrap { display:flex; flex-direction:column; gap:4px; }
.chat-composer { display:flex; gap:8px; align-items:flex-end; padding:8px; background:var(--sunken); border-radius:12px; }
.chat-input { flex:1; min-height:36px; max-height:160px; resize:none; border:none; outline:none; background:transparent; color:var(--text); font-family:${MONO}; font-size:13px; line-height:1.5; }
.chat-input::placeholder { color:var(--dim); }
.chat-send { flex:0 0 auto; width:36px; height:36px; border:none; border-radius:999px; background:var(--accent-solid); color:#fff; font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center; }
.chat-send:hover { background:var(--accent); }
.chat-stop { flex:0 0 auto; height:36px; padding:0 14px; border:1px solid var(--border-strong); border-radius:999px; background:var(--raised); color:var(--text-2); cursor:pointer; }
.chat-stop:hover { border-color:var(--danger); color:var(--danger); }
.chat-error { color:var(--danger); font-size:12px; padding:0 4px; }
.chat-error:empty { display:none; }
`;

function ensureStyle() {
  if (document.getElementById("chat-style")) return;
  const style = document.createElement("style");
  style.id = "chat-style";
  style.textContent = CSS;
  document.head.appendChild(style);
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function providerName(source) {
  return PROVIDERS[String(source || "").toLowerCase()] || "Agent";
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
  return "var(--muted)";
}

function toolName(name) {
  const raw = String(name || "Tool");
  const n = raw.toLowerCase();
  if (n === "bash" || n === "shell" || n === "execute" || n === "run") return "Shell";
  if (n === "read") return "Read";
  if (n === "edit" || n === "write" || n === "apply_patch" || n === "patch") return "Edit";
  return raw;
}

function oneLine(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

// Prefer a meaningful field of a tool input over a raw JSON dump.
function summarizeInput(input) {
  if (input == null) return "";
  if (typeof input === "string") return oneLine(input);
  if (typeof input !== "object") return oneLine(input);
  for (const key of ["command", "file_path", "path", "pattern", "query", "url"]) {
    if (typeof input[key] === "string") return oneLine(input[key]);
  }
  try { return oneLine(JSON.stringify(input)); } catch { return ""; }
}

// Minimal inline **bold** and `code`, built as DOM so text is never HTML-parsed.
function renderMarkup(text) {
  const frag = document.createDocumentFragment();
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match;
  while ((match = re.exec(text))) {
    if (match.index > last) frag.append(document.createTextNode(text.slice(last, match.index)));
    const token = match[1];
    if (token.startsWith("**")) {
      frag.append(h("strong", null, token.slice(2, -2)));
    } else {
      frag.append(h("code", "code", token.slice(1, -1)));
    }
    last = match.index + token.length;
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
}

function userBubble(text) {
  return h("div", "chat-user", text);
}

function assistantText(text) {
  const node = h("div", "chat-assistant");
  node.append(renderMarkup(text));
  return node;
}

function toolCard(name, input) {
  const card = h("div", "tool");
  card.append(h("span", "tool-name", toolName(name)));
  card.append(h("span", "tool-sum", summarizeInput(input)));
  return card;
}

// Turn one harness JSONL row into zero or more rendered nodes. Unknown shapes skip.
function rowsFromRaw(raw) {
  if (!raw || typeof raw !== "object") return [];
  const nodes = [];

  // Claude: raw.type "user" | "assistant", raw.message.content.
  if (raw.type === "user" || raw.type === "assistant") {
    const content = raw.message ? raw.message.content : undefined;
    const parts = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        nodes.push(raw.type === "user" ? userBubble(part.text) : assistantText(part.text));
      } else if (part.type === "tool_use") {
        nodes.push(toolCard(part.name, part.input));
      }
      // text with no value and tool_result are hidden.
    }
    return nodes;
  }

  // Codex: raw.type "response_item", raw.payload a role-tagged message.
  if (raw.type === "response_item") {
    const payload = raw.payload;
    if (!payload || payload.type !== "message" || !Array.isArray(payload.content)) return [];
    const role = payload.role === "user" ? "user" : payload.role === "assistant" ? "assistant" : "";
    if (!role) return [];
    for (const part of payload.content) {
      if (!part || typeof part !== "object" || typeof part.text !== "string" || !part.text.trim()) continue;
      nodes.push(role === "user" ? userBubble(part.text) : assistantText(part.text));
    }
    return nodes;
  }

  return [];
}

/**
 * Open a chat view for one session.
 * @param {HTMLElement} el container to fill and own
 * @param {string} computerName Hook computer name
 * @param {{title?:string,label?:string,cwd?:string,branch?:string,agentStatus?:string,target?:object}} child overview row
 * @returns {{close: () => void}}
 */
export function openChat(el, computerName, child, opts = {}) {
  ensureStyle();

  const target = child && child.target ? child.target : {};
  const source = target.source;
  const provider = providerName(source);
  const params = new URLSearchParams(target).toString();
  const host = `/hosts/${encodeURIComponent(computerName)}`;
  const socketUrl = (path) => `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${host}${path}`;
  const post = (path, body) =>
    fetch(host + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Phren-Desktop": "1" }, body: JSON.stringify(body) });

  el.classList.add("chat-pane");
  el.replaceChildren();

  const ring = h("div", "chat-ring", provider.charAt(0).toUpperCase());
  ring.style.borderColor = statusColor(child && child.agentStatus);
  ring.style.color = ring.style.borderColor;
  const title = h("div", "chat-title", (child && (child.title || child.label)) || provider);
  const sub = h("div", "chat-sub");
  sub.append(h("span", "chat-project", basename(child && child.cwd)));
  sub.append(h("span", "chat-branch", (child && child.branch) || ""));
  sub.append(h("span", "chat-computer", computerName));
  const headings = h("div", "chat-headings");
  headings.append(title, sub);
  const header = h("div", "chat-header");
  header.append(ring, headings);

  const transcript = h("div", "chat-transcript");
  const statusArea = h("div", "chat-status");
  const statusText = h("div", "chat-status-text");
  statusArea.append(statusText);

  const input = h("textarea", "chat-input");
  input.placeholder = `Message ${provider}\u2026`;
  input.rows = 1;
  const stopBtn = h("button", "chat-stop", "Stop");
  stopBtn.hidden = true;
  const sendBtn = h("button", "chat-send", "\u2191");
  sendBtn.title = "Send";
  const composer = h("div", "chat-composer");
  composer.append(input, stopBtn, sendBtn);
  const error = h("div", "chat-error");
  const composerWrap = h("div", "chat-composer-wrap");
  composerWrap.append(composer, error);

  // Order: header card, scrolling transcript, status line, composer at the bottom.
  el.append(header, transcript, statusArea, composerWrap);

  let previewEl = null;
  let working = false;
  let approvalEl = null;
  let approvalActionId = null;

  const isAtBottom = () => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  const scrollToBottom = () => { transcript.scrollTop = transcript.scrollHeight; };

  function setPreview(text) {
    const stick = isAtBottom();
    if (!text) {
      if (previewEl) { previewEl.remove(); previewEl = null; }
    } else {
      if (!previewEl) {
        previewEl = h("div", "chat-preview");
        transcript.append(previewEl);
      }
      previewEl.textContent = text;
    }
    if (stick) scrollToBottom();
  }

  function appendEntry(entry) {
    if (!entry || !entry.raw) return;
    for (const node of rowsFromRaw(entry.raw)) transcript.insertBefore(node, previewEl);
  }

  function onTranscript(frame) {
    const type = frame && frame.type;
    if (type === "backlog" || type === "append") {
      const stick = isAtBottom();
      if (type === "backlog") {
        transcript.replaceChildren();
        previewEl = null;
      }
      for (const entry of Array.isArray(frame.entries) ? frame.entries : []) appendEntry(entry);
      if (type === "backlog" || stick) scrollToBottom();
    } else if (type === "preview") {
      setPreview(typeof frame.text === "string" ? frame.text : "");
    }
    // "older" and unknown frames are ignored.
  }

  function clearApproval() {
    if (approvalEl) { approvalEl.remove(); approvalEl = null; approvalActionId = null; }
  }

  function showApproval(approval) {
    const actionId = String(approval.actionId);
    if (approvalEl && approvalActionId === actionId) return;
    clearApproval();
    approvalActionId = actionId;
    const detail = approval.title || approval.command || approval.reason || "Approval required";
    approvalEl = h("div", "chat-approval");
    approvalEl.append(h("div", "chat-approval-title", `${provider} asks`));
    const detailEl = h("div", "chat-approval-detail");
    detailEl.append(h("code", null, String(detail)));
    approvalEl.append(detailEl);
    const actions = h("div", "chat-approval-actions");
    const approve = h("button", "chat-pill chat-approve", "Approve");
    const deny = h("button", "chat-pill chat-deny", "Deny");
    approve.addEventListener("click", () => answerApproval(actionId, "approve"));
    deny.addEventListener("click", () => answerApproval(actionId, "deny"));
    actions.append(approve, deny);
    approvalEl.append(actions);
    statusArea.append(approvalEl);
  }

  async function answerApproval(actionId, decision) {
    try {
      const res = await post("/v1/approvals/answer", { target, actionId, decision });
      if (res.ok) clearApproval();
    } catch { /* leave the card up; the status socket will refresh it */ }
  }

  function setStatus(text, kind) {
    statusText.textContent = text;
    statusText.className = kind ? `chat-status-text ${kind}` : "chat-status-text";
  }

  function onStatus(frame) {
    if (!frame || frame.type !== "agentStatus") return;
    const status = String(frame.status || "").toLowerCase();
    working = status === "working";
    stopBtn.hidden = !working;
    if (working) setStatus("Working\u2026", "working");
    else if (status === "blocked" || status === "waiting") setStatus("Needs you", "waiting");
    else setStatus("", null);
    ring.style.borderColor = ring.style.color = statusColor(status);
    if (frame.pendingApproval && frame.pendingApproval.actionId) showApproval(frame.pendingApproval);
    else clearApproval();
  }

  function setError(text) {
    error.textContent = text || "";
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    setError("");
    try {
      const res = await post("/v1/prompt", { target, text, deliveryId: crypto.randomUUID() });
      if (!res.ok) {
        setError((await res.text()) || `Send failed (${res.status})`);
        return;
      }
      input.value = "";
    } catch (err) {
      setError(err && err.message ? err.message : "Send failed");
    }
  }

  function stop() {
    post("/v1/keys", { target, keys: ["Escape"] }).catch(() => {});
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", stop);

  const transcriptWs = new WebSocket(socketUrl(`/v1/transcripts?${params}`));
  transcriptWs.onmessage = (event) => {
    try { onTranscript(JSON.parse(event.data)); } catch { /* ignore malformed frames */ }
  };
  const statusWs = new WebSocket(socketUrl(`/v1/status?${params}`));
  statusWs.onmessage = (event) => {
    try { onStatus(JSON.parse(event.data)); } catch { /* ignore malformed frames */ }
  };

  return {
    /** Append review text (a diff line, a selection) to the draft and focus it, without sending. */
    insert(text) {
      const gap = input.value && !input.value.endsWith("\n") ? "\n" : "";
      input.value = input.value + gap + text;
      input.dispatchEvent(new Event("input"));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    close() {
      try { transcriptWs.close(); } catch { /* already closing */ }
      try { statusWs.close(); } catch { /* already closing */ }
      el.replaceChildren();
      el.classList.remove("chat-pane");
    },
  };
}
