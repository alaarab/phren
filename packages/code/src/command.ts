interface CliContext { phrenPath(): string }
import { defaultProjectForCwd, indexProject } from "./indexer.js";
import {
  definition,
  formatSymbolLine,
  outline,
  references,
  search,
  usage,
  type OutlineEntry,
} from "./query.js";
import { codeIndexStatus } from "./status.js";
import { findingsCitingSymbol, formatCitingFinding } from "./citations.js";

/**
 * The `phren code` subcommands.
 *
 * `index` and `status` maintain the index. Read commands
 * `search`, `outline`, `refs`, `def` and `usage` are thin formatters over
 * `query.ts`. The code module owns every one; the registry gate rejects them
 * while the module is disabled.
 */

interface ParsedArgs {
  positionals: string[];
  full: boolean;
  repoRoot?: string;
  top?: number;
  kind?: string;
  limit?: number;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function parseArgs(args: string[]): ParsedArgs | undefined {
  const parsed: ParsedArgs = { positionals: [], full: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--full") {
      parsed.full = true;
    } else if (arg === "--repo" || arg === "--path") {
      const value = args[++i];
      if (!value || value.startsWith("-")) return undefined;
      parsed.repoRoot = value;
    } else if (arg.startsWith("--repo=") || arg.startsWith("--path=")) {
      parsed.repoRoot = arg.slice(arg.indexOf("=") + 1);
    } else if (arg === "--top") {
      const value = parsePositiveInt(args[++i]);
      if (value === undefined) return undefined;
      parsed.top = value;
    } else if (arg.startsWith("--top=")) {
      const value = parsePositiveInt(arg.slice("--top=".length));
      if (value === undefined) return undefined;
      parsed.top = value;
    } else if (arg === "--kind") {
      const value = args[++i];
      if (!value || value.startsWith("-")) return undefined;
      parsed.kind = value;
    } else if (arg.startsWith("--kind=")) {
      parsed.kind = arg.slice("--kind=".length);
    } else if (arg === "--limit") {
      const value = parsePositiveInt(args[++i]);
      if (value === undefined) return undefined;
      parsed.limit = value;
    } else if (arg.startsWith("--limit=")) {
      const value = parsePositiveInt(arg.slice("--limit=".length));
      if (value === undefined) return undefined;
      parsed.limit = value;
    } else if (arg.startsWith("-")) {
      return undefined;
    } else {
      parsed.positionals.push(arg);
    }
  }
  return parsed;
}

const USAGE =
  "Usage: phren code index <project> [--full] [--repo <path>]\n" +
  "       phren code status <project> [--top <n>]\n" +
  "       phren code search <project> <query> [--kind k] [--limit n]\n" +
  "       phren code outline <project> <path>\n" +
  "       phren code refs <project> <symbol>\n" +
  "       phren code def <project> <symbol>\n" +
  "       phren code usage <project> [--top n]";

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function missingIndex(databasePath: string): void {
  console.log("Index    not built");
  console.log(`Expected ${databasePath}`);
}

function originSymbol(hit: { file: string; line: number; kind: string; name: string }): string {
  return `${hit.file}:${hit.line} ${hit.kind} ${hit.name}`;
}

function printOutline(entries: OutlineEntry[], indent = ""): void {
  for (const entry of entries) {
    const signature = entry.signature ? ` ${entry.signature}` : "";
    console.log(`${indent}${entry.line} ${entry.kind} ${entry.name}${signature}`);
    printOutline(entry.children, `${indent}  `);
  }
}

export async function runCodeCommand(args: string[], ctx: CliContext): Promise<number | void> {
  const [subcommand, ...rest] = args;
  const parsed = parseArgs(rest);
  if (!parsed) {
    console.error(USAGE);
    return 1;
  }
  const store = ctx.phrenPath();
  const positionals = parsed.positionals;
  const project = positionals[0] ?? defaultProjectForCwd();

  if (subcommand === "index") {
    const result = await indexProject(store, project, { repoRoot: parsed.repoRoot, full: parsed.full });
    console.log(`Project  ${result.project}`);
    console.log(`Repo     ${result.repoRoot}`);
    console.log(`Files    ${result.files}`);
    console.log(`Parsed   ${result.parsed}`);
    console.log(`Removed  ${result.removed}`);
    console.log(`Symbols  ${result.symbols}`);
    console.log(`Refs     ${result.references}`);
    console.log(`Time     ${formatDuration(result.durationMs)}`);
    console.log(`Database ${result.databasePath}`);
    return;
  }

  if (subcommand === "status") {
    const status = await codeIndexStatus(store, project, parsed.top ?? 10);
    if (!status.available) {
      console.log(`Project  ${status.project}`);
      missingIndex(status.databasePath);
      return;
    }
    console.log(`Project  ${status.project}`);
    console.log(`Files    ${status.files}`);
    console.log(`Symbols  ${status.symbols}`);
    console.log(`Refs     ${status.references}`);
    console.log(`Last     ${status.lastIndexedAt ? new Date(status.lastIndexedAt).toISOString() : "unknown"}`);
    if (status.languages.length > 0) {
      console.log(`Languages ${status.languages.map(entry => `${entry.language}:${entry.files}`).join(" ")}`);
    }
    if (status.kinds.length > 0) {
      console.log(`Kinds    ${status.kinds.map(entry => `${entry.kind}:${entry.symbols}`).join(" ")}`);
    }
    for (const symbol of status.top) {
      console.log(`Top      ${symbol.name} ${symbol.kind} ${symbol.uses} ${symbol.file}`);
    }
    return;
  }

  if (subcommand === "search") {
    const query = positionals.slice(1).join(" ");
    if (!query) { console.error(USAGE); return 1; }
    const result = await search(store, project, query, parsed.kind, parsed.limit ?? 20);
    if (!result.available) { missingIndex(result.databasePath); return; }
    if (result.value.length === 0) { console.log(`No symbols match "${query}" in ${project}.`); return; }
    console.log(`${project}: ${result.value.length} match(es) for "${query}"`);
    for (const hit of result.value) console.log(formatSymbolLine(hit));
    return;
  }

  if (subcommand === "outline") {
    const filePath = positionals[1];
    if (!filePath) { console.error(USAGE); return 1; }
    const result = await outline(store, project, filePath);
    if (!result.available) { missingIndex(result.databasePath); return; }
    if (result.value.length === 0) { console.log(`No indexed symbols for ${filePath} in ${project}.`); return; }
    console.log(`${project}/${filePath}`);
    printOutline(result.value);
    return;
  }

  if (subcommand === "refs") {
    const symbol = positionals[1];
    if (!symbol) { console.error(USAGE); return 1; }
    const result = await references(store, project, symbol, parsed.limit ?? 200);
    if (!result.available) { missingIndex(result.databasePath); return; }
    if (!result.value) { console.log(`No symbol "${symbol}" in ${project}.`); return; }
    const { symbol: hit, candidates, groups, total } = result.value;
    console.log(`references for ${hit.name} (${originSymbol(hit)}), ${total} in ${groups.length} file(s)`);
    if (candidates > 1) console.log(`${candidates} candidates shared this name; showing the best.`);
    if (groups.length === 0) { console.log("No resolved references."); return; }
    for (const group of groups) {
      console.log(group.file);
      for (const ref of group.references) console.log(`  ${ref.line} ${ref.kind}`);
    }
    return;
  }

  if (subcommand === "def") {
    const symbol = positionals[1];
    if (!symbol) { console.error(USAGE); return 1; }
    const result = await definition(store, project, symbol);
    if (!result.available) { missingIndex(result.databasePath); return; }
    if (!result.value) { console.log(`No symbol "${symbol}" in ${project}.`); return; }
    const { symbol: hit, candidates, snippet, blame } = result.value;
    console.log(`${hit.file}:${hit.line}-${hit.endLine} ${hit.kind} ${hit.name}${hit.exported ? " (exported)" : ""}`);
    if (hit.signature) console.log(hit.signature);
    if (hit.doc) console.log(hit.doc);
    if (candidates > 1) console.log(`${candidates} candidates shared this name; showing the best.`);
    if (blame) console.log(`last change ${blame.at} ${blame.authorHash.slice(0, 12)}`);
    if (snippet) { console.log(""); console.log(snippet); }
    const citing = findingsCitingSymbol(store, project, symbol);
    if (citing.length > 0) {
      console.log("");
      console.log("Findings");
      for (const finding of citing) console.log(formatCitingFinding(finding));
    }
    return;
  }

  if (subcommand === "usage") {
    const result = await usage(store, project, parsed.top ?? 10);
    if (!result.available) { missingIndex(result.databasePath); return; }
    const { top: hot, bottom: cold } = result.value;
    console.log(`${project} symbols by reference count`);
    console.log("hot");
    if (hot.length === 0) console.log("  none");
    for (const entry of hot) console.log(`  ${entry.name} ${entry.kind} ${entry.uses} ${entry.file}:${entry.line}`);
    console.log("cold");
    if (cold.length === 0) console.log("  none");
    for (const entry of cold) console.log(`  ${entry.name} ${entry.kind} ${entry.uses} ${entry.file}:${entry.line}`);
    return;
  }

  console.error(USAGE);
  return 1;
}
