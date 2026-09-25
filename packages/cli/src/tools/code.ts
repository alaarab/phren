import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpContext, resolveStoreForProject } from "./types.js";
import type { OutlineEntry, UsageEntry } from "@phren/code";
import { loadCodePackage, CODE_PACKAGE_HINT } from "../modules/code-package.js";

/**
 * Read tools over the `code` module's local code index (stage 2).
 *
 * These answer questions about functions, types and variables from the project's own index instead of a grep
 * sweep: a definition, the references grouped by file, a file's outline, a
 * ranked search and the most and least used functions and types. Every tool lives in the
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
        "Find functions, methods, types (classes, structs, enums, interfaces) and variables in a project's code index by name, signature or doc text. Use this instead of grep when you want a declaration rather than raw text: results are ranked exact name, then prefix, then full-text relevance, then how often it is used, and each hit carries its kind, signature, doc and path:line. Pass `kind` to narrow to function, method, class, struct, enum, interface, type or variable.",
      inputSchema: z.object({
        project: z.string().describe("Project name, optionally store-qualified."),
        query: z.string().describe("A name, or words from its signature or doc comment."),
        kind: z.enum(["function", "method", "class", "struct", "enum", "interface", "type", "variable"]).optional().describe("Only this kind."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum hits. Defaults to 20."),
      }),
    },
    async ({ project: projectInput, query, kind, limit }) => {
      const code = await loadCodePackage(ctx.phrenPath);
      if (!code) return text(CODE_PACKAGE_HINT);
      const { search, formatSymbolLine } = code;
      const target = resolveTarget(ctx, projectInput);
      if ("error" in target) return text(target.error);
      const result = await search(target.store, target.project, query, kind, limit ?? 20);
      if (!result.available) return text(noIndex(target.project));
      if (result.value.length === 0) return text(`Nothing named or described "${query}" in ${target.project}.`);
      return text(`${target.project}: ${result.value.length} match(es) for "${query}"\n${result.value.map(formatSymbolLine).join("\n")}`);
    },
  );

  server.registerTool(
    "code_definition",
    {
      title: "◆ phren · code definition",
      description:
        "Go to where a function, method, type or variable is defined, from a project's code index. Use this instead of grep: it accepts `Foo`, `Foo.bar` and `bar()` forms and returns the file and lines, signature, doc comment, the last change (a blame hash and date, never a name), a short source snippet and any Phren findings linked to it. When a common name matches several declarations it prefers an exported, non-variable one and reports how many candidates there were.",
      inputSchema: z.object({
        project: z.string().describe("Project name, optionally store-qualified."),
        name: z.string().optional().describe("What to look up: Foo, Foo.bar or bar()."),
        symbol: z.string().optional().describe("Deprecated: use name. Accepted until @phren/cli 0.2.18."),
      }),
    },
    async ({ project: projectInput, name: nameInput, symbol: legacyName }) => {
      const symbol = nameInput ?? legacyName;
      if (!symbol) return text("Pass name: the function, type or variable to look up.");
      const code = await loadCodePackage(ctx.phrenPath);
      if (!code) return text(CODE_PACKAGE_HINT);
      const { definition, findingsCitingSymbol, formatCitingFinding } = code;
      const target = resolveTarget(ctx, projectInput);
      if ("error" in target) return text(target.error);
      const result = await definition(target.store, target.project, symbol);
      if (!result.available) return text(noIndex(target.project));
      if (!result.value) return text(`Nothing named "${symbol}" in ${target.project}.`);
      const { symbol: hit, candidates, snippet, blame } = result.value;
      const lines = [
        `${hit.file}:${hit.line}-${hit.endLine} ${hit.kind} ${hit.name}${hit.exported ? " (exported)" : ""}`,
        hit.signature,
        hit.doc,
        candidates > 1 ? `${candidates} candidates shared this name; showing the best.` : "",
        blame ? `last change ${blame.at} ${blame.authorHash.slice(0, 12)}` : "",
      ];
      const citing = findingsCitingSymbol(target.store, target.project, symbol);
      const findingsBlock = citing.length > 0 ? ["Findings", ...citing.map(formatCitingFinding)] : [];
      return text(compactLines([...lines, snippet, ...findingsBlock].filter(Boolean).join("\n")));
    },
  );

  server.registerTool(
    "code_references",
    {
      title: "◆ phren · code references",
      description:
        "Find every place a function, method, type or variable is used, from a project's code index, grouped by file. Use this instead of grep to answer who calls or uses it: it accepts `Foo`, `Foo.bar` and `bar()` forms and counts only uses the index could resolve to exactly one definition. Common-name ambiguity is reported as a candidate count.",
      inputSchema: z.object({
        project: z.string().describe("Project name, optionally store-qualified."),
        name: z.string().optional().describe("What to look up: Foo, Foo.bar or bar()."),
        symbol: z.string().optional().describe("Deprecated: use name. Accepted until @phren/cli 0.2.18."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum reference lines. Defaults to 200."),
      }),
    },
    async ({ project: projectInput, name: nameInput, symbol: legacyName, limit }) => {
      const symbol = nameInput ?? legacyName;
      if (!symbol) return text("Pass name: the function, type or variable to look up.");
      const code = await loadCodePackage(ctx.phrenPath);
      if (!code) return text(CODE_PACKAGE_HINT);
      const { references } = code;
      const target = resolveTarget(ctx, projectInput);
      if ("error" in target) return text(target.error);
      const result = await references(target.store, target.project, symbol, limit ?? 200);
      if (!result.available) return text(noIndex(target.project));
      if (!result.value) return text(`Nothing named "${symbol}" in ${target.project}.`);
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
        "List a file's functions, types and variables in source order, methods nested under their class or container. Use this before reading a large file: it is far cheaper than opening the source and it shows the structure with each declaration's line, signature and doc. The path is the project-relative path the index uses.",
      inputSchema: z.object({
        project: z.string().describe("Project name, optionally store-qualified."),
        path: z.string().describe("Project-relative file path, as stored in the index."),
      }),
    },
    async ({ project: projectInput, path: filePath }) => {
      const code = await loadCodePackage(ctx.phrenPath);
      if (!code) return text(CODE_PACKAGE_HINT);
      const { outline } = code;
      const target = resolveTarget(ctx, projectInput);
      if ("error" in target) return text(target.error);
      const result = await outline(target.store, target.project, filePath);
      if (!result.available) return text(noIndex(target.project));
      if (result.value.length === 0) return text(`No functions, types or variables indexed for ${filePath} in ${target.project}.`);
      const count = result.value.reduce((n, entry) => n + 1 + countOutline(entry.children), 0);
      return text(`${target.project}/${filePath} (${count} declarations)\n${outlineLines(result.value).join("\n")}`);
    },
  );

  server.registerTool(
    "code_usage",
    {
      title: "◆ phren · code usage",
      description:
        "Show a project's most used and least used functions and types, by how many places use them. Use this instead of grep to see what code is central and what is barely used: it returns the top and bottom N so rarely used code is visible too. Local variables are left out of the most-used list so a busy one-function local or a one-letter loop name cannot dominate it.",
      inputSchema: z.object({
        project: z.string().describe("Project name, optionally store-qualified."),
        top: z.number().int().min(1).max(100).optional().describe("How many most used and how many least used. Defaults to 10."),
      }),
    },
    async ({ project: projectInput, top }) => {
      const code = await loadCodePackage(ctx.phrenPath);
      if (!code) return text(CODE_PACKAGE_HINT);
      const { usage } = code;
      const target = resolveTarget(ctx, projectInput);
      if ("error" in target) return text(target.error);
      const result = await usage(target.store, target.project, top ?? 10);
      if (!result.available) return text(noIndex(target.project));
      const { top: hot, bottom: cold } = result.value;
      const section = (label: string, entries: UsageEntry[]) =>
        entries.length === 0 ? `${label}\nnone` : `${label}\n${entries.map(usageLine).join("\n")}`;
      return text(`${target.project} functions and types by how many places use them\n${section("most used", hot)}\n${section("least used", cold)}`);
    },
  );
}

function countOutline(entries: OutlineEntry[]): number {
  return entries.reduce((sum, entry) => sum + 1 + countOutline(entry.children), 0);
}
