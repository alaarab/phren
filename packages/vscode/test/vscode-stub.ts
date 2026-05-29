// Minimal stand-in for the `vscode` module so the extension's pure-logic units
// (e.g. PhrenActivityProvider) can be exercised under vitest without launching
// an Electron Extension Host. Only the surface the code under test touches is
// implemented; extend as needed.

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
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

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

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
  constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}
