import * as fs from "fs";
import type { AgentTool } from "./types.js";

export const editFileTool: AgentTool = {
  name: "edit_file",
  description: "Edit a file by replacing an exact string match. The old_string must appear exactly once in the file.",
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

    if (!fs.existsSync(filePath)) return { output: `File not found: ${filePath}`, is_error: true };

    const content = fs.readFileSync(filePath, "utf-8");
    const count = content.split(oldStr).length - 1;

    if (count === 0) return { output: "old_string not found in file.", is_error: true };
    if (count > 1) return { output: `old_string found ${count} times — must be unique. Provide more context.`, is_error: true };

    fs.writeFileSync(filePath, content.replace(oldStr, newStr));
    return { output: `Edited ${filePath}` };
  },
};
