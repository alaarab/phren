import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  buildCitation,
  collapseToOneLine,
  registerEditorCommands,
  truncateToOneLine,
  workspaceFolderPath,
} from "../src/commands/editor-commands";
import { fakeClient, ok } from "./test-helpers";

vi.mock("../src/searchQuickPick", () => ({ showSearchQuickPick: vi.fn() }));
import { showSearchQuickPick } from "../src/searchQuickPick";

function handlerFor(commandId: string): (...args: unknown[]) => unknown {
  const call = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === commandId);
  if (!call) throw new Error(`"${commandId}" was never registered`);
  return call[1] as (...args: unknown[]) => unknown;
}

function fakeContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

let setStatusBarMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vscode.window.activeTextEditor = undefined;
  vscode.workspace.workspaceFolders = undefined;
  setStatusBarMessage = vi.fn();
  (vscode.window as unknown as Record<string, unknown>).setStatusBarMessage = setStatusBarMessage;
});

describe("editor-commands: collapseToOneLine / truncateToOneLine", () => {
  it("collapses newlines, tabs and runs of spaces to single spaces and trims", () => {
    expect(collapseToOneLine("  a\n\t b   c\n")).toBe("a b c");
  });

  it("caps the collapsed text at maxLength without a trailing space", () => {
    expect(truncateToOneLine("alpha beta gamma", 9)).toBe("alpha bet");
    expect(truncateToOneLine("short", 20)).toBe("short");
  });
});

describe("editor-commands: buildCitation", () => {
  it("uses a 1-based line and a path relative to the workspace folder", () => {
    const citation = buildCitation(
      { fsPath: "/repo/src/a.ts" },
      { start: { line: 4 } },
      "/repo",
    );
    expect(citation).toEqual({ file: "src/a.ts", line: 5, repo: "/repo" });
  });

  it("cites the absolute path, with no repo, when the document is outside the folder", () => {
    const citation = buildCitation(
      { fsPath: "/elsewhere/a.ts" },
      { start: { line: 0 } },
      "/repo",
    );
    expect(citation).toEqual({ file: "/elsewhere/a.ts", line: 1 });
  });

  it("cites the absolute path, with no repo, when there is no workspace folder", () => {
    expect(buildCitation({ fsPath: "/repo/a.ts" }, { start: { line: 2 } })).toEqual({ file: "/repo/a.ts", line: 3 });
  });

  it("yields no citation for an unsaved (untitled) document", () => {
    expect(
      buildCitation({ fsPath: "Untitled-1", scheme: "untitled" }, { start: { line: 0 } }, "/repo"),
    ).toBeUndefined();
  });
});

describe("editor-commands: workspaceFolderPath", () => {
  it("returns the folder containing the document", () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "/repo" } }];
    const document = { uri: vscode.Uri.file("/repo/src/a.ts") } as unknown as vscode.TextDocument;
    expect(workspaceFolderPath(document)).toBe("/repo");
  });

  it("returns undefined when the document is outside every folder, not the first folder", () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: "/repo" } }];
    const document = { uri: vscode.Uri.file("/elsewhere/a.ts") } as unknown as vscode.TextDocument;
    expect(workspaceFolderPath(document)).toBeUndefined();
  });
});

describe("editor-commands: searchSelection", () => {
  it("searches the collapsed selection", async () => {
    const client = fakeClient();
    registerEditorCommands(fakeContext(), client);
    vscode.window.activeTextEditor = {
      selection: { isEmpty: false, start: { line: 0 } },
      document: { uri: vscode.Uri.file("/repo/a.ts"), getText: () => "line one\n  line two" },
    };

    await handlerFor("phren.searchSelection")();

    expect(showSearchQuickPick).toHaveBeenCalledWith(client, "line one line two");
  });

  it("warns instead of searching when nothing is selected or under the cursor", async () => {
    registerEditorCommands(fakeContext(), fakeClient());

    await handlerFor("phren.searchSelection")();

    expect(showSearchQuickPick).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "Select text or place the cursor on a word to search Phren memory.",
    );
  });
});
