// The agent's own bookkeeping calls, ported from the phone's AgentToolCards.kt
// and ToolCards.kt: a subagent it delegated to, its todo list, the plan it
// wants reviewed, and the web, skill and MCP cards. Bounded previews; nothing
// is evaluated, and the raw call stays on the message.

import {
  parseJson, obj, str, bool, objects, prettyJson, NEWLINE_RE, NEWLINES_RE,
  type JsonValue, type JsonObject,
} from "./tool-presentation.js";

/** Bounded, display-only decoding shared by the agent tool cards. */
export namespace AgentToolCardJSON {
  export function parse(text: string): JsonValue | undefined { return parseJson(text); }

  /** The tool's own name: `functions.Task` -> `Task`. */
  export function tool(name: string | null | undefined): string {
    const parts = (name ?? "").split(".").filter((p) => p !== "");
    return parts.length > 0 ? parts[parts.length - 1] : "";
  }

  export function string(value: JsonValue | undefined, limit = 1200): string {
    const s = str(value);
    return s !== undefined ? s.slice(0, limit).trim() : "";
  }

  function textBlocks(value: JsonValue | undefined): string | null {
    const blocks = objects(value);
    if (blocks === undefined) return null;
    if (!blocks.every((b) => str(b["text"]) !== undefined)) return null;
    return blocks.map((b) => str(b["text"]) as string).join("\n\n");
  }

  /** A result as its text: a plain string, text blocks, or an envelope's output/result/content string. */
  export function resultText(result: string, depth = 0): string {
    if (depth >= 4) return result;
    const value = parse(result);
    if (value === undefined) return result;
    if (typeof value === "string") return resultText(value, depth + 1);
    const blocks = textBlocks(value);
    if (blocks !== null) return blocks;
    const o = obj(value);
    if (o !== undefined) {
      for (const key of ["output", "result", "content", "text"]) {
        const s = str(o[key]); if (s !== undefined) return resultText(s, depth + 1);
        const tb = textBlocks(o[key]); if (tb !== null) return tb;
      }
    }
    return result;
  }

  export function tag(name: string, text: string): string | null {
    const open = text.indexOf(`<${name}>`);
    if (open < 0) return null;
    const start = open + name.length + 2;
    const close = text.indexOf(`</${name}>`, start);
    if (close < 0) return null;
    return text.slice(start, close).trim();
  }
}

export type SubagentState = "running" | "done" | "failed";

/** A subagent: Claude Code's `Task`/`Agent`, Codex's `spawn_agent`. */
export interface AgentSubagentPresentation {
  name: string;
  description: string;
  model: string | null;
  prompt: string;
  promptAvailable: boolean;
  background: boolean;
  report: string;
  summary: string | null;
  state: SubagentState;
}

export namespace AgentSubagentPresentation {
  export type State = SubagentState;
  export const State = {
    RUNNING: "running" as SubagentState, DONE: "done" as SubagentState, FAILED: "failed" as SubagentState,
  };

  export function recognizes(name: string | null | undefined): boolean {
    return ["task", "agent", "spawn_agent"].includes(AgentToolCardJSON.tool(name).toLowerCase());
  }

  export function of(name: string, input: string, result: string | null = null, isError = false, notification: string | null = null): AgentSubagentPresentation | null {
    if (!recognizes(name)) return null;
    const values: JsonObject = obj(AgentToolCardJSON.parse(input)) ?? {};
    const value = (...keys: string[]): string => {
      for (const k of keys) { const s = AgentToolCardJSON.string(values[k]); if (s !== "") return s; }
      return "";
    };
    const rawPrompt = str(values["prompt"] ?? values["message"] ?? values["task"] ?? values["input"]) ?? "";
    const promptAvailable = !looksEncrypted(rawPrompt);
    const prompt = promptAvailable ? rawPrompt.slice(0, 20_000) : "";
    const taskName = value("task_name");
    const typed = value("name", "subagent_type", "agent_type", "role");
    const agentName = taskName === "" ? (typed === "" ? "Agent" : typed) : displayName(taskName);
    const described = value("description");
    const description = described === ""
      ? (prompt.split(NEWLINES_RE).find((s) => s !== "")?.slice(0, 140).replace(/^[ \t]+/, "").replace(/[ \t]+$/, "") ?? "")
      : described.slice(0, 140);
    const model = value("model") === "" ? null : value("model");
    const text = result !== null ? AgentToolCardJSON.resultText(result) : "";
    const spawnAcknowledgement = AgentToolCardJSON.tool(name) === "spawn_agent" && obj(AgentToolCardJSON.parse(text))?.["task_name"] !== undefined;
    const launched = text.toLowerCase().startsWith("async agent launched") || (text.includes("agentId:") && text.includes("output_file")) || spawnAcknowledgement;
    const background = bool(values["run_in_background"]) === true || launched;
    const status = notification !== null ? AgentToolCardJSON.tag("status", notification)?.toLowerCase() : undefined;
    const summaryRaw = notification !== null ? AgentToolCardJSON.tag("summary", notification) : null;
    const summary = summaryRaw !== null && summaryRaw !== "" ? summaryRaw.slice(0, 500) : null;
    const state: SubagentState = isError || ["failed", "killed", "cancelled", "canceled", "stopped", "error"].includes(status ?? "")
      ? "failed" : (status !== undefined || (result !== null && !launched)) ? "done" : "running";
    return { name: agentName, description, model, prompt, promptAvailable, background, report: launched ? "" : trimmed(text), summary, state };
  }

  function looksEncrypted(text: string): boolean {
    const value = text.trim();
    if (value.length <= 80 || !value.startsWith("gAAAAA")) return false;
    return [...value].every((c) => /[A-Za-z0-9\-_=]/.test(c));
  }

  function displayName(path: string): string {
    const parts = path.split("/").filter((p) => p !== "");
    const leaf = parts.length > 0 ? parts[parts.length - 1] : path;
    return leaf.replace(/_/g, " ").replace(/-/g, " ").split(/\s+/).filter((w) => w !== "")
      .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1)).join(" ");
  }

  /** The report without Claude Code's trailing `<usage>` block and "agentId: …" line. */
  export function trimmed(text: string): string {
    let report = text;
    const open = report.indexOf("<usage>");
    if (open >= 0 && report.indexOf("</usage>", open + 7) >= 0) report = report.slice(0, open);
    const lines = report.split("\n");
    while (lines.length > 0) {
      const last = lines[lines.length - 1];
      if (last.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "") === "" || last.startsWith("agentId:")) lines.pop();
      else break;
    }
    return lines.join("\n").slice(0, 12_000).trim();
  }
}

export type TodoStatus = "pending" | "active" | "done";

/** A checklist the agent keeps: TodoWrite, TaskCreate/TaskUpdate/TaskList, Codex's update_plan. */
export interface AgentTodoItem { text: string; status: TodoStatus; activeForm: string | null }
export interface AgentTodoPresentation {
  title: string;
  items: AgentTodoItem[];
  isSnapshot: boolean;
  note: string | null;
  readonly doneCount: number;
  readonly summary: string;
}

export namespace AgentTodoPresentation {
  export type Item = AgentTodoItem;
  export type Status = TodoStatus;
  export const Item = {
    Status: { PENDING: "pending" as TodoStatus, ACTIVE: "active" as TodoStatus, DONE: "done" as TodoStatus },
  };

  export function recognizes(name: string | null | undefined): boolean {
    return ["todowrite", "taskcreate", "taskupdate", "tasklist", "update_plan"].includes(AgentToolCardJSON.tool(name).toLowerCase());
  }

  export function of(name: string, input: string, result: string | null = null): AgentTodoPresentation | null {
    if (!recognizes(name)) return null;
    const tool = AgentToolCardJSON.tool(name).toLowerCase();
    const values: JsonObject = obj(AgentToolCardJSON.parse(input)) ?? {};
    let items: AgentTodoItem[] = []; let note: string | null = null;
    let title: string; let isSnapshot: boolean;
    if (tool === "todowrite") {
      title = "Todos"; isSnapshot = true; items = itemList(values["todos"], "content");
    } else if (tool === "update_plan") {
      title = "Plan"; isSnapshot = true;
      items = itemList(values["plan"], "step");
      note = AgentToolCardJSON.string(values["explanation"], 400) || null;
    } else if (tool === "taskcreate") {
      title = "Tasks"; isSnapshot = false;
      const subject = AgentToolCardJSON.string(values["subject"], 300);
      if (subject !== "") items = [{ text: subject, status: "pending", activeForm: null }];
      note = AgentToolCardJSON.string(values["description"], 400) || null;
    } else if (tool === "taskupdate") {
      title = "Tasks"; isSnapshot = false;
      const subject = AgentToolCardJSON.string(values["subject"], 300);
      const id = AgentToolCardJSON.string(values["taskId"] ?? values["id"] ?? values["task_id"], 40);
      const text = subject !== "" ? subject : (id === "" ? "" : `Task #${id}`);
      if (text !== "") items = [{ text, status: statusOf(values["status"]), activeForm: null }];
    } else {
      title = "Tasks"; isSnapshot = true;
      const text = result !== null ? AgentToolCardJSON.resultText(result) : "";
      const listed = AgentToolCardJSON.parse(text);
      if (listed !== undefined) {
        items = itemList(listed, "subject");
        if (items.length === 0) { const o = obj(listed); if (o !== undefined) items = itemList(o["tasks"], "subject"); }
      }
      if (items.length === 0) items = checklistLines(text);
      if (items.length === 0) {
        const joined = text.split("\n").slice(0, 6).join("\n").slice(0, 600).trim();
        note = joined === "" ? null : joined;
      }
    }
    if (items.length === 0 && note === null) return null;
    return makeTodo(title, items.slice(0, 40), isSnapshot, note);
  }

  /** Which snapshots, in timeline order, a later snapshot of the same family replaced. */
  export function superseded(cards: (AgentTodoPresentation | null)[]): boolean[] {
    const seen = new Set<string>(); const flags = cards.map(() => false);
    for (let index = cards.length - 1; index >= 0; index--) {
      const card = cards[index];
      if (card === null || card === undefined || !card.isSnapshot) continue;
      if (seen.has(card.title)) flags[index] = true; else seen.add(card.title);
    }
    return flags;
  }

  function itemList(value: JsonValue | undefined, key: string): AgentTodoItem[] {
    return (objects(value) ?? []).flatMap((entry) => {
      const text = AgentToolCardJSON.string(entry[key] ?? entry["content"] ?? entry["step"] ?? entry["subject"] ?? entry["text"], 300);
      if (text === "") return [];
      return [{ text, status: statusOf(entry["status"]), activeForm: AgentToolCardJSON.string(entry["activeForm"], 300) || null }];
    });
  }

  function statusOf(value: JsonValue | undefined): TodoStatus {
    const s = AgentToolCardJSON.string(value, 40).toLowerCase();
    if (["completed", "complete", "done", "resolved", "closed"].includes(s)) return "done";
    if (["in_progress", "in-progress", "active", "doing", "started", "running"].includes(s)) return "active";
    return "pending";
  }

  const CHECKLIST_LINE = /^(?:[-*]\s*)?\[([ xX~>-])\]\s+(.+)$/;
  function checklistLines(text: string): AgentTodoItem[] {
    return text.split(NEWLINES_RE).filter((s) => s !== "").slice(0, 200).flatMap((line) => {
      const trimmed = line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
      const m = CHECKLIST_LINE.exec(trimmed);
      if (m === null) return [];
      const body = m[2].slice(0, 300).replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
      if (body === "") return [];
      const glyph = m[1];
      const status: TodoStatus = glyph === "x" || glyph === "X" ? "done" : glyph === "~" || glyph === ">" ? "active" : "pending";
      return [{ text: body, status, activeForm: null }];
    });
  }
}

function makeTodo(title: string, items: AgentTodoItem[], isSnapshot: boolean, note: string | null): AgentTodoPresentation {
  const doneCount = items.filter((i) => i.status === "done").length;
  return {
    title, items, isSnapshot, note, doneCount,
    summary: `${doneCount} of ${items.length} done`,
  };
}

export type PlanState = "pending" | "approved" | "rejected";

/** Claude Code's plan review: `ExitPlanMode` carries the plan. */
export interface AgentPlanPresentation { plan: string; state: PlanState }

export namespace AgentPlanPresentation {
  export type State = PlanState;
  export const State = {
    PENDING: "pending" as PlanState, APPROVED: "approved" as PlanState, REJECTED: "rejected" as PlanState,
  };

  export function recognizes(name: string | null | undefined): boolean {
    return AgentToolCardJSON.tool(name).toLowerCase() === "exitplanmode";
  }
  export function isPlanMode(name: string | null | undefined): boolean {
    return AgentToolCardJSON.tool(name).toLowerCase() === "enterplanmode";
  }

  export function of(name: string, input: string, result: string | null = null, isError = false): AgentPlanPresentation | null {
    if (!recognizes(name)) return null;
    const plan = planOf(input);
    if (result === null) return { plan, state: "pending" };
    const text = AgentToolCardJSON.resultText(result).toLowerCase();
    return { plan, state: isError || text.includes("rejected") || text.includes("doesn't want") || text.includes("denied") ? "rejected" : "approved" };
  }

  /** From a pending permission request's message: the tool input as JSON. */
  export function fromApprovalInput(message: string): AgentPlanPresentation | null {
    const parsed = AgentToolCardJSON.parse(message);
    const plan = obj(parsed) !== undefined ? str((parsed as JsonObject)["plan"]) : undefined;
    if (plan === undefined || plan === "") return null;
    return { plan: plan.slice(0, 40_000).trim(), state: "pending" };
  }

  function planOf(input: string): string {
    const parsed = AgentToolCardJSON.parse(input);
    const plan = obj(parsed) !== undefined ? str((parsed as JsonObject)["plan"]) : undefined;
    return (plan ?? "").slice(0, 40_000).trim();
  }
}

/** An approval request, as the plan card reads it (AgentApproval). */
export interface AgentApproval {
  actionId: string;
  toolName: string;
  message: string | null;
  /** What the Live Activity shows: the plan text, not its JSON. */
  explanation: string;
}

export namespace AgentApproval {
  export function read(value: JsonObject): AgentApproval {
    const message = str(value["message"]) ?? null;
    const toolName = str(value["toolName"]) ?? "";
    const plan = toolName === "ExitPlanMode" && message !== null ? AgentPlanPresentation.fromApprovalInput(message) : null;
    return {
      actionId: str(value["actionId"]) ?? "",
      toolName,
      message,
      explanation: plan?.plan ?? message ?? "",
    };
  }
}

/** Claude Code asks for plan review through a permission request for `ExitPlanMode`. */
export function isPlanApproval(approval: AgentApproval): boolean {
  return approval.toolName === "ExitPlanMode";
}
export function approvalPlan(approval: AgentApproval): AgentPlanPresentation | null {
  return isPlanApproval(approval) && approval.message !== null ? AgentPlanPresentation.fromApprovalInput(approval.message) : null;
}

/** Bounded, display-only decoding shared by the web, skill and MCP cards. */
export namespace ToolCallText {
  export function parse(text: string): JsonValue | undefined { return parseJson(text); }

  export function unwrap(value: JsonValue, depth = 0): JsonValue {
    if (depth >= 5) return value;
    if (typeof value === "string") { const parsed = parse(value); if (parsed !== undefined) return unwrap(parsed, depth + 1); }
    const o = obj(value);
    if (o !== undefined) {
      if (bool(o["isError"]) === true) return value;
      if (o["structuredContent"] !== undefined) return unwrap(o["structuredContent"] as JsonValue, depth + 1);
      const content = o["content"];
      if (content !== undefined && Object.keys(o).length <= 2) return unwrap(content, depth + 1);
    }
    const blocks = objects(value);
    if (blocks !== undefined && blocks.length > 0 && blocks.every((b) => str(b["text"]) !== undefined && (b["type"] === undefined || ["text", "input_text", "output_text"].includes(str(b["type"]) ?? "")))) {
      const text = blocks.map((b) => str(b["text"]) as string).join("\n\n");
      return blocks.length === 1 ? unwrap(text, depth + 1) : text;
    }
    return value;
  }

  export function unwrapText(text: string): JsonValue { return unwrap(text); }

  /** The text a result reads as: strings as they are, everything else as pretty JSON. */
  export function text(value: JsonValue): string {
    return typeof value === "string" ? value : prettyJson(value, true);
  }

  /** A scalar as it reads on a card; containers as their size, never their braces. */
  export function plain(value: JsonValue, depth = 0, limit = 200): string {
    if (value === null) return "—";
    if (typeof value === "string") return value.trim().length > limit ? value.trim().slice(0, limit) + "…" : value.trim();
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return numberString(String(value));
    if (Array.isArray(value)) return value.length === 1 ? "1 item" : `${value.length} items`;
    const o = value as JsonObject;
    const size = Object.keys(o).length;
    if (depth <= 0) return size === 1 ? "{1 field}" : `{${size} fields}`;
    return orderedKeys(o).slice(0, 6).map((k) => `${k}: ${plain(o[k] as JsonValue, depth - 1, 60)}`).join(" · ");
  }

  function numberString(content: string): string {
    const d = Number(content);
    if (Number.isNaN(d)) return content;
    return Number.isInteger(d) && Number.isFinite(d) && Math.abs(d) < 1e15 ? String(d) : content;
  }

  const PREFERRED_KEYS = ["title", "name", "summary", "message", "query", "url", "path", "state", "status", "number", "id", "count", "total", "description", "body"];
  export function orderedKeys(dict: JsonObject): string[] {
    const preferred = PREFERRED_KEYS.filter((k) => dict[k] !== undefined);
    return [...preferred, ...Object.keys(dict).filter((k) => !preferred.includes(k)).sort()];
  }

  /** `_`, `-` and camelCase seams become spaces; first word capitalized, acronyms kept. */
  export function sentence(identifier: string): string {
    const spaced = identifier.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/-/g, " ");
    const words = spaced.split(/\s+/).filter((w) => w !== "");
    return words.map((word, index) => {
      if (word.length >= 2 && word === word.toUpperCase() && /[A-Za-z]/.test(word)) return word;
      if (index === 0) return word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase();
      return word.toLowerCase();
    }).join(" ");
  }

  /** The first `count` lines, each bounded, and whether anything was left out. */
  export function firstLines(text: string, count: number, characters = 200): [string[], boolean] {
    const lines: string[] = []; let truncated = false;
    for (const line of text.split(NEWLINE_RE)) {
      if (lines.length === count) { truncated = true; break; }
      if (line.length > characters) { lines.push(line.slice(0, characters) + "…"); truncated = true; }
      else lines.push(line);
    }
    return [lines, truncated];
  }
}

export type WebKind = "fetch" | "search";
export type WebStatus = "running" | "succeeded" | "failed";

/** A web fetch or search as its card reads it. */
export interface WebToolPresentation {
  kind: WebKind;
  url: string | null;
  query: string | null;
  location: string;
  prompt: string | null;
  resultMarkdown: string | null;
  resultTruncated: boolean;
  result: string | null;
  status: WebStatus;
  readonly title: string;
}

export namespace WebToolPresentation {
  export type Kind = WebKind;
  export type Status = WebStatus;
  export const Kind = { FETCH: "fetch" as WebKind, SEARCH: "search" as WebKind };
  export const Status = { RUNNING: "running" as WebStatus, SUCCEEDED: "succeeded" as WebStatus, FAILED: "failed" as WebStatus };
  export const PREVIEW_LINES = 12;
  const FETCH_NAMES = ["webfetch", "web_fetch", "fetch_url", "fetch_webpage", "fetch_page"];
  const SEARCH_NAMES = ["websearch", "web_search"];

  export function kind(name: string | null | undefined): WebKind | null {
    const parts = (name ?? "").split(".").filter((p) => p !== "");
    const tool = (parts.length > 0 ? parts[parts.length - 1] : "").toLowerCase();
    return FETCH_NAMES.includes(tool) ? "fetch" : SEARCH_NAMES.includes(tool) ? "search" : null;
  }
  export function recognizes(name: string | null | undefined): boolean { return kind(name) !== null; }

  export function of(name: string, input: string, result: string | null = null, isError = false): WebToolPresentation | null {
    const k = kind(name);
    if (k === null) return null;
    const values: JsonObject = obj(ToolCallText.parse(input)) ?? {};
    const value = (...names: string[]): string | undefined => {
      for (const n of names) { const s = str(values[n]); if (s !== undefined) { const t = s.trim(); if (t !== "") return t; } }
      return undefined;
    };
    const url = k === "fetch" ? value("url", "uri", "link") ?? null : null;
    const query = k === "search" ? value("query", "q", "search") ?? null : null;
    const prompt = k === "fetch" ? value("prompt", "instructions", "question") ?? null : null;
    const fallback = input.trim().slice(0, 120);
    const location = k === "fetch" ? (url !== null ? locationOf(url) : fallback) : query !== null ? `“${query}”` : fallback;
    const unwrapped = result !== null ? ToolCallText.unwrap(result) : undefined;
    const failed = isError || (obj(unwrapped) !== undefined && bool((unwrapped as JsonObject)["isError"]) === true);
    const status: WebStatus = result === null ? "running" : failed ? "failed" : "succeeded";
    const text = unwrapped !== undefined ? ToolCallText.text(unwrapped) : null;
    let markdown: string | null = null; let truncated = false;
    if (text !== null) {
      const [lines, cut] = ToolCallText.firstLines(linksAsMarkdown(text), PREVIEW_LINES, 400);
      const joined = lines.join("\n").trim();
      markdown = joined === "" ? null : joined; truncated = cut;
    }
    return { kind: k, url, query, location, prompt, resultMarkdown: markdown, resultTruncated: truncated, result: text, status, title: k === "fetch" ? "Fetch" : "Search" };
  }

  /** Host and path, without scheme, query, fragment or a trailing slash. */
  export function locationOf(url: string): string {
    const trimmed = url.trim();
    const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/.exec(trimmed);
    const host = m !== null ? m[1] : undefined;
    if (host === undefined || host === "") return trimmed.slice(0, 200);
    return (host + (m![2] ?? "").replace(/\/+$/, "")).slice(0, 200);
  }

  /** `Links: [{...}]` -> one `• [title](url)` per link. */
  export function linksAsMarkdown(text: string): string {
    if (!text.includes("Links: [")) return text;
    return text.split(NEWLINE_RE).map((line) => {
      const start = line.indexOf("[");
      const links = line.startsWith("Links: [") && start >= 0 ? objects(ToolCallText.parse(line.slice(start))) : undefined;
      if (links === undefined || links.length === 0) return line;
      return links.slice(0, 8).flatMap((link) => {
        const href = str(link["url"]);
        if (href === undefined || href === "") return [];
        const rawTitle = str(link["title"]);
        const title = rawTitle !== undefined && rawTitle !== "" ? rawTitle : href;
        return [`• [${title.replace(/\[/g, "\\[").replace(/\]/g, "\\]")}](${href})`];
      }).join("\n");
    }).join("\n");
  }
}

export type CallStatus = "running" | "succeeded" | "failed";

/** A skill invocation as the inline chip reads it. */
export interface SkillCallPresentation { command: string; args: string | null; result: string | null; status: CallStatus }

export namespace SkillCallPresentation {
  export type Status = CallStatus;
  export const Status = { RUNNING: "running" as CallStatus, SUCCEEDED: "succeeded" as CallStatus, FAILED: "failed" as CallStatus };
  const NAMES = ["skill", "use_skill", "load_skill", "invoke_skill", "run_skill"];

  export function recognizes(name: string | null | undefined): boolean {
    const parts = (name ?? "").split(".").filter((p) => p !== "");
    return NAMES.includes((parts.length > 0 ? parts[parts.length - 1] : "").toLowerCase());
  }

  export function of(name: string, input: string, result: string | null = null, isError = false): SkillCallPresentation | null {
    if (!recognizes(name)) return null;
    const values = obj(ToolCallText.parse(input));
    if (values === undefined) return null;
    const value = (...names: string[]): string | undefined => {
      for (const n of names) { const s = str(values[n]); if (s !== undefined) { const t = s.trim(); if (t !== "") return t; } }
      return undefined;
    };
    const skill = value("skill", "name", "skill_name", "command");
    if (skill === undefined) return null;
    const bare = skill.replace(/^\//, "");
    if (bare === "" || utf8LengthLocal(bare) > 200 || [...bare].some((c) => c === "\n" || c === "\r")) return null;
    let args: string | null = null;
    const rawArgs = value("args", "arguments", "input", "prompt");
    if (rawArgs !== undefined) {
      const line = rawArgs.split(NEWLINES_RE).find((l) => l !== "") ?? "";
      args = line.length > 120 ? line.slice(0, 120) + "…" : line;
    }
    const unwrapped = result !== null ? ToolCallText.unwrap(result) : undefined;
    const failed = isError || (obj(unwrapped) !== undefined && bool((unwrapped as JsonObject)["isError"]) === true);
    return { command: "/" + bare, args, result: unwrapped !== undefined ? ToolCallText.text(unwrapped) : null, status: result === null ? "running" : failed ? "failed" : "succeeded" };
  }
}

function utf8LengthLocal(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** A call to any MCP server but phren's. */
export interface MCPField { name: string; value: string }
export interface MCPToolPresentation {
  server: string;
  verb: string;
  fields: MCPField[];
  hiddenFields: number;
  resultLines: string[];
  resultTruncated: boolean;
  status: CallStatus;
}

export namespace MCPToolPresentation {
  export type Status = CallStatus;
  export type Field = MCPField;
  export const Status = { RUNNING: "running" as CallStatus, SUCCEEDED: "succeeded" as CallStatus, FAILED: "failed" as CallStatus };
  export const MAXIMUM_FIELDS = 8;
  export const MAXIMUM_RESULT_LINES = 6;
  const KNOWN_SERVERS: Record<string, string> = { github: "GitHub", gitlab: "GitLab", openai: "OpenAI", youtube: "YouTube", linkedin: "LinkedIn" };

  export function recognizes(name: string | null | undefined): boolean { return parts(name) !== null; }

  function parts(name: string | null | undefined): [string, string] | null {
    const split = (name ?? "").split(".").filter((p) => p !== "");
    const tool = split.length > 0 ? split[split.length - 1] : "";
    const components = tool.split("__");
    if (components.length < 3 || components[0] !== "mcp" || components[1] === "" || components[1] === "phren" || components.slice(2).join("") === "") return null;
    return [components[1], components.slice(2).join("_")];
  }

  export function of(name: string, input: string, result: string | null = null, isError = false): MCPToolPresentation | null {
    const split = parts(name);
    if (split === null) return null;
    const [rawServer, rawTool] = split;
    const values: JsonObject = obj(ToolCallText.parse(input)) ?? {};
    const keys = ToolCallText.orderedKeys(values);
    const fields = keys.slice(0, MAXIMUM_FIELDS).map((k) => ({ name: k.replace(/_/g, " "), value: ToolCallText.plain(values[k] as JsonValue) }));
    const hidden = Math.max(0, keys.length - MAXIMUM_FIELDS);
    const unwrapped = result !== null ? ToolCallText.unwrap(result) : undefined;
    const envelope = obj(unwrapped) ?? {};
    const failed = isError || bool(envelope["isError"]) === true || bool(envelope["ok"]) === false;
    const status: CallStatus = result === null ? "running" : failed ? "failed" : "succeeded";
    let lines: string[] = []; let truncated = false;
    if (unwrapped !== undefined) {
      if (failed) {
        const message = envelope["error"] ?? envelope["message"] ?? (envelope["content"] !== undefined ? ToolCallText.unwrap(envelope["content"] as JsonValue) : undefined) ?? unwrapped;
        const [first, cut] = ToolCallText.firstLines(ToolCallText.text(message as JsonValue), MAXIMUM_RESULT_LINES);
        lines = first.length === 0 ? ["Call failed"] : first; truncated = cut;
      } else if (obj(unwrapped) !== undefined) {
        const data = obj((unwrapped as JsonObject)["data"]) ?? (unwrapped as JsonObject);
        const dataKeys = ToolCallText.orderedKeys(data);
        lines = dataKeys.slice(0, MAXIMUM_RESULT_LINES).map((k) => `${k}: ${ToolCallText.plain(data[k] as JsonValue, 1, 160)}`);
        truncated = dataKeys.length > MAXIMUM_RESULT_LINES;
      } else if (Array.isArray(unwrapped)) {
        const shown = unwrapped.slice(0, MAXIMUM_RESULT_LINES - 1).map((v) => "· " + ToolCallText.plain(v, 1, 160));
        lines = [ToolCallText.plain(unwrapped)].concat(shown);
        truncated = unwrapped.length > shown.length;
      } else {
        const [first, cut] = ToolCallText.firstLines(ToolCallText.text(unwrapped), MAXIMUM_RESULT_LINES);
        lines = first.every((l) => l === "") ? [] : first; truncated = cut;
      }
    }
    return { server: serverName(rawServer), verb: ToolCallText.sentence(rawTool), fields, hiddenFields: hidden, resultLines: lines, resultTruncated: truncated, status };
  }

  export function serverName(raw: string): string {
    const known = KNOWN_SERVERS[raw.toLowerCase()];
    if (known !== undefined) return known;
    return raw.split(/[_-]/).filter((w) => w !== "").map((w) => (w === w.toLowerCase() ? w.slice(0, 1).toUpperCase() + w.slice(1) : w)).join(" ");
  }
}




