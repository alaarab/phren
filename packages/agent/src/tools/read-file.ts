import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { AgentTool } from "./types.js";
import { checkSensitivePath, validatePath } from "../permissions/sandbox.js";
import { looksLikeSecretsFile, scrubToolOutput } from "../permissions/privacy.js";

// ── Read deduplication ──────────────────────────────────────────────────
// Track file hashes per session to avoid re-sending unchanged content to LLM.
const readCache = new Map<string, { hash: string; lines: number }>();

/** Reset the read cache (call at session start). */
export function resetReadCache(): void {
  readCache.clear();
}

export const readFileTool: AgentTool = {
  name: "read_file",
  description: "Read file contents with numbered lines. Always read a file before editing it. Use offset/limit for large files to avoid overwhelming context.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path." },
      offset: { type: "number", description: "Line number to start from (1-based). Default: 1." },
      limit: { type: "number", description: "Max lines to read. Default: 2000." },
    },
    required: ["path"],
  },
  async execute(input) {
    const filePath = input.path as string;
    const offset = Math.max(1, (input.offset as number) || 1);
    const limit = Math.min(5000, (input.limit as number) || 2000);

    // Defense-in-depth: sensitive path check
    const resolved = path.resolve(filePath);
    const sensitive = checkSensitivePath(resolved);
    if (sensitive.sensitive) {
      return { output: `Access denied: ${sensitive.reason}`, is_error: true };
    }

    // Defense-in-depth: sandbox check
    const sandboxResult = validatePath(filePath, process.cwd(), []);
    if (!sandboxResult.ok) {
      return { output: `Path outside sandbox: ${sandboxResult.error}`, is_error: true };
    }

    if (!fs.existsSync(filePath)) return { output: `File not found: ${filePath}`, is_error: true };

    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, "utf-8");

    // Deduplication: if same file+range was read before and content unchanged, return stub
    const cacheKey = `${resolved}:${offset}:${limit}`;
    const contentHash = crypto.createHash("md5").update(content).digest("hex");
    const cached = readCache.get(cacheKey);
    if (cached && cached.hash === contentHash) {
      return {
        output: `(file unchanged since last read — ${cached.lines} lines, ${stat.size} bytes)`,
      };
    }

    // Privacy: detect secrets files and scrub their content
    if (looksLikeSecretsFile(content)) {
      const scrubbed = scrubToolOutput("read_file", content);
      const lines = scrubbed.split("\n");
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = selected.map((line, i) => `${offset + i}\t${line}`).join("\n");
      return {
        output: `⚠️ Sensitive file detected — secrets redacted:\n${numbered}`,
      };
    }

    const lines = content.split("\n");
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = selected.map((line, i) => `${offset + i}\t${line}`).join("\n");
    const truncated = selected.length < lines.length - (offset - 1);

    // Cache this read for dedup
    readCache.set(cacheKey, { hash: contentHash, lines: lines.length });

    return {
      output: truncated
        ? `${numbered}\n\n(${lines.length} total lines, showing ${offset}-${offset + selected.length - 1})`
        : numbered,
    };
  },
};
