import * as vscode from "vscode";
import { PhrenClient } from "../phrenClient";
import { showSearchQuickPick } from "../searchQuickPick";
import { containingFolder, relativeInside } from "../pathUtils";

export const SEARCH_SELECTION_MAX_CHARS = 200;
export const FINDING_MAX_CHARS = 500;

export interface Citation {
  file?: string;
  line?: number;
  repo?: string;
}

/** Collapse a multi-line selection (indentation, newlines, tabs) to single spaces. */
export function collapseToOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Collapse to one line and cap at maxLength, without leaving a trailing space. */
export function truncateToOneLine(text: string, maxLength: number): string {
  const oneLine = collapseToOneLine(text);
  return oneLine.length > maxLength ? oneLine.slice(0, maxLength).trimEnd() : oneLine;
}

/**
 * The citation for a finding saved from the editor: the 1-based line the
 * selection starts on, plus the document's path. Inside a workspace folder the
 * path is relative and the folder travels as `repo`; a file outside every
 * folder is cited by absolute path with no `repo`. An unsaved (untitled)
 * document has no file to cite, so it yields no citation at all.
 */
export function buildCitation(
  documentUri: { fsPath: string; scheme?: string },
  selection: { start: { line: number } },
  workspaceFolderPath?: string,
): Citation | undefined {
  if (documentUri.scheme === "untitled") {
    return undefined;
  }

  const line = selection.start.line + 1;
  if (workspaceFolderPath) {
    const relative = relativeInside(workspaceFolderPath, documentUri.fsPath);
    if (relative) {
      return { file: relative, line, repo: workspaceFolderPath };
    }
  }

  return { file: documentUri.fsPath, line };
}

/** The selected text, or the word under the cursor when nothing is selected. */
function activeSelectionText(editor: vscode.TextEditor): string {
  if (!editor.selection.isEmpty) {
    return editor.document.getText(editor.selection);
  }
  const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
  return wordRange ? editor.document.getText(wordRange) : "";
}

/** The workspace folder holding the document, or undefined when no folder contains it. */
export function workspaceFolderPath(document: vscode.TextDocument): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return containingFolder(
    folders.map((folder) => folder.uri.fsPath),
    document.uri.fsPath,
  );
}

export function registerEditorCommands(context: vscode.ExtensionContext, client: PhrenClient): void {
  const searchSelection = vscode.commands.registerCommand("phren.searchSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    const text = editor ? truncateToOneLine(activeSelectionText(editor), SEARCH_SELECTION_MAX_CHARS) : "";
    if (!text) {
      await vscode.window.showWarningMessage("Select text or place the cursor on a word to search Phren memory.");
      return;
    }
    await showSearchQuickPick(client, text);
  });

  context.subscriptions.push(searchSelection);
}
