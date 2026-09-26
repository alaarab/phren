import * as fs from "fs";
import * as path from "path";
import type { AgentTool } from "./types.js";
import { checkSensitivePath, validatePath } from "../permissions/sandbox.js";

/** Minified bundles and data files can have megabyte lines; cap each one. */
const MAX_LINE_CHARS = 2000;

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
    if (fs.statSync(filePath).isDirectory()) {
      return { output: `${filePath} is a directory. Use glob to list its files.`, is_error: true };
    }

    const buf = fs.readFileSync(filePath);
    if (buf.subarray(0, 8192).includes(0)) {
      return {
        output: `${filePath} looks binary (${buf.length} bytes); not shown. Use read_image for images, or a shell tool such as xxd for other binaries.`,
        is_error: true,
      };
    }
    const lines = buf.toString("utf-8").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    if (offset > lines.length) {
      return { output: `offset ${offset} is past the end of ${filePath} (${lines.length} lines).`, is_error: true };
    }
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    let clipped = 0;
    const numbered = selected
      .map((line, i) => {
        const text = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (text.length <= MAX_LINE_CHARS) return `${offset + i}\t${text}`;
        clipped++;
        return `${offset + i}\t${text.slice(0, MAX_LINE_CHARS)}… [line truncated: ${text.length} chars]`;
      })
      .join("\n");
    const end = offset + selected.length - 1;
    const notes: string[] = [];
    if (end < lines.length) {
      notes.push(`${lines.length} total lines, showing ${offset}-${end}; continue with offset ${end + 1}`);
    }
    if (clipped > 0) {
      notes.push(`${clipped} long line${clipped === 1 ? "" : "s"} truncated at ${MAX_LINE_CHARS} chars; use grep to see a specific line`);
    }

    return { output: notes.length > 0 ? `${numbered}\n\n(${notes.join("; ")})` : numbered };
  },
};
