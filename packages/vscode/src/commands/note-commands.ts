import * as vscode from "vscode";
import { asArraySafe, asRecord, toErrorMessage, type ExtensionContext } from "../extensionContext";

interface NoteCommandNode {
  projectName: string;
  id: string;
  date: string;
  time: string;
  text: string;
  promoted: boolean;
}

async function chooseProject(ctx: ExtensionContext, node?: { projectName?: string }): Promise<string | undefined> {
  const active = node?.projectName || ctx.statusBar.getActiveProjectName();
  if (active) return active;
  try {
    const raw = await ctx.phrenClient.listProjects();
    const projects = asArraySafe(asRecord(asRecord(raw)?.data)?.projects)
      .map((entry) => asRecord(entry))
      .map((entry) => typeof entry?.name === "string" ? entry.name : undefined)
      .filter((name): name is string => Boolean(name));
    if (!projects.length) {
      await vscode.window.showWarningMessage("No Phren projects found.");
      return undefined;
    }
    return vscode.window.showQuickPick(projects, { placeHolder: "Select a project for the note" });
  } catch (error) {
    await vscode.window.showErrorMessage(`Failed to list projects: ${toErrorMessage(error)}`);
    return undefined;
  }
}

export function registerNoteCommands(ctx: ExtensionContext): vscode.Disposable[] {
  const { phrenClient, treeDataProvider } = ctx;

  const add = vscode.commands.registerCommand("phren.addNote", async (node?: { projectName?: string }) => {
    const project = await chooseProject(ctx, node);
    if (!project) return;
    const editor = vscode.window.activeTextEditor;
    const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).trim() : "";
    const text = await vscode.window.showInputBox({
      prompt: `Add a lightweight daily note to ${project}`,
      placeHolder: "A reminder, status update, observation, or scratch thought",
      value: selected,
    });
    if (!text?.trim()) return;
    try {
      await phrenClient.addNote(project, text.trim());
      treeDataProvider.refresh();
      await vscode.window.showInformationMessage(`Note added to ${project}.`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to add note: ${toErrorMessage(error)}`);
    }
  });

  const open = vscode.commands.registerCommand("phren.openNote", async (note?: NoteCommandNode) => {
    if (!note) return;
    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: `# ${note.projectName} note\n\n${note.date} ${note.time.slice(0, 5)} · ${note.id}${note.promoted ? " · promoted" : ""}\n\n${note.text}\n`,
    });
    await vscode.window.showTextDocument(document, { preview: true });
  });

  const edit = vscode.commands.registerCommand("phren.editNote", async (note?: NoteCommandNode) => {
    if (!note) {
      await vscode.window.showWarningMessage("Edit Note is available from a note in the Phren explorer.");
      return;
    }
    const text = await vscode.window.showInputBox({ prompt: `Edit ${note.id}`, value: note.text });
    if (!text?.trim() || text.trim() === note.text) return;
    try {
      await phrenClient.editNote(note.projectName, note.id, text.trim());
      treeDataProvider.refresh();
      await vscode.window.showInformationMessage(`Updated ${note.id}.`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to edit note: ${toErrorMessage(error)}`);
    }
  });

  const remove = vscode.commands.registerCommand("phren.removeNote", async (note?: NoteCommandNode) => {
    if (!note) return;
    const confirmed = await vscode.window.showWarningMessage(`Remove note ${note.id}?`, { modal: true }, "Remove");
    if (confirmed !== "Remove") return;
    try {
      await phrenClient.removeNote(note.projectName, note.id);
      treeDataProvider.refresh();
      await vscode.window.showInformationMessage(`Removed ${note.id}.`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to remove note: ${toErrorMessage(error)}`);
    }
  });

  const promote = vscode.commands.registerCommand("phren.promoteNote", async (note?: NoteCommandNode) => {
    if (!note) return;
    const choice = await vscode.window.showQuickPick([
      { label: "No type", value: undefined },
      ...["decision", "pitfall", "pattern", "tradeoff", "architecture", "bug"].map((value) => ({ label: value, value })),
    ], { placeHolder: "Optional finding type" });
    if (!choice) return;
    try {
      await phrenClient.promoteNote(note.projectName, note.id, choice.value);
      treeDataProvider.refresh();
      await vscode.window.showInformationMessage(`Promoted ${note.id} to a finding.`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to promote note: ${toErrorMessage(error)}`);
    }
  });

  return [add, open, edit, remove, promote];
}
