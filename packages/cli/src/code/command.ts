import type { CliContext } from "../cli-registry.js";
import { defaultProjectForCwd, indexProject } from "./indexer.js";
import { codeIndexStatus } from "./status.js";

/**
 * `phren code index <project> [--full] [--repo <path>]` and
 * `phren code status <project>`. The code module owns both commands; the
 * registry gate rejects them while the module is disabled.
 */

interface ParsedArgs {
  project?: string;
  full: boolean;
  repoRoot?: string;
  top?: number;
}

function parseArgs(args: string[]): ParsedArgs | undefined {
  const parsed: ParsedArgs = { full: false };
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
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value <= 0) return undefined;
      parsed.top = Math.floor(value);
    } else if (arg.startsWith("--top=")) {
      const value = Number(arg.slice("--top=".length));
      if (!Number.isFinite(value) || value <= 0) return undefined;
      parsed.top = Math.floor(value);
    } else if (arg.startsWith("-")) {
      return undefined;
    } else if (parsed.project === undefined) {
      parsed.project = arg;
    } else {
      return undefined;
    }
  }
  return parsed;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export async function runCodeCommand(args: string[], ctx: CliContext): Promise<number | void> {
  const [subcommand, ...rest] = args;
  const parsed = parseArgs(rest);
  if (!parsed) {
    console.error("Usage: phren code index <project> [--full] [--repo <path>]\n       phren code status <project> [--top <n>]");
    return 1;
  }
  const store = ctx.phrenPath();
  const project = parsed.project ?? defaultProjectForCwd();

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
      console.log("Index    not built");
      console.log(`Expected ${status.databasePath}`);
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

  console.error("Usage: phren code index <project> [--full] [--repo <path>]\n       phren code status <project> [--top <n>]");
  return 1;
}
