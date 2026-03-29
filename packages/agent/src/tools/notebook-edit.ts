/**
 * NotebookEdit tool — edit Jupyter notebook cells without raw JSON manipulation.
 *
 * Supports replace, insert, and delete operations on .ipynb files.
 */
import * as fs from "fs";
import * as path from "path";
import type { AgentTool } from "./types.js";

interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

export const notebookEditTool: AgentTool = {
  name: "notebook_edit",
  description:
    "Edit a Jupyter notebook (.ipynb) cell. Supports replacing a cell's content, inserting a new cell, " +
    "or deleting a cell. Safer and faster than editing raw JSON via shell.",
  input_schema: {
    type: "object",
    properties: {
      notebook_path: {
        type: "string",
        description: "Path to the .ipynb file.",
      },
      cell_number: {
        type: "number",
        description: "0-indexed cell number to edit. For insert, the new cell is placed at this position.",
      },
      edit_mode: {
        type: "string",
        enum: ["replace", "insert", "delete"],
        description: "replace: overwrite cell content. insert: add new cell at position. delete: remove cell.",
      },
      new_source: {
        type: "string",
        description: "New cell content (required for replace and insert, ignored for delete).",
      },
      cell_type: {
        type: "string",
        enum: ["code", "markdown"],
        description: "Cell type for insert mode. Default: code.",
      },
    },
    required: ["notebook_path", "cell_number", "edit_mode"],
  },
  async execute(input) {
    const nbPath = input.notebook_path as string;
    const cellNum = input.cell_number as number;
    const mode = input.edit_mode as "replace" | "insert" | "delete";
    const newSource = (input.new_source as string) || "";
    const cellType = (input.cell_type as "code" | "markdown") || "code";

    if (!fs.existsSync(nbPath)) {
      return { output: `Notebook not found: ${nbPath}`, is_error: true };
    }

    if (!nbPath.endsWith(".ipynb")) {
      return { output: "Not a notebook file (must end in .ipynb)", is_error: true };
    }

    let nb: Notebook;
    try {
      nb = JSON.parse(fs.readFileSync(nbPath, "utf-8"));
    } catch {
      return { output: "Failed to parse notebook JSON", is_error: true };
    }

    if (!Array.isArray(nb.cells)) {
      return { output: "Invalid notebook: no cells array", is_error: true };
    }

    const sourceLines = newSource.split("\n").map((l, i, arr) =>
      i < arr.length - 1 ? l + "\n" : l,
    );

    switch (mode) {
      case "replace": {
        if (cellNum < 0 || cellNum >= nb.cells.length) {
          return { output: `Cell ${cellNum} out of range (0-${nb.cells.length - 1})`, is_error: true };
        }
        nb.cells[cellNum].source = sourceLines;
        // Clear outputs for code cells on replace
        if (nb.cells[cellNum].cell_type === "code") {
          nb.cells[cellNum].outputs = [];
          nb.cells[cellNum].execution_count = null;
        }
        break;
      }
      case "insert": {
        if (cellNum < 0 || cellNum > nb.cells.length) {
          return { output: `Insert position ${cellNum} out of range (0-${nb.cells.length})`, is_error: true };
        }
        const newCell: NotebookCell = {
          cell_type: cellType,
          source: sourceLines,
          metadata: {},
        };
        if (cellType === "code") {
          newCell.outputs = [];
          newCell.execution_count = null;
        }
        nb.cells.splice(cellNum, 0, newCell);
        break;
      }
      case "delete": {
        if (cellNum < 0 || cellNum >= nb.cells.length) {
          return { output: `Cell ${cellNum} out of range (0-${nb.cells.length - 1})`, is_error: true };
        }
        nb.cells.splice(cellNum, 1);
        break;
      }
    }

    fs.writeFileSync(nbPath, JSON.stringify(nb, null, 1) + "\n");

    const action = mode === "replace" ? "Replaced" : mode === "insert" ? "Inserted" : "Deleted";
    return {
      output: `${action} cell ${cellNum} in ${path.basename(nbPath)} (${nb.cells.length} cells total)`,
    };
  },
};
