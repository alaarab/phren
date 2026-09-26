import * as fs from "fs";
import * as path from "path";
import type { AgentTool, AgentToolResult } from "./types.js";
import { encodeDiffPayload } from "../multi/diff-renderer.js";
import { checkSensitivePath, validatePath } from "../permissions/sandbox.js";
import { applyEdits, snippetAround, type EditSpec } from "./edit-engine.js";

/** Shared path checks and read for the edit tools. */
function openForEdit(filePath: unknown): { ok: true; filePath: string; content: string } | { ok: false; result: AgentToolResult } {
  if (typeof filePath !== "string" || filePath === "") {
    return { ok: false, result: { output: "path is required.", is_error: true } };
  }
  const sensitive = checkSensitivePath(path.resolve(filePath));
  if (sensitive.sensitive) return { ok: false, result: { output: `Access denied: ${sensitive.reason}`, is_error: true } };
  const sandboxResult = validatePath(filePath, process.cwd(), []);
  if (!sandboxResult.ok) return { ok: false, result: { output: `Path outside sandbox: ${sandboxResult.error}`, is_error: true } };
  if (!fs.existsSync(filePath)) {
    return { ok: false, result: { output: `File not found: ${filePath}. Use write_file to create a new file.`, is_error: true } };
  }
  if (fs.statSync(filePath).isDirectory()) {
    return { ok: false, result: { output: `${filePath} is a directory, not a file.`, is_error: true } };
  }
  return { ok: true, filePath, content: fs.readFileSync(filePath, "utf-8") };
}

function runEdits(filePath: unknown, edits: EditSpec[]): AgentToolResult {
  const opened = openForEdit(filePath);
  if (!opened.ok) return opened.result;
  const outcome = applyEdits(opened.content, edits);
  if (!outcome.ok) return { output: `${opened.filePath}: ${outcome.error}`, is_error: true };
  fs.writeFileSync(opened.filePath, outcome.content);
  const count = outcome.replacements === 1 ? "1 replacement" : `${outcome.replacements} replacements`;
  const note = outcome.note ? ` (${outcome.note})` : "";
  // The model sees a short numbered excerpt of the result; the diff payload
  // after DIFF_MARKER is for the TUI and is stripped before the model sees it.
  const snippet = snippetAround(outcome.content.replace(/\r\n/g, "\n"), outcome.firstLine, outcome.lastLine);
  return {
    output: `Edited ${opened.filePath}: ${count}${note}.\n${snippet}${encodeDiffPayload(opened.filePath, opened.content, outcome.content)}`,
  };
}

export const editFileTool: AgentTool = {
  name: "edit_file",
  description:
    "Edit a file by replacing an exact string. Preferred over write_file for existing files. old_string must match the file " +
    "exactly (copy it from read_file output without the line-number prefix) and must be unique unless replace_all is true; " +
    "include a few surrounding lines to make it unique. On failure the error shows the closest matching lines.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit." },
      old_string: { type: "string", description: "Exact text to find." },
      new_string: { type: "string", description: "Replacement text (must differ from old_string)." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match. Default false." },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(input) {
    return runEdits(input.path, [{
      old_string: input.old_string as string,
      new_string: input.new_string as string,
      replace_all: input.replace_all === true,
    }]);
  },
};

export const multiEditTool: AgentTool = {
  name: "multi_edit",
  description:
    "Apply several exact-string edits to one file in a single atomic call. Edits run in order, each against the result of " +
    "the previous one; if any edit fails, nothing is written. Same matching rules as edit_file.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit." },
      edits: {
        type: "array",
        description: "Edits to apply in order.",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["path", "edits"],
  },
  async execute(input) {
    const edits = input.edits;
    if (!Array.isArray(edits) || edits.length === 0) {
      return { output: "edits must be a non-empty array of {old_string, new_string, replace_all?}.", is_error: true };
    }
    return runEdits(input.path, edits.map((e) => {
      const edit = (e ?? {}) as Record<string, unknown>;
      return {
        old_string: edit.old_string as string,
        new_string: edit.new_string as string,
        replace_all: edit.replace_all === true,
      };
    }));
  },
};
