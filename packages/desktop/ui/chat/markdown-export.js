// A chat as Markdown: built from the loaded transcript messages (the model the
// timeline renders from, not the DOM). Tool calls become one-line bullets and
// their output is left out. Everything passes through redactAll, so a token or
// password in a message never reaches the clipboard or a file.
import { redactAll } from "../redact.js";

/** Escape what would turn a title into markup, and keep it on one line. */
export function escapeTitle(text) {
  return String(text || "").replace(/\s+/g, " ").trim().replace(/([\\`*_[\]<>#|~])/g, "\\$1");
}

const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** `<slugified-title>-<YYYY-MM-DD>.md` */
export function exportFilename(title, date = new Date()) {
  const slug = String(title || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "chat";
  return `${slug}-${isoDate(date)}.md`;
}

function inline(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  const clipped = t.length > 120 ? `${t.slice(0, 119)}…` : t;
  const fence = "`".repeat(Math.max(0, ...(clipped.match(/`+/g) || []).map((r) => r.length)) + 1);
  return `${fence}${clipped.startsWith("`") || clipped.endsWith("`") ? ` ${clipped} ` : clipped}${fence}`;
}

function parse(text) {
  try { const v = JSON.parse(text); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

/** One bullet for a tool call row; `result` is its "Tool result" row when the transcript has it. */
export function toolBullet(message, result) {
  const name = String(message.title || "").split(".").pop() || "tool";
  const f = parse(message.text);
  const path = f.file_path || f.filePath || f.path || f.notebook_path;
  const failed = !!(result && result.isToolError);
  const lower = name.toLowerCase();
  let line;
  if (typeof f.command === "string" || typeof f.cmd === "string") {
    line = `Ran ${inline(f.command ?? f.cmd)}${result ? (failed ? " — failed" : " — passed") : ""}`;
  } else if (lower === "apply_patch") {
    const files = [...String(f.input || f.patch || message.text).matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((m) => m[1].trim());
    line = files.length ? `Edited ${files.map(inline).join(", ")}` : "Edited files";
  } else if (path && /^(edit|multiedit|notebookedit|str_replace_editor|str_replace_based_edit_tool|replace)$/.test(lower)) {
    line = `Edited ${inline(path)}`;
  } else if (path && /^(write|create)/.test(lower)) {
    line = `Wrote ${inline(path)}`;
  } else if (path && /^(read|view)/.test(lower)) {
    line = `Read ${inline(path)}`;
  } else if (typeof f.pattern === "string") {
    line = `Searched ${inline(f.pattern)}`;
  } else {
    line = `Used ${inline(name)}`;
  }
  if (failed && !line.endsWith("— failed")) line += " — failed";
  return `- ${line}`;
}

/**
 * @param {Array} messages the history's rows, oldest first
 * @param {{title?:string, project?:string, computer?:string, harness?:string, agent?:string, date?:Date, earlierMissing?:boolean}} meta
 * @returns {{markdown:string, messages:number}} messages counts the user and assistant rows written
 */
export function chatToMarkdown(messages, meta = {}) {
  const agent = meta.agent || meta.harness || "Agent";
  const results = new Map();
  for (const m of messages) if (m.role === "tool" && m.title === "Tool result" && m.toolCallID) results.set(m.toolCallID, m);
  const out = [`# ${escapeTitle(meta.title) || "Chat"}`, ""];
  out.push([meta.project, meta.computer, meta.harness, isoDate(meta.date || new Date())]
    .filter(Boolean).map((s) => String(s).replace(/\s+/g, " ")).join(" · "), "");
  if (meta.earlierMissing) out.push("_Earlier messages not included_", "");
  let count = 0;
  let heading = null;
  let bullets = false;
  const head = (who) => { if (heading !== who) { out.push(`**${who}**`, ""); heading = who; } };
  for (const m of messages) {
    if (m.isHookContext || m.isQueued) continue;
    if (m.role === "tool") {
      if (m.title === "Tool result" || m.title === "Changes") continue;
      if (m.title === "Conversation compacted") { out.push("_Conversation compacted_", ""); heading = null; bullets = false; continue; }
      head(agent);
      out.push(toolBullet(m, m.toolCallID ? results.get(m.toolCallID) : undefined));
      bullets = true;
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;
    const images = (m.imageBlocks?.length || 0) + (m.uploadImages?.length || 0);
    const body = String(m.text || "").trim();
    if (!body && !images) continue;
    if (bullets) { out.push(""); bullets = false; }
    head(m.role === "user" ? "You" : agent);
    if (body) out.push(body, "");
    for (let i = 0; i < images; i++) out.push("[image]", "");
    count++;
  }
  while (out[out.length - 1] === "") out.pop();
  return { markdown: `${redactAll(out.join("\n"))}\n`, messages: count };
}

/** Hand the text to the browser as a file; Electron asks where to save it. */
export function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// The chat pane the owner last used: the palette's export commands act on it.
let activePane = null;
export function setExportPane(handle) { activePane = handle; }
export function clearExportPane(handle) { if (activePane === handle) activePane = null; }
export function activeExportPane() { return activePane && activePane.isUsable() ? activePane : null; }
