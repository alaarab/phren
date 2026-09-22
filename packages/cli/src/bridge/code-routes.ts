import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { getProjectDirs } from "../shared.js";
import type { IndexResult, CodeStatus, OutlineEntry, ReferenceResult, SymbolDefinition, SymbolHit, UsageEntry } from "@phren/code";
import { CODE_PACKAGE_HINT, loadCodePackage } from "../modules/code-package.js";
const indexProject: typeof import("@phren/code").indexProject = async (store, ...args) => (await requireCodePackage(store)).indexProject(store, ...args);
import { isValidProjectName } from "../utils-paths.js";
import { errorMessage } from "../utils.js";
import { logger } from "../logger.js";
import { BridgeError } from "./protocol.js";
import type { ChangedFile } from "./changes.js";

export async function requireCodePackage(store?: string): Promise<typeof import("@phren/code")> {
  const code = await loadCodePackage(store);
  if (!code) throw new BridgeError(503, CODE_PACKAGE_HINT);
  return code;
}

/**
 * Read routes over the `code` module's local symbol index (stage 3).
 *
 * The phone's Code screen calls these over the Hook's HTTP pipe; each one is a
 * thin JSON formatter over `code/query.ts`, so the CLI, the MCP tools and the
 * phone all read the same index the same way. A project with no index is a 404
 * with the command that builds one. `CodeReindexer` follows the git module's
 * recorded change events and re-indexes the affected project after a short
 * debounce; a branch switch (HEAD changed) forces a full re-index.
 */

const KIND_VALUES = ["function", "method", "class", "struct", "enum", "interface", "type", "variable"] as const;

const projectSchema = z.string().min(1).max(100).refine(value => isValidProjectName(value), "Choose a valid project name.");
const querySchema = z.string().max(500);
const symbolSchema = z.string().min(1).max(500);
const pathSchema = z.string().min(1).max(4096).refine(value => !value.includes("\0") && !value.split("/").includes(".."), "Choose a valid file path.");
const kindSchema = z.enum(KIND_VALUES);
const limitSchema = z.coerce.number().int().min(1).max(500);
const topSchema = z.coerce.number().int().min(1).max(100);

/** The 404 a route throws when the project has no index on this computer. */
function noIndex(project: string): BridgeError {
  return new BridgeError(404, `No code index for "${project}" on this computer. Build one with: phren code index ${project}`);
}

/** The phone names a project and an optional query; both are validated here. */
export class CodeRoutes {
  constructor(private readonly store: string) {}

  async status(projectValue: string | null): Promise<CodeStatus> {
    const project = projectSchema.parse(projectValue ?? "");
    const result = await (await requireCodePackage(this.store)).codeIndexStatus(this.store, project);
    if (!result.available) throw noIndex(project);
    return result;
  }

  async search(projectValue: string | null, queryValue: string | null, kindValue: string | null, limitValue: string | null): Promise<{ project: string; query: string; symbols: SymbolHit[] }> {
    const project = projectSchema.parse(projectValue ?? "");
    const query = querySchema.parse(queryValue ?? "");
    const kind = kindValue === null || kindValue === "" ? undefined : kindSchema.parse(kindValue);
    const limit = limitValue === null || limitValue === "" ? undefined : limitSchema.parse(limitValue);
    const result = await (await requireCodePackage(this.store)).search(this.store, project, query, kind, limit ?? 20);
    if (!result.available) throw noIndex(project);
    return { project, query, symbols: result.value };
  }

  async outline(projectValue: string | null, pathValue: string | null): Promise<{ project: string; path: string; entries: OutlineEntry[] }> {
    const project = projectSchema.parse(projectValue ?? "");
    const file = pathSchema.parse(pathValue ?? "");
    const result = await (await requireCodePackage(this.store)).outline(this.store, project, file);
    if (!result.available) throw noIndex(project);
    return { project, path: file, entries: result.value };
  }

  async definition(projectValue: string | null, symbolValue: string | null): Promise<{ project: string; definition: SymbolDefinition & { findings: import("@phren/code").CitingFinding[] } }> {
    const project = projectSchema.parse(projectValue ?? "");
    const symbol = symbolSchema.parse(symbolValue ?? "");
    const result = await (await requireCodePackage(this.store)).definition(this.store, project, symbol);
    if (!result.available) throw noIndex(project);
    if (!result.value) throw new BridgeError(404, `No symbol "${symbol}" in ${project}.`);
    return { project, definition: { ...result.value, findings: (await requireCodePackage(this.store)).findingsCitingSymbol(this.store, project, symbol) } };
  }

  async references(projectValue: string | null, symbolValue: string | null, limitValue: string | null): Promise<{ project: string; references: ReferenceResult }> {
    const project = projectSchema.parse(projectValue ?? "");
    const symbol = symbolSchema.parse(symbolValue ?? "");
    const limit = limitValue === null || limitValue === "" ? undefined : limitSchema.parse(limitValue);
    const result = await (await requireCodePackage(this.store)).references(this.store, project, symbol, limit ?? 200);
    if (!result.available) throw noIndex(project);
    if (!result.value) throw new BridgeError(404, `No symbol "${symbol}" in ${project}.`);
    return { project, references: result.value };
  }

  async usage(projectValue: string | null, topValue: string | null): Promise<{ project: string; usage: { hot: UsageEntry[]; cold: UsageEntry[] } }> {
    const project = projectSchema.parse(projectValue ?? "");
    const top = topValue === null || topValue === "" ? undefined : topSchema.parse(topValue);
    const result = await (await requireCodePackage(this.store)).usage(this.store, project, top ?? 10);
    if (!result.available) throw noIndex(project);
    return { project, usage: { hot: result.value.top, cold: result.value.bottom } };
  }
}

export interface CodeReindexOptions {
  store: string;
  /** Index function; injectable so tests do not need the real parser. */
  index?: typeof indexProject;
  /** Where the one-line-per-run report goes; defaults to the CLI logger. */
  log?: (line: string) => void;
  /** How long to wait for the writes to settle. */
  debounceMs?: number;
}

/**
 * Re-indexes a project when the git module's change capture records a file
 * event inside it. The Hook only constructs this while the `code` module is on,
 * and only projects that already have an index are followed. A branch switch
 * (the repository's HEAD moved) upgrades the pending run to a full re-index.
 */
export class CodeReindexer {
  private readonly store: string;
  private readonly index: typeof indexProject;
  private readonly log: (line: string) => void;
  private readonly debounceMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingFull = new Set<string>();
  private readonly running = new Set<string>();
  private readonly rerun = new Set<string>();
  private readonly heads = new Map<string, string>();
  private closed = false;

  constructor(options: CodeReindexOptions) {
    this.store = options.store;
    this.index = options.index ?? indexProject;
    this.log = options.log ?? (line => logger.info("code", line));
    this.debounceMs = options.debounceMs ?? 500;
  }

  /** One recorded change event; schedules an incremental re-index of the project it belongs to. */
  record(files: ChangedFile[]): void {
    if (this.closed || files.length === 0) return;
    void this.recordAsync(files).catch(error => this.log(errorMessage(error)));
  }

  private async recordAsync(files: ChangedFile[]): Promise<void> {
    const projects = await this.indexedProjects();
    if (this.closed) return;
    for (const root of new Set(files.map(file => file.root))) {
      const project = projects.find(entry => entry.root === root);
      if (!project) continue;
      const head = readHead(root);
      const previous = this.heads.get(root);
      if (head !== undefined) this.heads.set(root, head);
      this.schedule(project.project, previous !== undefined && head !== undefined && previous !== head);
    }
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.rerun.clear();
    this.pendingFull.clear();
  }

  private async indexedProjects(): Promise<Array<{ project: string; root: string }>> {
    const { codeDatabasePath, resolveRepoRoot } = await requireCodePackage(this.store);
    const result: Array<{ project: string; root: string }> = [];
    for (const directory of getProjectDirs(this.store)) {
      const project = path.basename(directory);
      if (!fs.existsSync(codeDatabasePath(this.store, project))) continue;
      try {
        result.push({ project, root: fs.realpathSync(resolveRepoRoot(this.store, project)) });
      } catch { /* No checkout for this project on this computer. */ }
    }
    return result;
  }

  private schedule(project: string, full: boolean): void {
    if (this.closed) return;
    if (full) this.pendingFull.add(project);
    const existing = this.timers.get(project);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { this.timers.delete(project); void this.run(project); }, this.debounceMs);
    timer.unref?.();
    this.timers.set(project, timer);
  }

  private async run(project: string): Promise<void> {
    if (this.closed) return;
    // A run already in flight: let it finish, then take the newest event.
    if (this.running.has(project)) { this.rerun.add(project); return; }
    const full = this.pendingFull.delete(project);
    this.running.add(project);
    try {
      const result: IndexResult = await this.index(this.store, project, { full });
      this.log(`re-indexed ${project}${full ? " (full)" : ""}: ${result.parsed} parsed, ${result.symbols} symbols, ${result.durationMs} ms`);
    } catch (error) {
      this.log(`re-index of ${project} failed: ${errorMessage(error)}`);
    } finally {
      this.running.delete(project);
      if (this.rerun.delete(project)) this.schedule(project, false);
    }
  }
}

/** HEAD of the repository root, for branch-switch detection. A linked worktree's
 * `.git` is a file that points at its real git directory. */
function readHead(root: string): string | undefined {
  try {
    const dotGit = path.join(root, ".git");
    const gitDirectory = fs.statSync(dotGit).isDirectory()
      ? dotGit
      : (() => {
        const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
        return match ? path.resolve(root, match[1]) : undefined;
      })();
    if (!gitDirectory) return undefined;
    return fs.readFileSync(path.join(gitDirectory, "HEAD"), "utf8").trim();
  } catch {
    return undefined;
  }
}
