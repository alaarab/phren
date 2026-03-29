import * as fs from "fs";
import * as path from "path";
import type { AgentTool } from "./types.js";
import { validatePath } from "../permissions/sandbox.js";

function searchFile(filePath: string, regex: RegExp, context: number): string[] {
  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch { return []; }
  const lines = content.split("\n");
  const results: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      const start = Math.max(0, i - context);
      const end = Math.min(lines.length - 1, i + context);
      for (let j = start; j <= end; j++) {
        results.push(`${j + 1}\t${lines[j]}`);
      }
      if (end < lines.length - 1) results.push("--");
    }
  }
  return results;
}

function walkDir(dir: string, results: string[], maxFiles: number): void {
  if (results.length >= maxFiles) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (results.length >= maxFiles) return;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, results, maxFiles);
    else results.push(full);
  }
}

export const grepTool: AgentTool = {
  name: "grep",
  description: "Search file contents for a regex pattern. Returns matching lines with context.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for." },
      path: { type: "string", description: "File or directory to search. Default: cwd." },
      context: { type: "number", description: "Lines of context around matches. Default: 2." },
      glob: { type: "string", description: "File glob filter (e.g. '*.ts'). Default: all files." },
    },
    required: ["pattern"],
  },
  async execute(input) {
    const pattern = input.pattern as string;
    const searchPath = (input.path as string) || process.cwd();
    const context = (input.context as number) ?? 2;
    const fileGlob = input.glob as string | undefined;

    // Defense-in-depth: validate search path against sandbox
    const pathResult = validatePath(searchPath, process.cwd(), []);
    if (!pathResult.ok) {
      return { output: `Path outside sandbox: ${pathResult.error}`, is_error: true };
    }

    let regex: RegExp;
    try { regex = new RegExp(pattern, "i"); } catch {
      return { output: `Invalid regex: ${pattern}`, is_error: true };
    }

    const stat = fs.statSync(searchPath, { throwIfNoEntry: false });
    if (!stat) return { output: `Path not found: ${searchPath}`, is_error: true };

    if (stat.isFile()) {
      const results = searchFile(searchPath, regex, context);
      return { output: results.length > 0 ? `${searchPath}:\n${results.join("\n")}` : "No matches." };
    }

    const files: string[] = [];
    walkDir(searchPath, files, 5000);

    if (fileGlob) {
      const globRegex = new RegExp(
        fileGlob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"),
      );
      const filtered = files.filter((f) => globRegex.test(path.basename(f)));
      files.length = 0;
      files.push(...filtered);
    }

    const output: string[] = [];
    let matchCount = 0;
    for (const file of files) {
      if (matchCount > 100) break;
      const results = searchFile(file, regex, context);
      if (results.length > 0) {
        const rel = path.relative(searchPath, file);
        output.push(`${rel}:\n${results.join("\n")}`);
        matchCount++;
      }
    }

    return { output: output.length > 0 ? output.join("\n\n") : "No matches." };
  },
};
