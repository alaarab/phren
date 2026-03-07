import * as fs from "fs";
import * as path from "path";
import {
  addBacklogItem,
  addFinding,
  editQueueItem,
  listProjectCards,
  loadShellState,
  saveShellState,
  ShellState,
} from "./data-access.js";
import { style } from "./shell-render.js";
import {
  MAX_UNDO_STACK,
  TAB_ICONS,
  type UndoEntry,
  type ShellView,
  type ShellDeps,
  type DoctorResultLike,
} from "./shell-types.js";
export type { ShellView, ShellDeps } from "./shell-types.js";
import {
  resultMsg,
  defaultRunHooks,
  defaultRunUpdate,
  defaultRunRelink,
} from "./shell-palette.js";
import { runDoctor } from "./link.js";
import {
  renderShell,
  type SubsectionsCache,
  type ViewContext,
} from "./shell-view.js";
import {
  executePalette,
  completeInput as completeInputFn,
  getListItems,
  handleNavigateKey,
  type PaletteHost,
  type NavigationHost,
} from "./shell-input.js";

// ── Shell class ──────────────────────────────────────────────────────────────

export class CortexShell {
  private state: ShellState;
  private message = `  ${style.boldCyan("←→")} ${style.dim("tabs")}  ${style.boldCyan("↑↓")} ${style.dim("move")}  ${style.boldCyan("↵")} ${style.dim("activate")}  ${style.boldCyan("?")} ${style.dim("help")}`;
  healthCache?: { at: number; result: DoctorResultLike };
  prevHealthView?: ShellView;
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

  get mode(): "navigate" | "input" { return this.navMode; }
  get inputBuffer(): string { return this.inputBuf; }
  get filter(): string | undefined { return this.state.filter; }

  constructor(
    readonly cortexPath: string,
    readonly profile: string,
    readonly deps: ShellDeps = {
      runDoctor,
      runRelink: defaultRunRelink,
      runHooks: defaultRunHooks,
      runUpdate: defaultRunUpdate,
    },
  ) {
    this.state = loadShellState(cortexPath);
    const cards = listProjectCards(cortexPath, profile);
    this.state.view = "Projects";
    if (!this.state.project && cards.length > 0) this.state.project = cards[0].name;
    this.message = this.state.project
      ? `  Open ${style.boldCyan(this.state.project)} with ${style.boldCyan("↵")} · ${style.boldCyan("?")} for help`
      : `  Press ${style.boldCyan("?")} for help`;
  }

  close(): void { saveShellState(this.cortexPath, this.state); }
  setMessage(msg: string): void { this.message = msg; }

  confirmThen(label: string, action: () => void): void {
    this.pendingConfirm = { label, action };
    this.setMessage(`${label}  ${style.boldCyan("y")} ${style.dim("confirm")}  ${style.boldCyan("n")} ${style.dim("cancel")}`);
  }

  setView(view: ShellView): void {
    this.state.view = view;
    this.viewScrollMap[view] = 0;
    saveShellState(this.cortexPath, this.state);
  }

  setFilter(value: string): void {
    this.state.filter = value.trim() || undefined;
    saveShellState(this.cortexPath, this.state);
    this.setMessage(this.state.filter ? `  Filter: ${style.yellow(this.state.filter)}` : "  Filter cleared.");
  }

  snapshotForUndo(label: string, file: string): void {
    try {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, "utf8");
        this.undoStack.push({ label, file, content });
        if (this.undoStack.length > MAX_UNDO_STACK) this.undoStack.shift();
      }
    } catch { /* best effort */ }
  }

  popUndo(): string {
    const entry = this.undoStack.pop();
    if (!entry) return "Nothing to undo.";
    try { fs.writeFileSync(entry.file, entry.content); return `Undid: ${entry.label}`; }
    catch (err: unknown) { return `Undo failed: ${err instanceof Error ? err.message : String(err)}`; }
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

  getListItems(): { id?: string; name?: string; text?: string; line?: string }[] {
    return getListItems(this.cortexPath, this.profile, this.state, this.healthLineCount);
  }

  startInput(ctx: string, initial: string): void { this.navMode = "input"; this.inputCtx = ctx; this.inputBuf = initial; }
  private cancelInput(): void { this.navMode = "navigate"; this.inputBuf = ""; this.inputCtx = ""; this.setMessage("  Cancelled."); }

  private async submitInput(): Promise<void> {
    const buf = this.inputBuf;
    const ctx = this.inputCtx;
    this.navMode = "navigate"; this.inputBuf = ""; this.inputCtx = "";
    if (!buf.trim() && ctx !== "command") { this.setMessage("  Nothing entered."); return; }
    switch (ctx) {
      case "filter": this.setFilter(buf); break;
      case "command": await this.runPalette(buf.startsWith(":") ? buf.slice(1) : buf); break;
      case "add": { const p = this.ensureProjectSelected(); if (!p) return; this.setMessage(`  ${resultMsg(addBacklogItem(this.cortexPath, p, buf))}`); break; }
      case "learn-add": { const p = this.ensureProjectSelected(); if (!p) return; this.setMessage(`  ${resultMsg(addFinding(this.cortexPath, p, buf))}`); break; }
      case "mq-edit": { const p = this.ensureProjectSelected(); if (!p) return; const r = editQueueItem(this.cortexPath, p, this.inputMqId, buf); this.setMessage(`  ${resultMsg(r)}`); this.inputMqId = ""; break; }
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
    if (key === "\x7f" || key === "\x08") { this.inputBuf = this.inputBuf.slice(0, -1); return true; }
    if (key.startsWith("\x1b[")) return true;
    if (key.length === 1 && key.charCodeAt(0) >= 32) { this.inputBuf += key; return true; }
    return true;
  }

  // ── Doctor snapshot ────────────────────────────────────────────────────

  private async doctorSnapshot(): Promise<DoctorResultLike> {
    if (this.healthCache && Date.now() - this.healthCache.at < 10_000) return this.healthCache.result;
    const result = await this.deps.runDoctor(this.cortexPath, false);
    this.healthCache = { at: Date.now(), result };
    return result;
  }

  // ── Render (delegates to shell-view.ts) ────────────────────────────────

  async render(): Promise<string> {
    const ctx: ViewContext = {
      cortexPath: this.cortexPath, profile: this.profile, state: this.state,
      currentCursor: () => this.currentCursor(), currentScroll: () => this.currentScroll(),
      setScroll: (n) => this.setScroll(n),
    };
    return renderShell(ctx, this.navMode, this.inputCtx, this.inputBuf, this.showHelp, this.message,
      () => this.doctorSnapshot(), this._subsectionsCache,
      (n) => { this.healthLineCount = n; }, (c) => { this._subsectionsCache = c; });
  }

  // ── Navigation host adapter ────────────────────────────────────────────

  private asNavigationHost(): NavigationHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      cortexPath: this.cortexPath, profile: this.profile, state: this.state, deps: this.deps,
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
    };
  }

  // ── Palette (delegates to shell-input.ts) ──────────────────────────────

  private async runPalette(input: string): Promise<void> {
    await executePalette(this.asNavigationHost(), input);
  }

  // ── Backward-compat handleInput (used by tests) ────────────────────────

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
    if (input === "p") { this.setView("Projects"); this.setMessage(`  ${TAB_ICONS.Projects} Projects`); return true; }
    if (input === "b") { if (!this.state.project) { this.setMessage(style.dim("  Select a project first (↵)")); return true; } this.setView("Backlog"); this.setMessage(`  ${TAB_ICONS.Backlog} Backlog`); return true; }
    if (input === "l") { if (!this.state.project) { this.setMessage(style.dim("  Select a project first (↵)")); return true; } this.setView("Findings"); this.setMessage(`  ${TAB_ICONS.Findings} Findings`); return true; }
    if (input === "m") { if (!this.state.project) { this.setMessage(style.dim("  Select a project first (↵)")); return true; } this.setView("Review Queue"); this.setMessage(`  ${TAB_ICONS["Review Queue"]} Review Queue`); return true; }
    if (input === "h") { if (!this.state.project) { this.setMessage(style.dim("  Select a project first (↵)")); return true; } this.healthCache = undefined; this.setView("Health"); this.setMessage(`  ${TAB_ICONS.Health} Health`); return true; }
    if (input.startsWith("/")) { this.setFilter(input.slice(1)); return true; }
    if (input.startsWith(":")) { await this.runPalette(input.slice(1)); return true; }
    await this.runPalette(input);
    return true;
  }

  completeInput(line: string): string[] {
    return completeInputFn(line, this.cortexPath, this.profile, this.state);
  }
}

export { startShell } from "./shell-entry.js";

// ── Utilities exported for tests ──────────────────────────────────────────────

export function shellStatePath(cortexPath: string): string {
  return path.join(cortexPath, ".governance", "shell-state.json");
}

export function shellStateExists(cortexPath: string): boolean {
  return fs.existsSync(shellStatePath(cortexPath));
}
