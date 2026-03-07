import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  addBacklogItem,
  addLearning,
  addProjectToProfile,
  approveMemoryQueueItem,
  BacklogItem,
  completeBacklogItem,
  editMemoryQueueItem,
  listMachines,
  listProfiles,
  listProjectCards,
  loadShellState,
  pinBacklogItem,
  QueueItem,
  readBacklog,
  readLearnings,
  readMemoryQueue,
  readRuntimeHealth,
  rejectMemoryQueueItem,
  removeLearning,
  removeProjectFromProfile,
  resetShellState,
  saveShellState,
  setMachineProfile,
  ShellState,
  tidyBacklogDone,
  unpinBacklogItem,
  updateBacklogItem,
  workNextBacklogItem,
} from "./data-access.js";
import { runDoctor, runLink } from "./link.js";
import { runCortexUpdate } from "./update.js";
import { type CortexResult, EXEC_TIMEOUT_MS } from "./shared.js";

function resultMsg(r: CortexResult<string>): string {
  return r.ok ? r.data : r.error;
}

// ── ANSI utilities ──────────────────────────────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

const style = {
  bold:        (s: string) => `${ESC}1m${s}${RESET}`,
  dim:         (s: string) => `${ESC}2m${s}${RESET}`,
  italic:      (s: string) => `${ESC}3m${s}${RESET}`,
  cyan:        (s: string) => `${ESC}36m${s}${RESET}`,
  green:       (s: string) => `${ESC}32m${s}${RESET}`,
  yellow:      (s: string) => `${ESC}33m${s}${RESET}`,
  red:         (s: string) => `${ESC}31m${s}${RESET}`,
  magenta:     (s: string) => `${ESC}35m${s}${RESET}`,
  blue:        (s: string) => `${ESC}34m${s}${RESET}`,
  white:       (s: string) => `${ESC}37m${s}${RESET}`,
  gray:        (s: string) => `${ESC}90m${s}${RESET}`,
  boldCyan:    (s: string) => `${ESC}1;36m${s}${RESET}`,
  boldGreen:   (s: string) => `${ESC}1;32m${s}${RESET}`,
  boldYellow:  (s: string) => `${ESC}1;33m${s}${RESET}`,
  boldRed:     (s: string) => `${ESC}1;31m${s}${RESET}`,
  boldMagenta: (s: string) => `${ESC}1;35m${s}${RESET}`,
  boldBlue:    (s: string) => `${ESC}1;34m${s}${RESET}`,
  dimItalic:   (s: string) => `${ESC}2;3m${s}${RESET}`,
  invert:      (s: string) => `${ESC}7m${s}${RESET}`,
};

function badge(label: string, colorFn: (s: string) => string): string {
  return colorFn(`[${label}]`);
}

function separator(width = 50): string {
  return style.dim("─".repeat(width));
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function padToWidth(s: string, width: number): string {
  const visible = stripAnsi(s);
  if (visible.length > width) return visible.slice(0, width - 1) + "…";
  return s + " ".repeat(width - visible.length);
}

// ANSI handling: `s` may contain ANSI escape codes (styled text from the style.*
// helpers). We measure visible width via stripAnsi, then if truncation is needed we
// slice the *plain* text (discarding ANSI codes) to avoid cutting mid-escape. A
// trailing reset is appended to guard against any residual SGR state from earlier
// output on the same terminal line.
function truncateLine(s: string, cols: number): string {
  const visible = stripAnsi(s);
  if (visible.length <= cols) return s;
  return visible.slice(0, cols - 1) + "…" + "\x1b[0m";
}

// ── Tab layout ──────────────────────────────────────────────────────────────

// Projects is level 0 (the home screen); these sub-views are level 1 (drill-down into a project)
const SUB_VIEWS = ["Backlog", "Learnings", "Memory Queue", "Health"] as const;
const TAB_ICONS: Record<string, string> = {
  Projects:      "◉",
  Backlog:       "▤",
  Learnings:     "✦",
  "Memory Queue": "◈",
  Health:        "♡",
};

// ── Line-based viewport: edge-triggered scroll (stable, no jumpiness) ─────────

function lineViewport(
  allLines: string[],
  cursorFirstLine: number,
  cursorLastLine: number,
  height: number,
  prevStart: number,
): { lines: string[]; scrollStart: number } {
  if (allLines.length === 0 || height <= 0) return { lines: [], scrollStart: 0 };
  if (allLines.length <= height) return { lines: allLines.slice(), scrollStart: 0 };

  const first = Math.max(0, Math.min(cursorFirstLine, allLines.length - 1));
  const last  = Math.max(first, Math.min(cursorLastLine, allLines.length - 1));
  let start   = Math.max(0, prevStart);

  // Scroll up if cursor is above viewport
  if (first < start) start = first;
  // Scroll down if cursor is below viewport
  if (last >= start + height) start = last - height + 1;
  // Clamp
  start = Math.min(start, Math.max(0, allLines.length - height));

  return { lines: allLines.slice(start, start + height), scrollStart: start };
}

// ── Help text ────────────────────────────────────────────────────────────────

function shellHelpText(): string {
  const hdr = (s: string) => style.bold(s);
  const k   = (s: string) => style.boldCyan(s);
  const d   = (s: string) => style.dim(s);
  const cmd = (s: string) => style.cyan(s);

  return [
    "",
    hdr("Navigation"),
    `  ${k("← →")} ${d("switch tabs")}    ${k("↑ ↓")} ${d("move cursor")}    ${k("↵")} ${d("activate")}    ${k("q")} ${d("quit")}`,
    `  ${k("/")} ${d("filter")}    ${k(":")} ${d("command palette")}    ${k("Esc")} ${d("cancel / clear filter")}    ${k("?")} ${d("toggle this help")}`,
    "",
    hdr("View-specific keys"),
    `  ${style.bold("Projects")}     ${k("↵")} ${d("open project as context")}`,
    `  ${style.bold("Backlog")}      ${k("a")} ${d("add task")}  ${k("d")} ${d("toggle active/queue")}  ${k("↵")} ${d("mark complete")}`,
    `  ${style.bold("Learnings")}    ${k("a")} ${d("add learning")}  ${k("d")} ${d("delete selected")}`,
    `  ${style.bold("Memory Queue")} ${k("a")} ${d("approve")}  ${k("r")} ${d("reject")}  ${k("e")} ${d("edit")}`,
    "",
    hdr("Palette commands  (:cmd)"),
    `  ${cmd(":open <project>")}                             ${d("set active project context")}`,
    `  ${cmd(":add <task>")}                                 ${d("add backlog item")}`,
    `  ${cmd(":complete <id|match>")}                        ${d("mark done")}`,
    `  ${cmd(":move <id|match> <active|queue|done>")}        ${d("move item")}`,
    `  ${cmd(":reprioritize <id|match> <high|medium|low>")}`,
    `  ${cmd(":context <id|match> <text>")}`,
    `  ${cmd(":pin <id>")}  ${cmd(":unpin <id>")}  ${cmd(":work next")}  ${cmd(":tidy [keep]")}`,
    `  ${cmd(":learn add <text>")}  ${cmd(":learn remove <id|match>")}`,
    `  ${cmd(":mq approve|reject|edit <id>")}`,
    `  ${cmd(":govern")}  ${cmd(":consolidate")}  ${cmd(":search <query>")}`,
    `  ${cmd(":undo")}  ${cmd(":diff")}  ${cmd(":conflicts")}  ${cmd(":reset")}`,
    `  ${cmd(":run fix")}  ${cmd(":relink")}  ${cmd(":rerun hooks")}  ${cmd(":update")}`,
    `  ${cmd(":machines")}`,
  ].join("\n");
}

// ── Infrastructure ───────────────────────────────────────────────────────────

function resolveEntryScript(): string {
  const current = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(current), "index.js");
}

async function defaultRunHooks(cortexPath: string): Promise<string> {
  const entry = resolveEntryScript();
  execFileSync(process.execPath, [entry, "hook-session-start"], {
    cwd: cortexPath,
    stdio: "ignore",
    timeout: EXEC_TIMEOUT_MS,
  });
  execFileSync(process.execPath, [entry, "hook-stop"], {
    cwd: cortexPath,
    stdio: "ignore",
    timeout: EXEC_TIMEOUT_MS,
  });
  return "Lifecycle hooks rerun (session-start + stop).";
}

async function defaultRunUpdate(): Promise<string> {
  return runCortexUpdate();
}

async function defaultRunRelink(cortexPath: string): Promise<string> {
  await runLink(cortexPath, { register: false, allTools: true });
  return "Relink completed for detected tools.";
}

// ── Types ────────────────────────────────────────────────────────────────────

interface UndoEntry {
  label: string;
  file: string;
  content: string;
}

const MAX_UNDO_STACK = 10;

export type ShellView = ShellState["view"];

export interface ShellDeps {
  runDoctor: typeof runDoctor;
  runRelink: (cortexPath: string) => Promise<string>;
  runHooks:  (cortexPath: string) => Promise<string>;
  runUpdate: () => Promise<string>;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface DoctorResultLike {
  ok: boolean;
  machine?: string;
  profile?: string;
  checks: DoctorCheck[];
}

// ── Utility helpers ──────────────────────────────────────────────────────────

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function tokenize(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? null : ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) { out.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function backlogsByFilter(items: BacklogItem[], filter: string): BacklogItem[] {
  const needle = filter.toLowerCase().trim();
  if (!needle) return items;
  return items.filter((item) =>
    `${item.id} ${item.line} ${item.context || ""}`.toLowerCase().includes(needle),
  );
}

function queueByFilter(items: QueueItem[], filter: string): QueueItem[] {
  const needle = filter.toLowerCase().trim();
  if (!needle) return items;
  return items.filter((item) =>
    `${item.id} ${item.section} ${item.text}`.toLowerCase().includes(needle),
  );
}


function expandIds(input: string): string[] {
  const parts = input.split(",").map((s) => s.trim()).filter(Boolean);
  const result: string[] = [];
  for (const part of parts) {
    const rangeMatch = part.match(/^([AQD])(\d+)-\1?(\d+)$/i);
    if (rangeMatch) {
      const prefix = rangeMatch[1].toUpperCase();
      const start  = Number.parseInt(rangeMatch[2], 10);
      const end    = Number.parseInt(rangeMatch[3], 10);
      for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
        result.push(`${prefix}${i}`);
      }
    } else {
      result.push(part);
    }
  }
  return result;
}

function normalizeSection(sectionRaw: string): "Active" | "Queue" | "Done" | null {
  const normalized = sectionRaw.toLowerCase();
  if (["active", "a"].includes(normalized)) return "Active";
  if (["queue", "queued", "q"].includes(normalized)) return "Queue";
  if (["done", "d"].includes(normalized)) return "Done";
  return null;
}

// ── Shell class ──────────────────────────────────────────────────────────────

export class CortexShell {
  private state: ShellState;
  private message = `  ${style.boldCyan("←→")} ${style.dim("tabs")}  ${style.boldCyan("↑↓")} ${style.dim("move")}  ${style.boldCyan("↵")} ${style.dim("activate")}  ${style.boldCyan("?")} ${style.dim("help")}`;
  private healthCache?: { at: number; result: DoctorResultLike };
  private showHelp = false;
  private pendingConfirm?: { label: string; action: () => void };
  private undoStack: UndoEntry[] = [];

  // ── Navigation state ──────────────────────────────────────────────────────
  private navMode: "navigate" | "input" = "navigate";
  private inputBuf  = "";
  private inputCtx  = ""; // 'filter' | 'command' | 'add' | 'learn-add' | 'mq-edit'
  private inputMqId = ""; // id being edited in mq-edit mode
  private cursorMap: Partial<Record<string, number>> = {};
  private viewScrollMap: Partial<Record<string, number>> = {}; // stable scroll offset per view
  private healthLineCount = 0; // cached line count for Health view cursor navigation
  private _subsectionsCache: { project: string; map: Map<string, string> } | null = null;

  get mode(): "navigate" | "input" { return this.navMode; }
  get inputBuffer(): string         { return this.inputBuf; }

  constructor(
    private readonly cortexPath: string,
    private readonly profile: string,
    private readonly deps: ShellDeps = {
      runDoctor,
      runRelink: defaultRunRelink,
      runHooks:  defaultRunHooks,
      runUpdate: defaultRunUpdate,
    },
  ) {
    this.state = loadShellState(cortexPath);
    const cards = listProjectCards(cortexPath, profile);
    // Always start at Projects view so user picks their project each session
    this.state.view = "Projects";
    if (!this.state.project && cards.length > 0) this.state.project = cards[0].name;
    this.message = this.state.project
      ? `  Open ${style.boldCyan(this.state.project)} with ${style.boldCyan("↵")} · ${style.boldCyan("?")} for help`
      : `  Press ${style.boldCyan("?")} for help`;
  }

  close(): void {
    saveShellState(this.cortexPath, this.state);
  }

  private setMessage(msg: string): void {
    this.message = msg;
  }

  private confirmThen(label: string, action: () => void): void {
    this.pendingConfirm = { label, action };
    this.setMessage(`${label}  ${style.boldCyan("y")} ${style.dim("confirm")}  ${style.boldCyan("n")} ${style.dim("cancel")}`);
  }

  private setView(view: ShellView): void {
    this.state.view = view;
    // Reset scroll when entering a view fresh (cursor is already tracked separately)
    this.viewScrollMap[view] = 0;
    saveShellState(this.cortexPath, this.state);
  }

  private setFilter(value: string): void {
    this.state.filter = value.trim() || undefined;
    saveShellState(this.cortexPath, this.state);
    this.setMessage(this.state.filter
      ? `  Filter: ${style.yellow(this.state.filter)}`
      : "  Filter cleared.");
  }

  private snapshotForUndo(label: string, file: string): void {
    try {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, "utf8");
        this.undoStack.push({ label, file, content });
        if (this.undoStack.length > MAX_UNDO_STACK) this.undoStack.shift();
      }
    } catch { /* best effort */ }
  }

  private popUndo(): string {
    const entry = this.undoStack.pop();
    if (!entry) return "Nothing to undo.";
    try {
      fs.writeFileSync(entry.file, entry.content);
      return `Undid: ${entry.label}`;
    } catch (err: any) {
      return `Undo failed: ${err?.message || err}`;
    }
  }

  private ensureProjectSelected(): string | null {
    const selected = this.state.project;
    if (!selected) {
      this.setMessage("No project selected — open one from Projects view (↵) or use :open <project>");
      return null;
    }
    return selected;
  }

  // ── Cursor management ─────────────────────────────────────────────────────

  private currentCursor(): number {
    return this.cursorMap[this.state.view] ?? 0;
  }

  private setCursor(n: number): void {
    const count = this.listItemCount();
    this.cursorMap[this.state.view] = count > 0 ? Math.max(0, Math.min(n, count - 1)) : 0;
  }

  private moveCursor(delta: number): void {
    this.setCursor(this.currentCursor() + delta);
  }

  private currentScroll(): number {
    return this.viewScrollMap[this.state.view] ?? 0;
  }

  private setScroll(n: number): void {
    this.viewScrollMap[this.state.view] = Math.max(0, n);
  }

  private listItemCount(): number {
    return this.getListItems().length;
  }

  private getListItems(): { id?: string; name?: string; text?: string; line?: string }[] {
    switch (this.state.view) {
      case "Projects": {
        const cards = listProjectCards(this.cortexPath, this.profile);
        return this.state.filter
          ? cards.filter((c) =>
              `${c.name} ${c.summary} ${c.docs.join(" ")}`.toLowerCase().includes(this.state.filter!.toLowerCase()),
            )
          : cards;
      }
      case "Backlog": {
        const project = this.state.project;
        if (!project) return [];
        const result = readBacklog(this.cortexPath, project);
        if (!result.ok) return [];
        // Cursor only navigates Active + Queue (not Done)
        const active = this.state.filter
          ? backlogsByFilter(result.data.items.Active, this.state.filter)
          : result.data.items.Active;
        const queue = this.state.filter
          ? backlogsByFilter(result.data.items.Queue, this.state.filter)
          : result.data.items.Queue;
        return [...active, ...queue];
      }
      case "Learnings": {
        const project = this.state.project;
        if (!project) return [];
        const result = readLearnings(this.cortexPath, project);
        if (!result.ok) return [];
        return this.state.filter
          ? result.data.filter((i) =>
              `${i.id} ${i.date} ${i.text}`.toLowerCase().includes(this.state.filter!.toLowerCase()),
            )
          : result.data;
      }
      case "Memory Queue": {
        const project = this.state.project;
        if (!project) return [];
        const result = readMemoryQueue(this.cortexPath, project);
        if (!result.ok) return [];
        return this.state.filter ? queueByFilter(result.data, this.state.filter) : result.data;
      }
      case "Health":
        // Health uses cursor as line scroll position; return dummy items for cursor clamping
        return Array.from({ length: Math.max(1, this.healthLineCount) }, (_, i) => ({ id: String(i) }));
      default:
        return [];
    }
  }

  // ── Activation (Enter key) ────────────────────────────────────────────────

  private async activateSelected(): Promise<void> {
    const cursor = this.currentCursor();
    const items  = this.getListItems() as any[];
    const item   = items[cursor];
    if (!item) return;

    switch (this.state.view) {
      case "Projects":
        if (item.name) {
          this.state.project = item.name;
          saveShellState(this.cortexPath, this.state);
          this.setView("Backlog");
          this.setMessage(`  ${style.green("●")} ${style.boldCyan(item.name)}`);
        }
        break;

      case "Backlog":
        if (item.id) {
          const project = this.ensureProjectSelected();
          if (!project) return;
          const file = path.join(this.cortexPath, project, "backlog.md");
          this.confirmThen(`Complete ${style.dim(item.id)} "${item.line}"?`, () => {
            this.snapshotForUndo(`complete ${item.id}`, file);
            const r = completeBacklogItem(this.cortexPath, project, item.id);
            this.invalidateSubsectionsCache();
            this.setMessage(`  ${resultMsg(r)}`);
            this.setCursor(Math.max(0, cursor - 1));
          });
        }
        break;

      case "Learnings":
        if (item.text) {
          // Enter previews the learning — use 'd' or Delete key to remove
          this.setMessage(`  ${style.dim(item.id ?? "")}  ${item.text}`);
        }
        break;

      case "Memory Queue":
        if (item.text) {
          // Enter previews the item — use 'a' to approve, 'r' to reject
          this.setMessage(`  ${style.dim(item.id ?? "")}  ${item.text}  ${style.dim("[ a approve · r reject ]")}`);
        }
        break;
    }
  }

  // ── View-specific action keys ─────────────────────────────────────────────

  private async doViewAction(key: string): Promise<void> {
    const cursor  = this.currentCursor();
    const items   = this.getListItems() as any[];
    const item    = items[cursor];
    const project = this.state.project;

    switch (this.state.view) {
      case "Backlog":
        if (key === "a") {
          this.startInput("add", "");
        } else if (key === "d" && item?.id) {
          if (!project) { this.setMessage("Select a project first."); return; }
          const file = path.join(this.cortexPath, project, "backlog.md");
          // Toggle: if Active → Queue, if Queue → Active
          const backlogResult = readBacklog(this.cortexPath, project);
          const isActive = backlogResult.ok && backlogResult.data.items.Active.some((i: BacklogItem) => i.id === item.id);
          const targetSection = isActive ? "Queue" : "Active";
          this.snapshotForUndo(`move ${item.id} → ${targetSection.toLowerCase()}`, file);
          const r = updateBacklogItem(this.cortexPath, project, item.id, { section: targetSection });
          this.invalidateSubsectionsCache();
          this.setMessage(`  ${resultMsg(r)}`);
        }
        break;

      case "Learnings":
        if (key === "a") {
          this.startInput("learn-add", "");
        } else if ((key === "d" || key === "\x7f") && item?.text) {
          if (!project) { this.setMessage("Select a project first."); return; }
          this.confirmThen(`Delete learning ${style.dim(item.id)}?`, () => {
            const file = path.join(this.cortexPath, project!, "LEARNINGS.md");
            this.snapshotForUndo(`remove learning ${item.id}`, file);
            const r = removeLearning(this.cortexPath, project!, item.text);
            this.setMessage(`  ${resultMsg(r)}`);
            this.setCursor(Math.max(0, cursor - 1));
          });
        }
        break;

      case "Memory Queue":
        if (key === "a" && item?.id) {
          if (!project) { this.setMessage("Select a project first."); return; }
          this.confirmThen(`Approve ${style.dim(item.id)} "${item.text}"?`, () => {
            const r = approveMemoryQueueItem(this.cortexPath, project!, item.id);
            this.setMessage(`  ${resultMsg(r)}`);
            this.setCursor(Math.max(0, cursor - 1));
          });
        } else if (key === "r" && item?.id) {
          if (!project) { this.setMessage("Select a project first."); return; }
          this.confirmThen(`Reject ${style.dim(item.id)} "${item.text}"?`, () => {
            const r = rejectMemoryQueueItem(this.cortexPath, project!, item.id);
            this.setMessage(`  ${resultMsg(r)}`);
            this.setCursor(Math.max(0, cursor - 1));
          });
        } else if (key === "e" && item?.id) {
          this.inputMqId = item.id;
          this.startInput("mq-edit", item.text || "");
        }
        break;
    }
  }

  // ── Input mode ────────────────────────────────────────────────────────────

  private startInput(ctx: string, initial: string): void {
    this.navMode  = "input";
    this.inputCtx = ctx;
    this.inputBuf = initial;
  }

  private cancelInput(): void {
    this.navMode  = "navigate";
    this.inputBuf = "";
    this.inputCtx = "";
    this.setMessage("  Cancelled.");
  }

  private async submitInput(): Promise<void> {
    const buf = this.inputBuf;
    const ctx = this.inputCtx;
    this.navMode  = "navigate";
    this.inputBuf = "";
    this.inputCtx = "";

    if (!buf.trim() && ctx !== "command") {
      this.setMessage("  Nothing entered.");
      return;
    }

    switch (ctx) {
      case "filter":
        this.setFilter(buf);
        break;

      case "command":
        await this.executePalette(buf.startsWith(":") ? buf.slice(1) : buf);
        break;

      case "add": {
        const project = this.ensureProjectSelected();
        if (!project) return;
        const r = addBacklogItem(this.cortexPath, project, buf);
        this.setMessage(`  ${resultMsg(r)}`);
        break;
      }

      case "learn-add": {
        const project = this.ensureProjectSelected();
        if (!project) return;
        const r = addLearning(this.cortexPath, project, buf);
        this.setMessage(`  ${resultMsg(r)}`);
        break;
      }

      case "mq-edit": {
        const project = this.ensureProjectSelected();
        if (!project) return;
        const r = editMemoryQueueItem(this.cortexPath, project, this.inputMqId, buf);
        this.setMessage(`  ${resultMsg(r)}`);
        this.inputMqId = "";
        break;
      }
    }
  }

  // ── Tab switching ─────────────────────────────────────────────────────────

  private nextTab(): void {
    if (this.state.view === "Projects") return; // no left/right on project list
    const idx  = SUB_VIEWS.indexOf(this.state.view as typeof SUB_VIEWS[number]);
    const next = SUB_VIEWS[(idx + 1) % SUB_VIEWS.length];
    if (next) {
      if (next === "Health") this.healthCache = undefined;
      this.setView(next);
      this.setMessage(`  ${TAB_ICONS[next]} ${next}`);
    }
  }

  private prevTab(): void {
    if (this.state.view === "Projects") return; // no left/right on project list
    const idx  = SUB_VIEWS.indexOf(this.state.view as typeof SUB_VIEWS[number]);
    const prev = SUB_VIEWS[(idx - 1 + SUB_VIEWS.length) % SUB_VIEWS.length];
    if (prev) {
      if (prev === "Health") this.healthCache = undefined;
      this.setView(prev);
      this.setMessage(`  ${TAB_ICONS[prev]} ${prev}`);
    }
  }

  // ── Raw key handling ──────────────────────────────────────────────────────

  async handleRawKey(key: string): Promise<boolean> {
    // Ctrl-C / Ctrl-D always exit
    if (key === "\x03" || key === "\x04") return false;

    // Pending confirm: y/n only
    if (this.pendingConfirm) {
      const pending = this.pendingConfirm;
      this.pendingConfirm = undefined;
      if (key.toLowerCase() === "y") {
        pending.action();
      } else {
        this.setMessage("  Cancelled.");
      }
      return true;
    }

    // Any key dismisses help overlay
    if (this.showHelp) {
      this.showHelp = false;
      this.setMessage(`  ${style.boldCyan("←→")} ${style.dim("tabs")}  ${style.boldCyan("↑↓")} ${style.dim("move")}  ${style.boldCyan("↵")} ${style.dim("activate")}  ${style.boldCyan("?")} ${style.dim("help")}`);
      return true;
    }

    return this.navMode === "input"
      ? this.handleInputKey(key)
      : this.handleNavigateKey(key);
  }

  private showCursorPosition(): void {
    const count = this.listItemCount();
    if (count === 0) return;
    const cursor = this.currentCursor();
    const items  = this.getListItems() as any[];
    const item   = items[cursor];
    const label  = item?.name ?? item?.line ?? item?.text ?? "";
    const short  = label.length > 50 ? label.slice(0, 48) + "…" : label;
    this.setMessage(`  ${style.dim(`${cursor + 1} / ${count}`)}${short ? `  ${style.dimItalic(short)}` : ""}`);
  }

  private async handleNavigateKey(key: string): Promise<boolean> {
    // Arrow keys
    if (key === "\x1b[A") { this.moveCursor(-1);  this.showCursorPosition(); return true; } // up
    if (key === "\x1b[B") { this.moveCursor(1);   this.showCursorPosition(); return true; } // down
    if (key === "\x1b[D") { // left
      if (this.state.view === "Projects") { this.setMessage(`  ${style.dim("press ↵ to open a project first")}`); }
      else { this.prevTab(); }
      return true;
    }
    if (key === "\x1b[C") { // right
      if (this.state.view === "Projects") { this.setMessage(`  ${style.dim("press ↵ to open a project first")}`); }
      else { this.nextTab(); }
      return true;
    }

    // Page up / page down
    if (key === "\x1b[5~") { this.moveCursor(-10); this.showCursorPosition(); return true; }
    if (key === "\x1b[6~") { this.moveCursor(10);  this.showCursorPosition(); return true; }

    // Home / End
    if (key === "\x1b[H" || key === "\x1b[1~") { this.setCursor(0);                         this.showCursorPosition(); return true; }
    if (key === "\x1b[F" || key === "\x1b[4~") { this.setCursor(this.listItemCount() - 1);  this.showCursorPosition(); return true; }

    // Tab / Shift-Tab for view cycling
    if (key === "\t")     { this.nextTab(); return true; }
    if (key === "\x1b[Z") { this.prevTab(); return true; }

    // Quit
    if (key === "q" || key === "Q") return false;

    // Enter
    if (key === "\r" || key === "\n") {
      await this.activateSelected();
      return true;
    }

    // Help toggle
    if (key === "?") {
      this.showHelp = !this.showHelp;
      this.setMessage(this.showHelp
        ? "  Showing help — press any key to dismiss"
        : `  ${style.boldCyan("←→")} ${style.dim("tabs")}  ${style.boldCyan("↑↓")} ${style.dim("move")}  ${style.boldCyan("↵")} ${style.dim("activate")}  ${style.boldCyan("?")} ${style.dim("help")}`);
      return true;
    }

    // Filter
    if (key === "/") {
      this.startInput("filter", this.state.filter || "");
      return true;
    }

    // Command palette
    if (key === ":") {
      this.startInput("command", "");
      return true;
    }

    // Escape: clear filter → back to Projects → quit hint
    if (key === "\x1b") {
      if (this.state.filter) {
        this.setFilter("");
      } else if (this.state.view !== "Projects") {
        this.setView("Projects");
        this.setMessage(`  ${TAB_ICONS.Projects} ${style.dim("select a project")}`);
      } else {
        this.setMessage(`  ${style.dim("press")} ${style.boldCyan("q")} ${style.dim("to quit")}`);
      }
      return true;
    }

    // Single-letter view shortcuts (p goes home; b/l/m/h need a project)
    if (key === "p") { this.setView("Projects");     this.setMessage(`  ${TAB_ICONS.Projects} Projects`);          return true; }
    if (key === "b") {
      if (!this.state.project) { this.setMessage(style.dim("  Select a project first (↵)")); return true; }
      this.setView("Backlog");      this.setMessage(`  ${TAB_ICONS.Backlog} Backlog`);            return true;
    }
    if (key === "l") {
      if (!this.state.project) { this.setMessage(style.dim("  Select a project first (↵)")); return true; }
      this.setView("Learnings");    this.setMessage(`  ${TAB_ICONS.Learnings} Learnings`);        return true;
    }
    if (key === "m") {
      if (!this.state.project) { this.setMessage(style.dim("  Select a project first (↵)")); return true; }
      this.setView("Memory Queue"); this.setMessage(`  ${TAB_ICONS["Memory Queue"]} Memory Queue`); return true;
    }
    if (key === "h") {
      if (!this.state.project) { this.setMessage(style.dim("  Select a project first (↵)")); return true; }
      this.healthCache = undefined;
      this.setView("Health");
      this.setMessage(`  ${TAB_ICONS.Health} Health`);
      return true;
    }

    // View-specific action keys
    if (["a", "d", "r", "e", "\x7f"].includes(key)) {
      await this.doViewAction(key);
      return true;
    }

    return true;
  }

  private async handleInputKey(key: string): Promise<boolean> {
    if (key === "\x03") return false; // Ctrl-C

    if (key === "\x1b") {
      // Check if it's a lone Escape (not the start of an escape sequence)
      this.cancelInput();
      return true;
    }

    if (key === "\r" || key === "\n") {
      await this.submitInput();
      return true;
    }

    // Backspace
    if (key === "\x7f" || key === "\x08") {
      this.inputBuf = this.inputBuf.slice(0, -1);
      return true;
    }

    // Ignore escape sequences (arrow keys etc.) in input mode
    if (key.startsWith("\x1b[")) return true;

    // Printable characters
    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      this.inputBuf += key;
      return true;
    }

    return true;
  }

  // ── Tab bar ───────────────────────────────────────────────────────────────

  private renderTabBar(): string {
    const cols = process.stdout.columns || 80;

    if (this.state.view === "Projects") {
      // Level 0: just show Projects tab
      const label = `${TAB_ICONS.Projects} Projects`;
      const tabLine = ` ${style.boldCyan(label)} `;
      return `${tabLine}\n${separator(cols)}`;
    }

    // Level 1: show project name + sub-view tabs
    const projectTag = this.state.project
      ? `${style.cyan(this.state.project)} ${style.dim("›")} `
      : "";
    const tabs = SUB_VIEWS.map((v) => {
      const icon  = TAB_ICONS[v] || "";
      const label = `${icon} ${v}`;
      return v === this.state.view
        ? ` ${style.boldCyan(label)} `
        : ` ${style.dim(label)} `;
    });

    const tabLine = `  ${projectTag}${tabs.join(style.dim("│"))}`;
    return `${tabLine}\n${separator(cols)}`;
  }

  // ── Bottom bar ────────────────────────────────────────────────────────────

  private renderBottomBar(): string {
    const cols = process.stdout.columns || 80;
    const sep  = separator(cols);
    const dot  = style.dim("  ·  ");
    const k    = (s: string) => style.boldCyan(s);
    const d    = (s: string) => style.dim(s);

    if (this.navMode === "input") {
      const labels: Record<string, string> = {
        filter:      "filter",
        command:     "cmd",
        add:         "add task",
        "learn-add": "add learning",
        "mq-edit":   "edit Memory Queue item",
      };
      const label = labels[this.inputCtx] || this.inputCtx;
      return `${sep}\n  ${style.boldCyan(label + " ›")} ${this.inputBuf}${style.cyan("█")}`;
    }

    const viewHints: Record<string, string[]> = {
      Projects:      [`${k("↵")} ${d("open project")}`],
      Backlog:       [`${k("a")} ${d("add")}`, `${k("↵")} ${d("mark done")}`, `${k("d")} ${d("toggle active")}`],
      Learnings:     [`${k("a")} ${d("add")}`, `${k("d")} ${d("remove")}`],
      "Memory Queue":[`${k("a")} ${d("keep")}`, `${k("r")} ${d("discard")}`, `${k("e")} ${d("edit")}`],
      Health:        [`${k("↑↓")} ${d("scroll")}`],
      "Machines/Profiles": [`${k(":")} ${d(":machine map")}`, `${k(":")} ${d(":profile add-project")}`],
    };

    const extra = viewHints[this.state.view] ?? [];
    const isSubView = this.state.view !== "Projects";
    const nav   = isSubView
      ? [`${k("←→")} ${d("tabs")}`, `${k("↑↓")} ${d("move")}`, `${k("esc")} ${d("back")}`]
      : [`${k("↑↓")} ${d("move")}`];
    const tail  = [`${k("/")} ${d("filter")}`, `${k(":")} ${d("cmd")}`, `${k("?")} ${d("help")}`, `${k("q")} ${d("quit")}`];

    const hints = [...nav, ...extra, ...tail];
    return `${sep}\n  ${hints.join(dot)}`;
  }

  // ── Content height ────────────────────────────────────────────────────────

  private contentHeight(): number {
    const rows = process.stdout.rows || 24;
    // header(1) + tabbar+sep(2) + sep+message(2) + sep+bottombar(2) = 7
    return Math.max(4, rows - 7);
  }

  // ── View renderers ────────────────────────────────────────────────────────

  private renderProjectsView(cursor: number, height: number): string[] {
    const cols  = process.stdout.columns || 80;
    const cards = listProjectCards(this.cortexPath, this.profile);
    const filtered = this.state.filter
      ? cards.filter((c) =>
          `${c.name} ${c.summary} ${c.docs.join(" ")}`.toLowerCase().includes(this.state.filter!.toLowerCase()),
        )
      : cards;

    if (!filtered.length) {
      return [style.dim("  No projects in this profile.")];
    }

    // Phase 1: build ALL lines, tracking cursor item's line span
    const allLines: string[] = [];
    let cursorFirstLine = 0;
    let cursorLastLine  = 0;

    for (let absIdx = 0; absIdx < filtered.length; absIdx++) {
      const card       = filtered[absIdx];
      const isSelected = absIdx === cursor;
      if (isSelected) cursorFirstLine = allLines.length;
      const isActive   = card.name === this.state.project;

      const cursorChar = isSelected ? style.cyan("▶") : " ";
      const bullet     = isActive ? style.green("●") : style.dim("○");
      const nameStr    = isActive ? style.boldGreen(card.name) : style.bold(card.name);
      const docsStr    = style.dim(`[${card.docs.join(" · ") || "no docs"}]`);

      let nameRow    = `  ${cursorChar} ${bullet} ${nameStr}  ${docsStr}`;
      let summaryRow = `        ${style.dim(card.summary || "")}`;

      if (isSelected) {
        nameRow    = `\x1b[7m${padToWidth(nameRow, cols)}${RESET}`;
        summaryRow = `\x1b[7m${padToWidth(summaryRow, cols)}${RESET}`;
      }

      allLines.push(nameRow);
      allLines.push(summaryRow);
      if (isSelected) cursorLastLine = allLines.length - 1;
    }

    // Phase 2: stable edge-triggered scroll
    const usableHeight = Math.max(1, height - (allLines.length > height ? 1 : 0));
    const vp = lineViewport(allLines, cursorFirstLine, cursorLastLine, usableHeight, this.currentScroll());
    this.setScroll(vp.scrollStart);
    const lines = vp.lines;

    if (allLines.length > usableHeight) {
      const pct = filtered.length <= 1 ? 100 : Math.round((cursor / (filtered.length - 1)) * 100);
      lines.push(style.dim(`  ─── ${cursor + 1}/${filtered.length}  ${pct}%`));
    }

    return lines;
  }

  private sectionBullet(title: string): { bullet: string; colorFn: (s: string) => string } {
    switch (title) {
      case "Active": return { bullet: style.green("●"),  colorFn: style.boldGreen };
      case "Queue":  return { bullet: style.yellow("●"), colorFn: style.boldYellow };
      case "Done":   return { bullet: style.gray("●"),   colorFn: style.dim };
      default:       return { bullet: "●",               colorFn: style.bold };
    }
  }

  private parseSubsections(backlogPath: string, project: string): Map<string, string> {
    if (this._subsectionsCache?.project === project) return this._subsectionsCache.map;
    const map = new Map<string, string>();
    try {
      const raw = fs.readFileSync(backlogPath, "utf8");
      let currentSub = "";
      for (const line of raw.split("\n")) {
        const subMatch = line.match(/^###\s+(.+)/);
        if (subMatch) { currentSub = subMatch[1].trim(); continue; }
        if (line.match(/^##\s/)) { currentSub = ""; continue; }
        if (line.startsWith("- ")) {
          const body = line.replace(/^- \[[ x]\]\s*/, "").trim();
          if (currentSub && body) map.set(body, currentSub);
        }
      }
    } catch { /* best effort */ }
    this._subsectionsCache = { project, map };
    return map;
  }

  private invalidateSubsectionsCache(): void {
    this._subsectionsCache = null;
  }

  private renderBacklogView(cursor: number, height: number): string[] {
    const cols    = process.stdout.columns || 80;
    const project = this.state.project;
    if (!project) {
      return [style.dim("  No project selected — navigate to Projects (← →) and press ↵")];
    }

    const result = readBacklog(this.cortexPath, project);
    if (!result.ok) return [result.error];

    const parsed   = result.data;
    const warnings = parsed.issues.length
      ? [`  ${style.yellow("⚠")}  ${style.yellow(parsed.issues.join("; "))}`, ""]
      : [];

    const backlogFile  = path.join(this.cortexPath, project, "backlog.md");
    const subsections  = this.parseSubsections(backlogFile, project);

    const active = this.state.filter
      ? backlogsByFilter(parsed.items.Active, this.state.filter)
      : parsed.items.Active;
    const queue = this.state.filter
      ? backlogsByFilter(parsed.items.Queue, this.state.filter)
      : parsed.items.Queue;
    const done = this.state.filter
      ? backlogsByFilter(parsed.items.Done, this.state.filter)
      : parsed.items.Done;
    const flatItems = [...active, ...queue, ...done];

    if (!flatItems.length) {
      const hint = this.state.filter ? "  No items match the filter." : `  No backlog items. Press ${style.boldCyan("a")} to add one.`;
      return [...warnings, style.dim(hint)];
    }

    const activeStart = 0;
    const queueStart  = active.length;
    const doneStart   = active.length + queue.length;

    // Phase 1: build ALL lines, tracking cursor item's line span
    const allLines: string[] = [];
    let cursorFirstLine = 0;
    let cursorLastLine  = 0;
    let lastSection = "";
    let lastSub     = "";

    for (let absIdx = 0; absIdx < flatItems.length; absIdx++) {
      const item       = flatItems[absIdx];
      const isSelected = absIdx === cursor;
      const isDone     = absIdx >= doneStart;

      // Section header
      const section = absIdx < queueStart ? "Active" : absIdx < doneStart ? "Queue" : "Done";
      if (section !== lastSection) {
        lastSection = section;
        lastSub     = "";
        const { bullet, colorFn } = this.sectionBullet(section);
        allLines.push(`  ${bullet} ${colorFn(section)}`);
      }

      // Subsection header
      const sub = subsections.get(item.line) || "";
      if (sub && sub !== lastSub) {
        lastSub = sub;
        allLines.push(`    ${style.boldYellow(sub)}`);
      }

      if (isSelected) cursorFirstLine = allLines.length;

      const idStr   = style.dim(item.id);
      const pinTag  = item.pinned ? ` ${style.boldCyan("[pin]")}` : "";
      const prioTag = item.priority && !isDone
        ? ` ${item.priority === "high"
            ? style.boldRed(`[${item.priority}]`)
            : item.priority === "medium"
              ? style.yellow(`[${item.priority}]`)
              : style.dim(`[${item.priority}]`)}`
        : "";
      const check    = item.checked ? style.green("[✓]") : style.dim("[ ]");
      const lineText = isDone ? style.dim(item.line) : item.line;

      let row = `    ${idStr} ${check} ${lineText}${pinTag}${prioTag}`;
      if (isSelected && !isDone) row = `\x1b[7m${padToWidth(row, cols)}${RESET}`;
      else row = truncateLine(row, cols);
      allLines.push(row);

      if (item.context) {
        const ctx = `       ${style.dimItalic("→ " + item.context)}`;
        allLines.push(isSelected && !isDone ? `\x1b[7m${padToWidth(ctx, cols)}${RESET}` : truncateLine(ctx, cols));
      }

      if (isSelected) cursorLastLine = allLines.length - 1;
    }

    // Phase 2: stable edge-triggered scroll
    const usableHeight = Math.max(1, height - warnings.length - (allLines.length > height ? 1 : 0));
    const vp = lineViewport(allLines, cursorFirstLine, cursorLastLine, usableHeight, this.currentScroll());
    this.setScroll(vp.scrollStart);
    const lines: string[] = [...warnings, ...vp.lines];

    if (allLines.length > usableHeight) {
      const navigable = active.length + queue.length;
      const pct = navigable <= 1 ? 100 : Math.round((cursor / Math.max(navigable - 1, 1)) * 100);
      lines.push(style.dim(`  ─── ${cursor + 1}/${navigable}  ${pct}%`));
    }

    return lines;
  }

  private renderLearningsView(cursor: number, height: number): string[] {
    const cols    = process.stdout.columns || 80;
    const project = this.state.project;
    if (!project) return [style.dim("  No project selected.")];

    const result = readLearnings(this.cortexPath, project);
    if (!result.ok) return [result.error];

    const all = result.data;
    const filtered = this.state.filter
      ? all.filter((item) =>
          `${item.id} ${item.date} ${item.text}`.toLowerCase().includes(this.state.filter!.toLowerCase()),
        )
      : all;

    if (!filtered.length) {
      return [style.dim(`  No learnings yet. Press ${style.boldCyan("a")} to add one.`)];
    }

    // Phase 1: build ALL lines, tracking cursor item's line span
    const allLines: string[] = [];
    let cursorFirstLine = 0;
    let cursorLastLine  = 0;

    for (let absIdx = 0; absIdx < filtered.length; absIdx++) {
      const item       = filtered[absIdx];
      const isSelected = absIdx === cursor;

      if (isSelected) cursorFirstLine = allLines.length;

      const idStr   = style.dim(item.id.padEnd(4));
      const dateStr = style.dim(`[${item.date}]`);

      let row = `  ${idStr}  ${dateStr}  ${item.text}`;
      if (isSelected) row = `\x1b[7m${padToWidth(row, cols)}${RESET}`;
      else row = truncateLine(row, cols);
      allLines.push(row);

      if (item.citation) {
        const cite = `              ${style.italic(style.blue("↗ " + item.citation))}`;
        allLines.push(isSelected ? `\x1b[7m${padToWidth(cite, cols)}${RESET}` : truncateLine(cite, cols));
      }

      if (isSelected) cursorLastLine = allLines.length - 1;
    }

    // Phase 2: stable edge-triggered scroll
    const usableHeight = Math.max(1, height - (allLines.length > height ? 1 : 0));
    const vp = lineViewport(allLines, cursorFirstLine, cursorLastLine, usableHeight, this.currentScroll());
    this.setScroll(vp.scrollStart);

    if (allLines.length > usableHeight) {
      const pct = filtered.length <= 1 ? 100 : Math.round((cursor / (filtered.length - 1)) * 100);
      vp.lines.push(style.dim(`  ─── ${cursor + 1}/${filtered.length}  ${pct}%`));
    }

    return vp.lines;
  }

  private queueSectionBadge(section: string): string {
    switch (section.toLowerCase()) {
      case "review":    return badge(section, style.yellow);
      case "stale":     return badge(section, style.red);
      case "conflicts": return badge(section, style.magenta);
      default:          return badge(section, style.dim);
    }
  }

  private renderMemoryQueueView(cursor: number, height: number): string[] {
    const cols    = process.stdout.columns || 80;
    const project = this.state.project;
    if (!project) return [style.dim("  No project selected.")];

    const result = readMemoryQueue(this.cortexPath, project);
    if (!result.ok) return [result.error];

    const filtered = this.state.filter
      ? queueByFilter(result.data, this.state.filter)
      : result.data;

    if (!filtered.length) {
      return [style.dim("  No queued memory items. Run :govern to scan for stale entries.")];
    }

    // Phase 1: build ALL lines, tracking cursor item's line span
    const allLines: string[] = [];
    let cursorFirstLine = 0;
    let cursorLastLine  = 0;
    let currentSection = "";

    for (let absIdx = 0; absIdx < filtered.length; absIdx++) {
      const item       = filtered[absIdx];
      const isSelected = absIdx === cursor;

      if (item.section !== currentSection) {
        currentSection = item.section;
        allLines.push(`  ${this.queueSectionBadge(currentSection)} ${style.bold(currentSection)}`);
      }

      if (isSelected) cursorFirstLine = allLines.length;

      const riskBadge = item.risky ? badge("risk", style.boldRed) : badge("ok", style.green);
      const confStr   = item.confidence !== undefined
        ? ` ${style.dim("conf=")}${
            item.confidence >= 0.8 ? style.green(item.confidence.toFixed(2))
            : item.confidence >= 0.6 ? style.yellow(item.confidence.toFixed(2))
            : style.red(item.confidence.toFixed(2))}`
        : "";

      let metaRow = `    ${style.dim(item.id)}  ${riskBadge}  ${style.dim(`[${item.date}]`)}${confStr}`;
      let textRow = `      ${item.text}`;

      if (isSelected) {
        metaRow = `\x1b[7m${padToWidth(metaRow, cols)}${RESET}`;
        textRow = `\x1b[7m${padToWidth(textRow, cols)}${RESET}`;
      } else {
        metaRow = truncateLine(metaRow, cols);
        textRow = truncateLine(textRow, cols);
      }

      allLines.push(metaRow);
      allLines.push(textRow);

      if (isSelected) cursorLastLine = allLines.length - 1;
    }

    // Phase 2: stable edge-triggered scroll
    const usableHeight = Math.max(1, height - (allLines.length > height ? 1 : 0));
    const vp = lineViewport(allLines, cursorFirstLine, cursorLastLine, usableHeight, this.currentScroll());
    this.setScroll(vp.scrollStart);

    if (allLines.length > usableHeight) {
      const pct = filtered.length <= 1 ? 100 : Math.round((cursor / (filtered.length - 1)) * 100);
      vp.lines.push(style.dim(`  ─── ${cursor + 1}/${filtered.length}  ${pct}%`));
    }

    return vp.lines;
  }

  private renderMachinesView(): string[] {
    const machines = listMachines(this.cortexPath);
    const profiles = listProfiles(this.cortexPath);
    const lines: string[] = [];

    lines.push(style.bold("  Machines"));
    if (!machines.ok) {
      lines.push(`    ${style.dim(machines.error)}`);
    } else {
      const entries = Object.entries(machines.data);
      if (!entries.length) lines.push(`    ${style.dim("(none)")}`);
      for (const [machine, prof] of entries) {
        lines.push(`    ${style.bold(machine)} ${style.dim("→")} ${style.cyan(prof as string)}`);
      }
    }

    lines.push("", style.bold("  Profiles"));
    if (!profiles.ok) {
      lines.push(`    ${style.dim(profiles.error)}`);
    } else {
      if (!profiles.data.length) lines.push(`    ${style.dim("(none)")}`);
      for (const prof of profiles.data) {
        lines.push(`    ${style.cyan(prof.name)}: ${prof.projects.join(", ") || style.dim("(no projects)")}`);
      }
    }

    lines.push(
      "",
      `  ${style.dim(":machine map <hostname> <profile>")}`,
      `  ${style.dim(":profile add-project|remove-project <profile> <project>")}`,
    );

    return lines;
  }

  private async doctorSnapshot(): Promise<DoctorResultLike> {
    if (this.healthCache && Date.now() - this.healthCache.at < 10_000) {
      return this.healthCache.result;
    }
    const result = await this.deps.runDoctor(this.cortexPath, false);
    this.healthCache = { at: Date.now(), result };
    return result;
  }

  private async renderHealthView(cursor: number, height: number): Promise<string[]> {
    const doctor  = await this.doctorSnapshot();
    const runtime = readRuntimeHealth(this.cortexPath);
    const allLines: string[] = [];

    const statusIcon  = doctor.ok ? style.green("✓") : style.red("✗");
    const statusLabel = doctor.ok ? style.boldGreen("healthy") : style.boldRed("issues found");
    allLines.push(`  ${statusIcon}  ${style.bold("cortex")} ${statusLabel}`);
    if (doctor.machine) allLines.push(`     ${style.dim("machine:")} ${style.bold(doctor.machine)}`);
    if (doctor.profile) allLines.push(`     ${style.dim("profile:")} ${style.cyan(doctor.profile)}`);

    allLines.push("", `  ${style.bold("Checks")}`);
    for (const check of doctor.checks) {
      const icon   = check.ok ? style.green("✓") : style.red("✗");
      const status = check.ok ? style.dim("ok") : style.boldRed("fail");
      allLines.push(`    ${icon} ${status}  ${check.name}: ${check.detail}`);
    }

    allLines.push("", `  ${style.bold("Runtime")}`);
    allLines.push(`    ${style.dim("last hook:   ")} ${style.dim(runtime.lastPromptAt || "n/a")}`);
    allLines.push(`    ${style.dim("last auto-save:  ")} ${style.dim(runtime.lastAutoSave?.at || "n/a")}  ${style.dim(runtime.lastAutoSave?.status || "")}`);
    allLines.push(`    ${style.dim("last governance: ")} ${style.dim(runtime.lastGovernance?.at || "n/a")}  ${style.dim(runtime.lastGovernance?.status || "")}`);

    allLines.push("", `  ${style.dim(":run fix  :relink  :rerun hooks  :update")}`);

    this.healthLineCount = allLines.length;
    if (allLines.length <= height) return allLines;

    // Scrollable: cursor highlights current line
    const cols = process.stdout.columns || 80;
    const clampedCursor = Math.max(0, Math.min(cursor, allLines.length - 1));
    // Apply highlight to cursor line
    allLines[clampedCursor] = `\x1b[7m${padToWidth(allLines[clampedCursor], cols)}${RESET}`;
    const vp = lineViewport(allLines, clampedCursor, clampedCursor, height - 1, this.currentScroll());
    this.setScroll(vp.scrollStart);
    const pct = allLines.length <= 1 ? 100 : Math.round((clampedCursor / (allLines.length - 1)) * 100);
    vp.lines.push(style.dim(`  ─── ${clampedCursor + 1}/${allLines.length}  ${pct}%`));
    return vp.lines;
  }

  // ── Main render ───────────────────────────────────────────────────────────

  async render(): Promise<string> {
    const cols   = process.stdout.columns || 80;
    const cursor = this.currentCursor();
    const height = this.contentHeight();

    // Header line
    const projectLabel = this.state.project
      ? `  ${style.dim("·")}  ${style.cyan(this.state.project)}`
      : "";
    const filterLabel = this.state.filter
      ? `  ${style.dim("·")}  ${style.yellow("/" + this.state.filter)}`
      : "";
    const header = `  ${style.boldCyan("◆ cortex")}${projectLabel}${filterLabel}`;

    // Tab bar
    const tabBar = this.renderTabBar();

    // Content
    let contentLines: string[];
    if (this.showHelp) {
      contentLines = shellHelpText().split("\n");
    } else {
      switch (this.state.view) {
        case "Projects":
          contentLines = this.renderProjectsView(cursor, height);
          break;
        case "Backlog":
          contentLines = this.renderBacklogView(cursor, height);
          break;
        case "Learnings":
          contentLines = this.renderLearningsView(cursor, height);
          break;
        case "Memory Queue":
          contentLines = this.renderMemoryQueueView(cursor, height);
          break;
        case "Machines/Profiles":
          contentLines = this.renderMachinesView();
          break;
        case "Health":
          contentLines = await this.renderHealthView(cursor, height);
          break;
        default:
          contentLines = ["  Unknown view."];
      }
    }

    // Clamp to available height; pad blank lines if content is shorter
    const displayed = contentLines.slice(0, height);
    while (displayed.length < height) displayed.push("");

    // Message + bottom bar
    const msgLine   = `  ${style.dimItalic(stripAnsi(this.message).trimStart() ? this.message : "")}`;
    const bottomBar = this.renderBottomBar();

    // Erase-to-EOL on each line so overwrite-in-place doesn't leave artifacts
    // \x1b[K clears from cursor to end of line — width-independent
    const parts = [header, tabBar, ...displayed, msgLine, bottomBar];
    return parts.map(line => {
      if (line.includes("\n")) {
        return line.split("\n").map(sub => sub + "\x1b[K").join("\n");
      }
      return line + "\x1b[K";
    }).join("\n") + "\n";
  }

  // ── Backward-compat handleInput (used by tests) ───────────────────────────

  async handleInput(raw: string): Promise<boolean> {
    const input = raw.trim();

    if (this.pendingConfirm) {
      const pending = this.pendingConfirm;
      this.pendingConfirm = undefined;
      if (input.toLowerCase() === "y") {
        pending.action();
      } else {
        this.setMessage("  Cancelled.");
      }
      return true;
    }
    if (this.showHelp) {
      this.showHelp = false;
      this.setMessage(`  ${style.boldCyan("←→")} ${style.dim("tabs")}  ${style.boldCyan("↑↓")} ${style.dim("move")}  ${style.boldCyan("↵")} ${style.dim("activate")}  ${style.boldCyan("?")} ${style.dim("help")}`);
      if (!input) return true;
    }
    if (!input) return true;

    if (["q", "quit", ":q", ":quit", ":exit"].includes(input.toLowerCase())) return false;

    if (input === "p") { this.setView("Projects"); this.setMessage(`  ${TAB_ICONS.Projects} Projects`); return true; }
    if (input === "b") {
      if (!this.state.project) { this.setMessage(style.dim("  Select a project first (↵)")); return true; }
      this.setView("Backlog"); this.setMessage(`  ${TAB_ICONS.Backlog} Backlog`); return true;
    }
    if (input === "l") {
      if (!this.state.project) { this.setMessage(style.dim("  Select a project first (↵)")); return true; }
      this.setView("Learnings"); this.setMessage(`  ${TAB_ICONS.Learnings} Learnings`); return true;
    }
    if (input === "m") {
      if (!this.state.project) { this.setMessage(style.dim("  Select a project first (↵)")); return true; }
      this.setView("Memory Queue"); this.setMessage(`  ${TAB_ICONS["Memory Queue"]} Memory Queue`); return true;
    }
    if (input === "h") {
      if (!this.state.project) { this.setMessage(style.dim("  Select a project first (↵)")); return true; }
      this.healthCache = undefined; this.setView("Health"); this.setMessage(`  ${TAB_ICONS.Health} Health`); return true;
    }

    if (input.startsWith("/")) { this.setFilter(input.slice(1)); return true; }
    if (input.startsWith(":")) { await this.executePalette(input.slice(1)); return true; }
    await this.executePalette(input);
    return true;
  }

  // ── Tab completion (for readline fallback) ────────────────────────────────

  private backlogIdCompletions(): string[] {
    const project = this.state.project;
    if (!project) return [];
    const result = readBacklog(this.cortexPath, project);
    if (!result.ok) return [];
    return [
      ...result.data.items.Active,
      ...result.data.items.Queue,
      ...result.data.items.Done,
    ].map((item) => item.id);
  }

  private queueIdCompletions(): string[] {
    const project = this.state.project;
    if (!project) return [];
    const result = readMemoryQueue(this.cortexPath, project);
    if (!result.ok) return [];
    return result.data.map((item) => item.id);
  }

  completeInput(line: string): string[] {
    const commands = [
      ":projects", ":backlog", ":learnings", ":memory", ":machines", ":health",
      ":open", ":search", ":add", ":complete", ":move", ":reprioritize", ":pin",
      ":unpin", ":context", ":work next", ":tidy", ":learn add", ":learn remove",
      ":mq approve", ":mq reject", ":mq edit", ":machine map",
      ":profile add-project", ":profile remove-project",
      ":run fix", ":relink", ":rerun hooks", ":update", ":govern", ":consolidate",
      ":undo", ":diff", ":conflicts", ":reset", ":help",
    ];

    const trimmed = line.trimStart();
    if (!trimmed.startsWith(":")) return [];
    const after = trimmed.slice(1);
    const parts = tokenize(after);
    const endsWithSpace = /\s$/.test(trimmed);

    if (parts.length === 0) return commands;
    if (parts.length === 1 && !endsWithSpace) {
      const prefix = `:${parts[0].toLowerCase()}`;
      return commands.filter((c) => c.startsWith(prefix));
    }

    const cmd = parts[0].toLowerCase();
    if (cmd === "open") {
      return listProjectCards(this.cortexPath, this.profile).map((c) => `:open ${c.name}`);
    }
    if (["complete", "move", "reprioritize", "context", "pin", "unpin"].includes(cmd)) {
      return this.backlogIdCompletions().map((id) => `:${cmd} ${id}`);
    }
    if (cmd === "mq" && ["approve", "reject", "edit"].includes((parts[1] || "").toLowerCase())) {
      return this.queueIdCompletions().map((id) => `:mq ${parts[1].toLowerCase()} ${id}`);
    }
    if (cmd === "learn" && (parts[1] || "").toLowerCase() === "remove") {
      const project = this.state.project;
      if (!project) return [];
      const r = readLearnings(this.cortexPath, project);
      if (!r.ok) return [];
      return r.data.map((item) => `:learn remove ${item.id}`);
    }

    return commands;
  }

  // ── Command palette ───────────────────────────────────────────────────────

  private async executePalette(input: string): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) return;
    const parts   = tokenize(trimmed);
    const command = (parts[0] || "").toLowerCase();

    if (command === "help") {
      this.showHelp = true;
      this.setMessage("  Showing help — press any key to dismiss");
      return;
    }

    if (command === "projects")  { this.setView("Projects");         this.setMessage(`  ${TAB_ICONS.Projects} Projects`);          return; }
    if (command === "backlog")   { this.setView("Backlog");          this.setMessage(`  ${TAB_ICONS.Backlog} Backlog`);            return; }
    if (command === "learnings") { this.setView("Learnings");        this.setMessage(`  ${TAB_ICONS.Learnings} Learnings`);        return; }
    if (command === "memory")    { this.setView("Memory Queue");     this.setMessage(`  ${TAB_ICONS["Memory Queue"]} Memory Queue`); return; }
    if (command === "machines")  { this.setView("Machines/Profiles"); this.setMessage("  Machines/Profiles"); return; }
    if (command === "health") {
      this.healthCache = undefined;
      this.setView("Health");
      this.setMessage(`  ${TAB_ICONS.Health} Health`);
      return;
    }

    if (command === "open") {
      const project = parts[1];
      if (!project) { this.setMessage("  Usage: :open <project>"); return; }
      const cards = listProjectCards(this.cortexPath, this.profile);
      if (!cards.some((c) => c.name === project)) { this.setMessage(`  Unknown project: ${project}`); return; }
      this.state.project = project;
      saveShellState(this.cortexPath, this.state);
      this.setMessage(`  ${style.green("●")} ${style.boldCyan(project)} — project context set`);
      return;
    }

    if (command === "search") {
      const query = trimmed.slice("search".length).trim();
      if (!query) { this.setMessage("  Usage: :search <query>"); return; }
      this.setMessage("  Searching…");
      try {
        const entry = resolveEntryScript();
        const args  = [entry, "search", query, "--limit", "6"];
        if (this.state.project) args.push("--project", this.state.project);
        const out = execFileSync(process.execPath, args, {
          cwd: this.cortexPath, encoding: "utf8", timeout: 60_000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        this.setMessage(out.split("\n").slice(0, 14).join("\n") || "  No results.");
      } catch (err: any) {
        this.setMessage(`  Search failed: ${err?.message || err}`);
      }
      return;
    }

    if (command === "add") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      const text = trimmed.slice("add".length).trim();
      if (!text) { this.setMessage("  Usage: :add <task>"); return; }
      this.setMessage(`  ${resultMsg(addBacklogItem(this.cortexPath, project, text))}`);
      return;
    }

    if (command === "complete") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      const match = parts.slice(1).join(" ").trim();
      if (!match) { this.setMessage("  Usage: :complete <id|match>"); return; }
      const ids = expandIds(match);
      if (ids.length > 1) {
        this.confirmThen(`Complete ${ids.length} items (${ids.join(", ")})?`, () => {
          const file = path.join(this.cortexPath, project, "backlog.md");
          this.snapshotForUndo(`complete ${ids.length} items`, file);
          this.setMessage(ids.map((id) => resultMsg(completeBacklogItem(this.cortexPath, project, id))).join("; "));
        });
      } else {
        this.confirmThen(`Complete "${match}"?`, () => {
          const file = path.join(this.cortexPath, project, "backlog.md");
          this.snapshotForUndo(`complete "${match}"`, file);
          this.setMessage(`  ${resultMsg(completeBacklogItem(this.cortexPath, project, match))}`);
        });
      }
      return;
    }

    if (command === "move") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      if (parts.length < 3) { this.setMessage("  Usage: :move <id|match> <active|queue|done>"); return; }
      const section = normalizeSection(parts[parts.length - 1]);
      if (!section) { this.setMessage("  Target section must be active|queue|done"); return; }
      const match = parts.slice(1, -1).join(" ");
      const ids   = expandIds(match);
      if (ids.length > 1) {
        const file = path.join(this.cortexPath, project, "backlog.md");
        this.snapshotForUndo(`move ${ids.length} items to ${section}`, file);
        this.setMessage(ids.map((id) => resultMsg(updateBacklogItem(this.cortexPath, project, id, { section }))).join("; "));
      } else {
        this.setMessage(`  ${resultMsg(updateBacklogItem(this.cortexPath, project, match, { section }))}`);
      }
      return;
    }

    if (command === "reprioritize") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      if (parts.length < 3) { this.setMessage("  Usage: :reprioritize <id|match> <high|medium|low>"); return; }
      const priority = parts[parts.length - 1].toLowerCase();
      if (!["high", "medium", "low"].includes(priority)) { this.setMessage("  Priority must be high|medium|low"); return; }
      const match = parts.slice(1, -1).join(" ");
      this.setMessage(`  ${resultMsg(updateBacklogItem(this.cortexPath, project, match, { priority }))}`);
      return;
    }

    if (command === "context") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      if (parts.length < 3) { this.setMessage("  Usage: :context <id|match> <text>"); return; }
      const match   = parts[1];
      const context = parts.slice(2).join(" ");
      this.setMessage(`  ${resultMsg(updateBacklogItem(this.cortexPath, project, match, { context }))}`);
      return;
    }

    if (command === "pin") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      if (parts.length < 2) { this.setMessage("  Usage: :pin <id|match>"); return; }
      this.setMessage(`  ${resultMsg(pinBacklogItem(this.cortexPath, project, parts.slice(1).join(" ")))}`);
      return;
    }

    if (command === "unpin") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      if (parts.length < 2) { this.setMessage("  Usage: :unpin <id|match>"); return; }
      this.setMessage(`  ${resultMsg(unpinBacklogItem(this.cortexPath, project, parts.slice(1).join(" ")))}`);
      return;
    }

    if (command === "work" && parts[1]?.toLowerCase() === "next") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      this.setMessage(`  ${resultMsg(workNextBacklogItem(this.cortexPath, project))}`);
      return;
    }

    if (command === "tidy") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      const keep = parts[1] ? Number.parseInt(parts[1], 10) : 30;
      const file  = path.join(this.cortexPath, project, "backlog.md");
      this.snapshotForUndo("tidy", file);
      this.setMessage(`  ${resultMsg(tidyBacklogDone(this.cortexPath, project, Number.isNaN(keep) ? 30 : keep))}`);
      return;
    }

    if (command === "learn") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      const action = (parts[1] || "").toLowerCase();
      if (action === "add") {
        const text = trimmed.split(/\s+/).slice(2).join(" ").trim();
        if (!text) { this.setMessage("  Usage: :learn add <text>"); return; }
        this.setMessage(`  ${resultMsg(addLearning(this.cortexPath, project, text))}`);
        return;
      }
      if (action === "remove") {
        const match = parts.slice(2).join(" ").trim();
        if (!match) { this.setMessage("  Usage: :learn remove <id|match>"); return; }
        this.confirmThen(`Remove learning "${match}"?`, () => {
          const file = path.join(this.cortexPath, project!, "LEARNINGS.md");
          this.snapshotForUndo(`learn remove "${match}"`, file);
          this.setMessage(`  ${resultMsg(removeLearning(this.cortexPath, project!, match))}`);
        });
        return;
      }
      this.setMessage("  Usage: :learn add <text> | :learn remove <id|match>");
      return;
    }

    if (command === "mq") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      const action = (parts[1] || "").toLowerCase();
      if (action === "approve") {
        const match = parts.slice(2).join(" ").trim();
        if (!match) { this.setMessage("  Usage: :mq approve <id|match>"); return; }
        const ids = expandIds(match);
        this.setMessage(
          ids.length > 1
            ? ids.map((id) => resultMsg(approveMemoryQueueItem(this.cortexPath, project, id))).join("; ")
            : `  ${resultMsg(approveMemoryQueueItem(this.cortexPath, project, match))}`,
        );
        return;
      }
      if (action === "reject") {
        const match = parts.slice(2).join(" ").trim();
        if (!match) { this.setMessage("  Usage: :mq reject <id|match>"); return; }
        const ids = expandIds(match);
        if (ids.length > 1) {
          this.confirmThen(`Reject ${ids.length} items (${ids.join(", ")})?`, () => {
            const file = path.join(this.cortexPath, project!, "MEMORY_QUEUE.md");
            this.snapshotForUndo(`mq reject ${ids.length} items`, file);
            this.setMessage(ids.map((id) => resultMsg(rejectMemoryQueueItem(this.cortexPath, project!, id))).join("; "));
          });
        } else {
          this.confirmThen(`Reject "${match}"?`, () => {
            const file = path.join(this.cortexPath, project!, "MEMORY_QUEUE.md");
            this.snapshotForUndo(`mq reject "${match}"`, file);
            this.setMessage(`  ${resultMsg(rejectMemoryQueueItem(this.cortexPath, project!, match))}`);
          });
        }
        return;
      }
      if (action === "edit") {
        if (parts.length < 4) { this.setMessage("  Usage: :mq edit <id|match> <text>"); return; }
        this.setMessage(`  ${resultMsg(editMemoryQueueItem(this.cortexPath, project, parts[2], parts.slice(3).join(" ")))}`);
        return;
      }
      this.setMessage("  Usage: :mq approve|reject|edit ...");
      return;
    }

    if (command === "machine" && parts[1]?.toLowerCase() === "map") {
      if (parts.length < 4) { this.setMessage("  Usage: :machine map <hostname> <profile>"); return; }
      this.setMessage(`  ${resultMsg(setMachineProfile(this.cortexPath, parts[2], parts[3]))}`);
      return;
    }

    if (command === "profile") {
      const action  = (parts[1] || "").toLowerCase();
      const profile = parts[2];
      const project = parts[3];
      if (!profile || !project) { this.setMessage("  Usage: :profile add-project|remove-project <profile> <project>"); return; }
      if (action === "add-project") {
        this.setMessage(`  ${resultMsg(addProjectToProfile(this.cortexPath, profile, project))}`);
        return;
      }
      if (action === "remove-project") {
        this.setMessage(`  ${resultMsg(removeProjectFromProfile(this.cortexPath, profile, project))}`);
        return;
      }
      this.setMessage("  Usage: :profile add-project|remove-project <profile> <project>");
      return;
    }

    if (command === "run" && parts[1]?.toLowerCase() === "fix") {
      const t0     = Date.now();
      const doctor = await this.deps.runDoctor(this.cortexPath, true);
      this.healthCache = undefined;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      this.setMessage(`  doctor --fix: ${doctor.ok ? style.green("ok") : style.red("issues remain")} (${elapsed}s)`);
      return;
    }

    if (command === "relink") {
      const t0 = Date.now();
      const r  = await this.deps.runRelink(this.cortexPath);
      this.setMessage(`  ${r} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      return;
    }

    if (command === "rerun" && parts[1]?.toLowerCase() === "hooks") {
      const t0 = Date.now();
      const r  = await this.deps.runHooks(this.cortexPath);
      this.healthCache = undefined;
      this.setMessage(`  ${r} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      return;
    }

    if (command === "update") {
      const t0 = Date.now();
      const r  = await this.deps.runUpdate();
      this.setMessage(`  ${r} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      return;
    }

    if (command === "govern") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      try {
        const t0  = Date.now();
        const out = execFileSync(process.execPath, [resolveEntryScript(), "govern-memories", project], {
          cwd: this.cortexPath, encoding: "utf8", timeout: 60_000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        this.setMessage(`  ${out || "Governance scan completed."} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      } catch (err: any) {
        this.setMessage(`  Governance failed: ${err?.message || err}`);
      }
      return;
    }

    if (command === "consolidate") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      try {
        const t0  = Date.now();
        const out = execFileSync(process.execPath, [resolveEntryScript(), "consolidate-memories", project], {
          cwd: this.cortexPath, encoding: "utf8", timeout: 60_000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        this.setMessage(`  ${out || "Consolidation completed."} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      } catch (err: any) {
        this.setMessage(`  Consolidation failed: ${err?.message || err}`);
      }
      return;
    }

    if (command === "conflicts") {
      try {
        const lines: string[] = [];
        try {
          const conflicted = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
            cwd: this.cortexPath, encoding: "utf8", timeout: 10_000,
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          if (conflicted) {
            lines.push(style.boldRed("  Unresolved conflicts:"));
            for (const f of conflicted.split("\n").filter(Boolean)) {
              lines.push(`    ${style.red("!")} ${f}`);
            }
          }
        } catch { /* not a git repo */ }

        const auditPath = path.join(this.cortexPath, ".governance", "audit.log");
        if (fs.existsSync(auditPath)) {
          const auditLines = fs.readFileSync(auditPath, "utf8").split("\n")
            .filter((l) => l.includes("auto_merge"))
            .slice(-10);
          if (auditLines.length) {
            lines.push(`  ${style.bold("Recent auto-merges:")}`);
            for (const l of auditLines) lines.push(`    ${style.dim(l)}`);
          }
        }

        const project = this.state.project;
        if (project) {
          const queueResult = readMemoryQueue(this.cortexPath, project);
          if (queueResult.ok) {
            const conflictItems = queueResult.data.filter((q) => q.section === "Conflicts");
            if (conflictItems.length) {
              lines.push(`  ${style.yellow(`${conflictItems.length} conflict(s) in Memory Queue`)}  (:mq approve|reject)`);
            }
          }
        }

        this.setMessage(lines.length ? lines.join("\n") : "  No conflicts found.");
      } catch (err: any) {
        this.setMessage(`  Conflict check failed: ${err?.message || err}`);
      }
      return;
    }

    if (command === "undo") {
      this.setMessage(`  ${this.popUndo()}`);
      return;
    }

    if (command === "diff") {
      const project = this.ensureProjectSelected();
      if (!project) return;
      try {
        const projectDir = path.join(this.cortexPath, project);
        const diff = execFileSync("git", ["diff", "--no-color", "--", projectDir], {
          cwd: this.cortexPath, encoding: "utf8", timeout: 10_000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (!diff) {
          const staged = execFileSync("git", ["diff", "--cached", "--no-color", "--", projectDir], {
            cwd: this.cortexPath, encoding: "utf8", timeout: 10_000,
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          this.setMessage(staged || "  No uncommitted changes.");
        } else {
          const lines = diff.split("\n").slice(0, 30);
          if (diff.split("\n").length > 30) lines.push(style.dim(`... (${diff.split("\n").length - 30} more lines)`));
          this.setMessage(lines.join("\n"));
        }
      } catch {
        this.setMessage("  Not a git repository or git not available.");
      }
      return;
    }

    if (command === "reset") {
      this.setMessage(`  ${resultMsg(resetShellState(this.cortexPath))}`);
      this.state = loadShellState(this.cortexPath);
      const cards = listProjectCards(this.cortexPath, this.profile);
      this.state.project = cards[0]?.name;
      return;
    }

    const suggestion = this.suggestCommand(command);
    if (suggestion) {
      this.setMessage(`  Unknown: ${trimmed} — did you mean :${suggestion}?`);
    } else {
      this.setMessage(`  Unknown: ${trimmed} — press ${style.boldCyan("?")} for help`);
    }
  }

  private suggestCommand(input: string): string | undefined {
    const known = [
      "help", "projects", "backlog", "learnings", "memory", "machines", "health",
      "open", "search", "add", "complete", "move", "reprioritize", "pin", "unpin", "context",
      "work next", "tidy", "learn add", "learn remove", "mq approve", "mq reject",
      "mq edit", "machine map", "profile add-project", "profile remove-project",
      "run fix", "relink", "rerun hooks", "update", "govern", "consolidate",
      "undo", "diff", "conflicts", "reset",
    ];
    let best: string | undefined;
    let bestDist = Infinity;
    for (const cmd of known) {
      const d = editDistance(input.toLowerCase(), cmd);
      if (d < bestDist && d <= 2) { bestDist = d; best = cmd; }
    }
    return best;
  }
}

// ── Terminal control ──────────────────────────────────────────────────────────

function clearScreen(): void {
  if (process.stdout.isTTY) {
    // Move cursor to home and overwrite in place (no full clear = no flicker)
    process.stdout.write("\x1b[H");
  }
}

// Clear any leftover lines below the rendered content
function clearToEnd(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[J");
  }
}

// ── Shell entry point (raw stdin) ─────────────────────────────────────────────

export async function startShell(cortexPath: string, profile: string): Promise<void> {
  const shell = new CortexShell(cortexPath, profile);

  if (!process.stdin.isTTY) {
    // Non-interactive fallback: readline mode for piped input / tests
    const { createInterface } = await import("readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const repaint = async () => {
      clearScreen();
      process.stdout.write(await shell.render());
      rl.setPrompt(`\n${style.boldCyan(":cortex>")} `);
      rl.prompt();
    };
    await repaint();
    rl.on("line", async (line) => {
      try {
        const keep = await shell.handleInput(line);
        if (!keep) { shell.close(); rl.close(); return; }
      } catch (err: any) {
        process.stdout.write(`\n${style.red("Error:")} ${String(err?.message || err)}\n`);
      }
      await repaint();
    });
    rl.on("SIGINT", () => { shell.close(); rl.close(); });
    await new Promise<void>((resolve) => { rl.on("close", () => { shell.close(); resolve(); }); });
    return;
  }

  // Raw stdin mode — full arrow-key TUI
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  // Enter alternate screen buffer (prevents scrollback issues)
  process.stdout.write("\x1b[?1049h");

  let exiting = false;

  const repaint = async () => {
    clearScreen();
    process.stdout.write(await shell.render());
    clearToEnd();
  };

  await repaint();

  const onData = async (key: string) => {
    if (exiting) return;
    try {
      const keep = await shell.handleRawKey(key);
      if (!keep) {
        exiting = true;
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        shell.close();
        // Exit alternate screen buffer and restore terminal
        process.stdout.write("\x1b[?1049l");
        done();
        return;
      }
      await repaint();
    } catch (err: any) {
      (shell as any).message = `Error: ${err?.message || err}`;
      await repaint();
    }
  };

  let done: () => void;
  const exitPromise = new Promise<void>((resolve) => { done = resolve; });

  process.stdin.on("data", onData);

  // Handle terminal resize
  process.stdout.on("resize", async () => {
    if (!exiting) await repaint();
  });

  await exitPromise;
}

// ── Utilities exported for tests ──────────────────────────────────────────────

export function shellStatePath(cortexPath: string): string {
  return path.join(cortexPath, ".governance", "shell-state.json");
}

export function shellStateExists(cortexPath: string): boolean {
  return fs.existsSync(shellStatePath(cortexPath));
}
