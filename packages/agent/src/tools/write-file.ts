import * as fs from "fs";
import * as path from "path";
import type { AgentTool } from "./types.js";
import { encodeDiffPayload } from "../multi/diff-renderer.js";

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
