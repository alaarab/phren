import * as fs from "fs";
import * as path from "path";
import type { AgentTool } from "./types.js";
import { encodeDiffPayload } from "../multi/diff-renderer.js";
import { checkSensitivePath, validatePath } from "../permissions/sandbox.js";

export const editFileTool: AgentTool = {
  name: "edit_file",
  description: "Edit a file by replacing an exact string match. Preferred over write_file for modifying existing files — only changes what's needed. The old_string must appear exactly once; include surrounding lines for uniqueness if needed.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit." },
      old_string: { type: "string", description: "Exact string to find and replace." },
      new_string: { type: "string", description: "Replacement string." },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(input) {
    const filePath = input.path as string;
    const oldStr = input.old_string as string;
    const newStr = input.new_string as string;

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

    const oldContent = fs.readFileSync(filePath, "utf-8");
    const count = oldContent.split(oldStr).length - 1;

    if (count === 0) return { output: "old_string not found in file.", is_error: true };
    if (count > 1) return { output: `old_string found ${count} times — must be unique. Provide more context.`, is_error: true };

    const newContent = oldContent.replace(oldStr, newStr);
    fs.writeFileSync(filePath, newContent);
    return { output: `Edited ${filePath}${encodeDiffPayload(filePath, oldContent, newContent)}` };
  },
};
