import * as path from "path";
import * as vscode from "vscode";
import { PhrenClient } from "../phrenClient";
import { showSearchQuickPick } from "../searchQuickPick";

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
 * selection starts on, the document's path relative to its workspace folder,
 * and that folder's path.
 */
export function buildCitation(
  documentUri: { fsPath: string },
  selection: { start: { line: number } },
  workspaceFolderPath?: string,
): Citation {
  const citation: Citation = { line: selection.start.line + 1 };
  if (!workspaceFolderPath) {
    return citation;
  }

  citation.repo = workspaceFolderPath;
  const relative = path.relative(workspaceFolderPath, documentUri.fsPath);
  // A document outside the folder (or on another root) has no meaningful
  // relative path, so the citation keeps only the line and the folder.
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    citation.file = relative;
  }
  return citation;
}

/** The selected text, or the word under the cursor when nothing is selected. */
function activeSelectionText(editor: vscode.TextEditor): string {
  if (!editor.selection.isEmpty) {
    return editor.document.getText(editor.selection);
  }
  const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
  return wordRange ? editor.document.getText(wordRange) : "";
}

/** The workspace folder holding the document, preferring an exact container in multi-root workspaces. */
export function workspaceFolderPath(document: vscode.TextDocument): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const containing = folders.find((folder) => {
    const relative = path.relative(folder.uri.fsPath, document.uri.fsPath);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  return (containing ?? folders[0]).uri.fsPath;
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
