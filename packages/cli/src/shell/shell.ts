import * as fs from "fs";
import * as path from "path";
import {
  addTask,
  addFinding,
  loadShellState,
  saveShellState,
  ShellState,
} from "../data/access.js";
import { style } from "./render.js";
import {
  MAX_UNDO_STACK,
  type UndoEntry,
  type ShellView,
  type ShellDeps,
  type DoctorResultLike,
} from "./types.js";
import { logger } from "../logger.js";
export type { ShellView, ShellDeps } from "./types.js";
import {
  resultMsg,
  defaultRunHooks,
  defaultRunUpdate,
  defaultRunRelink,
} from "./palette.js";
import { runDoctor } from "../link/link.js";
import {
  renderShell,
  type SubsectionsCache,
  type ViewContext,
} from "./view.js";
import {
  executePalette,
  completeInput as completeInputFn,
  getListItems,
  handleNavigateKey,
  applyViewShortcut,
  type NavigationHost,
} from "./input.js";
import { errorMessage } from "../utils.js";
import type { ShellStartup } from "./startup.js";
import { GraphController } from "./graph/controller.js";

/** Remove the final character, keeping surrogate pairs and combining marks intact. */
function dropLastCharacter(s: string): string {
  if (!s) return s;
  const chars = [...s];
  chars.pop();
  while (chars.length && /\p{M}/u.test(chars[chars.length - 1]!)) chars.pop();
  return chars.join("");
}

// ── Shell class ──────────────────────────────────────────────────────────────

export class PhrenShell {
  private state: ShellState;
  private message = `  ${style.boldCyan("←→")} ${style.dim("tabs")}  ${style.boldCyan("↑↓")} ${style.dim("move")}  ${style.boldCyan("↵")} ${style.dim("activate")}  ${style.boldCyan("?")} ${style.dim("help")}`;
  healthCache?: { at: number; result: DoctorResultLike };
  prevHealthView: ShellView | undefined = undefined;
  showHelp = false;
  private pendingConfirm?: { label: string; action: () => void };
  private undoStack: UndoEntry[] = [];

  private navMode: "navigate" | "input" = "navigate";
  private inputBuf = "";
  private inputCtx = "";
  inputMqId = "";
  private cursorMap: Partial<Record<string, number>> = {};
  private viewScrollMap: Partial<Record<string, number>> = {};
  private healthLineCount = 0;
  private _subsectionsCache: SubsectionsCache | null = null;
  private _graph?: GraphController;
  private repaintHandler: (() => void) | null = null;
  private suspendHandler: ((run: () => Promise<void> | void) => Promise<void>) | null = null;
  /** `--live` / `--no-live`; undefined leaves watch mode at its default. */
  private graphLive?: boolean;

  get mode(): "navigate" | "input" { return this.navMode; }
  get inputBuffer(): string { return this.inputBuf; }
  get filter(): string | undefined { return this.state.filter; }

  constructor(
    readonly phrenPath: string,
    readonly profile: string,
    readonly deps: ShellDeps = {
      runDoctor,
      runRelink: defaultRunRelink,
      runHooks: defaultRunHooks,
      runUpdate: defaultRunUpdate,
    },
    startup: ShellStartup = {},
  ) {
    this.state = loadShellState(phrenPath);
    // A deep link (`phren shell --view tasks --here`) wins over the view the
    // last session happened to leave behind; without one we always land home.
    if (startup.project) this.state.project = startup.project;
    this.graphLive = startup.live;
    this.state.view = startup.view ?? "Projects";
    this.message = startup.notice
      ? `  ${style.yellow("⚠")}  ${startup.notice}`
      : this.state.view === "Graph"
      ? ""
      : this.state.project
      ? `  Dashboard ready — active context ${style.boldCyan(this.state.project)}`
      : `  Dashboard ready — choose a project with ${style.boldCyan("↵")} or stay global`;
  }

  close(): void { this._graph?.dispose(); saveShellState(this.phrenPath, this.state); }
  setMessage(msg: string): void { this.message = msg; }

  /**
   * Let the host (entry.ts) hand over a way to repaint on the shell's own
   * initiative — the graph view uses it to animate its layout settling and
   * to show a build that finished while nothing was typed.
   */
  setRepaintHandler(handler: (() => void) | null): void {
    this.repaintHandler = handler;
    this._graph?.setRepaintHook(handler);
  }

  /**
   * Let the host lend the terminal to a child process. Without one — a non-TTY
   * host, or an embedder — callers fall back to telling the user the path.
   */
  setSuspendHandler(handler: ((run: () => Promise<void> | void) => Promise<void>) | null): void {
    this.suspendHandler = handler;
  }

  get canSuspend(): boolean {
    return this.suspendHandler !== null;
  }

  /** Run `fn` with the terminal released. Resolves false when that is impossible. */
  async suspend(fn: () => Promise<void> | void): Promise<boolean> {
    if (!this.suspendHandler) return false;
    await this.suspendHandler(fn);
    return true;
  }

  graph(): GraphController {
    if (!this._graph) {
      this._graph = new GraphController(this.phrenPath, this.profile, { watchEnabled: this.graphLive });
      this._graph.setRepaintHook(this.repaintHandler);
    }
    return this._graph;
  }

  confirmThen(label: string, action: () => void): void {
    this.pendingConfirm = { label, action };
    this.setMessage(`${label}  ${style.boldCyan("y")} ${style.dim("confirm")}  ${style.boldCyan("n")} ${style.dim("cancel")}`);
  }

  setView(view: ShellView): void {
    if (this.state.view === "Graph" && view !== "Graph") this._graph?.stopAnimation();
    this.state.view = view;
    this.viewScrollMap[view] = 0;
    saveShellState(this.phrenPath, this.state);
  }

  setFilter(value: string): void {
    this.state.filter = value.trim() || undefined;
    saveShellState(this.phrenPath, this.state);
    this.setMessage(this.state.filter ? `  Filter: ${style.yellow(this.state.filter)}` : "  Filter cleared.");
  }

  snapshotForUndo(label: string, file: string): void {
    try {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, "utf8");
        this.undoStack.push({ label, file, content });
        if (this.undoStack.length > MAX_UNDO_STACK) this.undoStack.shift();
      }
    } catch (err: unknown) {
      logger.debug("shell", `shell pushUndo: ${errorMessage(err)}`);
    }
  }

  popUndo(): string {
    const entry = this.undoStack.pop();
    if (!entry) return "Nothing to undo.";
    try { fs.writeFileSync(entry.file, entry.content); return `Undid: ${entry.label}`; }
    catch (err: unknown) { return `Undo failed: ${errorMessage(err)}`; }
  }

  ensureProjectSelected(): string | null {
    if (!this.state.project) {
      this.setMessage("No project selected — open one from Projects view (↵) or use :open <project>");
      return null;
    }
    return this.state.project;
  }

  invalidateSubsectionsCache(): void { this._subsectionsCache = null; }

  // ── Cursor management ────────────────────────────────────────────────────

  currentCursor(): number { return this.cursorMap[this.state.view] ?? 0; }
  setCursor(n: number): void {
    const count = this.getListItems().length;
    this.cursorMap[this.state.view] = count > 0 ? Math.max(0, Math.min(n, count - 1)) : 0;
  }
  moveCursor(delta: number): void { this.setCursor(this.currentCursor() + delta); }
  private currentScroll(): number { return this.viewScrollMap[this.state.view] ?? 0; }
  private setScroll(n: number): void { this.viewScrollMap[this.state.view] = Math.max(0, n); }

  getListItems(): { id?: string; name?: string; text?: string; line?: string; path?: string; scopeType?: string; storePath?: string }[] {
    return getListItems(this.phrenPath, this.profile, this.state, this.healthLineCount);
  }

  startInput(ctx: string, initial: string): void { this.navMode = "input"; this.inputCtx = ctx; this.inputBuf = initial; }
  private cancelInput(): void { this.navMode = "navigate"; this.inputBuf = ""; this.inputCtx = ""; this.setMessage("  Cancelled."); }

  private async submitInput(): Promise<void> {
    const buf = this.inputBuf;
    const ctx = this.inputCtx;
    this.navMode = "navigate"; this.inputBuf = ""; this.inputCtx = "";
    if (!buf.trim() && ctx !== "command" && ctx !== "graph-search") { this.setMessage("  Nothing entered."); return; }
    switch (ctx) {
      case "filter": this.setFilter(buf); break;
      case "graph-search": {
        const graph = this.graph();
        const best = graph.applySearch(buf);
        if (best) this.setMessage(`  ${style.yellow(`1/${graph.search.results.length}`)}  ${graph.describe(best).trimStart()}`);
        else this.setMessage(buf.trim() ? `  ${style.dim("no matches for")} ${style.yellow(buf.trim())}` : `  ${style.dim("search cleared")}`);
        break;
      }
      case "command": await this.runPalette(buf.startsWith(":") ? buf.slice(1) : buf); break;
      case "add": { const p = this.ensureProjectSelected(); if (!p) return; this.setMessage(`  ${resultMsg(addTask(this.phrenPath, p, buf))}`); break; }
      case "learn-add": { const p = this.ensureProjectSelected(); if (!p) return; this.setMessage(`  ${resultMsg(addFinding(this.phrenPath, p, buf))}`); break; }
      case "skill-add": {
        const p = this.ensureProjectSelected();
        if (!p) return;
        const name = buf.trim().replace(/\.md$/i, "").replace(/[^a-zA-Z0-9_-]/g, "-");
        if (!name) { this.setMessage("  No name entered."); return; }
        const destDir = path.join(this.phrenPath, p, "skills");
        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, `${name}.md`);
        if (fs.existsSync(dest)) { this.setMessage(`  Skill "${name}" already exists.`); return; }
        const template = `# ${name}\n\nDescribe what this skill does.\n\n## Usage\n\n\`\`\`\nExample usage here\n\`\`\`\n`;
        fs.writeFileSync(dest, template, "utf8");
        this.setMessage(`  Created skill "${name}" — edit ${dest}`);
        break;
      }
    }
  }

  // ── Raw key handling ───────────────────────────────────────────────────

  async handleRawKey(key: string): Promise<boolean> {
    if (key === "\x03" || key === "\x04") return false;
    if (this.pendingConfirm) {
      const pending = this.pendingConfirm; this.pendingConfirm = undefined;
      if (key.toLowerCase() === "y") { pending.action(); } else { this.setMessage("  Cancelled."); }
      return true;
    }
    if (this.showHelp) {
      this.showHelp = false;
      this.setMessage(`  ${style.boldCyan("←→")} ${style.dim("tabs")}  ${style.boldCyan("↑↓")} ${style.dim("move")}  ${style.boldCyan("↵")} ${style.dim("activate")}  ${style.boldCyan("?")} ${style.dim("help")}`);
      return true;
    }
    return this.navMode === "input" ? this.handleInputKey(key) : handleNavigateKey(this.asNavigationHost(), key);
  }

  private async handleInputKey(key: string): Promise<boolean> {
    if (key === "\x03") return false;
    if (key === "\x1b") { this.cancelInput(); return true; }
    if (key === "\r" || key === "\n") { await this.submitInput(); return true; }
    if (key === "\x7f" || key === "\x08") { this.inputBuf = dropLastCharacter(this.inputBuf); return true; }
    if (key.startsWith("\x1b")) return true;
    // Accept any printable key. Astral characters (emoji, and anything else the
    // user pastes) span two UTF-16 units, so this cannot test key.length === 1.
    const cp = key.codePointAt(0);
    if (cp !== undefined && cp >= 32 && cp !== 0x7f) { this.inputBuf += key; return true; }
    return true;
  }

  // ── Doctor snapshot ────────────────────────────────────────────────────

  private async doctorSnapshot(): Promise<DoctorResultLike> {
    if (this.healthCache && Date.now() - this.healthCache.at < 10_000) return this.healthCache.result;
    const result = await this.deps.runDoctor(this.phrenPath, false);
    this.healthCache = { at: Date.now(), result };
    return result;
  }

  // ── Render (delegates to shell-view.ts) ────────────────────────────────

  async render(): Promise<string> {
    const ctx: ViewContext = {
      phrenPath: this.phrenPath, profile: this.profile, state: this.state,
      currentCursor: () => this.currentCursor(), currentScroll: () => this.currentScroll(),
      setScroll: (n) => this.setScroll(n),
      graph: () => this.graph(),
    };
    return renderShell(ctx, this.navMode, this.inputCtx, this.inputBuf, this.showHelp, this.message,
      () => this.doctorSnapshot(), this._subsectionsCache,
      (n) => { this.healthLineCount = n; }, (c) => { this._subsectionsCache = c; });
  }

  // ── Navigation host adapter ────────────────────────────────────────────

  private asNavigationHost(): NavigationHost {
    const self = this;
    return {
      phrenPath: this.phrenPath, profile: this.profile, state: this.state, deps: this.deps,
      get showHelp() { return self.showHelp; }, set showHelp(v) { self.showHelp = v; },
      get healthCache() { return self.healthCache; }, set healthCache(v) { self.healthCache = v; },
      get prevHealthView() { return self.prevHealthView; }, set prevHealthView(v) { self.prevHealthView = v; },
      get filter() { return self.state.filter; },
      get inputMqId() { return self.inputMqId; }, set inputMqId(v) { self.inputMqId = v; },
      setMessage: (msg) => this.setMessage(msg), setView: (view) => this.setView(view),
      setFilter: (value) => this.setFilter(value),
      confirmThen: (label, action) => this.confirmThen(label, action),
      snapshotForUndo: (label, file) => this.snapshotForUndo(label, file),
      ensureProjectSelected: () => this.ensureProjectSelected(),
      invalidateSubsectionsCache: () => this.invalidateSubsectionsCache(),
      popUndo: () => this.popUndo(),
      currentCursor: () => this.currentCursor(),
      setCursor: (n) => this.setCursor(n),
      moveCursor: (delta) => this.moveCursor(delta),
      getListItems: () => this.getListItems(),
      startInput: (ctx, initial) => this.startInput(ctx, initial),
      graph: () => this.graph(),
      suspend: (fn) => this.suspend(fn),
    };
  }

  // ── Palette (delegates to shell-input.ts) ──────────────────────────────

  private async runPalette(input: string): Promise<void> {
    await executePalette(this.asNavigationHost(), input);
  }

  async handleInput(raw: string): Promise<boolean> {
    const input = raw.trim();
    if (this.pendingConfirm) {
      const pending = this.pendingConfirm; this.pendingConfirm = undefined;
      if (input.toLowerCase() === "y") { pending.action(); } else { this.setMessage("  Cancelled."); }
      return true;
    }
    if (this.showHelp) {
      this.showHelp = false;
      this.setMessage(`  ${style.boldCyan("←→")} ${style.dim("tabs")}  ${style.boldCyan("↑↓")} ${style.dim("move")}  ${style.boldCyan("↵")} ${style.dim("activate")}  ${style.boldCyan("?")} ${style.dim("help")}`);
      if (!input) return true;
    }
    if (!input) return true;
    if (["q", "quit", ":q", ":quit", ":exit"].includes(input.toLowerCase())) return false;
    if (applyViewShortcut(this.asNavigationHost(), input)) return true;
    if (input.startsWith("/")) { this.setFilter(input.slice(1)); return true; }
    if (input.startsWith(":")) { await this.runPalette(input.slice(1)); return true; }
    await this.runPalette(input);
    return true;
  }

  completeInput(line: string): string[] {
    return completeInputFn(line, this.phrenPath, this.profile, this.state);
  }
}

export { startShell } from "./entry.js";
export type { ShellStartup } from "./startup.js";
