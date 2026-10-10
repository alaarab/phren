// The chat's transcript rows, prepared off the UI thread: how calls and results
// fold into pills and read runs, the turn activity and change rows, the
// background-job tray and the bounded output previews. Ported from the phone's
// ChatTimeline.kt. Pure: values in, values out, no DOM and no Node APIs.

import { renderKey } from "./message.js";
import type { TranscriptMessage } from "./transcript.js";
import { ToolPresentation, AgentToolClassification, diffDocument, isNewline } from "./tool-presentation.js";
import {
  AgentToolCardJSON, AgentSubagentPresentation, AgentTodoPresentation, AgentPlanPresentation,
  WebToolPresentation, SkillCallPresentation, MCPToolPresentation,
} from "./tool-cards.js";
import { PhrenToolPresentation } from "./phren-tools.js";
import { AgentChatProgress, AgentChatSpinner, type AgentChatProgressPhase, type AgentChatProgressTurn } from "./progress.js";

// --- Graphemes, voice marker and elapsed text -------------------------------------------------

type GraphemeSegmenter = { segment(input: string): Iterable<{ segment: string }> };
type SegmenterConstructor = new (locale?: string, options?: { granularity: "grapheme" }) => GraphemeSegmenter;
const SegmenterClass = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;

/** Extended grapheme clusters (Swift Characters); code points where Intl is absent. */
function graphemeClusters(text: string): string[] {
  if (SegmenterClass !== undefined) {
    const out: string[] = [];
    for (const part of new SegmenterClass(undefined, { granularity: "grapheme" }).segment(text)) out.push(part.segment);
    return out;
  }
  return Array.from(text);
}

/** The owner's own words without talk mode's marker. */
export const VoiceMarker = {
  hidden(text: string): string { return text.replace(/^\s*\[voice\]\s*/i, ""); },
};

/** Elapsed seconds as "27s", "1m 04s", "1h 02m 03s". */
export const ElapsedTime = {
  text(seconds: number, padSeconds = true): string {
    const total = Math.max(0, Math.trunc(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad2 = (n: number): string => String(n).padStart(2, "0");
    if (hours > 0) return `${hours}h ${pad2(minutes)}m ${pad2(secs)}s`;
    if (minutes > 0) return `${minutes}m ${padSeconds ? pad2(secs) : String(secs)}s`;
    return `${secs}s`;
  },
};

// --- Presentation caches ----------------------------------------------------------------------

const presentations = new Map<string, ToolPresentation>();
/** Decoded presentations per message content, shared by every row. */
export const ToolPresentationCache = {
  value(message: TranscriptMessage): ToolPresentation {
    const key = renderKey(message);
    const cached = presentations.get(key);
    if (cached !== undefined) return cached;
    const value = ToolPresentation.of(message.title ?? "Tool", message.text);
    if (presentations.size >= 500) presentations.clear();
    presentations.set(key, value);
    return value;
  },
};

const collapsedChangeCounts = new Map<string, number>();
/** The diff row count of a folded change, cached by content. */
function collapsedChangeRows(text: string, key: string): number {
  const cached = collapsedChangeCounts.get(key);
  if (cached !== undefined) return cached;
  const rows = diffDocument(text).rows.length;
  if (collapsedChangeCounts.size >= 400) collapsedChangeCounts.clear();
  collapsedChangeCounts.set(key, rows);
  return rows;
}

// --- Background worker labels ------------------------------------------------------------------

const PROVIDER = /(?:^|\s)--provider\s+(codex|opencode)(?:\s|$)/;
const LABEL = /(?:^|\s)--label\s+(["'])([\s\S]*?)\1/;

/** A worker launched through one of phren's provider wrappers. */
export const BackgroundJobLabel = {
  parse(command: string): { provider: string; label: string } | null {
    let provider: string;
    if (command.includes("skills/fanout/scripts/")) {
      const match = PROVIDER.exec(command);
      if (match !== null) provider = match[1];
      else if (command.includes("scripts/codex.sh")) provider = "codex";
      else if (command.includes("scripts/opencode.sh")) provider = "opencode";
      else return null;
    } else if (command.includes("skills/codex/scripts/run.sh")) provider = "codex";
    else if (command.includes("skills/deepseek/scripts/run.sh")) provider = "opencode";
    else return null;
    const match = LABEL.exec(command);
    const label = match?.[2]?.trim() ?? null;
    // A label the shell had yet to expand ("${L[$n]}", "$(...)", `...`) is not a name.
    if (label === null || label.length === 0 || label.includes("$") || label.includes("`")) return null;
    return { provider, label };
  },
};

// --- Activity context -------------------------------------------------------------------------

/** An attachment waiting in the composer or sent. */
export interface ChatAttachmentDraft { id: string; path: string | null }

/** A sent message waiting for its transcript row: a muted bubble at the end of the conversation. */
export interface ChatPendingEcho {
  id: string;
  text: string;
  images: ChatAttachmentDraft[];
  submittedAt: string | null;
  deliveryState: string;
}

/** How long a receipt may wait for its row before it offers Remove and Review. */
export const CHAT_PENDING_ECHO_STALE_AFTER_SECONDS = 30;

export function chatPendingEcho(id: string, text: string, images: ChatAttachmentDraft[] = [], fields: Partial<Pick<ChatPendingEcho, "submittedAt" | "deliveryState">> = {}): ChatPendingEcho {
  return { id, text, images, submittedAt: fields.submittedAt ?? null, deliveryState: fields.deliveryState ?? "unknown" };
}

/** Only source changes enter preparation; the view's clock never does. */
export interface ChatActivityContext {
  turns: AgentChatProgressTurn[];
  harnessVerb: string | null;
  /** The last harness verb of each turn, by the turn's start. */
  turnVerbs: Record<string, string>;
  submittedAt: string | null;
  submittedAfterLine: number;
  busy: boolean;
  waiting: boolean;
  /** The pane's folder, so a turn's diff names files inside it relatively. */
  workingDirectory: string | null;
  pendingEchoes: ChatPendingEcho[];
}

export function chatActivityContext(fields: Partial<ChatActivityContext> = {}): ChatActivityContext {
  return {
    turns: [], harnessVerb: null, turnVerbs: {}, submittedAt: null, submittedAfterLine: -1,
    busy: false, waiting: false, workingDirectory: null, pendingEchoes: [], ...fields,
  };
}

function activityContextEquals(left: ChatActivityContext, right: ChatActivityContext): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// --- Turn activity ----------------------------------------------------------------------------

/** One turn's activity line, live or finished. */
export class ChatTurnActivity {
  readonly ownerID: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly phase: AgentChatProgressPhase;
  readonly verb: string;
  /** The verb is the harness's own (Claude's spinner word). */
  readonly fromHarness: boolean;

  constructor(ownerID: string, startedAt: string, finishedAt: string | null, phase: AgentChatProgressPhase, verb: string, fromHarness = false) {
    this.ownerID = ownerID; this.startedAt = startedAt; this.finishedAt = finishedAt;
    this.phase = phase; this.verb = verb; this.fromHarness = fromHarness;
  }

  get isLive(): boolean { return this.phase === "working"; }
  get identifier(): string { return this.isLive ? "chat-activity" : "chat-activity-done"; }

  label(now: string): string {
    const elapsed = AgentChatProgress.elapsed(this.startedAt, this.finishedAt, this.phase, now);
    return `${this.verb} ${ChatTurnActivity.duration(elapsed === null ? 0 : elapsed / 1000)}`;
  }

  static duration(elapsed: number): string {
    return ElapsedTime.text(Math.max(0, Math.trunc(elapsed)), true);
  }
}

// --- Turn changes -----------------------------------------------------------------------------

export interface ChatTurnChangesFile { path: string; status: string; patch: string; added: number; removed: number }
export interface ChatTurnChangesPiece { path: string; status: string; lines: string[] }

const changeCollectCache = new Map<string, ChatTurnChanges | null>();

/**
 * What one finished turn changed, read from the transcript alone: the Hook's
 * patches under shell calls and the patches edit calls carry.
 */
export class ChatTurnChanges {
  static readonly MAXIMUM_FILES = 200;
  readonly ownerID: string;
  readonly files: ChatTurnChangesFile[];

  constructor(ownerID: string, files: ChatTurnChangesFile[]) { this.ownerID = ownerID; this.files = files; }

  get id(): string { return this.ownerID; }
  get added(): number { return this.files.reduce((sum, file) => sum + file.added, 0); }
  get removed(): number { return this.files.reduce((sum, file) => sum + file.removed, 0); }
  get title(): string { return this.files.length === 1 ? "1 file changed" : `${this.files.length} files changed`; }
  get spokenLabel(): string { return `${this.title}, ${this.added} added, ${this.removed} removed`; }
  get identifier(): string { return `chat-turn-changes:${this.ownerID}`; }

  /** The change set between a turn's message and its end, or null when it changed no files. */
  static collect(ownerID: string, rows: TranscriptMessage[], root: string | null = null): ChatTurnChanges | null {
    const key = ownerID + "|" + (root ?? "") + "|" + rows.filter((row) => row.role === "tool").map((row) => renderKey(row)).join(",");
    const cached = changeCollectCache.get(key);
    if (cached !== undefined) return cached;
    const changes = ChatTurnChanges.build(ownerID, rows, root);
    if (changeCollectCache.size >= 400) changeCollectCache.clear();
    changeCollectCache.set(key, changes);
    return changes;
  }

  private static build(ownerID: string, rows: TranscriptMessage[], root: string | null): ChatTurnChanges | null {
    const tools = rows.filter((row) => row.role === "tool");
    if (tools.length === 0) return null;
    // A call the Hook measured is described by its Changes rows; a failed call wrote nothing.
    const captured = new Set(tools.filter((row) => row.isChange).map((row) => row.toolCallID).filter((id): id is string => id !== null));
    const failed = new Set(tools.filter((row) => row.isToolResult && row.isToolError).map((row) => row.toolCallID).filter((id): id is string => id !== null));
    const pieces: ChatTurnChangesPiece[] = [];
    for (const message of tools) {
      if (message.isChange) pieces.push(...ChatTurnChanges.pieces(message.text));
      else if (!message.isToolResult && !message.isCompaction && message.title !== "Background notification") {
        const id = message.toolCallID;
        if (id !== null && (captured.has(id) || failed.has(id))) continue;
        const patch = ToolPresentationCache.value(message).patch;
        if (patch === null) continue;
        pieces.push(...ChatTurnChanges.pieces(patch));
      }
    }
    if (pieces.length === 0) return null;
    // Claude's Edit names a file by its absolute path where the Hook and Codex name it in the repository.
    const relative = new Set(pieces.map((piece) => piece.path).filter((path) => !path.startsWith("/")));
    const folder = root !== null ? (root.endsWith("/") ? root : root + "/") : null;
    const canonical = (path: string): string => {
      if (!path.startsWith("/")) return path;
      if (folder !== null && path.startsWith(folder) && path.length > folder.length) return path.slice(folder.length);
      let best: string | null = null;
      for (const candidate of relative) if (path.endsWith("/" + candidate) && (best === null || candidate.length > best.length)) best = candidate;
      return best ?? path;
    };
    const order: string[] = [];
    const grouped = new Map<string, ChatTurnChangesPiece[]>();
    for (const piece of pieces) {
      const path = canonical(piece.path);
      if (!grouped.has(path)) {
        if (order.length >= ChatTurnChanges.MAXIMUM_FILES) continue;
        order.push(path);
      }
      const list = grouped.get(path);
      if (list === undefined) grouped.set(path, [piece]); else list.push(piece);
    }
    const files: ChatTurnChangesFile[] = [];
    for (const path of order) {
      const parts = grouped.get(path);
      if (parts === undefined) continue;
      const status = parts[parts.length - 1].status === "D" ? "D" : parts[0].status === "A" ? "A" : "M";
      const header = status === "A" ? "*** Add File: " : status === "D" ? "*** Delete File: " : "*** Update File: ";
      const lines = [header + path];
      let added = 0; let removed = 0;
      for (const part of parts) {
        // Each piece is its own hunk: an Add's lines have no `@@` of their own.
        if (part.lines.length > 0 && !part.lines[0].startsWith("@@")) lines.push("@@");
        let inside = part.status === "A";
        for (const line of part.lines) {
          if (line.startsWith("@@")) inside = true;
          else if (inside && line.startsWith("+")) added++;
          else if (inside && line.startsWith("-")) removed++;
          lines.push(line);
        }
      }
      files.push({ path, status, patch: lines.join("\n"), added, removed });
    }
    return files.length === 0 ? null : new ChatTurnChanges(ownerID, files);
  }

  /** One piece per file a patch names: apply_patch sections or git's unified form, headers dropped. */
  static pieces(patch: string): ChatTurnChangesPiece[] {
    const result: ChatTurnChangesPiece[] = [];
    let current: ChatTurnChangesPiece | null = null;
    let gitHeader = false;
    const flush = (): void => { if (current !== null) result.push(current); current = null; };
    const sections: [string, string][] = [["*** Update File: ", "M"], ["*** Add File: ", "A"], ["*** Delete File: ", "D"]];
    for (const raw of patch.split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const section = sections.find((candidate) => line.startsWith(candidate[0]));
      if (section !== undefined) {
        flush();
        const path = line.slice(section[0].length).replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
        if (path.length > 0) current = { path, status: section[1], lines: [] };
        gitHeader = false;
      } else if (line.startsWith("diff --git ")) {
        flush();
        const at = line.lastIndexOf(" b/");
        if (at >= 0) current = { path: line.slice(at + 3), status: "M", lines: [] };
        gitHeader = true;
      } else if (line.startsWith("*** ")) {
        continue; // Begin, End, End of File, Move to: framing, not content.
      } else if (gitHeader) {
        if (line.startsWith("new file mode")) { if (current !== null) current.status = "A"; }
        else if (line.startsWith("deleted file mode")) { if (current !== null) current.status = "D"; }
        else if (line.startsWith("@@")) { gitHeader = false; current?.lines.push(line); }
      } else current?.lines.push(line);
    }
    flush();
    // A trailing newline leaves one empty line that is not content.
    for (const piece of result) while (piece.lines.length > 0 && piece.lines[piece.lines.length - 1] === "") piece.lines.pop();
    return result;
  }
}

// --- Tool card status and kind -----------------------------------------------------------------

export type ToolCardStatus = "running" | "done" | "failed";

/** How a call stands, at the right end of its pill or card. */
export const ToolCardStatus = {
  of(raw: string): ToolCardStatus { return raw === "failed" ? "failed" : raw === "running" ? "running" : "done"; },
};

/** The agent's own bookkeeping calls, each with a card of its own instead of the generic pill. */
export type ToolCardKind =
  | { kind: "agent"; value: AgentSubagentPresentation }
  | { kind: "todos"; value: AgentTodoPresentation }
  | { kind: "plan"; value: AgentPlanPresentation }
  | { kind: "planMode" }
  | { kind: "web"; value: WebToolPresentation }
  | { kind: "skill"; value: SkillCallPresentation }
  | { kind: "mcp"; value: MCPToolPresentation };

export const ToolCardKind = {
  PlanMode: { kind: "planMode" } as ToolCardKind,

  recognizes(name: string | null | undefined): boolean {
    return AgentSubagentPresentation.recognizes(name) || AgentTodoPresentation.recognizes(name) ||
      AgentPlanPresentation.recognizes(name) || AgentPlanPresentation.isPlanMode(name) || WebToolPresentation.recognizes(name) ||
      SkillCallPresentation.recognizes(name) || MCPToolPresentation.recognizes(name);
  },

  /** A visible event (a skill, an MCP call, an agent) ends a read run; a fetch or search folds with reads. */
  interruptsRun(name: string | null | undefined): boolean {
    return ToolCardKind.recognizes(name) && !WebToolPresentation.recognizes(name);
  },

  /** `notification`: a background agent's `<task-notification>`, when one has arrived for this call. */
  of(call: TranscriptMessage, result: TranscriptMessage | null, notification: string | null = null): ToolCardKind | null {
    const name = call.title ?? "";
    const failed = result !== null && result.isToolError;
    const agent = AgentSubagentPresentation.of(name, call.text, result?.text ?? null, failed, notification);
    if (agent !== null) return { kind: "agent", value: agent };
    const todos = AgentTodoPresentation.of(name, call.text, result?.text ?? null);
    if (todos !== null) return { kind: "todos", value: todos };
    const plan = AgentPlanPresentation.of(name, call.text, result?.text ?? null, failed);
    if (plan !== null) return { kind: "plan", value: plan };
    if (AgentPlanPresentation.isPlanMode(name)) return ToolCardKind.PlanMode;
    const web = WebToolPresentation.of(name, call.text, result?.text ?? null, failed);
    if (web !== null) return { kind: "web", value: web };
    const skill = SkillCallPresentation.of(name, call.text, result?.text ?? null, failed);
    if (skill !== null) return { kind: "skill", value: skill };
    const mcp = MCPToolPresentation.of(name, call.text, result?.text ?? null, failed);
    if (mcp !== null) return { kind: "mcp", value: mcp };
    return null;
  },
};

// --- Bounded output ---------------------------------------------------------------------------

/** A bounded preview of tool output: at most `lines` lines and `characters` characters, "…" when cut. */
export class ToolOutputPreview {
  readonly text: string;
  readonly truncated: boolean;

  constructor(output: string, lines = 6, characters = 640) {
    const graphemes = graphemeClusters(output);
    const bounded = graphemes.slice(0, characters + 1);
    const prefix = bounded.slice(0, characters).join("");
    const split = prefix.split(/\r\n|[\n\r\u000B\u000C\u0085\u2028\u2029]/);
    this.truncated = bounded.length > characters || split.length > lines;
    this.text = split.slice(0, lines).join("\n") + (this.truncated ? "…" : "");
  }
}

/** Full output in bounded layout pages while retaining every source character for Copy. */
export class ToolOutputPages {
  static readonly Page = class {
    readonly text: string;
    readonly firstLine: number;
    readonly lastLine: number;
    constructor(text: string, firstLine: number, lastLine: number) { this.text = text; this.firstLine = firstLine; this.lastLine = lastLine; }
    get displayText(): string {
      if (this.text.endsWith("\r\n")) return this.text.slice(0, -2);
      const last = this.text.length > 0 ? this.text[this.text.length - 1] : "";
      return last.length > 0 && isNewline(last) ? this.text.slice(0, -1) : this.text;
    }
  };

  readonly pages: InstanceType<typeof ToolOutputPages.Page>[];
  readonly totalLines: number;
  readonly source: string;

  constructor(source: string) {
    this.source = source;
    const clusters = graphemeClusters(source);
    const result: InstanceType<typeof ToolOutputPages.Page>[] = [];
    let offset = 0;
    let start = 0;
    let line = 1;
    let firstLine = 1;
    let characters = 0;
    for (const cluster of clusters) {
      const end = offset + cluster.length;
      offset = end;
      characters++;
      const lastLine = line;
      if (Array.from(cluster).some((c) => isNewline(c))) line++;
      if (end < source.length && (characters >= 4_000 || line - firstLine >= 120)) {
        result.push(new ToolOutputPages.Page(source.slice(start, end), firstLine, lastLine));
        start = end; firstLine = line; characters = 0;
      }
    }
    result.push(new ToolOutputPages.Page(source.slice(start), firstLine, line));
    this.pages = result;
    this.totalLines = line;
  }
}

// --- Tool summary -----------------------------------------------------------------------------

const PATH_PREVIEW = /^[~.]?\/?[\w.@-]+(?:\/[\w.@-]+)+(?::\d+)?$/;

/** A pill's summary of its calls: title, icon, last preview and status. */
export class ChatToolSummary {
  readonly title: string;
  readonly icon: string;
  readonly preview: string;
  readonly count: number;
  /** Failed when any failed, running while any has no result yet, otherwise done. */
  readonly status: ToolCardStatus;
  /** The preview names a file (a Read's path): drawn in the path color. */
  readonly previewIsPath: boolean;

  constructor(messages: TranscriptMessage[]) {
    // What a call changed on disk is listed under it, not counted as a call.
    const calls = messages.filter((message) => message.title !== "Tool result" && !message.isChange);
    const values = calls.map((message) => ToolPresentationCache.value(message));
    const names = values.map((value) => value.title);
    this.title = new Set(names).size === 1 ? names[0] : calls.length === 0 ? "Tool results" : "Activity";
    this.icon = ChatToolSummary.icon(this.title);
    this.count = Math.max(1, calls.length === 0 ? messages.length : calls.length);
    this.preview = values.length > 0
      ? values[values.length - 1].preview
      : messages.length > 0 ? ToolPresentationCache.value(messages[messages.length - 1]).preview : "";
    this.status = ChatToolSummary.status(messages);
    this.previewIsPath = PATH_PREVIEW.test(this.preview);
  }

  static icon(title: string): string {
    switch (title) {
      case "Shell": return "terminal"; case "Browse": return "globe"; case "Patch": return "pencil.line";
      case "Write": return "doc.badge.plus"; case "Read": return "doc.text"; case "List": return "folder";
      default: return "wrench.and.screwdriver";
    }
  }

  static status(messages: TranscriptMessage[]): ToolCardStatus {
    const results = messages.filter((message) => message.isToolResult);
    if (results.some((result) => ReadOnlyToolCall.failed(result))) return "failed";
    const calls = messages.filter((message) => message.role === "tool" && !message.isToolResult && !message.isChange);
    const answered = new Set(results.map((result) => result.toolCallID).filter((id): id is string => id !== null));
    const open = calls.some((call) => call.toolCallID === null ? results.length === 0 : !answered.has(call.toolCallID));
    return open || results.length === 0 ? "running" : "done";
  }
}

// --- Read-only classification ------------------------------------------------------------------

const EXIT_CODE = /(?:^|\n)Exit code: -?\d+\s*$/;
const WRITES = /(?:;|`|\$\(|>>?|<<|\b(?:rm|mv|cp|tee|touch|mkdir|ln|chmod|chown|install|xargs)\b|\bfind\b[^|]*(?:-delete|-exec)|\bgit\s+(?:commit|push|checkout|switch|restore|reset|clean|merge|rebase|pull|fetch|add|rm|mv|stash|apply)\b)/i;

/**
 * Conservative classification of a call that was only looking around: it came
 * back, changed nothing on disk and didn't fail. Only those fold into read runs.
 */
export const ReadOnlyToolCall = {
  looksAround(messages: TranscriptMessage[]): boolean {
    if (messages.some((message) => message.isChange)) return false;
    const result = messages.find((message) => message.isToolResult);
    if (result === undefined || ReadOnlyToolCall.failed(result)) return false;
    const call = messages.find((message) => message.role === "tool" && !message.isToolResult);
    if (call === undefined) return false;
    if (PhrenToolPresentation.recognizes(call.title) || ToolCardKind.interruptsRun(call.title) || ChatBackgroundJobs.isBackground(call)) return false;
    // A web fetch or search is looking around too: three in a row fold.
    if (WebToolPresentation.recognizes(call.title)) return true;
    const presentation = ToolPresentationCache.value(call);
    switch (presentation.title) {
      case "Read": case "Browse": case "List": return true;
      case "Wait Agent": case "List Agents": case "Send Message": return true;
      // The Hook attaches what a call wrote, so a result with no change is the agent finding something out.
      case "Shell": case "Tools": return ReadOnlyToolCall.shell(presentation.body) || (presentation.patch === null && !presentation.editsFiles);
      default: {
        const leaf = (call.title ?? "").split(".").filter((part) => part !== "").pop()?.toLowerCase();
        return leaf !== undefined && ["read", "glob", "grep", "ls"].includes(leaf);
      }
    }
  },

  /** The provider's own error flag, or the non-zero exit a command's output ends with. */
  failed(result: TranscriptMessage): boolean {
    if (result.isToolError) return true;
    return EXIT_CODE.test(ToolPresentationCache.value(result).body.slice(-40));
  },

  shell(command: string): boolean {
    const source = command.trim();
    if (source.length === 0 || source.includes("\n") || WRITES.test(source)) return false;
    const segments = source.split("|").flatMap((segment) => segment.split("&&"));
    if (segments.length === 0) return false;
    return segments.every((segment) => {
      const words = segment.trim().split(/\s+/).filter((word) => word !== "");
      const first = words[0]?.toLowerCase();
      if (first === undefined) return false;
      if (first === "git") return words.length > 1 && ["diff", "log", "status", "show"].includes(words[1].toLowerCase());
      if (first === "sed") return words.slice(1).some((word) => word === "-n" || (word.startsWith("-") && word.includes("n") && !word.includes("i")));
      return ["cat", "head", "tail", "grep", "rg", "ls", "find", "wc", "echo", "pwd", "which", "type"].includes(first);
    });
  },
};

// --- Background jobs --------------------------------------------------------------------------

export type ChatBackgroundJobState = { kind: "running" } | { kind: "finished"; exitCode: number | null };

export interface ChatBackgroundJob {
  id: string;
  title: string;
  worker: string | null;
  command: string;
  output: string;
  state: ChatBackgroundJobState;
  startedAt: string;
  finishedAt: string | null;
}

export const ChatBackgroundJob = {
  State: {
    Running: { kind: "running" } as ChatBackgroundJobState,
    Finished: (exitCode: number | null): ChatBackgroundJobState => ({ kind: "finished", exitCode }),
  },
};

const RUN_IN_BACKGROUND = /["']?run_in_background["']?\s*[:=]\s*true/;
const BACKGROUND = /["']?background["']?\s*[:=]\s*true/;
const MOVED = /^command did not complete within its \d+s timeout and was moved to the background/;
const EXIT = /exit (?:code )?(-?\d+)/i;
const backgroundFlags = new Map<string, boolean>();

interface BackgroundNotice { summary: string; status: string; output: string; at: string | null }

/** The background-agent tray: running and recently finished jobs parsed from the transcript. */
export const ChatBackgroundJobs = {
  /** How long a finished job stays in the row before it leaves. */
  FINISHED_LINGER_SECONDS: 120,

  /** `firstSeen` / `finishedSeen`: when the phone first saw each job, and saw it finished. */
  parse(messages: TranscriptMessage[], firstSeen: Map<string, string>, finishedSeen: Map<string, string> = new Map(),
    now: string = new Date().toISOString(), includeExpired = false): ChatBackgroundJob[] {
    const results = new Map<string, TranscriptMessage>();
    const notifications = new Map<string, BackgroundNotice>();
    for (const message of messages) {
      if (message.role !== "tool") continue;
      if (message.isToolResult && message.toolCallID !== null) results.set(message.toolCallID, message);
      if (message.title === "Background notification") {
        const id = ChatBackgroundJobs.notificationCallID(message.text);
        if (id === null) continue;
        notifications.set(id, {
          summary: AgentToolCardJSON.tag("summary", message.text) ?? "Background command finished",
          status: AgentToolCardJSON.tag("status", message.text) ?? "completed",
          output: AgentToolCardJSON.tag("output", message.text) ?? "",
          at: message.timestamp,
        });
      }
    }
    const jobs: ChatBackgroundJob[] = [];
    for (const message of messages) {
      if (message.role !== "tool" || message.isToolResult || message.isChange) continue;
      const id = message.toolCallID;
      if (id === null) continue;
      const result = results.get(id);
      const resultText = result === undefined ? "" : ToolPresentationCache.value(result).body;
      // A call flagged for the background, or one moved there after it outran its timeout.
      if (!ChatBackgroundJobs.isBackground(message) && !ChatBackgroundJobs.resultLooksBackgrounded(resultText)) continue;
      const presentation = ToolPresentationCache.value(message);
      const notification = notifications.get(id);
      const output = notification !== undefined && notification.output.length > 0 ? notification.output : resultText;
      const worker = BackgroundJobLabel.parse(presentation.body);
      const tool = (message.title ?? "").split(".").filter((part) => part !== "").pop();
      const description = tool === "Bash" ? presentation.description : null;
      const summary = worker !== null ? `Worker: ${worker.label}` : description ?? notification?.summary ?? presentation.preview;
      const code = ChatBackgroundJobs.exitCode(notification?.summary) ?? ChatBackgroundJobs.exitCode(resultText);
      // A background call's result only says the job started; done means the notification came.
      const status = notification?.status.toLowerCase() ?? "";
      const finished = ["completed", "failed", "killed", "cancelled", "canceled", "stopped"].includes(status)
        || (result !== undefined && resultText.length > 0 && !ChatBackgroundJobs.resultLooksBackgrounded(resultText));
      const startedAt = message.timestamp ?? firstSeen.get(id) ?? now;
      const finishedAt = finished ? notification?.at ?? result?.timestamp ?? finishedSeen.get(id) ?? now : null;
      // Finished jobs linger long enough to be read, then leave.
      if (!includeExpired && finishedAt !== null && Math.trunc((Date.parse(now) - Date.parse(finishedAt)) / 1000) > ChatBackgroundJobs.FINISHED_LINGER_SECONDS) continue;
      jobs.push({
        id,
        title: summary.length === 0 ? "Background command" : summary,
        worker: worker?.provider ?? null,
        command: presentation.body,
        output,
        state: finished ? ChatBackgroundJob.State.Finished(code) : ChatBackgroundJob.State.Running,
        startedAt,
        finishedAt,
      });
    }
    return jobs;
  },

  backgroundIDs(messages: TranscriptMessage[]): Set<string> {
    return new Set(ChatBackgroundJobs.parse(messages, new Map(), new Map(), new Date().toISOString(), true).map((job) => job.id));
  },

  /** Claude Code's own notice as the whole result, not a command whose output mentions one. */
  resultLooksBackgrounded(text: string): boolean {
    const first = text.trim().toLowerCase();
    return first.startsWith("command running in background with id") || MOVED.test(first);
  },

  /** Cheap first: a substring scan says no for almost every call before any regex runs. */
  isBackground(message: TranscriptMessage): boolean {
    const key = `${message.id}|${message.text.length}`;
    const cached = backgroundFlags.get(key);
    if (cached !== undefined) return cached;
    const lower = message.text.toLowerCase();
    const value = message.text.includes("background")
      && ["shell", "tools"].includes(ToolPresentationCache.value(message).title.toLowerCase())
      && (RUN_IN_BACKGROUND.test(lower) || BACKGROUND.test(lower));
    if (backgroundFlags.size >= 2_000) backgroundFlags.clear();
    backgroundFlags.set(key, value);
    return value;
  },

  /** The call a `<task-notification>` answers. */
  notificationCallID(text: string): string | null { return AgentToolCardJSON.tag("tool-use-id", text); },

  exitCode(text: string | null | undefined): number | null {
    if (text === null || text === undefined) return null;
    const match = EXIT.exec(text);
    if (match === null) return null;
    const value = Number.parseInt(match[1], 10);
    return Number.isNaN(value) ? null : value;
  },
};

// --- Timeline entries -------------------------------------------------------------------------

export type ChatTimelineEntryKind = "message" | "activity" | "read_run";

export interface ChatTimelineEntryFields {
  messages?: TranscriptMessage[];
  kind?: ChatTimelineEntryKind;
  phren?: PhrenToolPresentation | null;
  /** A card of its own for the agent's bookkeeping calls; null for the pill. */
  card?: ToolCardKind | null;
  /** A whole-list card (todos) a later call replaced: shown folded to one line. */
  cardSuperseded?: boolean;
  /** A folded patch in this row is big enough to need the bounded accessibility path. */
  hasLargeCollapsedChange?: boolean;
  /** The folded run's title, preview and inner groups, built once in preparation. */
  readRun?: ChatReadRunPresentation | null;
  placeholderIdentifier?: string;
  placeholderLabel?: string;
  turnActivity?: ChatTurnActivity | null;
  /** The files a finished turn changed, drawn as one row at its end. */
  turnChanges?: ChatTurnChanges | null;
  /** A sent message the transcript hasn't echoed yet. */
  pendingEcho?: ChatPendingEcho | null;
}

/** One row of the transcript: a message, a tool pill or card, a folded run, turn activity, changes or a pending echo. */
export class ChatTimelineEntry {
  messages: TranscriptMessage[];
  kind: ChatTimelineEntryKind;
  phren: PhrenToolPresentation | null;
  card: ToolCardKind | null;
  cardSuperseded: boolean;
  hasLargeCollapsedChange: boolean;
  readRun: ChatReadRunPresentation | null;
  placeholderIdentifier: string;
  placeholderLabel: string;
  turnActivity: ChatTurnActivity | null;
  turnChanges: ChatTurnChanges | null;
  pendingEcho: ChatPendingEcho | null;

  constructor(messages: TranscriptMessage[], fields: ChatTimelineEntryFields = {}) {
    this.messages = messages;
    this.kind = fields.kind ?? "message";
    this.phren = fields.phren ?? null;
    this.card = fields.card ?? null;
    this.cardSuperseded = fields.cardSuperseded ?? false;
    this.hasLargeCollapsedChange = fields.hasLargeCollapsedChange ?? false;
    this.readRun = fields.readRun ?? null;
    this.placeholderIdentifier = fields.placeholderIdentifier ?? "";
    this.placeholderLabel = fields.placeholderLabel ?? "";
    this.turnActivity = fields.turnActivity ?? null;
    this.turnChanges = fields.turnChanges ?? null;
    this.pendingEcho = fields.pendingEcho ?? null;
  }

  copy(fields: ChatTimelineEntryFields): ChatTimelineEntry {
    return new ChatTimelineEntry(fields.messages ?? this.messages, {
      messages: fields.messages ?? this.messages,
      kind: this.kind, phren: this.phren, card: this.card, cardSuperseded: this.cardSuperseded,
      hasLargeCollapsedChange: this.hasLargeCollapsedChange, readRun: this.readRun,
      placeholderIdentifier: this.placeholderIdentifier, placeholderLabel: this.placeholderLabel,
      turnActivity: this.turnActivity, turnChanges: this.turnChanges, pendingEcho: this.pendingEcho, ...fields,
    });
  }

  get id(): string {
    if (this.turnActivity !== null) return `activity:${this.turnActivity.ownerID}`;
    if (this.turnChanges !== null) return `changes:${this.turnChanges.ownerID}`;
    if (this.pendingEcho !== null) return `pending:${this.pendingEcho.id}`;
    return this.messages.length > 0 ? this.messages[0].id : "";
  }
  get isActivity(): boolean { return this.kind !== "message"; }
  get isReadRun(): boolean { return this.kind === "read_run"; }
  get callID(): string { return this.messages[0]?.toolCallID ?? this.messages[0]?.id ?? ""; }
  get cardMarkdownKey(): string { return this.messages.map((message) => renderKey(message)).join("\n") + "|card"; }

  /** A folded change whose diff is too big to expose row by row. */
  static largeCollapsedChange(messages: TranscriptMessage[]): boolean {
    return messages.some((message) => message.isChange && collapsedChangeRows(message.text, renderKey(message)) > 120);
  }

  static group(messages: TranscriptMessage[], foldingReads = true): ChatTimelineEntry[] {
    const entries: ChatTimelineEntry[] = [];
    let previousMessageID: string | null = null;
    let calls = new Map<string, number>();
    const ambiguous = new Set<string>();
    // A background agent's completion, by the call it answers.
    const notifications = new Map<string, string>();
    // Claude Code's AskUserQuestion draws as the question card itself.
    const askedQuestions = new Set(messages.filter((message) => message.role === "tool" && !message.isToolResult && message.title === "AskUserQuestion")
      .map((message) => message.toolCallID).filter((id): id is string => id !== null));
    for (const message of messages) {
      // Completion metadata feeds the pinned Background tray, not another card.
      if (message.role === "tool" && message.title === "Background notification") {
        const id = ChatBackgroundJobs.notificationCallID(message.text);
        if (id !== null) notifications.set(id, message.text);
        continue;
      }
      if (message.role === "tool" && !message.isToolResult && message.title === "AskUserQuestion") continue;
      if (message.role === "tool" && message.isToolResult && message.toolCallID !== null && askedQuestions.has(message.toolCallID)) continue;
      if (message.role !== "tool") {
        entries.push(new ChatTimelineEntry([message]));
        // Phren's result may follow an assistant line: keep only its unanswered calls.
        calls = new Map([...calls].filter(([, index]) => {
          const title = entries[index].messages[0]?.title;
          return (PhrenToolPresentation.recognizes(title) || ToolCardKind.recognizes(title)) && entries[index].messages.every((entry) => !entry.isToolResult);
        }));
        for (const key of [...ambiguous]) if (!calls.has(key)) ambiguous.delete(key);
        previousMessageID = message.id;
        continue;
      }
      // A result, or what the call changed on disk, joins its call.
      if (message.isToolResult || message.isChange) {
        const key = message.toolCallID;
        const index = key !== null && key.length > 0 && !ambiguous.has(key) ? calls.get(key) : undefined;
        if (index !== undefined) {
          entries[index] = entries[index].copy({ messages: [...entries[index].messages, message] });
          previousMessageID = message.id;
          continue;
        }
        // Older transcripts lack IDs: only pair an immediately adjacent, unidentified call and result.
        const previous = entries[entries.length - 1];
        const call = previous !== undefined && previous.messages.length === 1 ? previous.messages[0] : undefined;
        if (message.toolCallID === null && call !== undefined && call.role === "tool" && !call.isToolResult &&
          call.toolCallID === null && call.id === previousMessageID) {
          entries[entries.length - 1] = previous.copy({ messages: [...previous.messages, message] });
          previousMessageID = message.id;
          continue;
        }
      } else if (message.toolCallID !== null && message.toolCallID.length > 0) {
        const key = message.toolCallID;
        if (calls.has(key)) ambiguous.add(key); else calls.set(key, entries.length);
      }
      entries.push(new ChatTimelineEntry([message], { kind: "activity" }));
      previousMessageID = message.id;
    }
    for (let index = 0; index < entries.length; index++) {
      const call = entries[index].messages[0];
      if (call === undefined || call.role !== "tool" || call.isToolResult) continue;
      // A Skill call's newest result is what the skill loaded: Claude Code's own result is only the "Launching skill" notice.
      const result = SkillCallPresentation.recognizes(call.title)
        ? [...entries[index].messages].reverse().find((entry) => entry.isToolResult) ?? null
        : entries[index].messages.find((entry) => entry.isToolResult) ?? null;
      if (AgentToolClassification.kind(call.title, call.text) === AgentToolClassification.Kind.PHREN) {
        entries[index] = entries[index].copy({ phren: PhrenToolPresentation.of(call.title ?? "", call.text, result?.text ?? null, result?.isToolError === true) });
      } else if (ToolCardKind.recognizes(call.title)) {
        entries[index] = entries[index].copy({ card: ToolCardKind.of(call, result, call.toolCallID !== null ? notifications.get(call.toolCallID) ?? null : null) });
      }
    }
    // Which todo lists a later call replaced: once, for the whole timeline.
    const lists = entries.map((entry) => entry.card?.kind === "todos" ? entry.card.value : null);
    AgentTodoPresentation.superseded(lists).forEach((superseded, index) => {
      if (superseded) entries[index] = entries[index].copy({ cardSuperseded: true });
    });
    return foldingReads ? ChatTimelineEntry.foldSameToolRuns(ChatTimelineEntry.foldReadRuns(entries)) : entries;
  }

  /** Two or more calls in a row of the same tool become one pill; calls that changed files keep their own row. */
  private static foldSameToolRuns(entries: ChatTimelineEntry[]): ChatTimelineEntry[] {
    const result: ChatTimelineEntry[] = [];
    let run: ChatTimelineEntry[] = [];
    let runTool: string | null = null;
    const flush = (): void => {
      if (run.length >= 2) result.push(new ChatTimelineEntry(run.flatMap((entry) => entry.messages), { kind: "read_run" }));
      else result.push(...run);
      run = []; runTool = null;
    };
    for (const entry of entries) {
      const tool = ChatTimelineEntry.sameToolKey(entry);
      if (tool === null) { flush(); result.push(entry); continue; }
      if (tool !== runTool) { flush(); runTool = tool; }
      run.push(entry);
    }
    flush();
    return result;
  }

  private static sameToolKey(entry: ChatTimelineEntry): string | null {
    if (entry.kind !== "activity" || entry.phren !== null || entry.card !== null) return null;
    if (entry.messages.some((message) => message.isChange)) return null;
    const call = entry.messages.find((message) => message.role === "tool" && !message.isToolResult);
    if (call === undefined || ChatBackgroundJobs.isBackground(call)) return null;
    const presentation = ToolPresentationCache.value(call);
    if (presentation.patch !== null || presentation.editsFiles) return null;
    return presentation.title;
  }

  /** Three or more calls in a row that only looked around become one row. */
  private static foldReadRuns(entries: ChatTimelineEntry[]): ChatTimelineEntry[] {
    const result: ChatTimelineEntry[] = [];
    let run: ChatTimelineEntry[] = [];
    const flush = (): void => {
      if (run.length >= 3) result.push(new ChatTimelineEntry(run.flatMap((entry) => entry.messages), { kind: "read_run" }));
      else result.push(...run);
      run = [];
    };
    for (const entry of entries) {
      if (entry.kind === "activity" && ReadOnlyToolCall.looksAround(entry.messages)) run.push(entry);
      else { flush(); result.push(entry); }
    }
    flush();
    return result;
  }
}

// --- Folded read run --------------------------------------------------------------------------

/** A folded read run as its row draws it: the inner cards and the summary line, built once. */
export class ChatReadRunPresentation {
  readonly groups: ChatTimelineEntry[];
  readonly title: string;
  readonly preview: string;
  /** Every call is the same tool ("Shell ×2"): its name, else null. */
  readonly sameTool: string | null;
  readonly status: ToolCardStatus;
  readonly spokenLabel: string;

  constructor(messages: TranscriptMessage[]) {
    // Re-grouping restores the exact call and result cards shown before the run folded.
    this.groups = ChatTimelineEntry.group(messages, false).map((entry) => entry.copy({ hasLargeCollapsedChange: ChatTimelineEntry.largeCollapsedChange(entry.messages) }));
    const calls = this.groups.map((group) => group.messages.find((message) => !message.isToolResult && !message.isChange))
      .filter((message): message is TranscriptMessage => message !== undefined);
    // What the agent did, in order: "Shell ×4 · Read ×2".
    const counts: [string, number][] = [];
    for (const name of calls.map((call) => ToolPresentationCache.value(call).title)) {
      const index = counts.findIndex((entry) => entry[0] === name);
      if (index >= 0) counts[index] = [name, counts[index][1] + 1]; else counts.push([name, 1]);
    }
    this.title = counts.slice(0, 3).map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(" · ") + (counts.length > 3 ? " …" : "");
    // The last command, so the row still says where the agent got to.
    this.preview = calls.length > 0 ? ToolPresentationCache.value(calls[calls.length - 1]).preview : "";
    this.sameTool = counts.length === 1 ? counts[0][0] : null;
    this.status = ChatToolSummary.status(messages);
    const operations = this.groups.length === 1 ? "operation" : "operations";
    this.spokenLabel = `${this.title}, ${this.groups.length} ${this.sameTool === null || this.sameTool === "Read" ? "read " : ""}${operations}` + (this.status === "failed" ? ", Failed" : "");
  }
}

// --- Preparation ------------------------------------------------------------------------------

interface ChatMessageKey {
  content: string;
  timestamp: string | null;
  failed: boolean;
  queued: boolean;
  scheduled: boolean;
  queueKey: string | null;
  images: number[];
  results: string;
  call: string | null;
}

/**
 * Work tied to transcript changes, never to scrolling or connection ticks. The
 * model runs this off the main thread; `update` returns early when nothing that
 * shapes a row changed.
 */
export class ChatTranscriptPreparation {
  entries: ChatTimelineEntry[] = [];
  jobs: ChatBackgroundJob[] = [];
  currentToolName: string | null = null;
  currentToolDetail: string | null = null;
  revision = 0;
  private keys: ChatMessageKey[] = [];
  private baseEntries: ChatTimelineEntry[] = [];
  private activityContext = chatActivityContext();
  private firstSeen = new Map<string, string>();
  private finishedSeen = new Map<string, string>();
  private readRuns = new Map<string, ChatReadRunPresentation>();

  copy(): ChatTranscriptPreparation {
    const clone = new ChatTranscriptPreparation();
    clone.entries = this.entries; clone.jobs = this.jobs;
    clone.currentToolName = this.currentToolName; clone.currentToolDetail = this.currentToolDetail;
    clone.revision = this.revision; clone.keys = this.keys; clone.baseEntries = this.baseEntries;
    clone.activityContext = this.activityContext;
    clone.firstSeen = new Map(this.firstSeen); clone.finishedSeen = new Map(this.finishedSeen);
    clone.readRuns = new Map(this.readRuns);
    return clone;
  }

  update(messages: TranscriptMessage[], activity: ChatActivityContext = chatActivityContext(), now: string = new Date().toISOString()): void {
    const incoming: ChatMessageKey[] = messages.map((message) => ({
      content: renderKey(message), timestamp: message.timestamp, failed: message.isToolError, queued: message.isQueued,
      scheduled: message.isScheduled, queueKey: message.queueKey, images: message.imageBlocks,
      results: JSON.stringify(message.resultImages), call: message.toolCallID,
    }));
    if (ChatTranscriptPreparation.keysEqual(incoming, this.keys) && activityContextEquals(activity, this.activityContext)) return;
    this.revision++;
    this.activityContext = activity;
    if (!ChatTranscriptPreparation.keysEqual(incoming, this.keys)) {
      this.keys = incoming;
      let built = ChatTimelineEntry.group(messages);
      // Derived row work that must not run while drawing: the folded run's cards,
      // the bounded accessibility path, the placeholder's identity.
      built = built.map((entry) => {
        let result = entry.copy({ hasLargeCollapsedChange: ChatTimelineEntry.largeCollapsedChange(entry.messages) });
        if (result.isReadRun) {
          const key = ChatTranscriptPreparation.readRunKey(result.messages);
          const run = this.readRuns.get(key) ?? new ChatReadRunPresentation(result.messages);
          this.readRuns.set(key, run);
          result = result.copy({ readRun: run });
        }
        return result;
      });
      const live = new Set(built.filter((entry) => entry.isReadRun).map((entry) => ChatTranscriptPreparation.readRunKey(entry.messages)));
      for (const key of [...this.readRuns.keys()]) if (!live.has(key)) this.readRuns.delete(key);
      built = built.map((entry) => entry.copy({
        placeholderIdentifier: ChatTranscriptPreparation.placeholderIdentifier(entry),
        placeholderLabel: ChatTranscriptPreparation.placeholderLabel(entry),
      }));
      this.jobs = ChatBackgroundJobs.parse(messages, this.firstSeen, this.finishedSeen, now, true);
      for (const job of this.jobs) {
        this.firstSeen.set(job.id, job.startedAt);
        if (job.finishedAt !== null) this.finishedSeen.set(job.id, job.finishedAt);
      }
      const retained = new Set(this.jobs.map((job) => job.id));
      for (const key of [...this.firstSeen.keys()]) if (!retained.has(key)) this.firstSeen.delete(key);
      for (const key of [...this.finishedSeen.keys()]) if (!retained.has(key)) this.finishedSeen.delete(key);
      const completed = new Set<string>();
      this.currentToolName = null; this.currentToolDetail = null;
      for (const message of [...messages].reverse()) {
        if (message.role !== "tool") continue;
        if (message.isToolResult) { if (message.toolCallID !== null) completed.add(message.toolCallID); }
        else if (!message.isChange && !message.isCompaction && message.title !== "Background notification" && (message.toolCallID === null || !completed.has(message.toolCallID))) {
          this.currentToolName = message.title;
          // The card's own short read of the input: a command's first line, or a path.
          this.currentToolDetail = message.title !== null ? ToolPresentation.of(message.title, message.text).preview : null;
          break;
        }
      }
      this.baseEntries = built;
    }
    this.entries = ChatTranscriptPreparation.attachingActivity(this.baseEntries, messages, activity);
  }

  static readRunKey(messages: TranscriptMessage[]): string {
    return messages.map((message) => renderKey(message)).join("\n");
  }

  /** The identifier a far-off placeholder keeps: the same one the row carries when drawn in full. */
  static placeholderIdentifier(entry: ChatTimelineEntry): string {
    const first = entry.messages[0];
    if (first !== undefined && first.isCompaction) return "chat-compaction";
    if (entry.phren !== null) return `chat-phren-card:${entry.callID}`;
    if (entry.card !== null) {
      switch (entry.card.kind) {
        case "agent": return `chat-agent-card:${entry.callID}`;
        case "todos": return `chat-todo-card:${entry.callID}`;
        case "plan": case "planMode": return `chat-plan-card:${entry.callID}`;
        case "web": return `chat-web-card:${entry.callID}`;
        case "skill": return `chat-skill-chip:${entry.callID}`;
        case "mcp": return `chat-mcp-card:${entry.callID}`;
      }
    }
    if (entry.isReadRun) return `chat-read-run:${entry.messages[0].id}`;
    if (entry.isActivity) return `chat-tool-group:${entry.messages[0].id}`;
    if (first !== undefined) {
      if (first.localCommand !== null) return `chat-command:${first.id}`;
      if (first.isNarration) return `chat-narration:${first.id}`;
      if (first.isHookContext) return `chat-hook-context:${first.id}`;
      if (first.isScheduled) return `chat-scheduled-check:${first.id}`;
      return `chat-message:${first.id}`;
    }
    return "";
  }

  /** The one-line label a placeholder reads as. */
  static placeholderLabel(entry: ChatTimelineEntry): string {
    const first = entry.messages[0];
    if (first !== undefined && first.isCompaction) return first.text.length === 0 ? "Conversation compacted" : `Conversation compacted: ${first.text}`;
    if (entry.phren !== null) return [entry.phren.verb, entry.phren.project, entry.phren.tag].filter((part): part is string => part !== null).join(", ");
    if (entry.card !== null) return toolCardOffScreenLabel(entry.card);
    if (entry.isReadRun && entry.readRun !== null) return entry.readRun.spokenLabel;
    if (entry.isActivity) {
      const summary = new ChatToolSummary(entry.messages);
      return `${summary.title}, ${summary.count} ${summary.count === 1 ? "operation" : "operations"}`;
    }
    if (first !== undefined) {
      if (first.localCommand !== null) {
        return first.localCommand.kind === "output" ? `Command output: ${first.localCommand.text}` : `Command: ${first.localCommand.text}`;
      }
      if (first.isNarration) return `Thinking: ${new ToolOutputPreview(first.text, 4, 400).text}`;
      if (first.isHookContext) return `phren context: ${new ToolOutputPreview(first.text, 2, 200).text}`;
      if (first.isScheduled) return "Scheduled check";
      const role = first.role === "user" ? "Your message" : "Agent reply";
      const text = first.role === "user" ? VoiceMarker.hidden(first.text) : first.text;
      const body = new ToolOutputPreview(text, 40, 6_000).text;
      return body.length === 0 ? role : `${role}: ${body}`;
    }
    return "";
  }

  /** Places each turn's activity line and changes row, then the pending echoes and the live line. */
  static attachingActivity(entries: ChatTimelineEntry[], messages: TranscriptMessage[], context: ChatActivityContext): ChatTimelineEntry[] {
    const users = messages.filter((message) => message.role === "user" && !message.isQueued && !message.isScheduled && message.localCommand === null && !message.isCompaction);
    const insertions = new Map<number, ChatTimelineEntry[]>();
    const insert = (index: number, entry: ChatTimelineEntry): void => {
      const list = insertions.get(index); if (list === undefined) insertions.set(index, [entry]); else list.push(entry);
    };
    let live: ChatTurnActivity | null = null;
    for (let index = 0; index < context.turns.length; index++) {
      const turn = context.turns[index];
      const start = turn.startedAt;
      if (start === null) continue;
      const previousEnd = index > 0 ? (context.turns[index - 1].endLine ?? context.turns[index - 1].startLine) : -1;
      const end = turn.endLine ?? (index + 1 < context.turns.length ? context.turns[index + 1].startLine - 1 : Number.MAX_SAFE_INTEGER);
      const owner = ChatTranscriptPreparation.lastOrNull(users.filter((message) => message.line > previousEnd && message.line <= turn.startLine))
        ?? users.find((message) => message.line >= turn.startLine && message.line <= end);
      if (owner === undefined) continue;
      const nextUser = users.find((message) => message.line > owner.line)?.line ?? Number.MAX_SAFE_INTEGER;
      const rows = messages.filter((message) => message.line > owner.line && message.line < nextUser && message.line <= end);
      const calls = rows.filter((message) => message.role === "tool" && !message.isToolResult && !message.isChange && !message.isCompaction && message.title !== "Background notification");
      if (turn.phase === "working") {
        if (index !== context.turns.length - 1 || !context.busy || context.waiting) continue;
        live = new ChatTurnActivity(owner.id, start, null, "working", context.harnessVerb ?? ChatTranscriptPreparation.liveVerb(rows, calls), context.harnessVerb !== null);
      } else if (turn.finishedAt !== null) {
        // Claude's own word in the past tense ("Brewed for"); ours without one.
        const said = context.turnVerbs[start];
        const verb = turn.phase === "stopped" ? "Stopped after"
          : said !== undefined ? `${AgentChatSpinner.pastTense(said) ?? "Worked"} for` : calls.length === 0 ? "Thought for" : "Worked for";
        const activity = new ChatTurnActivity(owner.id, start, turn.finishedAt, turn.phase, verb, said !== undefined);
        // The final assistant text is the reply; earlier text can be tool commentary.
        const reply = ChatTranscriptPreparation.lastOrNull(rows.filter((message) => message.role === "assistant" && message.localCommand === null && !message.isNarration && !message.isHookContext));
        const anchor = reply ?? users.find((message) => message.line > owner.line) ?? null;
        const found = anchor !== null ? entries.findIndex((entry) => entry.messages.some((message) => message.id === anchor.id)) : -1;
        const position = found >= 0 ? found : entries.length;
        insert(position, ChatTranscriptPreparation.activityEntry(activity));
        // What the turn changed closes it: after its last row, before the next message.
        const changes = ChatTurnChanges.collect(owner.id, rows, context.workingDirectory);
        const last = ChatTranscriptPreparation.lastOrNull(rows);
        if (changes !== null && last !== undefined) {
          const foundLast = ChatTranscriptPreparation.lastIndex(entries, (entry) => entry.messages.some((message) => message.id === last.id));
          const after = foundLast >= 0 ? foundLast + 1 : entries.length;
          insert(after, new ChatTimelineEntry([], { turnChanges: changes, placeholderIdentifier: changes.identifier, placeholderLabel: changes.spokenLabel }));
        }
      }
    }
    // Cover submit-to-acknowledgement latency without inventing a persisted start.
    const submittedAt = context.submittedAt;
    if (live === null && context.busy && !context.waiting && submittedAt !== null && context.turns.every((turn) => !(turn.startLine > context.submittedAfterLine))) {
      const owner = users.find((message) => message.line > context.submittedAfterLine);
      const rows = messages.filter((message) => message.line > (owner?.line ?? context.submittedAfterLine));
      const calls = rows.filter((message) => message.role === "tool" && !message.isToolResult && !message.isChange && !message.isCompaction);
      live = new ChatTurnActivity(owner?.id ?? `submission:${Date.parse(submittedAt) / 1000}`, submittedAt, null, "working",
        context.harnessVerb ?? ChatTranscriptPreparation.liveVerb(rows, calls), context.harnessVerb !== null);
    }
    const result: ChatTimelineEntry[] = [];
    for (let index = 0; index <= entries.length; index++) {
      const inserted = insertions.get(index);
      if (inserted !== undefined) result.push(...inserted);
      if (index < entries.length) result.push(entries[index]);
    }
    // The person's own message lands with the live line, above it.
    for (const echo of context.pendingEchoes) result.push(new ChatTimelineEntry([], { pendingEcho: echo, placeholderLabel: `Your message: ${VoiceMarker.hidden(echo.text)}` }));
    if (live !== null) result.push(ChatTranscriptPreparation.activityEntry(live));
    return result;
  }

  private static liveVerb(rows: TranscriptMessage[], calls: TranscriptMessage[]): string {
    const completed = new Set(rows.filter((message) => message.isToolResult).map((message) => message.toolCallID).filter((id): id is string => id !== null));
    const open = ChatTranscriptPreparation.lastOrNull(calls.filter((call) => {
      const id = call.toolCallID;
      if (id !== null) return !completed.has(id) && !ChatBackgroundJobs.isBackground(call);
      return rows.every((message) => !(message.isToolResult && message.line > call.line));
    }));
    if (open !== undefined) return ToolPresentationCache.value(open).activityVerb;
    if (rows.some((message) => message.role === "assistant" && message.text.length > 0)) return "Responding";
    return calls.length === 0 ? "Thinking" : "Working";
  }

  private static activityEntry(activity: ChatTurnActivity): ChatTimelineEntry {
    return new ChatTimelineEntry([], {
      turnActivity: activity, placeholderIdentifier: activity.identifier,
      placeholderLabel: activity.label(activity.finishedAt ?? activity.startedAt),
    });
  }

  private static keysEqual(left: ChatMessageKey[], right: ChatMessageKey[]): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      const a = left[index]; const b = right[index];
      if (a.content !== b.content || a.timestamp !== b.timestamp || a.failed !== b.failed || a.queued !== b.queued ||
        a.scheduled !== b.scheduled || a.queueKey !== b.queueKey || a.call !== b.call ||
        a.results !== b.results || a.images.length !== b.images.length) return false;
      for (let i = 0; i < a.images.length; i++) if (a.images[i] !== b.images[i]) return false;
    }
    return true;
  }

  private static lastOrNull<T>(values: T[]): T | undefined { return values.length === 0 ? undefined : values[values.length - 1]; }
  private static lastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
    for (let index = values.length - 1; index >= 0; index--) if (predicate(values[index])) return index;
    return -1;
  }
}

/** The markdown a card renders, cut to what the row shows. */
export function toolCardMarkdownPreview(card: ToolCardKind): ToolOutputPreview | null {
  switch (card.kind) {
    case "agent": return card.value.report.length === 0 ? null : new ToolOutputPreview(card.value.report, 8, 1_000);
    case "plan": return card.value.plan.length === 0 ? null : new ToolOutputPreview(card.value.plan, 14, 2_000);
    case "web": return card.value.resultMarkdown === null ? null : new ToolOutputPreview(card.value.resultMarkdown, WebToolPresentation.PREVIEW_LINES, 4_000);
    // A skill chip opens what the skill loaded: its call's last result.
    case "skill": return card.value.result === null || card.value.result.length === 0 ? null : new ToolOutputPreview(card.value.result, 40, 6_000);
    default: return null;
  }
}

/** The short label a card keeps when its row is far off screen. */
export function toolCardOffScreenLabel(card: ToolCardKind): string {
  switch (card.kind) {
    case "agent": return `${card.value.name}, ${card.value.description}, ${card.value.state}`;
    case "todos": return `${card.value.title}, ${card.value.summary}`;
    case "plan": return "Plan ready for review";
    case "planMode": return "Entered plan mode";
    case "web": return `${card.value.title}, ${card.value.location}`;
    case "skill": return `Skill ${card.value.command}` + (card.value.args !== null ? `, ${card.value.args}` : "");
    case "mcp": return `${card.value.server} · ${card.value.verb}`;
  }
}
