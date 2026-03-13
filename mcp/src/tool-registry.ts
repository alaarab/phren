import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

export interface ToolMetadata {
  name: string;
  title?: string;
  description: string;
  module: string;
  category: string;
}

const CATEGORY_BY_MODULE: Record<string, string> = {
  "mcp-search": "Search and browse",
  "mcp-tasks": "Task management",
  "mcp-finding": "Finding capture",
  "mcp-memory": "Memory quality",
  "mcp-data": "Data management",
  "mcp-graph": "Entities and graph",
  "mcp-session": "Session management",
  "mcp-ops": "Operations and review",
  "mcp-skills": "Skills management",
  "mcp-hooks": "Hooks management",
  "mcp-extract": "Extraction",
};

const MODULE_ORDER = Object.keys(CATEGORY_BY_MODULE);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function decodeStringLiteral(raw: string): string {
  return raw
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

function sourceDir(): string {
  return __dirname;
}

function parseModuleTools(moduleName: string, source: string): ToolMetadata[] {
  const tools: ToolMetadata[] = [];
  const pattern = /registerTool\(\s*"([^"]+)"\s*,\s*\{([\s\S]*?)\}\s*,/g;

  for (const match of source.matchAll(pattern)) {
    const [, name, configBlock] = match;
    const descMatch = configBlock.match(/description:\s*"((?:[^"\\]|\\.)*)"/s);
    if (!descMatch) continue;
    const titleMatch = configBlock.match(/title:\s*"((?:[^"\\]|\\.)*)"/s);
    tools.push({
      name,
      title: titleMatch ? decodeStringLiteral(titleMatch[1]) : undefined,
      description: decodeStringLiteral(descMatch[1]).replace(/\s+/g, " ").trim(),
      module: moduleName,
      category: CATEGORY_BY_MODULE[moduleName] || "Other",
    });
  }

  // Handle loop-registered tools: { tool: "name", ... } patterns followed by registerTool(action.tool, ...)
  const loopPattern = /for\s*\(const\s+(\w+)\s+of\s+\[([\s\S]*?)\]\s*(?:as\s+const\s*)?\)\s*\{\s*server\.registerTool\(\s*\1\.tool\s*,\s*\{([\s\S]*?)\}\s*,/g;
  for (const loopMatch of source.matchAll(loopPattern)) {
    const [, , itemsBlock, configBlock] = loopMatch;
    const itemPattern = /\{\s*tool:\s*"([^"]+)"[^}]*verb:\s*"([^"]+)"/g;
    for (const itemMatch of itemsBlock.matchAll(itemPattern)) {
      const [, toolName, verb] = itemMatch;
      const descMatch = configBlock.match(/description:\s*`\$\{[\w.]+\}\s*(.*?)`/s);
      const desc = descMatch ? `${verb} ${descMatch[1]}`.trim() : `${verb} operation`;
      tools.push({
        name: toolName,
        description: desc,
        module: moduleName,
        category: CATEGORY_BY_MODULE[moduleName] || "Other",
      });
    }
  }

  return tools;
}

export function getRegisteredTools(): ToolMetadata[] {
  const dir = sourceDir();
  const entries: ToolMetadata[] = [];

  for (const moduleName of MODULE_ORDER) {
    const tsPath = path.join(dir, `${moduleName}.ts`);
    const jsPath = path.join(dir, `${moduleName}.js`);
    const sourcePath = fs.existsSync(tsPath) ? tsPath : jsPath;
    if (!fs.existsSync(sourcePath)) continue;
    entries.push(...parseModuleTools(moduleName, fs.readFileSync(sourcePath, "utf8")));
  }

  return entries;
}

export function getToolCount(): number {
  return getRegisteredTools().length;
}

export function getToolsByCategory(): Array<{ category: string; tools: ToolMetadata[] }> {
  const grouped = new Map<string, ToolMetadata[]>();
  for (const tool of getRegisteredTools()) {
    const items = grouped.get(tool.category) || [];
    items.push(tool);
    grouped.set(tool.category, items);
  }
  return MODULE_ORDER
    .map((moduleName) => CATEGORY_BY_MODULE[moduleName])
    .filter((category, index, all) => all.indexOf(category) === index)
    .map((category) => ({
      category,
      tools: (grouped.get(category) || []).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((entry) => entry.tools.length > 0);
}

export function renderToolCatalogMarkdown(): string {
  return getToolsByCategory()
    .map(({ category, tools }) => {
      const lines = tools.map((tool) => `- \`${tool.name}\`: ${tool.description}`);
      return `**${category}:**\n${lines.join("\n")}`;
    })
    .join("\n\n");
}
