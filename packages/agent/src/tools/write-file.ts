import * as fs from "fs";
import * as path from "path";
import type { AgentTool } from "./types.js";
import { encodeDiffPayload } from "../multi/diff-renderer.js";
import { checkSensitivePath, validatePath } from "../permissions/sandbox.js";

export const writeFileTool: AgentTool = {
  name: "write_file",
  description: "Write content to a file, creating parent directories as needed. Use for new files only — prefer edit_file for modifying existing files. Overwrites existing content entirely.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write." },
      content: { type: "string", description: "Content to write." },
    },
    required: ["path", "content"],
  },
  async execute(input) {
    const filePath = input.path as string;
    const content = input.content as string;

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

    const oldContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);

    const msg = `Wrote ${content.length} bytes to ${filePath}`;
    if (oldContent) {
      return { output: msg + encodeDiffPayload(filePath, oldContent, content) };
    }
    return { output: msg };
  },
};
