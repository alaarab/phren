import * as fs from "fs";
import type { AgentTool } from "./types.js";

export const readFileTool: AgentTool = {
  name: "read_file",
  description: "Read the contents of a file. Returns numbered lines. Use offset and limit for large files.",
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

    if (!fs.existsSync(filePath)) return { output: `File not found: ${filePath}`, is_error: true };

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = selected.map((line, i) => `${offset + i}\t${line}`).join("\n");
    const truncated = selected.length < lines.length - (offset - 1);

    return {
      output: truncated
        ? `${numbered}\n\n(${lines.length} total lines, showing ${offset}-${offset + selected.length - 1})`
        : numbered,
    };
  },
};
