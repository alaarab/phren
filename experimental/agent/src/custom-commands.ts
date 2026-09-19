import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentConfigDir, agentUserDir } from "./config.js";

export interface CustomCommand {
  name: string;
  description?: string;
  body: string;
  source: "project" | "user";
  path: string;
}

export interface CustomCommandInfo {
  name: string;
  description?: string;
}

export function parseCommandMarkdown(raw: string): { description?: string; body: string } {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { body: normalized.trim() };
  const frontmatter = match[1];
  const body = normalized.slice(match[0].length).trim();
  let description: string | undefined;
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = line.match(/^description\s*:\s*(.*)$/);
    if (m) {
      description = m[1].trim().replace(/^["']|["']$/g, "");
      break;
    }
  }
  return { description, body };
}

export function substituteArguments(body: string, args: string): string {
  const trimmed = args.trim();
  const tokens = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  let out = body.replace(/\$ARGUMENTS\b/g, trimmed);
  out = out.replace(/\$([1-9])\b/g, (_match, index: string) => tokens[Number(index) - 1] ?? "");
  return out;
}

export function expandCustomCommand(command: CustomCommand, args: string): string {
  return substituteArguments(command.body, args).trim();
}

export function loadCustomCommands(cwd = process.cwd(), options: { home?: string } = {}): CustomCommand[] {
  const home = options.home ?? os.homedir();
  const sources: Array<{ dir: string; source: "project" | "user" }> = [
    { dir: path.join(agentUserDir(home), "commands"), source: "user" },
    { dir: path.join(agentConfigDir(cwd), "commands"), source: "project" },
  ];
  const byName = new Map<string, CustomCommand>();
  for (const { dir, source } of sources) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const name = entry.slice(0, -3).trim();
      if (!name) continue;
      const file = path.join(dir, entry);
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      const { description, body } = parseCommandMarkdown(raw);
      byName.set(name, { name, description, body, source, path: file });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function customCommandInfos(commands: CustomCommand[]): CustomCommandInfo[] {
  return commands.map((command) => ({ name: command.name, description: command.description }));
}
