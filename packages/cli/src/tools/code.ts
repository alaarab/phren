import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpContext, resolveStoreForProject } from "./types.js";
import {
  definition,
  formatSymbolLine,
  outline,
  references,
  search,
  usage,
  type OutlineEntry,
  type UsageEntry,
} from "../code/query.js";

/**
 * Read tools over the `code` module's local symbol index (stage 2).
 *
 * These answer symbol questions from the project's own index instead of a grep
 * sweep: a definition, the references grouped by file, a file's outline, a
 * ranked search and the hottest and coldest symbols. Every tool lives in the
 * `code` module, so it is absent until the module is enabled and the project is
 * indexed; the result is compact text, one line per hit, not a JSON dump.
 */

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function noIndex(project: string): string {
  return `No code index for "${project}". Build one with: phren code index ${project}`;
}

function resolveTarget(ctx: McpContext, projectInput: string): { store: string; project: string } | { error: string } {
  try {
    const { phrenPath, project } = resolveStoreForProject(ctx, projectInput, "read");
    return { store: phrenPath, project };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function compactLines(textValue: string): string {
  return textValue.split("\n").filter(line => line.trim().length > 0).join("\n");
}

function outlineLines(entries: OutlineEntry[], depth = 0): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const signature = entry.signature ? ` ${entry.signature}` : "";
    const doc = entry.doc ? ` | ${entry.doc.split("\n")[0]}` : "";
    out.push(`${"  ".repeat(depth)}${entry.line} ${entry.kind} ${entry.name}${signature}${doc}`);
    out.push(...outlineLines(entry.children, depth + 1));
  }
  return out;
}

function usageLine(entry: UsageEntry): string {
  return `${entry.file}:${entry.line} ${entry.kind} ${entry.name} ${entry.uses}`;
}

export function register(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "code_search",
    {
      title: "◆ phren · code search",
      description:
        "Search a project's code index for symbols by name, signature or doc text. Use this instead of grep when you want a symbol (a function, class, method, type) rather than raw text: results are ranked exact name, then prefix, then full-text relevance, then usage count, and each hit carries its kind, signature, doc and path:line. Pass `kind` to narrow to function, method, class, struct, enum, interface, type or variable.",
      inputSchema: z.object({
        project: z.string().describe("Project name, optionally store-qualified."),
        query: z.string().describe("Symbol name or words from its signature or doc comment."),
        kind: z.enum(["function", "method", "class", "struct", "enum", "interface", "type", "variable"]).optional().describe("Only symbols of this kind."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum hits. Defaults to 20."),
      }),
    },
    async ({ project: projectInput, query, kind, limit }) => {
      const target = resolveTarget(ctx, projectInput);
      if ("error" in target) return text(target.error);
      const result = await search(target.store, target.project, query, kind, limit ?? 20);
      if (!result.available) return text(noIndex(target.project));
      if (result.value.length === 0) return text(`No symbols match "${query}" in ${target.project}.`);
      return text(`${target.project}: ${result.value.length} match(es) for "${query}"\n${result.value.map(formatSymbolLine).join("\n")}`);
    },
  );

  server.registerTool(
    "code_definition",
    {
      title: "◆ phren · code definition",
      description:
        "Go to a symbol's definition in a project's code index. Use this instead of grep to find where a function, class or method is declared: it accepts `Foo`, `Foo.bar` and `bar()` forms and returns the file and lines, signature, doc comment, the last change (a blame hash and date, never a name) and a short source snippet. When a common name matches several symbols it prefers an exported, non-variable declaration and reports how many candidates there were.",
      inputSchema: z.object({
        project: z.string().describe("Project name, optionally store-qualified."),
        symbol: z.string().describe("A symbol name: Foo, Foo.bar or bar()."),
      }),
    },
    async ({ project: projectInput, symbol }) => {
      const target = resolveTarget(ctx, projectInput);
      if ("error" in target) return text(target.error);
      const result = await definition(target.store, target.project, symbol);
      if (!result.available) return text(noIndex(target.project));
      if (!result.value) return text(`No symbol "${symbol}" in ${target.project}.`);
      const { symbol: hit, candidates, snippet, blame } = result.value;
      const lines = [
        `${hit.file}:${hit.line}-${hit.endLine} ${hit.kind} ${hit.name}${hit.exported ? " (exported)" : ""}`,
        hit.signature,
        hit.doc,
        candidates > 1 ? `${candidates} candidates shared this name; showing the best.` : "",
        blame ? `last change ${blame.at} ${blame.authorHash.slice(0, 12)}` : "",
      ];
      return text(compactLines([...lines, snippet].filter(Boolean).join("\n")));
    },
  );

  server.registerTool(
    "code_references",
    {
      title: "◆ phren · code references",
      description:
        "Find every resolved reference to a symbol in a project's code index, grouped by file. Use this instead of grep to answer who calls or uses a function, class or method: it accepts `Foo`, `Foo.bar` and `bar()` forms and counts only references the index could resolve to exactly one definition. Common-name ambiguity is reported as a candidate count.",
      inputSchema: z.object({
        project: z.string().describe("Project name, optionally store-qualified."),
        symbol: z.string().describe("A symbol name: Foo, Foo.bar or bar()."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum reference lines. Defaults to 200."),
      }),
    },
    async ({ project: projectInput, symbol, limit }) => {
      const target = resolveTarget(ctx, projectInput);
      if ("error" in target) return text(target.error);
      const result = await references(target.store, target.project, symbol, limit ?? 200);
      if (!result.available) return text(noIndex(target.project));
      if (!result.value) return text(`No symbol "${symbol}" in ${target.project}.`);
      const { symbol: hit, candidates, groups, total } = result.value;
      const header = `references for ${hit.name} (${hit.file}:${hit.line} ${hit.kind}), ${total} in ${groups.length} file(s)`;
      const note = candidates > 1 ? `\n${candidates} candidates shared this name; showing the best.` : "";
      if (groups.length === 0) return text(`${header}\nNo resolved references.${note}`);
      const body = groups.map(group => `${group.file}\n${group.references.map(ref => `  ${ref.line} ${ref.kind}`).join("\n")}`).join("\n");
      return text(`${header}${note}\n${body}`);
    },
  );

  server.registerTool(
    "code_outline",
    {
      title: "◆ phren · code outline",
      description:
        "List a file's symbols in source order, nested under their parent class or container. Use this before reading a large file: it is far cheaper than opening the source and it shows the structure (classes and their methods, top-level functions and types) with each symbol's line, signature and doc. The path is the project-relative path the index uses.",
      inputSchema: z.object({
        project: z.string().describe("Project name, optionally store-qualified."),
        path: z.string().describe("Project-relative file path, as stored in the index."),
      }),
    },
    async ({ project: projectInput, path: filePath }) => {
      const target = resolveTarget(ctx, projectInput);
      if ("error" in target) return text(target.error);
      const result = await outline(target.store, target.project, filePath);
      if (!result.available) return text(noIndex(target.project));
      if (result.value.length === 0) return text(`No indexed symbols for ${filePath} in ${target.project}.`);
      const count = result.value.reduce((n, entry) => n + 1 + countOutline(entry.children), 0);
      return text(`${target.project}/${filePath} (${count} symbols)\n${outlineLines(result.value).join("\n")}`);
    },
  );

  server.registerTool(
    "code_usage",
    {
      title: "◆ phren · code usage",
      description:
        "Show a project's hottest and coldest symbols by resolved-reference count. Use this instead of grep to see what code is central and what is barely used: it returns the top and bottom N so cold code is visible too. Local variables are excluded from the hot list so a busy one-function local or a one-letter loop name cannot dominate it.",
      inputSchema: z.object({
        project: z.string().describe("Project name, optionally store-qualified."),
        top: z.number().int().min(1).max(100).optional().describe("How many hot and how many cold symbols. Defaults to 10."),
      }),
    },
    async ({ project: projectInput, top }) => {
      const target = resolveTarget(ctx, projectInput);
      if ("error" in target) return text(target.error);
      const result = await usage(target.store, target.project, top ?? 10);
      if (!result.available) return text(noIndex(target.project));
      const { top: hot, bottom: cold } = result.value;
      const section = (label: string, entries: UsageEntry[]) =>
        entries.length === 0 ? `${label}\nnone` : `${label}\n${entries.map(usageLine).join("\n")}`;
      return text(`${target.project} symbols by reference count\n${section("hot", hot)}\n${section("cold", cold)}`);
    },
  );
}

function countOutline(entries: OutlineEntry[]): number {
  return entries.reduce((sum, entry) => sum + 1 + countOutline(entry.children), 0);
}
