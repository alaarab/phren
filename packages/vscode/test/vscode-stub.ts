// Minimal stand-in for the `vscode` module so the extension's pure-logic units
// can be exercised under vitest without launching an Electron Extension Host.
// Only the surface the code under test touches is implemented; extend as needed.
//
// `window`/`workspace`/`commands` members are `vi.fn()` so tests can control
// return values per-case (`vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(...)`)
// and inspect calls (`vscode.commands.registerCommand.mock.calls`). Call
// `vi.clearAllMocks()` in `beforeEach` to avoid cross-test call-log bleed.

import { vi } from "vitest";

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  fire(data: T): void {
    for (const listener of [...this.listeners]) listener(data);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class ThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: ThemeColor,
  ) {}
  static Folder: ThemeIcon;
  static File: ThemeIcon;
}
ThemeIcon.Folder = new ThemeIcon("folder");
ThemeIcon.File = new ThemeIcon("file");

export class MarkdownString {
  value = "";
  constructor(value?: string, public supportThemeIcons = false) {
    if (value) this.value = value;
  }
  appendMarkdown(text: string): this {
    this.value += text;
    return this;
  }
}

export class TreeItem {
  description?: string;
  iconPath?: unknown;
  tooltip?: unknown;
  contextValue?: string;
  id?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

export class Uri {
  private constructor(public readonly fsPath: string) {}
  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }
  toString(): string {
    return `file://${this.fsPath}`;
  }
}

export class RelativePattern {
  constructor(
    public readonly base: string,
    public readonly pattern: string,
  ) {}
}

/**
 * Real vscode.Disposable exposes both `dispose()` and a static `.from(...)`.
 * Nothing under test constructs one directly; kept minimal.
 */
export class Disposable {
  constructor(private readonly callOnDispose: () => void) {}
  dispose(): void {
    this.callOnDispose();
  }
}

function makeDisposable() {
  return { dispose: vi.fn() };
}

export const commands = {
  registerCommand: vi.fn((_command: string, _callback: (...args: any[]) => any) => makeDisposable()),
  executeCommand: vi.fn(async (..._args: any[]) => undefined),
};

export const window = {
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showTextDocument: vi.fn(),
  createOutputChannel: vi.fn(() => ({
    name: "",
    append: vi.fn(),
    appendLine: vi.fn(),
    replace: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  })),
  createTreeView: vi.fn(() => ({ reveal: vi.fn(async () => undefined), dispose: vi.fn() })),
  createWebviewPanel: vi.fn(),
  withProgress: vi.fn(async (_options: unknown, task: (...args: any[]) => any) =>
    task({ report: vi.fn() }, { isCancellationRequested: false }),
  ),
  activeTextEditor: undefined as
    | { selection: { isEmpty: boolean }; document: { getText: (selection?: unknown) => string } }
    | undefined,
};

export const workspace = {
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
  getConfiguration: vi.fn((_section?: string) => ({
    get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
    update: vi.fn(async () => undefined),
  })),
  openTextDocument: vi.fn(async (_options?: unknown) => ({})),
  createFileSystemWatcher: vi.fn(() => ({
    onDidChange: vi.fn(() => makeDisposable()),
    onDidCreate: vi.fn(() => makeDisposable()),
    onDidDelete: vi.fn(() => makeDisposable()),
    dispose: vi.fn(),
  })),
  onDidChangeConfiguration: vi.fn(() => makeDisposable()),
  onDidChangeWorkspaceFolders: vi.fn(() => makeDisposable()),
};
