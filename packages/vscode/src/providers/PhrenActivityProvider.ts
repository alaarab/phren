import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** One memory-lookup event, mirrored from the CLI's lookup-events.jsonl schema. */
interface LookupEvent {
  at: string;
  query?: string;
  project?: string;
  filename?: string;
  type?: string;
  path?: string;
  snippet?: string;
  source?: string;
}

const MAX_ITEMS = 60;
const DEBOUNCE_MS = 150;

/**
 * Tree view that surfaces phren's memory lookups in real time. It tails
 * `<storePath>/.runtime/lookup-events.jsonl` (written by the MCP search tool)
 * and refreshes whenever new events land, so you can watch phren land on
 * memories as it searches. Also notifies a listener (the status bar) of the
 * newest lookup for a transient "looking up …" flash.
 */
export class PhrenActivityProvider
  implements vscode.TreeDataProvider<LookupEvent>, vscode.Disposable
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    LookupEvent | undefined | null
  >();

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly logPath: string;
  private events: LookupEvent[] = [];
  private lastTopKey = "";
  private watcher?: fs.FSWatcher;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private onNewLookup?: (ev: LookupEvent) => void;

  constructor(storePath: string) {
    this.logPath = path.join(storePath, ".runtime", "lookup-events.jsonl");
    this.reload(false);
    this.startWatching();
  }

  /** Register a callback fired once per batch with the newest lookup event. */
  setOnNewLookup(cb: (ev: LookupEvent) => void): void {
    this.onNewLookup = cb;
  }

  getTreeItem(element: LookupEvent): vscode.TreeItem {
    const loc = `${element.project ?? "?"}/${element.filename ?? "?"}`;
    const item = new vscode.TreeItem(
      element.filename ?? loc,
      vscode.TreeItemCollapsibleState.None,
    );
    const when = relTime(element.at);
    item.description = element.query ? `“${element.query}” · ${when}` : when;
    item.iconPath = new vscode.ThemeIcon(iconForType(element.type));
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${loc}**`);
    if (element.type) md.appendMarkdown(`  \n_${element.type}_`);
    if (element.query) md.appendMarkdown(`  \nFound via: \`${element.query}\``);
    if (element.snippet) md.appendMarkdown(`\n\n${element.snippet}`);
    md.appendMarkdown(`\n\n_${when}_`);
    item.tooltip = md;
    item.contextValue = "phrenLookup";
    return item;
  }

  getChildren(element?: LookupEvent): LookupEvent[] {
    if (element) return [];
    return this.events;
  }

  refresh(): void {
    this.reload(true);
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  private startWatching(): void {
    const dir = path.dirname(this.logPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Best-effort; the directory will appear once phren writes its first event.
    }
    try {
      // Watch the .runtime directory (the file may not exist yet) and react only
      // to changes touching the lookup-events log.
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (!filename || path.basename(filename.toString()) === "lookup-events.jsonl") {
          this.scheduleReload();
        }
      });
    } catch {
      // fs.watch unsupported on this platform/path — the view still loads its
      // initial snapshot and refreshes manually via the refresh command.
    }
  }

  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.reload(true), DEBOUNCE_MS);
  }

  private reload(fireEvents: boolean): void {
    const next = this.readTail();
    const prevTop = this.lastTopKey;
    this.events = next;
    const newTop = next[0] ? keyOf(next[0]) : "";
    this.lastTopKey = newTop;
    if (fireEvents) {
      this.onDidChangeTreeDataEmitter.fire(undefined);
      if (next[0] && newTop !== prevTop && this.onNewLookup) {
        this.onNewLookup(next[0]);
      }
    }
  }

  private readTail(): LookupEvent[] {
    try {
      if (!fs.existsSync(this.logPath)) return [];
      const lines = fs.readFileSync(this.logPath, "utf8").split("\n").filter(Boolean);
      const recent = lines.slice(-MAX_ITEMS).reverse();
      const out: LookupEvent[] = [];
      for (const line of recent) {
        try {
          const parsed = JSON.parse(line) as LookupEvent;
          if (parsed && typeof parsed.at === "string") out.push(parsed);
        } catch {
          // Skip malformed lines.
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}

function keyOf(ev: LookupEvent): string {
  return `${ev.at}|${ev.project ?? ""}/${ev.filename ?? ""}`;
}

function iconForType(type?: string): string {
  switch (type) {
    case "findings":
      return "lightbulb";
    case "reference":
      return "book";
    case "task":
      return "checklist";
    case "skill":
      return "tools";
    case "summary":
    case "claude":
      return "file";
    default:
      return "search";
  }
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
