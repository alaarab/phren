// A phren tool call as a bounded, human-readable card, ported from the phone's
// PhrenToolPresentation.kt. Raw input and output stay on the message for the
// full reader; malformed or future tools still get useful fields.

import {
  parseJson, obj, arr, str, bool, num, int, objects, strings, prettyJson, capitalized,
  NEWLINES_RE, type JsonValue, type JsonObject,
} from "./tool-presentation.js";

export type PhrenStatus = "running" | "succeeded" | "failed";
export type TargetKind = "task" | "finding" | "search";

export interface PhrenField { name: string; value: string }
export interface PhrenRow { title: string; detail: string | null; trailing: string | null }
export interface PhrenRowGroup { header: string | null; rows: PhrenRow[] }
export interface PhrenUsageWindow { name: string; usedPercent: number | null; resetsIn: string | null; reset: boolean; exhausted: boolean }
export interface PhrenUsageAccount { name: string; account: string | null; windows: PhrenUsageWindow[]; exhausted: boolean; stale: boolean; age: string | null; availableIn: string | null; spend: string | null }
export interface PhrenReturnRow { computer: string; project: string | null; label: string | null; harness: string | null; state: string; excerpt: string | null }
export interface PhrenSessionRow { status: string; project: string | null; label: string | null; title: string | null; idleFor: number | null; conductor: boolean }
export interface PhrenSessionGroup { computer: string; rows: PhrenSessionRow[] }
export interface PhrenSearchResult { title: string; text: string; source: string | null }
export interface PhrenTarget { kind: TargetKind; store: string | null; project: string | null; stableID: string | null; text: string | null }

export interface PhrenDetailUsage { kind: "usage"; accounts: PhrenUsageAccount[]; missing: string[] }
export interface PhrenDetailRows { kind: "rows"; groups: PhrenRowGroup[] }
export type PhrenDetail = PhrenDetailUsage | PhrenDetailRows;

export interface PhrenConductorSessions { kind: "sessions"; groups: PhrenSessionGroup[]; missing: string[] }
export interface PhrenConductorHandOff { kind: "handOff"; target: string }
export interface PhrenConductorReturns { kind: "returns"; rows: PhrenReturnRow[] }
export type PhrenConductor = PhrenConductorSessions | PhrenConductorHandOff | PhrenConductorReturns;

export interface PhrenToolPresentation {
  verb: string;
  project: string | null;
  body: string;
  tag: string | null;
  fields: PhrenField[];
  resultSummary: string | null;
  titles: string[];
  items: string[];
  /** The raw tool name as the agent called it ("mcp__phren__add_task"). */
  toolName: string;
  status: PhrenStatus;
  fullInput: string;
  fullOutput: string | null;
  rawResult: string | null;
  issues: string[];
  target: PhrenTarget | null;
  searchResults: PhrenSearchResult[];
  conductor: PhrenConductor | null;
  detail: PhrenDetail | null;
  showsOutput: boolean;
}

/** The reason a computer could not be reached, humanized (OfflineReason.label). */
const OFFLINE_REASONS: Record<string, string> = {
  "peer-offline": "Peer offline",
  "host-unreachable": "Host unreachable",
  "connection-refused": "Connection refused",
  "auth-failed": "Auth failed",
  "timed-out": "Timed out",
  "no-route": "No route",
};

export namespace OfflineReason {
  export function label(code: string | null | undefined): string | null {
    if (code === null || code === undefined) return null;
    return OFFLINE_REASONS[code] ?? null;
  }
}

export namespace PhrenToolPresentation {
  export type Status = PhrenStatus;
  export const Status = {
    RUNNING: "running" as PhrenStatus, SUCCEEDED: "succeeded" as PhrenStatus, FAILED: "failed" as PhrenStatus,
  };
  export type Field = PhrenField;
  export type Row = PhrenRow;
  export type RowGroup = PhrenRowGroup;
  export type SearchResult = PhrenSearchResult;
  export type UsageAccount = PhrenUsageAccount;
  export type UsageWindow = PhrenUsageWindow;
  export type ReturnRow = PhrenReturnRow;
  export type SessionGroup = PhrenSessionGroup;
  export type SessionRow = PhrenSessionRow;
  export type Target = PhrenTarget;

  export const field = (name: string, value: string): PhrenField => ({ name, value });
  export const row = (title: string, detail: string | null = null, trailing: string | null = null): PhrenRow => ({ title, detail, trailing });
  export const rowGroup = (header: string | null, rows: PhrenRow[]): PhrenRowGroup => ({ header, rows });

  export namespace Detail {
    export type Usage = PhrenDetailUsage;
    export type Rows = PhrenDetailRows;
    export const usage = (accounts: PhrenUsageAccount[], missing: string[]): PhrenDetailUsage => ({ kind: "usage", accounts, missing });
    export const rows = (groups: PhrenRowGroup[]): PhrenDetailRows => ({ kind: "rows", groups });
  }
  export namespace Conductor {
    export type Sessions = PhrenConductorSessions;
    export type HandOff = PhrenConductorHandOff;
    export type Returns = PhrenConductorReturns;
    export const sessions = (groups: PhrenSessionGroup[], missing: string[]): PhrenConductorSessions => ({ kind: "sessions", groups, missing });
    export const handOff = (target: string): PhrenConductorHandOff => ({ kind: "handOff", target });
    export const returns = (rows: PhrenReturnRow[]): PhrenConductorReturns => ({ kind: "returns", rows });
  }

  /** The tool after phren's own prefix: Claude Code sends `mcp__phren__add_task`; OpenCode `phren_add_task`. */
  export function bareTool(name: string | null | undefined): string | null {
    const parts = (name ?? "").split(".").filter((p) => p !== "");
    const tool = parts.length > 0 ? parts[parts.length - 1] : null;
    if (tool === null) return null;
    if (tool.startsWith("mcp__phren__")) return tool.slice("mcp__phren__".length);
    if (tool.startsWith("phren_")) return tool.slice("phren_".length);
    return null;
  }

  export function recognizes(name: string | null | undefined): boolean {
    return bareTool(name) !== null;
  }

  export function of(name: string, input: string, result: string | null = null, isError = false): PhrenToolPresentation | null {
    const tool = bareTool(name);
    if (tool === null) return null;
    const values: JsonObject = obj(parseJson(input)) ?? {};
    const parsedResult: JsonValue | undefined = result !== null ? parseJson(result) : undefined;
    const response: JsonValue | undefined = result !== null
      ? unwrapValue(parsedResult !== undefined ? parsedResult : (result as JsonValue))
      : undefined;
    const envelope = obj(response) ?? {};
    const data = obj(envelope["data"]) ?? envelope;
    const value = (...names: string[]): string => {
      for (const n of names) { const v = values[n]; if (v !== undefined) { const p = plain(v); if (p !== "") return p; } }
      return "";
    };
    const failure = result !== null ? failureOf(parsedResult !== undefined ? parsedResult : (result as JsonValue)) : null;
    const failed = isError || failure !== null;
    const status: PhrenStatus = failed ? "failed" : result === null ? "running" : "succeeded";
    const valueKeys = Object.keys(values).sort();
    const fullInput = valueKeys.length === 0 ? readable(input) : valueKeys.map((key) => {
      const raw = values[key] as JsonValue;
      return capitalized(key.replace(/_/g, " ")) + "\n" + (typeof raw === "string" ? raw : prettyJson(raw));
    }).join("\n\n");
    const project = nonempty(tool === "get_project_summary" ? value("project", "name") : value("project"));
    const tag = tool === "add_finding" ? nonempty(value("findingType", "finding_type")) : null;
    const details: PhrenField[] = [];
    const action = value("action").toLowerCase();
    const op = tool === "phren_admin" && action !== "" ? action : tool;
    const conductorTool = ["live_sessions", "hand_off", "dispatch", "dispatch_returns"].find((t) => tool === t || (tool === "phren_admin" && action === t)) ?? null;
    let verb: string; let body: string;
    switch (conductorTool ?? op) {
      case "live_sessions": verb = "Live sessions"; body = ""; break;
      case "dispatch_returns": verb = "Dispatch returns"; body = ""; break;
      case "hand_off": verb = "Hand off"; body = value("text", "prompt"); break;
      case "dispatch": {
        verb = "Dispatch"; body = "";
        for (const [label, key] of [["Computer", "computer"], ["Harness", "harness"], ["Model", "model"], ["Label", "label"]] as const) {
          const raw = values[key]; if (raw !== undefined) { const p = plain(raw); if (p !== "") details.push(field(label, p)); }
        }
        break;
      }
      case "add_finding": verb = "Save finding"; body = value("finding", "text", "content"); break;
      case "add_task": verb = "Add task"; body = value("task", "item", "text"); break;
      case "complete_task": verb = "Completed a task"; body = value("item", "task", "id"); break;
      case "manage_task": {
        verb = "Update task"; body = value("item", "task", "id", "text");
        if (action !== "") details.push(field("Action", action));
        break;
      }
      case "search_knowledge": verb = "Search memory"; body = value("query", "q"); break;
      case "get_memory_detail": verb = "Read a memory"; body = value("id", "memoryId", "memory_id"); break;
      case "get_tasks": verb = "Read tasks"; body = value("status", "filter"); break;
      case "get_project_summary": verb = "Read project"; body = ""; break;
      case "session": verb = "Session"; body = value("summary", "message", "name"); break;
      case "phren_admin": verb = "Phren admin"; body = value("message", "value", "setting"); break;
      case "revise_finding": verb = "Revise finding"; body = value("newText", "new_text", "text", "finding", "content"); break;
      case "set_topic_summary": verb = "Saved a topic summary"; body = value("summary", "text", "content"); break;
      default: {
        verb = VERBS[op] ?? capitalized(op.replace(/_/g, " ")); body = "";
        for (const key of valueKeys) {
          if (key === "project" || key === "action") continue;
          if (details.length >= 8) break;
          details.push(field(key.replace(/_/g, " "), plain(values[key] as JsonValue)));
        }
      }
    }
    let summary: string | null = null;
    let resultTitles: string[] = [];
    let conductorView: PhrenConductor | null = null;
    let detailView: PhrenDetail | null = null;
    if (conductorTool === "hand_off") {
      const rawTarget = values["target"];
      const targetValue = obj(rawTarget) ?? (typeof rawTarget === "string" ? obj(parseJson(rawTarget)) : undefined) ?? obj(data["target"]);
      const pane = (targetValue !== undefined ? str(targetValue["pane"]) : undefined) ?? nonempty(value("session"))?.slice(0, 8) ?? "a session";
      const label = str(data["label"]) ?? nonempty(value("project"));
      conductorView = Conductor.handOff(label !== null ? `${label} (${pane})` : pane);
    }
    const hitsOf = (): JsonValue[] | undefined => {
      const r = arr(data["results"]); if (r !== undefined) return r;
      const h = arr(data["hits"]); if (h !== undefined) return h;
      return Array.isArray(response) ? response : undefined;
    };
    if (failed) {
      summary = nonempty(firstLine(failure ?? (result !== null ? readable(result) : ""))) ?? "Call failed";
    } else if (tool === "search_knowledge" && result !== null) {
      const hits = hitsOf();
      if (hits !== undefined) {
        const count = int(data["count"]) ?? int(data["total"]) ?? hits.length;
        summary = `${count} ${count === 1 ? "memory" : "memories"} found`;
        resultTitles = hits.slice(0, 3).map((hit) => {
          const o = obj(hit);
          if (o !== undefined) return nonempty(firstLine(o["title"] ?? o["snippet"] ?? o["filename"] ?? o["text"] ?? ""));
          return nonempty(firstLine(hit));
        }).filter((t): t is string => t !== null);
      }
    } else if (conductorTool === "live_sessions" && result !== null) {
      const sessions = objects(data["sessions"]) ?? [];
      const rows = sessions.map((item) => {
        const raw = (str(item["status"]) ?? "").toLowerCase();
        const rowStatus = ["blocked", "waiting"].includes(raw) ? "needs-you" : ["working", "idle", "done"].includes(raw) ? raw : "unknown";
        return [(str(item["computer"]) ?? "?"), {
          status: rowStatus, project: str(item["project"]) ?? null, label: str(item["label"]) ?? null,
          title: str(item["title"]) ?? null, idleFor: numberInt(item["idleFor"]), conductor: str(item["role"]) === "conductor",
        }] as [string, PhrenSessionRow];
      });
      const order: string[] = []; const byComputer = new Map<string, PhrenSessionRow[]>();
      for (const [computer, row] of rows) {
        if (!byComputer.has(computer)) { order.push(computer); byComputer.set(computer, []); }
        byComputer.get(computer)!.push(row);
      }
      const unreachable = (objects(data["unreachable"]) ?? []).flatMap((item) => {
        const computer = str(item["computer"]); if (computer === undefined) return [];
        const label = OfflineReason.label(str(item["code"]));
        return [`${computer} (${label !== null ? label.toLowerCase() : "unreachable"})`];
      });
      const unlinked = (objects(data["notLinked"]) ?? []).flatMap((it) => { const n = str(it["name"]); return n === undefined ? [] : [n]; });
      conductorView = Conductor.sessions(order.map((c) => ({ computer: c, rows: byComputer.get(c)! })), [...unreachable, ...unlinked]);
      summary = `${rows.length} ${rows.length === 1 ? "session" : "sessions"} on ${order.length} ${order.length === 1 ? "computer" : "computers"}`;
    } else if (conductorTool === "dispatch_returns" && result !== null) {
      const items = objects(data["returns"]) ?? [];
      const rows = items.map((item) => {
        const raw = (str(item["state"]) ?? "").toLowerCase();
        const state = ["done", "needs-you", "failed", "blocked"].includes(raw) ? raw : "gone";
        const line = (key: string): string | null => { const s = str(item[key]); return s !== undefined ? nonempty(firstLine(s)) : null; };
        let excerpt: string | null = state === "done" ? line("reply") : state === "needs-you" ? (line("question") ?? line("reply")) : state === "failed" ? line("error") : null;
        if (excerpt !== null) excerpt = excerpt.replace(/[*_`#>]+/g, "").trim().slice(0, 160);
        return { computer: str(item["computer"]) ?? "?", project: str(item["project"]) ?? null, label: str(item["label"]) ?? null, harness: str(item["harness"]) ?? null, state, excerpt };
      });
      conductorView = Conductor.returns(rows);
      summary = rows.length === 0 ? "No unread returns" : `${rows.length} ${rows.length === 1 ? "return" : "returns"}`;
    } else if (conductorTool === "hand_off" && result !== null) {
      summary = bool(data["delivered"]) === false ? "Not confirmed" : "Delivered";
    } else if (conductorTool === "dispatch" && result !== null) {
      const state = str(data["state"]);
      const id = str(data["id"])?.slice(0, 8);
      const parts = [
        state !== undefined ? (state === "accepted" ? "Accepted" : capitalized(state)) : null,
        id !== undefined ? `receipt ${id}` : null,
      ].filter((p): p is string => p !== null);
      summary = parts.join(" · ") !== "" ? parts.join(" · ") : null;
    } else if (tool === "get_memory_detail" && result !== null) {
      summary = nonempty(firstLine(data["title"] ?? data["content"] ?? data["text"] ?? envelope["message"] ?? response ?? ""));
    } else if (result !== null) {
      const read = readOf(op, action, data, envelope);
      if (read !== null) { detailView = read[0]; summary = read[1]; }
    }
    if (summary === null && !failed && result !== null) {
      const message = str(envelope["message"]);
      if (message !== undefined) summary = nonempty(firstLine(message.replace(/^[#*\s]+/gm, "").replace(/\*\*/g, "")));
    }
    const listKey = ["item", "task", "finding"].find((k) => (arr(values[k])?.length ?? 0) > 1);
    const items = listKey !== undefined
      ? (values[listKey] as JsonValue[]).slice(0, 50).map((v) => plain(v)).filter((s) => s !== "")
      : [];
    const issues = !failed ? [] : (objects(envelope["issues"]) ?? []).slice(0, 6).flatMap((issue) => {
      const message = str(issue["message"]); if (message === undefined || message === "") return [];
      const path = plain(issue["path"] ?? "");
      return [path === "" ? message : `${path}: ${message}`];
    });
    const searchResults = tool !== "search_knowledge" ? [] : (hitsOf() ?? []).map((hit): PhrenSearchResult => {
      const item = obj(hit);
      if (item === undefined) return { title: "", text: prettyJson(hit), source: null };
      const title = str(item["title"]) ?? "";
      const text = str(item["content"] ?? item["text"] ?? item["snippet"]) ?? "";
      const source = [str(item["project"]), str(item["filename"])].filter((s): s is string => s !== undefined).join(" · ");
      return { title, text: text === "" && title === "" ? prettyJson(item) : text, source: source === "" ? null : source };
    });
    const string = (o: JsonObject, keys: string[]): string | undefined => {
      for (const k of keys) { const s = str(o[k]); if (s !== undefined && s !== "") return s; }
      return undefined;
    };
    const store = string(values, ["store", "storeId", "storeID"]) ?? string(data, ["store", "storeId", "storeID"]) ?? null;
    const targetProject = project ?? string(data, ["project"]) ?? null;
    const kind: TargetKind | null =
      ["add_task", "manage_task", "complete_task", "update_task", "get_task"].includes(tool) ? "task" :
      ["add_finding", "revise_finding", "edit_finding", "get_memory_detail"].includes(tool) ? "finding" :
      tool === "search_knowledge" ? "search" : null;
    let target: PhrenTarget | null = null;
    if (kind !== null && status === "succeeded" && !["remove", "delete"].includes(action)) {
      const record = obj(data["task"] ?? data["finding"] ?? data["item"]) ?? data;
      const id = string(record, ["stableId", "stable_id", "taskId", "findingId", "id"]) ?? string(values, ["finding_id", "findingId", "id", "memoryId", "memory_id"]) ?? null;
      const updates = obj(values["updates"]) ?? {};
      const text = kind === "task"
        ? (string(updates, ["text"]) ?? string(values, ["item", "task", "text"]) ?? null)
        : (string(values, ["new_text", "newText", "text", "finding", "content"]) ?? null);
      target = { kind, store, project: targetProject, stableID: id, text };
    }
    const fullOutput = result !== null ? readable(result) : null;
    const showsOutput = !failed && fullOutput !== null && body === "" && items.length === 0 && resultTitles.length === 0 &&
      conductorView === null && detailView === null;
    return {
      verb, project, body, tag, fields: details, resultSummary: summary, titles: resultTitles, items,
      toolName: name, status, fullInput, fullOutput, rawResult: result, issues, target, searchResults,
      conductor: conductorView, detail: detailView, showsOutput,
    };
  }

  /** phren_admin actions and the tools without their own verb above. */
  export const VERBS: Record<string, string> = {
    account_usage: "Account usage", list_actions: "Phren actions", owner_inbox: "Owner inbox",
    list_projects: "Projects", get_findings: "Read findings", get_notes: "Read notes",
    get_truths: "Read truths", get_review_queue: "Review queue", store_list: "Stores",
    list_skills: "Skills", get_contradictions: "Contradictions", health_check: "Health check",
    get_config: "Read config", set_config: "Change config", authority: "Release authority",
    dispatch_report: "Report PR", dispatch_approve: "Answer approval", list_hooks: "Hooks",
    code_search: "Code search", code_definition: "Code definition", code_references: "Code references",
    code_outline: "Code outline", code_usage: "Code usage", doctor_fix: "Doctor",
    push_changes: "Push changes", add_project: "Add project", get_topic_summaries: "Topic summaries",
  };

  /** The full-output view: MCP text blocks and phren's JSON inside them. */
  export function readable(text: string): string { return readableAt(text, 0); }
}

function nonempty(value: string): string | null {
  return value === "" ? null : value;
}

/** Swift's `plain`: strings trimmed, null as "-", containers summarized. */
function plain(value: JsonValue | undefined, depth = 0): string {
  if (depth >= 4) return "…";
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value.slice(0, 1200).trim();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return Number.isInteger(value) && Math.abs(value) < 1e15 ? String(value) : String(value);
  if (Array.isArray(value)) return value.slice(0, 8).map((v) => plain(v, depth + 1)).join(", ");
  const o = value as JsonObject;
  return Object.keys(o).sort().slice(0, 8).map((k) => `${k}: ${plain(o[k], depth + 1)}`).join(" · ");
}

function firstLine(value: JsonValue | undefined): string {
  const line = plain(value).split(NEWLINES_RE).find((s) => s !== "");
  return line !== undefined ? line.slice(0, 180) : "";
}

function numberInt(value: JsonValue | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  return null;
}

/** Retain ok/error metadata when this already is a phren response. */
function unwrapValue(value: JsonValue, depth = 0): JsonValue {
  if (depth >= 5) return value;
  if (typeof value === "string") {
    const parsed = parseJson(value);
    if (parsed !== undefined) return unwrapValue(parsed, depth + 1);
  }
  const o = obj(value);
  if (o !== undefined) {
    if (o["ok"] !== undefined || o["data"] !== undefined || bool(o["isError"]) === true) return value;
    if (o["structuredContent"] !== undefined) return unwrapValue(o["structuredContent"] as JsonValue, depth + 1);
    if (o["content"] !== undefined) return unwrapValue(o["content"] as JsonValue, depth + 1);
  }
  const first = (objects(value) ?? [])[0];
  if (first !== undefined && str(first["type"]) === "text") return unwrapValue(str(first["text"]) as string, depth + 1);
  return value;
}

const FAILURE_TEXT = /^(?:Error:|Tool error:|Error calling tool|MCP error)/i;

/** Inspect result envelopes, never arbitrary data rows; MCP may put the failure in any text block. */
function failureOf(value: JsonValue, depth = 0): string | null {
  if (depth >= 8) return null;
  if (typeof value === "string") {
    const parsed = parseJson(value);
    if (parsed !== undefined) return failureOf(parsed, depth + 1);
    const trimmed = value.trim();
    return FAILURE_TEXT.test(trimmed) ? trimmed : null;
  }
  if (Array.isArray(value)) {
    for (const e of value) { const f = failureOf(e, depth + 1); if (f !== null) return f; }
    return null;
  }
  const dict = obj(value);
  if (dict === undefined) return null;
  const errors = strings(obj(dict["data"])?.["errors"]);
  if (errors !== undefined && errors.length > 0) return errors.join("; ");
  const marked = bool(dict["ok"]) === false || bool(dict["success"]) === false || bool(dict["isError"]) === true || bool(dict["is_error"]) === true ||
    ["failed", "error"].includes(str(dict["status"]) ?? "") || (dict["error"] !== undefined && dict["error"] !== null && bool(dict["ok"]) !== true);
  for (const key of ["structuredContent", "content", "result", "text"]) {
    const nested = dict[key]; if (nested === undefined) continue;
    const f = failureOf(nested, depth + 1); if (f !== null) return f;
  }
  if (!marked) return null;
  const errObj = obj(dict["error"]);
  if (errObj !== undefined) { const m = str(errObj["message"]); if (m !== undefined) return m; }
  for (const key of ["error", "message", "detail", "content"]) { const s = str(dict[key]); if (s !== undefined && s !== "") return readableAt(s, 0); }
  const blocks = objects(dict["content"]);
  if (blocks !== undefined) {
    const text = blocks.map((b) => str(b["text"])).filter((t): t is string => t !== undefined).join("\n");
    if (text !== "") return readableAt(text, 0);
  }
  return "Call failed";
}

function readableAt(text: string, depth: number): string {
  if (depth >= 8) return text;
  const parsed = parseJson(text);
  if (parsed === undefined) return text;
  const parsedObj = obj(parsed);
  if (parsedObj !== undefined && parsedObj["ok"] === undefined && parsedObj["data"] === undefined) {
    const blocks = objects(parsedObj["content"]);
    if (blocks !== undefined && blocks.length > 0) {
      return blocks.map((b) => str(b["text"])).filter((t): t is string => t !== undefined).map((t) => readableAt(t, depth + 1)).join("\n\n");
    }
  }
  const allText = objects(parsed);
  if (allText !== undefined && allText.length > 0 && allText.every((b) => str(b["type"]) === "text")) {
    return allText.map((b) => str(b["text"])).filter((t): t is string => t !== undefined).map((t) => readableAt(t, depth + 1)).join("\n\n");
  }
  const value = unwrapValue(parsed);
  if (typeof value === "string") return value;
  if (obj(value) === undefined && !Array.isArray(value)) return text;
  const message = str(obj(value)?.["message"]);
  if (message !== undefined && message !== "") return message;
  return prettyJson(value);
}

const TASK_TAGS = /\s*\[(?:high|medium|low|pinned)]/g;

/** One task as a row: its text without the tags the fields already carry. */
function taskRow(item: JsonObject): PhrenRow | null {
  const line = str(item["line"]);
  if (line === undefined) return null;
  const claim = str(obj(item["claim"])?.["computer"]);
  const detail = [str(item["priority"]), bool(item["pinned"]) === true ? "pinned" : null, claim !== undefined ? "claimed on " + claim : null]
    .filter((p): p is string => p !== null && p !== undefined).join(" · ");
  return { title: line.replace(TASK_TAGS, "").trim(), detail: nonempty(detail), trailing: str(item["id"]) ?? null };
}

function inboxRow(item: JsonObject): PhrenRow | null {
  const rawTitle = str(item["title"]);
  const title = rawTitle !== undefined ? nonempty(firstLine(rawTitle)) : null;
  if (title === null) return null;
  const rawKind = str(item["kind"]);
  const kind = rawKind !== undefined ? (rawKind === "needs-you" ? "needs you" : rawKind) : null;
  const detail = [kind, str(item["project"]), str(item["computer"])].filter((p): p is string => p !== null && p !== undefined).join(" · ");
  return { title, detail: nonempty(detail), trailing: str(item["state"]) === "resolved" ? "resolved" : null };
}

/** A description's first sentence, bounded for one row. */
function sentence(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = /\.(\s|$)/.exec(flat);
  const end = m !== null ? flat.slice(0, m.index) + "." : flat;
  return nonempty(end.slice(0, 160));
}

/** The rows a read draws instead of its raw output, and its one-line result. */
function readOf(op: string, action: string, data: JsonObject, envelope: JsonObject): [PhrenDetail | null, string | null] | null {
  const string = (item: JsonObject, key: string): string | null => { const s = str(item[key]); return s !== undefined ? nonempty(firstLine(s)) : null; };
  const joined = (...parts: (string | null)[]): string | null => {
    const filtered = parts.filter((p): p is string => p !== null && p !== "").join(" · ");
    return nonempty(filtered);
  };
  const count = (n: number, one: string, many = one + "s"): string => `${n} ${n === 1 ? one : many}`;
  const list = (key: string): JsonObject[] => objects(data[key]) ?? [];
  const rows = (items: JsonObject[], row: (item: JsonObject) => PhrenRow | null): PhrenDetail | null => {
    const built = items.slice(0, 200).map(row).filter((r): r is PhrenRow => r !== null);
    return built.length > 0 ? PhrenToolPresentation.Detail.rows([{ header: null, rows: built }]) : null;
  };
  switch (op) {
    case "account_usage": {
      const accounts = objects(data["accounts"]);
      if (accounts === undefined) return null;
      const built = accounts.map((item): PhrenUsageAccount => {
        const windows = (objects(item["windows"]) ?? []).map((window): PhrenUsageWindow => {
          const used = num(window["usedPercent"]);
          return {
            name: string(window, "name") ?? string(window, "id") ?? "Window",
            usedPercent: used !== undefined ? Math.round(used) : null,
            resetsIn: string(window, "resetsIn"),
            reset: bool(window["reset"]) === true,
            exhausted: bool(window["exhausted"]) === true,
          };
        });
        const spendObj = obj(item["spend"]);
        let spend: string | null = null;
        if (spendObj !== undefined) {
          const amount = num(spendObj["amountUSD"]);
          if (amount !== undefined) {
            const period = ({ rolling_7_days: "7 days", rolling_30_days: "30 days", calendar_week: "this week" } as Record<string, string>)[str(spendObj["period"]) ?? ""];
            spend = joined("$" + amount.toFixed(2), period ?? null);
          }
        }
        return {
          name: string(item, "name") ?? string(item, "harness") ?? "Account",
          account: string(item, "account"), windows,
          exhausted: bool(item["exhausted"]) === true, stale: bool(item["stale"]) === true,
          age: string(item, "age"), availableIn: string(item, "availableIn"), spend,
        };
      });
      const noData = list("noData").flatMap((item) => { const n = string(item, "name"); return n !== null ? [`${n} (no numbers)`] : []; });
      const unreachable = list("unreachable").flatMap((item) => {
        const computer = string(item, "computer"); if (computer === null) return [];
        const label = OfflineReason.label(str(item["code"]));
        return [`${computer} (${label !== null ? label.toLowerCase() : "unreachable"})`];
      });
      const unlinked = list("notLinked").flatMap((item) => { const n = string(item, "name"); return n !== null ? [n] : []; });
      const out = built.filter((a) => a.exhausted).length;
      const summary = count(built.length, "account") + (out > 0 ? `, ${out} out of quota` : "");
      return [PhrenToolPresentation.Detail.usage(built, [...noData, ...unreachable, ...unlinked]), summary];
    }
    case "list_actions": {
      const actions = objects(data["actions"]);
      if (actions === undefined) return null;
      return [rows(actions, (item) => {
        const name = string(item, "name"); if (name === null) return null;
        const required = (objects(item["params"]) ?? []).filter((p) => bool(p["required"]) === true).map((p) => str(p["name"])).filter((n): n is string => n !== undefined);
        const desc = str(item["description"]);
        return { title: name, detail: desc !== undefined ? sentence(desc) : null, trailing: required.length > 0 ? required.join(", ") : null };
      }), count(actions.length, "action")];
    }
    case "get_tasks": {
      const groups: PhrenRowGroup[] = []; let total = 0;
      const add = (project: string | null, items: JsonObject, label: boolean): void => {
        for (const section of ["Active", "Queue", "Done"]) {
          const tasks = objects(items[section]) ?? [];
          total += tasks.length;
          const built = tasks.slice(0, 200).map(taskRow).filter((r): r is PhrenRow => r !== null);
          if (built.length > 0) groups.push({ header: label ? joined(project, section) : section, rows: built });
        }
      };
      const items = obj(data["items"]);
      const projects = objects(data["projects"]);
      const single = taskRow(data);
      if (items !== undefined) add(str(data["project"]) ?? null, items, false);
      else if (projects !== undefined) for (const p of projects) add(str(p["project"]) ?? null, obj(p["items"]) ?? {}, true);
      else if (single !== null) { total = 1; groups.push({ header: str(data["section"]) ?? null, rows: [single] }); }
      else return null;
      if (total === 0) return null;
      return [PhrenToolPresentation.Detail.rows(groups), count(total, "task")];
    }
    case "list_projects": {
      const projects = objects(data["projects"]);
      if (projects === undefined) return null;
      return [rows(projects, (item) => {
        const name = string(item, "name"); if (name === null) return null;
        return { title: name, detail: string(item, "brief"), trailing: string(item, "store") };
      }), count(int(data["total"]) ?? projects.length, "project")];
    }
    case "owner_inbox": {
      const single = obj(data["item"]);
      if (single !== undefined) return [rows([single], inboxRow), null];
      const items = objects(data["items"]);
      if (items === undefined) return null;
      return [rows(items, inboxRow), items.length === 0 ? "Inbox is empty" : count(items.length, "item")];
    }
    case "get_findings": {
      const findings = objects(data["findings"]);
      if (findings === undefined) return null;
      return [rows(findings, (item) => {
        const text = string(item, "text"); if (text === null) return null;
        const status = string(item, "status");
        return { title: text, detail: status !== null && status !== "active" ? status : null, trailing: string(item, "date") };
      }), count(int(data["total"]) ?? findings.length, "finding")];
    }
    case "get_notes": {
      const notes = objects(data["notes"]);
      if (notes === undefined) return null;
      return [rows(notes, (item) => {
        const text = string(item, "text"); if (text === null) return null;
        return { title: text, detail: null, trailing: joined(string(item, "date"), string(item, "time")) };
      }), count(notes.length, "note")];
    }
    case "get_truths": {
      const truths = strings(data["truths"]);
      if (truths === undefined) return null;
      return [rows(truths.map((t) => ({ text: t })), (item) => {
        const text = string(item, "text"); if (text === null) return null;
        return { title: text, detail: null, trailing: null };
      }), count(truths.length, "truth")];
    }
    case "get_review_queue": {
      const items = objects(data["items"]);
      if (items === undefined) return null;
      return [rows(items, (item) => {
        const text = string(item, "text"); if (text === null) return null;
        return { title: text, detail: joined(string(item, "project"), string(item, "date")), trailing: string(item, "section") };
      }), count(items.length, "item")];
    }
    case "get_contradictions": {
      const items = objects(data["contradictions"]);
      if (items === undefined) return null;
      return [rows(items, (item) => {
        const text = string(item, "text"); if (text === null) return null;
        return { title: text, detail: string(item, "project"), trailing: string(item, "date") };
      }), items.length === 0 ? "No contradictions" : count(items.length, "contradiction")];
    }
    case "store_list": {
      const stores = objects(data["stores"]);
      if (stores === undefined) return null;
      return [rows(stores, (item) => {
        const name = string(item, "name"); if (name === null) return null;
        const projects = arr(item["projects"])?.length;
        return {
          title: name,
          detail: joined(string(item, "role"), projects !== undefined ? count(projects, "project") : null),
          trailing: bool(item["exists"]) === false ? "missing" : null,
        };
      }), count(stores.length, "store")];
    }
    case "list_skills": {
      const skills = objects(data["skills"]);
      if (skills === undefined) return null;
      return [rows(skills, (item) => {
        const name = string(item, "name"); if (name === null) return null;
        const desc = str(item["description"]);
        return {
          title: string(item, "command") ?? name,
          detail: desc !== undefined ? sentence(desc) : null,
          trailing: bool(item["enabled"]) === false ? "off" : null,
        };
      }), count(skills.length, "skill")];
    }
    case "session": {
      if (action !== "history") return null;
      const sessions = objects(envelope["data"]);
      if (sessions === undefined) return null;
      return [rows(sessions, (item) => {
        const started = string(item, "startedAt")?.slice(0, 16).replace("T", " ");
        const mins = int(item["durationMins"]);
        return {
          title: string(item, "summary") ?? string(item, "project") ?? string(item, "sessionId")?.slice(0, 8) ?? "Session",
          detail: joined(string(item, "project"), mins !== undefined ? `${mins}m` : null),
          trailing: started ?? null,
        };
      }), count(sessions.length, "session")];
    }
    case "get_project_summary": {
      const counts = obj(data["counts"]);
      if (counts === undefined) return null;
      const findings = int(counts["findings"]);
      const openTasks = int(counts["openTasks"]);
      return [null, joined(findings !== undefined ? count(findings, "finding") : null, openTasks !== undefined ? count(openTasks, "open task") : null)];
    }
    default: return null;
  }
}
