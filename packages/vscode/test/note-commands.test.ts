import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerNoteCommands } from "../src/commands/note-commands";
import { fakeClient, fakeExtensionContext, ok } from "./test-helpers";

function handlerFor(commandId: string): (...args: unknown[]) => unknown {
  const call = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === commandId);
  if (!call) throw new Error(`"${commandId}" was never registered`);
  return call[1] as (...args: unknown[]) => unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  vscode.window.activeTextEditor = undefined;
});

describe("note-commands: addNote / project resolution", () => {
  it("uses the node's projectName directly", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerNoteCommands(ctx);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("a note");

    await handlerFor("phren.addNote")({ projectName: "app" });

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(client.addNote).toHaveBeenCalledWith("app", "a note");
  });

  it("falls back to the active project from the status bar", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client, activeProjectName: "active-app" });
    registerNoteCommands(ctx);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("a note");

    await handlerFor("phren.addNote")();

    expect(client.listProjects).not.toHaveBeenCalled();
    expect(client.addNote).toHaveBeenCalledWith("active-app", "a note");
  });

  it("prompts from the project list, warning instead when there are none", async () => {
    const client = fakeClient({ listProjects: vi.fn(async () => ok({ projects: [] })) });
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerNoteCommands(ctx);

    await handlerFor("phren.addNote")();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith("No Phren projects found.");
    expect(client.addNote).not.toHaveBeenCalled();
  });

  it("shows an error rather than crashing when listing projects fails", async () => {
    const client = fakeClient({ listProjects: vi.fn(async () => { throw new Error("boom"); }) });
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerNoteCommands(ctx);

    await handlerFor("phren.addNote")();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to list projects: boom");
    expect(client.addNote).not.toHaveBeenCalled();
  });

  it("seeds the prompt with the active editor's selection and trims before sending", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client, activeProjectName: "app" });
    registerNoteCommands(ctx);
    vscode.window.activeTextEditor = { selection: { isEmpty: false }, document: { getText: () => "  a selection  " } };
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("  a note with spaces  ");

    await handlerFor("phren.addNote")();

    expect(vi.mocked(vscode.window.showInputBox).mock.calls[0][0]).toMatchObject({ value: "a selection" });
    expect(client.addNote).toHaveBeenCalledWith("app", "a note with spaces");
  });

  it("aborts on empty input and refreshes + informs on success", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client, activeProjectName: "app" });
    registerNoteCommands(ctx);

    vi.mocked(vscode.window.showInputBox).mockResolvedValue("   ");
    await handlerFor("phren.addNote")();
    expect(client.addNote).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showInputBox).mockResolvedValue("real note");
    await handlerFor("phren.addNote")();
    expect(ctx.treeDataProvider.refresh).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Note added to app.");
  });

  it("shows an error and skips refresh when addNote itself fails", async () => {
    const client = fakeClient({ addNote: vi.fn(async () => { throw new Error("disk full"); }) });
    const ctx = fakeExtensionContext({ phrenClient: client, activeProjectName: "app" });
    registerNoteCommands(ctx);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("note");

    await handlerFor("phren.addNote")();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to add note: disk full");
    expect(ctx.treeDataProvider.refresh).not.toHaveBeenCalled();
  });
});

describe("note-commands: openNote", () => {
  it("is a no-op when there is no note (e.g. stale command palette invocation)", async () => {
    const ctx = fakeExtensionContext();
    registerNoteCommands(ctx);

    await handlerFor("phren.openNote")(undefined);

    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it("opens a markdown preview document containing the project, timestamp, id, and text", async () => {
    const ctx = fakeExtensionContext();
    registerNoteCommands(ctx);
    const doc = { uri: "untitled:note" };
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(doc as never);

    await handlerFor("phren.openNote")({
      projectName: "app", id: "n1", date: "2026-01-01", time: "14:30:00", text: "the note body", promoted: false,
    });

    const arg = vi.mocked(vscode.workspace.openTextDocument).mock.calls[0][0] as { content: string };
    expect(arg.content).toContain("app note");
    expect(arg.content).toContain("2026-01-01 14:30");
    expect(arg.content).toContain("n1");
    expect(arg.content).toContain("the note body");
    expect(arg.content).not.toContain("promoted");
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(doc, { preview: true });
  });

  it("marks promoted notes in the opened content", async () => {
    const ctx = fakeExtensionContext();
    registerNoteCommands(ctx);
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({} as never);

    await handlerFor("phren.openNote")({
      projectName: "app", id: "n1", date: "2026-01-01", time: "14:30:00", text: "x", promoted: true,
    });

    const arg = vi.mocked(vscode.workspace.openTextDocument).mock.calls[0][0] as { content: string };
    expect(arg.content).toContain("promoted");
  });
});

describe("note-commands: editNote", () => {
  const note = { projectName: "app", id: "n1", date: "2026-01-01", time: "10:00:00", text: "original text", promoted: false };

  it("warns instead of prompting when invoked without a note", async () => {
    const ctx = fakeExtensionContext();
    registerNoteCommands(ctx);

    await handlerFor("phren.editNote")(undefined);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith("Edit Note is available from a note in the Phren explorer.");
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it("seeds the prompt with the current text", async () => {
    const ctx = fakeExtensionContext();
    registerNoteCommands(ctx);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("original text");

    await handlerFor("phren.editNote")(note);

    expect(vi.mocked(vscode.window.showInputBox).mock.calls[0][0]).toMatchObject({ value: "original text" });
  });

  it("does not call the client when the text is unchanged or empty", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerNoteCommands(ctx);

    vi.mocked(vscode.window.showInputBox).mockResolvedValue("original text"); // unchanged
    await handlerFor("phren.editNote")(note);
    expect(client.editNote).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showInputBox).mockResolvedValue("   "); // empty
    await handlerFor("phren.editNote")(note);
    expect(client.editNote).not.toHaveBeenCalled();
  });

  it("calls editNote with the trimmed new text when it actually changed", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerNoteCommands(ctx);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("  updated text  ");

    await handlerFor("phren.editNote")(note);

    expect(client.editNote).toHaveBeenCalledWith("app", "n1", "updated text");
    expect(ctx.treeDataProvider.refresh).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Updated n1.");
  });
});

describe("note-commands: removeNote", () => {
  const note = { projectName: "app", id: "n1", date: "2026-01-01", time: "10:00:00", text: "t", promoted: false };

  it("is a silent no-op without a note", async () => {
    const ctx = fakeExtensionContext();
    registerNoteCommands(ctx);

    await handlerFor("phren.removeNote")(undefined);

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("requires the modal confirmation to say exactly Remove", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerNoteCommands(ctx);

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined);
    await handlerFor("phren.removeNote")(note);
    expect(client.removeNote).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Remove");
    await handlerFor("phren.removeNote")(note);
    expect(client.removeNote).toHaveBeenCalledWith("app", "n1");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Removed n1.");
  });
});

describe("note-commands: promoteNote", () => {
  const note = { projectName: "app", id: "n1", date: "2026-01-01", time: "10:00:00", text: "t", promoted: false };

  it("is a no-op without a note and aborts if the type quickpick is cancelled", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerNoteCommands(ctx);

    await handlerFor("phren.promoteNote")(undefined);
    expect(client.promoteNote).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);
    await handlerFor("phren.promoteNote")(note);
    expect(client.promoteNote).not.toHaveBeenCalled();
  });

  it('"No type" promotes without a findingType', async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerNoteCommands(ctx);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: "No type", value: undefined });

    await handlerFor("phren.promoteNote")(note);

    expect(client.promoteNote).toHaveBeenCalledWith("app", "n1", undefined);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Promoted n1 to a finding.");
  });

  it("passes the chosen finding type through", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerNoteCommands(ctx);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: "pitfall", value: "pitfall" });

    await handlerFor("phren.promoteNote")(note);

    expect(client.promoteNote).toHaveBeenCalledWith("app", "n1", "pitfall");
  });

  it("offers every promotable finding type in the quickpick", async () => {
    const ctx = fakeExtensionContext();
    registerNoteCommands(ctx);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await handlerFor("phren.promoteNote")(note);

    const items = vi.mocked(vscode.window.showQuickPick).mock.calls[0][0] as Array<{ label: string }>;
    expect(items.map((i) => i.label)).toEqual([
      "No type", "decision", "pitfall", "pattern", "tradeoff", "architecture", "bug",
    ]);
  });
});
