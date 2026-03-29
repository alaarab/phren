import * as fs from "fs";
import * as path from "path";
import type { AgentTool } from "./types.js";
import { validatePath } from "../permissions/sandbox.js";

/** Simple glob matching without external dependencies. Supports * and ** patterns. */
function matchGlob(pattern: string, filePath: string): boolean {
  // Normalize path separators
  const p = pattern.replace(/\\/g, "/");
  const f = filePath.replace(/\\/g, "/");
  // Build regex: escape special chars, then convert glob tokens
  let regex = "";
  let i = 0;
  while (i < p.length) {
    if (p[i] === "*" && p[i + 1] === "*") {
      // ** matches any depth of directories
      regex += ".*";
      i += 2;
      if (p[i] === "/") i++; // skip trailing /
    } else if (p[i] === "*") {
      // * matches anything except /
      regex += "[^/]*";
      i++;
    } else if (p[i] === "?") {
      regex += "[^/]";
      i++;
    } else {
      // Escape regex special chars
      regex += p[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${regex}$`).test(f);
}

function walkDir(dir: string, base: string, results: string[], maxResults: number): void {
  if (results.length >= maxResults) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (results.length >= maxResults) return;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      walkDir(full, base, results, maxResults);
    } else {
      results.push(rel);
    }
  }
}

export const globTool: AgentTool = {
  name: "glob",
  description: "Find files by glob pattern. Use to discover project structure, locate files by extension or name. Examples: '**/*.ts', 'src/**/*.test.js', '**/config.*'. Skips node_modules and dotfiles.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match." },
      path: { type: "string", description: "Directory to search in. Default: cwd." },
    },
    required: ["pattern"],
  },
  async execute(input) {
    const pattern = input.pattern as string;
    const searchPath = (input.path as string) || process.cwd();
    const maxResults = 500;

    // Defense-in-depth: validate search path against sandbox
    const pathResult = validatePath(searchPath, process.cwd(), []);
    if (!pathResult.ok) {
      return { output: `Path outside sandbox: ${pathResult.error}`, is_error: true };
    }

    const allFiles: string[] = [];
    walkDir(searchPath, searchPath, allFiles, 10000);

    const matches = allFiles.filter((f) => matchGlob(pattern, f)).slice(0, maxResults);
    if (matches.length === 0) return { output: "No files found." };
    return { output: matches.join("\n") };
  },
};
