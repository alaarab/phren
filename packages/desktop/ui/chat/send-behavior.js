// Phone parity rules, independent of the DOM and transport.
export const PASTE_ATTACHMENT_BYTES = 32 * 1024;
export const PASTE_ATTACHMENT_NAME = "pasted-text.txt";
export function pasteBecomesAttachment(text) {
  return new TextEncoder().encode(text).length >= PASTE_ATTACHMENT_BYTES;
}

export function waitTimeLabel(statusSince, needsOwner, now = Date.now()) {
  if (!needsOwner || !statusSince) return null;
  const since = Date.parse(statusSince);
  if (!Number.isFinite(since)) return null;
  const seconds = Math.max(0, (now - since) / 1000);
  if (seconds < 60) return "Waiting";
  if (seconds < 3600) return `Waiting ${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `Waiting ${Math.floor(seconds / 3600)}h`;
  return `Waiting ${Math.floor(seconds / 86400)}d`;
}

export function workedForLabel(activity) {
  const seconds = Math.max(0, Math.floor((Date.parse(activity.finishedAt) - Date.parse(activity.startedAt)) / 1000)) || 0;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), secs = seconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  const duration = hours ? `${hours}h ${pad(minutes)}m ${pad(secs)}s` : minutes ? `${minutes}m ${pad(secs)}s` : `${secs}s`;
  return `${activity.verb || "Worked for"} ${duration}`;
}

// Only explicit reader actions can rejoin the tail. Geometry during a render
// or a server backlog replacement never grants permission to follow.
export function followState(state, event) {
  if (event.type === "latest" || event.type === "send") return { following: true, touching: false };
  if (event.type === "touch-start") return { following: false, touching: true };
  if (event.type === "touch-end") return { ...state, touching: false };
  if (event.type === "leave") return { ...state, following: false };
  if (event.type === "reader-scroll") return { ...state, following: !state.touching && event.distance <= 1 };
  return state;
}

// The phone's GitHostPresentation accepts successful publication receipts,
// including an already-open result. Never infer creation from assistant prose.
export function pullRequestLanded(result, host) {
  if (!result?.ok || typeof result.pullURL !== "string") return null;
  let url;
  try { url = new URL(result.pullURL); } catch { return null; }
  if (url.protocol !== "https:" || !url.hostname) return null;
  const tail = url.pathname.split("/").filter(Boolean).at(-1);
  const number = Number.isInteger(result.number) && result.number > 0 ? result.number : /^\d+$/.test(tail || "") && Number(tail) > 0 ? Number(tail) : null;
  const gitlab = host?.kind === "gitlab" || host === "gitlab";
  const reference = number ? `${gitlab ? "MR !" : "PR #"}${number}` : gitlab ? "Merge request" : "Pull request";
  return { text: `${reference} ${result.existing === true ? "was already open" : "opened"}`, url: url.href, number };
}

// Tool results are paired with the creation call: links in unrelated commands,
// failed tools and PR reads must never announce a newly opened request.
export function openedRequest(messages) {
  const calls = new Map();
  for (const message of messages || []) {
    if (message.role === "tool" && !message.isToolResult && message.toolCallID) calls.set(message.toolCallID, message);
    if (!message.isToolResult || message.isToolError) continue;
    const call = calls.get(message.toolCallID);
    if (!call) continue;
    let command = call.text || "";
    try { const input = JSON.parse(command); command = input.command || input.cmd || ""; } catch { /* raw shell input */ }
    if (!/(?:^|&&\s*|;\s*)(?:gh\s+pr|glab\s+mr)\s+create\b/.test(command.trim())) continue;
    const urls = String(message.text || "").match(/https:\/\/[^\s<>"']+/g) || [];
    for (const raw of urls) {
      const url = raw.replace(/[).,;]+$/, "");
      if (!/\/(?:pull|merge_requests)\/\d+$/.test(url)) continue;
      return pullRequestLanded({ ok: true, pullURL: url }, /\/merge_requests\//.test(url) ? "gitlab" : "github");
    }
  }
  return null;
}
