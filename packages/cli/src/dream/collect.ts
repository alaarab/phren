// Dream inputs: what actually happened in a project's sessions during the lookback window
// (trimmed transcripts from every harness Phren reads), next to what the project's memory
// currently says (findings with fids, truths, topics, pages), the repo's recent git log and
// the dream journal. Transcripts are budgeted newest first so a busy day can't crowd out
// the memory the model is meant to correct.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { claudeHomes } from "../bridge/claude-accounts.js";
import { materializedRoot } from "../bridge/codex-threads.js";
import { phrenStoreRoot } from "../bridge/transcripts.js";
import { redactSecretsForLog } from "../content/secrets.js";
import { readFindings } from "../data/access.js";
import { codexHome, copilotHome } from "../home-paths.js";
import { getProjectSourcePath } from "../project-config.js";
import { readProjectTopics } from "../project-topics.js";
import { storeAwareProjectPath } from "../store-routing.js";
import { injectedSize, overBudget } from "./contract-stubs.js"; // CONTRACT STUB: ./budget.js at integration

export type DreamTranscriptSource = "claude" | "codex" | "copilot" | "opencode";

export const DEFAULT_TRANSCRIPT_BUDGET_CHARS = 120_000;
/** Bytes read from the end of a transcript; older turns of a huge file are outside any lookback anyway. */
const TAIL_BYTES = 8 * 1024 * 1024;
/** Bytes read from the start to find a session's cwd (Codex writes it once, in session_meta). */
const HEAD_BYTES = 64 * 1024;
const MESSAGE_MAX_CHARS = 1_500;
/** A session gets trimmed rather than dropped while at least this much budget remains. */
const MIN_PARTIAL_CHARS = 2_000;
const MAX_FILES = 400;
const JOURNAL_LINES = 20;
const GIT_LOG_COUNT = 20;

export interface DreamTranscriptRoot { source: DreamTranscriptSource; root: string; maxDepth: number }

export interface DreamTranscript {
  source: DreamTranscriptSource;
  session: string;
  cwd: string;
  first: string;
  last: string;
  turns: number;
  /** Trimmed rendering: `[t<n>] user|assistant|tools: ...` lines. */
  text: string;
  trimmed?: true;
}

export interface DreamFindingInput { fid: string; date: string; text: string; status: string; citation?: string }
export interface DreamPageInput { slug: string; title: string; summary: string }
export interface DreamBudgetState { sizeBytes: number; budgetBytes: number; over: boolean; candidates: string[] }

export interface DreamInputs {
  project: string;
  from: string;
  to: string;
  repoDir?: string;
  transcripts: DreamTranscript[];
  transcriptChars: number;
  /** Sessions in the window left out entirely for budget. */
  transcriptsDropped: number;
  findings: DreamFindingInput[];
  truths: string[];
  topics: Array<{ slug: string; label: string }>;
  pages: DreamPageInput[];
  gitLog: string[];
  journal: string[];
  budget: DreamBudgetState;
}

export interface CollectOptions {
  from: Date;
  to: Date;
  budgetChars?: number;
  injectBudgetKB?: number;
  /** Transcript locations; defaults to every harness Phren reads on this computer. */
  roots?: DreamTranscriptRoot[];
  /** Folders whose sessions belong to the project; defaults to its source path and that repo's worktrees. */
  projectDirs?: string[];
  /** Replace the git reader (tests); false skips git. */
  gitLog?: false | ((dir: string) => string[]);
}

export function defaultTranscriptRoots(): DreamTranscriptRoot[] {
  const roots: DreamTranscriptRoot[] = claudeHomes().map(home => ({ source: "claude" as const, root: path.join(home.dir, "projects"), maxDepth: 1 }));
  roots.push({ source: "codex", root: path.join(codexHome(), "sessions"), maxDepth: 3 });
  roots.push({ source: "codex", root: materializedRoot(), maxDepth: 0 });
  roots.push({ source: "copilot", root: path.join(copilotHome(), "session-state"), maxDepth: 1 });
  roots.push({ source: "opencode", root: path.join(phrenStoreRoot(), ".runtime", "sessions"), maxDepth: 0 });
  return roots;
}

export function projectStoreDir(phrenPath: string, project: string): string {
  return storeAwareProjectPath(phrenPath, project) ?? path.join(phrenPath, project);
}

// ── Transcript parsing ───────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const objs = (value: unknown): Json[] => Array.isArray(value) ? value.map(obj) : [];
const absolute = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 4096 && path.isAbsolute(value) ? value : undefined;

function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  return objs(content).filter(block => ["text", "input_text", "output_text"].includes(String(block.type)) && typeof block.text === "string")
    .map(block => block.text as string).join("\n");
}

/** Harness scaffolding that is not something the person or the agent said. */
function cleanText(text: string): string {
  const stripped = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (/^<(environment_context|user_instructions|local-command-stdout|command-name|command-message)\b/.test(stripped)) return "";
  if (stripped.startsWith("# AGENTS.md instructions")) return "";
  return stripped;
}

function messageOf(raw: Json, source: DreamTranscriptSource): { role: "user" | "assistant"; text: string } | undefined {
  let role: unknown, content: unknown;
  if (source === "claude") {
    if (raw.isCompactSummary === true || raw.isMeta === true) return undefined;
    const message = obj(raw.message);
    role = message.role; content = message.content;
  } else if (source === "codex") {
    const payload = obj(raw.payload);
    if (payload.type !== "message") return undefined;
    role = payload.role; content = payload.content;
  } else if (source === "copilot") {
    if (raw.type === "user.message") role = "user";
    else if (raw.type === "assistant.message") role = "assistant";
    else return undefined;
    content = obj(raw.data).content;
  } else {
    if (raw.type === "user/message") role = "user";
    else if (raw.type === "assistant/message") role = "assistant";
    else return undefined;
    const message = obj(obj(raw.data).message);
    role = message.role ?? role; content = message.content;
  }
  if (role !== "user" && role !== "assistant") return undefined;
  const text = cleanText(blocksText(content));
  return text ? { role, text } : undefined;
}

/** Tool names a row starts; the tool's input and output bodies are never kept. */
function toolsOf(raw: Json, source: DreamTranscriptSource): string[] {
  if (source === "claude") {
    return objs(obj(raw.message).content).filter(block => block.type === "tool_use" && typeof block.name === "string").map(block => block.name as string);
  }
  if (source === "codex") {
    const payload = obj(raw.payload);
    if (["function_call", "custom_tool_call", "local_shell_call"].includes(String(payload.type))) return [typeof payload.name === "string" ? payload.name : String(payload.type)];
    return [];
  }
  if (source === "copilot") {
    const name = obj(raw.data).toolName;
    return raw.type === "tool.execution_start" && typeof name === "string" ? [name] : [];
  }
  const tool = obj(obj(raw.data).part);
  return tool.type === "tool" && typeof tool.tool === "string" ? [tool.tool] : [];
}

function timestampOf(raw: Json, source: DreamTranscriptSource): number | undefined {
  const value = source === "opencode" ? raw.time ?? raw.timestamp : raw.timestamp;
  const parsed = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cwdOf(raw: Json, source: DreamTranscriptSource): string | undefined {
  const direct = absolute(raw.cwd);
  if (direct) return direct;
  const payload = obj(raw.payload), data = obj(raw.data);
  if (source === "copilot") return absolute(obj(data.context).cwd);
  return absolute(payload.cwd) ?? absolute(data.cwd) ?? absolute(obj(data.context).cwd);
}

function sessionOf(source: DreamTranscriptSource, file: string): string {
  const name = path.basename(file, ".jsonl");
  if (source === "copilot") return path.basename(path.dirname(file));
  if (source === "opencode") return name.replace(/^opencode-/, "").replace(/\.events$/, "");
  const rollout = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(name);
  return rollout ? rollout[1] : name;
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 5) / 2);
  return `${text.slice(0, half)} […] ${text.slice(-half)}`;
}

function readChunk(file: string, start: number, length: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString("utf8");
  } finally { fs.closeSync(fd); }
}

function parseLines(text: string, dropFirst: boolean): Json[] {
  const lines = text.split("\n");
  if (dropFirst) lines.shift();
  const rows: Json[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { rows.push(obj(JSON.parse(line))); } catch { /* A partial or foreign line. */ }
  }
  return rows;
}

export function underDirs(cwd: string, dirs: string[]): boolean {
  const resolved = path.resolve(cwd);
  return dirs.some(dir => resolved === dir || resolved.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep));
}

/** One transcript trimmed to the window, or undefined when it is not the project's or has nothing in the window. */
export function readTranscript(source: DreamTranscriptSource, file: string, dirs: string[], from: number, to: number): DreamTranscript | undefined {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return undefined; }
  if (size === 0) return undefined;
  const whole = size <= TAIL_BYTES;
  const tailRows = parseLines(readChunk(file, whole ? 0 : size - TAIL_BYTES, whole ? size : TAIL_BYTES), !whole);
  let cwd: string | undefined;
  for (const row of whole ? tailRows : parseLines(readChunk(file, 0, Math.min(HEAD_BYTES, size)), false)) {
    cwd = cwdOf(row, source);
    if (cwd) break;
  }
  if (!cwd) for (const row of tailRows) { cwd = cwdOf(row, source); if (cwd) break; }
  if (!cwd || !underDirs(cwd, dirs)) return undefined;

  const lines: string[] = [];
  let turn = 0, first: number | undefined, last: number | undefined;
  let pendingTools: string[] = [];
  const flushTools = () => {
    if (!pendingTools.length) return;
    const counts = new Map<string, number>();
    for (const name of pendingTools) counts.set(name, (counts.get(name) ?? 0) + 1);
    lines.push(`[t${turn}] tools: ${[...counts].map(([name, n]) => n > 1 ? `${name}×${n}` : name).join(", ")}`);
    pendingTools = [];
  };
  for (const row of tailRows) {
    const at = timestampOf(row, source);
    if (at !== undefined && (at < from || at > to)) continue;
    const message = messageOf(row, source);
    const tools = toolsOf(row, source);
    if (!message && !tools.length) continue;
    if (at !== undefined) { first ??= at; last = at; }
    if (message) {
      flushTools();
      if (message.role === "user") turn++;
      lines.push(`[t${turn}] ${message.role}: ${cap(redactSecretsForLog(message.text).replace(/\s*\n\s*/g, " ⏎ "), MESSAGE_MAX_CHARS)}`);
    }
    pendingTools.push(...tools);
  }
  flushTools();
  if (!lines.length || first === undefined || last === undefined) return undefined;
  return { source, session: sessionOf(source, file), cwd, first: new Date(first).toISOString(), last: new Date(last).toISOString(), turns: turn, text: lines.join("\n") };
}

function transcriptFiles(roots: DreamTranscriptRoot[], from: number): Array<{ source: DreamTranscriptSource; file: string; mtime: number }> {
  const found: Array<{ source: DreamTranscriptSource; file: string; mtime: number }> = [];
  const walk = (source: DreamTranscriptSource, dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (depth > 0) walk(source, full, depth - 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (source === "copilot" && entry.name !== "events.jsonl") continue;
      if (source === "opencode" && !entry.name.startsWith("opencode-")) continue;
      try {
        const mtime = fs.statSync(full).mtimeMs;
        // Modified before the window opened: nothing in it can be in the window.
        if (mtime >= from) found.push({ source, file: full, mtime });
      } catch { /* Gone since listing. */ }
    }
  };
  for (const root of roots) walk(root.source, root.root, root.maxDepth);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
}

/** Fit transcripts into the budget, newest session first; the oldest turns of a session are trimmed before it is dropped. */
export function budgetTranscripts(all: DreamTranscript[], budgetChars: number): { kept: DreamTranscript[]; chars: number; dropped: number } {
  const sorted = [...all].sort((a, b) => b.last.localeCompare(a.last));
  const kept: DreamTranscript[] = [];
  let used = 0, dropped = 0;
  for (const transcript of sorted) {
    const remaining = budgetChars - used;
    const overhead = 200;
    if (transcript.text.length + overhead <= remaining) {
      kept.push(transcript); used += transcript.text.length + overhead; continue;
    }
    if (remaining < MIN_PARTIAL_CHARS) { dropped++; continue; }
    const lines = transcript.text.split("\n");
    const tail: string[] = [];
    let size = overhead + 40;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (size + lines[i].length + 1 > remaining) break;
      tail.unshift(lines[i]); size += lines[i].length + 1;
    }
    if (!tail.length) { dropped++; continue; }
    kept.push({ ...transcript, text: `[earlier turns trimmed]\n${tail.join("\n")}`, trimmed: true });
    used += size;
  }
  return { kept, chars: kept.reduce((sum, t) => sum + t.text.length, 0), dropped };
}

// ── Memory and repo ──────────────────────────────────────────────────────────

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
}

function defaultGitLog(dir: string): string[] {
  try { return git(dir, ["log", `-${GIT_LOG_COUNT}`, "--date=short", "--format=%h %ad %s"]).split("\n").filter(Boolean); } catch { return []; }
}

/** The repo's own folder plus its other worktrees, where agents also work on this project. */
export function projectDirsFor(phrenPath: string, project: string): string[] {
  const source = getProjectSourcePath(phrenPath, project);
  if (!source) return [];
  const dirs = new Set([source]);
  try {
    for (const line of git(source, ["worktree", "list", "--porcelain"]).split("\n")) {
      if (line.startsWith("worktree ")) dirs.add(path.resolve(line.slice("worktree ".length).trim()));
    }
  } catch { /* Not a git repo, or git missing. */ }
  return [...dirs];
}

export function readTruths(phrenPath: string, project: string): string[] {
  const file = storeAwareProjectPath(phrenPath, project, "truths.md") ?? path.join(phrenPath, project, "truths.md");
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(line => line.startsWith("- "))
      .map(line => line.slice(2).replace(/\s*_\(added \d{4}-\d{2}-\d{2}\)_\s*$/, "").trim()).filter(Boolean);
  } catch { return []; }
}

function readPages(projectDir: string): DreamPageInput[] {
  const dir = path.join(projectDir, "reference", "pages");
  let names: string[];
  try { names = fs.readdirSync(dir).filter(name => name.endsWith(".md")).sort(); } catch { return []; }
  return names.map(name => {
    let head = "";
    try { head = readChunk(path.join(dir, name), 0, 2048); } catch { /* unreadable */ }
    const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(head)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
    return { slug: name.slice(0, -3), title: field("title"), summary: field("summary") };
  });
}

export function journalFile(phrenPath: string, project: string): string {
  return path.join(projectStoreDir(phrenPath, project), "dreams", "journal.md");
}

function readJournalTail(phrenPath: string, project: string): string[] {
  try { return fs.readFileSync(journalFile(phrenPath, project), "utf8").split("\n").filter(line => line.startsWith("- ")).slice(-JOURNAL_LINES); } catch { return []; }
}

const ACTIVE_STATUSES = new Set(["active", "contradicted", "stale", "invalid_citation"]);

export async function collect(phrenPath: string, project: string, options: CollectOptions): Promise<DreamInputs> {
  const from = options.from.getTime(), to = options.to.getTime();
  const dirs = (options.projectDirs ?? projectDirsFor(phrenPath, project)).map(dir => path.resolve(dir));
  const transcripts: DreamTranscript[] = [];
  if (dirs.length) {
    for (const { source, file } of transcriptFiles(options.roots ?? defaultTranscriptRoots(), from)) {
      const transcript = readTranscript(source, file, dirs, from, to);
      if (transcript) transcripts.push(transcript);
    }
  }
  const fitted = budgetTranscripts(transcripts, options.budgetChars ?? DEFAULT_TRANSCRIPT_BUDGET_CHARS);

  const read = readFindings(phrenPath, project);
  const findings: DreamFindingInput[] = read.ok
    ? read.data.filter(item => item.stableId && ACTIVE_STATUSES.has(item.status))
      .map(item => ({ fid: item.stableId!, date: item.date, text: item.text, status: item.status, ...(item.citation ? { citation: item.citation } : {}) }))
    : [];
  const topics = readProjectTopics(phrenPath, project).topics.map(topic => ({ slug: topic.slug, label: topic.label }));
  const repoDir = dirs[0];
  const gitLog = options.gitLog === false || !repoDir ? [] : (options.gitLog ?? defaultGitLog)(repoDir);
  const budgetBytes = Math.round((options.injectBudgetKB ?? 8) * 1024);
  const sizeBytes = await injectedSize(phrenPath, project);
  const candidates = sizeBytes > budgetBytes ? await overBudget(phrenPath, project, options.injectBudgetKB ?? 8) : [];

  return {
    project,
    from: options.from.toISOString(),
    to: options.to.toISOString(),
    ...(repoDir ? { repoDir } : {}),
    transcripts: fitted.kept,
    transcriptChars: fitted.chars,
    transcriptsDropped: fitted.dropped,
    findings,
    truths: readTruths(phrenPath, project),
    topics,
    pages: readPages(projectStoreDir(phrenPath, project)),
    gitLog,
    journal: readJournalTail(phrenPath, project),
    budget: { sizeBytes, budgetBytes, over: sizeBytes > budgetBytes, candidates },
  };
}
