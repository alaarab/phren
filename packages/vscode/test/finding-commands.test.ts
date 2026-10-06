import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerFindingCommands } from "../src/commands/finding-commands";
import { fakeClient, fakeExtensionContext, ok } from "./test-helpers";

vi.mock("../src/findingViewer", () => ({ showFindingDetail: vi.fn() }));
import { showFindingDetail } from "../src/findingViewer";

/** Grabs the callback registered for `commandId` via vscode.commands.registerCommand. */
function handlerFor(commandId: string): (...args: unknown[]) => unknown {
  const call = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === commandId);
  if (!call) throw new Error(`"${commandId}" was never registered`);
  return call[1] as (...args: unknown[]) => unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  vscode.window.activeTextEditor = undefined;
});

describe("finding-commands: addFinding", () => {
  it("uses the node's projectName directly, skipping project resolution entirely", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("a new finding");

    await handlerFor("phren.addFinding")({ projectName: "app" });

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(client.addFinding).toHaveBeenCalledWith("app", "a new finding");
    expect(ctx.treeDataProvider.refresh).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Finding added to app");
  });

  it("falls back to the status bar's active project when invoked with no node", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client, activeProjectName: "active-app" });
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("text");

    await handlerFor("phren.addFinding")();

    expect(client.listProjects).not.toHaveBeenCalled();
    expect(client.addFinding).toHaveBeenCalledWith("active-app", "text");
  });

  it("prompts from the project list when there is no node and no active project, and aborts if none exist", async () => {
    const client = fakeClient({ listProjects: vi.fn(async () => ok({ projects: [] })) });
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerFindingCommands(ctx);

    await handlerFor("phren.addFinding")();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith("No Phren projects found.");
    expect(client.addFinding).not.toHaveBeenCalled();
  });

  it("aborts quietly if the project quickpick is dismissed", async () => {
    const client = fakeClient({ listProjects: vi.fn(async () => ok({ projects: [{ name: "a" }] })) });
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await handlerFor("phren.addFinding")();

    expect(client.addFinding).not.toHaveBeenCalled();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it("shows an error (not a crash) when listing projects itself fails", async () => {
    const client = fakeClient({ listProjects: vi.fn(async () => { throw new Error("network down"); }) });
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerFindingCommands(ctx);

    await handlerFor("phren.addFinding")();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to list projects: network down");
  });

  it("seeds the input box with the active editor's selected text", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client, activeProjectName: "app" });
    registerFindingCommands(ctx);
    vscode.window.activeTextEditor = {
      selection: { isEmpty: false },
      document: { getText: () => "  selected snippet  " },
    };
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("selected snippet");

    await handlerFor("phren.addFinding")();

    expect(vi.mocked(vscode.window.showInputBox).mock.calls[0][0]).toMatchObject({ value: "selected snippet" });
  });

  it("does not call the client at all when the input is empty or whitespace-only", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client, activeProjectName: "app" });
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("   ");

    await handlerFor("phren.addFinding")();

    expect(client.addFinding).not.toHaveBeenCalled();
  });

  it("shows an error and does not refresh the tree when the addFinding call itself fails", async () => {
    const client = fakeClient({ addFinding: vi.fn(async () => { throw new Error("store locked"); }) });
    const ctx = fakeExtensionContext({ phrenClient: client, activeProjectName: "app" });
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("text");

    await handlerFor("phren.addFinding")();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Failed to add finding: store locked");
    expect(ctx.treeDataProvider.refresh).not.toHaveBeenCalled();
  });
});

describe("finding-commands: openFinding", () => {
  it("delegates straight to showFindingDetail with the client, the finding, and a refresh callback", () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerFindingCommands(ctx);
    const finding = { projectName: "app", id: "f1", date: "2026-01-01", text: "x" };

    handlerFor("phren.openFinding")(finding);

    expect(showFindingDetail).toHaveBeenCalledWith(client, finding, expect.any(Function));
    const refreshCb = vi.mocked(showFindingDetail).mock.calls[0][2] as () => void;
    refreshCb();
    expect(ctx.treeDataProvider.refresh).toHaveBeenCalled();
  });
});

describe("finding-commands: removeFinding", () => {
  it("from the tree (finding arg given): does nothing unless the modal confirmation is exactly Remove", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerFindingCommands(ctx);
    const finding = { projectName: "app", id: "f1", text: "the finding text" };
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined);

    await handlerFor("phren.removeFinding")(finding);
    expect(client.removeFinding).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Remove");
    await handlerFor("phren.removeFinding")(finding);
    expect(client.removeFinding).toHaveBeenCalledWith("app", "the finding text");
    expect(ctx.treeDataProvider.refresh).toHaveBeenCalled();
  });

  it("shows the modal with { modal: true } so it can't be dismissed by clicking away", async () => {
    const ctx = fakeExtensionContext();
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined);

    await handlerFor("phren.removeFinding")({ projectName: "app", id: "f1", text: "t" });

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Remove finding "f1"?',
      { modal: true },
      "Remove",
    );
  });

  it("from the palette (no finding arg): resolves a project, prompts for exact text, and aborts on empty input", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client, activeProjectName: "app" });
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("  ");

    await handlerFor("phren.removeFinding")();

    expect(client.removeFinding).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled(); // no modal confirm on this path
  });

  it("from the palette: a successful removal shows a generic message (no finding id known)", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client, activeProjectName: "app" });
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("exact text");

    await handlerFor("phren.removeFinding")();

    expect(client.removeFinding).toHaveBeenCalledWith("app", "exact text");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Finding removed.");
  });
});

describe("finding-commands: supersede/retract/resolveContradiction require a tree node", () => {
  it.each([
    ["phren.supersedeFinding", "Supersede Finding is available from the Phren explorer context menu."],
    ["phren.retractFinding", "Retract Finding is available from the Phren explorer context menu."],
    ["phren.resolveContradiction", "Resolve Contradiction is available from the Phren explorer context menu."],
  ])("%s warns instead of prompting when invoked from the command palette (no finding)", async (commandId, message) => {
    const ctx = fakeExtensionContext();
    registerFindingCommands(ctx);

    await handlerFor(commandId)(undefined);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(message);
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });
});

describe("finding-commands: supersedeFinding / retractFinding with a finding", () => {
  it("supersedeFinding trims the replacement text and refreshes on success", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("  newer finding  ");

    await handlerFor("phren.supersedeFinding")({ projectName: "app", id: "f1", text: "old finding" });

    expect(client.supersedeFinding).toHaveBeenCalledWith("app", "old finding", "newer finding");
    expect(ctx.treeDataProvider.refresh).toHaveBeenCalled();
  });

  it("retractFinding requires a non-empty reason", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("");

    await handlerFor("phren.retractFinding")({ projectName: "app", id: "f1", text: "t" });

    expect(client.retractFinding).not.toHaveBeenCalled();
  });
});

describe("finding-commands: resolveContradiction (two sequential prompts)", () => {
  it("never shows the resolution prompt if the first (contradicting-text) prompt is cancelled", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

    await handlerFor("phren.resolveContradiction")({ projectName: "app", id: "f1", text: "t" });

    expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
    expect(client.resolveContradiction).not.toHaveBeenCalled();
  });

  it("calls the client with both prompts' answers, trimmed", async () => {
    const client = fakeClient();
    const ctx = fakeExtensionContext({ phrenClient: client });
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce("  the other finding  ")
      .mockResolvedValueOnce("  keep the first  ");

    await handlerFor("phren.resolveContradiction")({ projectName: "app", id: "f1", text: "this finding" });

    expect(client.resolveContradiction).toHaveBeenCalledWith("app", "this finding", "the other finding", "keep the first");
  });
});

describe("finding-commands: filterFindingsByDate", () => {
  function fmt(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  it("does nothing when the quickpick is dismissed", async () => {
    const ctx = fakeExtensionContext();
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await handlerFor("phren.filterFindingsByDate")();

    expect(ctx.treeDataProvider.setDateFilter).not.toHaveBeenCalled();
  });

  it('"Clear filter" clears the date filter', async () => {
    const ctx = fakeExtensionContext();
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: "Clear filter" });

    await handlerFor("phren.filterFindingsByDate")();

    expect(ctx.treeDataProvider.setDateFilter).toHaveBeenCalledWith(undefined);
  });

  it('"Today" sets a same-day from/to range', async () => {
    const ctx = fakeExtensionContext();
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: "Today" });

    await handlerFor("phren.filterFindingsByDate")();

    const today = fmt(new Date());
    expect(ctx.treeDataProvider.setDateFilter).toHaveBeenCalledWith({ from: today, to: today, label: "Today" });
  });

  it('"Last 7 days" sets a 7-day range ending today', async () => {
    const ctx = fakeExtensionContext();
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: "Last 7 days" });

    await handlerFor("phren.filterFindingsByDate")();

    const today = new Date();
    const from = new Date(today);
    from.setDate(from.getDate() - 7);
    expect(ctx.treeDataProvider.setDateFilter).toHaveBeenCalledWith({ from: fmt(from), to: fmt(today), label: "Last 7 days" });
  });

  it('"Custom range..." validates YYYY-MM-DD and aborts if either prompt is cancelled', async () => {
    const ctx = fakeExtensionContext();
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: "Custom range..." });
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

    await handlerFor("phren.filterFindingsByDate")();

    expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
    expect(ctx.treeDataProvider.setDateFilter).not.toHaveBeenCalled();

    const validate = vi.mocked(vscode.window.showInputBox).mock.calls[0][0]!.validateInput!;
    expect(validate("2026-01-01")).toBeNull();
    expect(validate("01/01/2026")).toBe("Use YYYY-MM-DD format");
  });

  it('"Custom range..." sets from/to from both prompts when both are provided', async () => {
    const ctx = fakeExtensionContext();
    registerFindingCommands(ctx);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ label: "Custom range..." });
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("2026-01-01").mockResolvedValueOnce("2026-01-15");

    await handlerFor("phren.filterFindingsByDate")();

    expect(ctx.treeDataProvider.setDateFilter).toHaveBeenCalledWith({
      from: "2026-01-01", to: "2026-01-15", label: "2026-01-01 to 2026-01-15",
    });
  });
});
