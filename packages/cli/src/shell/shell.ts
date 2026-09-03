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
import { renderWidth } from "./render.js";
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
import { applyEditorKey, createEditorState, editorText, type EditorState } from "../editor/buffer.js";
import { saveEditedFile, type EditKind } from "../editor/save.js";
import { renderEditor } from "./editor-view.js";
import { syncSkillLinksForScope } from "../skill/files.js";

/** How far the help should scroll for a key, or 0 when it should close instead. */
function helpScrollDelta(key: string): number {
  switch (key) {
    case "\x1b[B": case "j": return 1;
    case "\x1b[A": case "k": return -1;
    case "\x1b[6~": return 10;
    case "\x1b[5~": return -10;
    default: return 0;
  }
}

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

  private navMode: "navigate" | "input" | "editor" = "navigate";
  private editor?: { state: EditorState; kind: EditKind; scope?: string };
  private inputBuf = "";
  private inputCtx = "";
  inputMqId = "";
  private cursorMap: Partial<Record<string, number>> = {};
  private viewScrollMap: Partial<Record<string, number>> = {};
  private healthLineCount = 0;
  private helpScroll = 0;
  private _subsectionsCache: SubsectionsCache | null = null;
  private _graph?: GraphController;
  private repaintHandler: (() => void) | null = null;
  private suspendHandler: ((run: () => Promise<void> | void) => Promise<void>) | null = null;
  /** `--live` / `--no-live`; undefined leaves watch mode at its default. */
  private graphLive?: boolean;

  get mode(): "navigate" | "input" | "editor" { return this.navMode; }
  get editorState(): EditorState | undefined { return this.editor?.state; }
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
  /**
   * The Graph view wants the mouse (drag to orbit, wheel to zoom, click to
   * select); every other view wants the terminal's own text selection. The
   * entry point supplies what turning it on and off means for this terminal.
   */
  setMouseHandler(handler: ((on: boolean) => void) | null): void {
    this.mouseHandler = handler;
  }
  private mouseHandler: ((on: boolean) => void) | null = null;

  /** Apply the mouse state for the current view (after grabbing the terminal). */
  syncMouse(): void {
    this.mouseHandler?.(this.state.view === "Graph");
  }

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
    const hadMouse = this.state.view === "Graph";
    this.state.view = view;
    if (hadMouse !== (view === "Graph")) this.mouseHandler?.(view === "Graph");
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

  // ── Modal editor ───────────────────────────────────────────────────────

  /** Open a file in the built-in editor. Returns false if it cannot be read. */
  openEditor(filePath: string, label: string, kind: EditKind, scope?: string): boolean {
    let content = "";
    try {
      content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    } catch (err: unknown) {
      this.setMessage(`  Could not open ${label}: ${errorMessage(err)}`);
      return false;
    }
    this.editor = { state: createEditorState(filePath, label, content), kind, scope };
    this.navMode = "editor";
    return true;
  }

  private closeEditor(message: string): void {
    this.editor = undefined;
    this.navMode = "navigate";
    this.invalidateSubsectionsCache();
    this.setMessage(message);
  }

  private saveEditor(): boolean {
    const open = this.editor;
    if (!open) return false;
    // The same undo stack :undo uses, so a bad save is recoverable.
    this.snapshotForUndo(`edit ${open.state.label}`, open.state.path);
    const result = saveEditedFile(open.state.path, editorText(open.state), open.kind);
    if (!result.ok) {
      open.state = { ...open.state, message: result.error ?? "could not save" };
      return false;
    }
    // Only a frontmatter change moves what the manifests contain.
    if (result.frontmatterChanged && open.scope) {
      try { syncSkillLinksForScope(this.phrenPath, open.scope); }
      catch (err: unknown) { logger.debug("shell", `skill re-sync: ${errorMessage(err)}`); }
    }
    open.state = { ...open.state, dirty: false, message: `written  ${open.state.label}` };
    return true;
  }

  private async handleEditorKey(key: string): Promise<boolean> {
    const open = this.editor;
    if (!open) { this.navMode = "navigate"; return true; }
    open.state = applyEditorKey(open.state, key);

    if (open.state.wantSave) {
      open.state = { ...open.state, wantSave: false };
      const saved = this.saveEditor();
      // A failed save cancels a :wq — you do not want to lose the buffer.
      if (!saved && this.editor) this.editor.state = { ...this.editor.state, wantClose: false };
    }
    if (this.editor?.state.wantClose) {
      const label = this.editor.state.label;
      const wasDirty = this.editor.state.dirty;
      this.closeEditor(wasDirty ? `  Closed ${label} without saving` : `  ${style.green("✓")} ${label}`);
    }
    return true;
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
      // Scroll rather than dismiss, so the half of the help that does not fit
      // on a small terminal is reachable at all.
      const scroll = helpScrollDelta(key);
      if (scroll !== 0) { this.helpScroll = Math.max(0, this.helpScroll + scroll); return true; }
      this.showHelp = false;
      this.helpScroll = 0;
      this.setMessage(`  ${style.boldCyan("←→")} ${style.dim("tabs")}  ${style.boldCyan("↑↓")} ${style.dim("move")}  ${style.boldCyan("↵")} ${style.dim("activate")}  ${style.boldCyan("?")} ${style.dim("help")}`);
      return true;
    }
    if (this.navMode === "editor") return this.handleEditorKey(key);
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
    // The editor takes the whole frame: it is a mode, not a view.
    if (this.navMode === "editor" && this.editor) {
      const rows = Math.max(4, process.stdout.rows || 24);
      const lines = renderEditor(this.editor.state, renderWidth(), rows);
      return lines.map((line) => `${line}\x1b[K`).join("\n");
    }
    const ctx: ViewContext = {
      phrenPath: this.phrenPath, profile: this.profile, state: this.state,
      currentCursor: () => this.currentCursor(), currentScroll: () => this.currentScroll(),
      setScroll: (n) => this.setScroll(n),
      graph: () => this.graph(),
    };
    // The editor path returned above, so this is only ever navigate or input.
    const viewMode = this.navMode === "input" ? "input" : "navigate";
    return renderShell(ctx, viewMode, this.inputCtx, this.inputBuf, this.showHelp, this.helpScroll, this.message,
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
      openEditor: (filePath, label, kind, scope) => this.openEditor(filePath, label, kind, scope),
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
      this.helpScroll = 0;
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
