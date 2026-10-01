import type { AgentTool } from "./types.js";
import { validatePath } from "../permissions/sandbox.js";
import { ripgrepPath, runRipgrep, walkTree } from "./search-support.js";

const MAX_RESULTS = 500;
const MAX_WALK_FILES = 10000;
/** Stop reading `rg --files` here; the notice then says "more than". */
const MAX_RG_FILES = 100000;

/** Every file under `root` that ripgrep lists (.gitignore applied, hidden files included, not .git or node_modules), or null without ripgrep. */
async function listWithRipgrep(root: string, pattern: string, signal?: AbortSignal): Promise<{ matches: string[]; total: number; capped: boolean } | null> {
  const rg = ripgrepPath();
  if (!rg) return null;
  const matches: string[] = [];
  let total = 0;
  let capped = false;
  try {
    await runRipgrep(rg, ["--files", "--hidden", "--glob", "!.git", "--glob", "!node_modules", "--sort", "path"], root, (line) => {
      const rel = line.replace(/^\.[\\/]/, "");
      if (!matchGlob(pattern, rel)) return false;
      total++;
      if (matches.length < MAX_RESULTS) matches.push(rel);
      if (total >= MAX_RG_FILES) { capped = true; return true; }
      return false;
    }, signal);
  } catch {
    return null;
  }
  return { matches, total, capped };
}

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

export const globTool: AgentTool = {
  name: "glob",
  description: "Find files by glob pattern. Use to discover project structure, locate files by extension or name. Examples: '**/*.ts', 'src/**/*.test.js', '**/config.*'. Honours .gitignore, includes hidden files such as .github (not .git).",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match." },
      path: { type: "string", description: "Directory to search in. Default: cwd." },
    },
    required: ["pattern"],
  },
  async execute(input, signal) {
    const pattern = input.pattern as string;
    const searchPath = (input.path as string) || process.cwd();
    
    // Defense-in-depth: validate search path against sandbox
    const pathResult = validatePath(searchPath, process.cwd(), []);
    if (!pathResult.ok) {
      return { output: `Path outside sandbox: ${pathResult.error}`, is_error: true };
    }

    let matches: string[];
    let note = "";
    const listed = await listWithRipgrep(pathResult.resolved, pattern, signal);
    if (listed) {
      matches = listed.matches;
      if (listed.total > matches.length) note = `showing the first ${matches.length} of ${listed.capped ? "more than " : ""}${listed.total} matches; narrow the pattern or path`;
    } else {
      const walked = walkTree(searchPath, MAX_WALK_FILES, (rel) => matchGlob(pattern, rel));
      matches = walked.files.slice(0, MAX_RESULTS);
      if (walked.truncated) note = `searched the first ${MAX_WALK_FILES} files; narrow the path or pattern`;
      else if (walked.files.length > MAX_RESULTS) note = `showing the first ${MAX_RESULTS} of ${walked.files.length} matches; narrow the pattern or path`;
    }
    if (matches.length === 0) return { output: note ? `No files found (${note}).` : "No files found." };
    return { output: note ? `${matches.join("\n")}\n\n(${note})` : matches.join("\n") };
  },
};
