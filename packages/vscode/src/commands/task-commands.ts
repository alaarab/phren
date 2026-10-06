import * as vscode from "vscode";
import { type ExtensionContext, toErrorMessage, asRecord, asArraySafe } from "../extensionContext";
import { showTaskDetail } from "../taskViewer";
import { showQueueItemDetail, type QueueItemData } from "../queueViewer";
import { showSessionOverview } from "../sessionViewer";

export function registerTaskCommands(ctx: ExtensionContext): vscode.Disposable[] {
  const { phrenClient, statusBar, treeDataProvider } = ctx;
  const refreshTree = () => treeDataProvider.refresh();

  const openTask = vscode.commands.registerCommand(
    "phren.openTask",
    (task: { projectName: string; id: string; line: string; section: string; checked: boolean; priority?: string; pinned?: boolean; issueUrl?: string; issueNumber?: number }) => {
      showTaskDetail(phrenClient, task, refreshTree);
    },
  );

  const openQueueItem = vscode.commands.registerCommand(
    "phren.openQueueItem",
    (item: QueueItemData) => {
      showQueueItemDetail(phrenClient, item, refreshTree);
    },
  );

  const openSessionOverview = vscode.commands.registerCommand(
    "phren.openSessionOverview",
    async (session: {
      projectName: string;
      sessionId: string;
      startedAt: string;
      durationMins?: number;
      summary?: string;
      findingsAdded: number;
      status: "active" | "ended";
    }) => {
      try {
        await showSessionOverview(phrenClient, session);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to open session overview: ${toErrorMessage(error)}`);
      }
    },
  );

  const copySessionId = vscode.commands.registerCommand(
    "phren.copySessionId",
    async (session: { sessionId: string }) => {
      try {
        await vscode.env.clipboard.writeText(session.sessionId);
        await vscode.window.showInformationMessage(`Copied session ID ${session.sessionId.slice(0, 8)}.`);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to copy session ID: ${toErrorMessage(error)}`);
      }
    },
  );

  const addTask = vscode.commands.registerCommand("phren.addTask", async () => {
    let project = statusBar.getActiveProjectName();
    if (!project) {
      let projectsRaw: unknown;
      try {
        projectsRaw = await phrenClient.listProjects();
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to list projects: ${toErrorMessage(error)}`);
        return;
      }
      const projectsData = asRecord(asRecord(projectsRaw)?.data);
      const projects = asArraySafe(projectsData?.projects);
      const projectNames: string[] = [];
      for (const p of projects) {
        const rec = asRecord(p);
        const name = typeof rec?.name === "string" ? rec.name : undefined;
        if (name) projectNames.push(name);
      }
      if (projectNames.length === 0) {
        await vscode.window.showWarningMessage("No Phren projects found.");
        return;
      }
      project = await vscode.window.showQuickPick(projectNames, { placeHolder: "Select a project" });
      if (!project) return;
    }

    const taskText = await vscode.window.showInputBox({ prompt: "Enter task text" });
    const trimmedTaskText = taskText?.trim();
    if (!trimmedTaskText) return;

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Adding task to Phren...", cancellable: false },
        async () => {
          await phrenClient.addTask(project, trimmedTaskText);
        },
      );
      treeDataProvider.refresh();
      await vscode.window.showInformationMessage(`Task added to ${project}`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to add task: ${toErrorMessage(error)}`);
    }
  });

  const completeTask = vscode.commands.registerCommand(
    "phren.completeTask",
    async (task: { projectName: string; id: string; line: string; section: string; checked: boolean }) => {
      try {
        await phrenClient.completeTask(task.projectName, task.line);
        treeDataProvider.refresh();
        await vscode.window.showInformationMessage(`Task "${task.id}" marked complete.`);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to complete task: ${toErrorMessage(error)}`);
      }
    },
  );

  const removeTask = vscode.commands.registerCommand(
    "phren.removeTask",
    async (task?: { projectName: string; id: string; line: string; section: string; checked: boolean }) => {
      if (!task) {
        await vscode.window.showWarningMessage("Remove Task is available from the Phren explorer context menu.");
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Delete task "${task.id}"?`,
        { modal: true, detail: task.line },
        "Delete",
      );
      if (confirmed !== "Delete") return;

      try {
        await phrenClient.removeTask(task.projectName, task.line);
        treeDataProvider.refresh();
        await vscode.window.showInformationMessage(`Task "${task.id}" deleted.`);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to delete task: ${toErrorMessage(error)}`);
      }
    },
  );

  const pinTask = vscode.commands.registerCommand(
    "phren.pinTask",
    async (task?: { projectName: string; id: string; line: string; section: string; checked: boolean; pinned?: boolean }) => {
      if (!task) {
        await vscode.window.showWarningMessage("Pin Task is available from the Phren explorer context menu.");
        return;
      }
      try {
        if (task.pinned) {
          await phrenClient.unpinTask(task.projectName, task.line);
          treeDataProvider.refresh();
          await vscode.window.showInformationMessage(`Task "${task.id}" unpinned.`);
        } else {
          await phrenClient.pinTask(task.projectName, task.line);
          treeDataProvider.refresh();
          await vscode.window.showInformationMessage(`Task "${task.id}" pinned.`);
        }
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to ${task.pinned ? "unpin" : "pin"} task: ${toErrorMessage(error)}`);
      }
    },
  );

  const updateTask = vscode.commands.registerCommand(
    "phren.updateTask",
    async (task?: { projectName: string; id: string; line: string; section: string; checked: boolean }) => {
      if (!task) {
        await vscode.window.showWarningMessage("Update Task is available from the Phren explorer context menu.");
        return;
      }

      const field = await vscode.window.showQuickPick(
        [
          { label: "Priority", description: "Set task priority (high/medium/low)" },
          { label: "Section", description: "Move to Active/Queue/Done" },
          { label: "Context", description: "Add or update context note" },
        ],
        { placeHolder: "What do you want to update?" },
      );
      if (!field) return;

      const updates: Record<string, unknown> = {};

      if (field.label === "Priority") {
        const priority = await vscode.window.showQuickPick(["high", "medium", "low"], {
          placeHolder: "Select priority",
        });
        if (!priority) return;
        updates.priority = priority;
      } else if (field.label === "Section") {
        const section = await vscode.window.showQuickPick(["Active", "Queue", "Done"], {
          placeHolder: "Move task to section",
        });
        if (!section) return;
        updates.section = section;
      } else if (field.label === "Context") {
        const context = await vscode.window.showInputBox({
          prompt: "Enter context note for this task",
          value: "",
        });
        if (context === undefined) return;
        updates.context = context;
      }

      try {
        await phrenClient.updateTask(task.projectName, task.line, updates);
        treeDataProvider.refresh();
        await vscode.window.showInformationMessage(`Task "${task.id}" updated.`);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to update task: ${toErrorMessage(error)}`);
      }
    },
  );

  const linkTaskIssue = vscode.commands.registerCommand(
    "phren.linkTaskIssue",
    async (task?: { projectName: string; id: string; line: string }) => {
      if (!task) {
        await vscode.window.showWarningMessage("Link Issue is available from the Phren explorer context menu.");
        return;
      }
      const input = await vscode.window.showInputBox({
        prompt: "Enter GitHub issue number or URL",
        placeHolder: "123 or https://github.com/owner/repo/issues/123",
      });
      if (!input?.trim()) return;
      const trimmed = input.trim();
      const numMatch = trimmed.match(/^(\d+)$/);
      try {
        if (numMatch) {
          await phrenClient.linkTaskIssue(task.projectName, task.line, parseInt(numMatch[1], 10));
        } else {
          await phrenClient.linkTaskIssue(task.projectName, task.line, undefined, trimmed);
        }
        treeDataProvider.refresh();
        await vscode.window.showInformationMessage(`Issue linked to task "${task.id}".`);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to link issue: ${toErrorMessage(error)}`);
      }
    },
  );

  const createTaskIssue = vscode.commands.registerCommand(
    "phren.createTaskIssue",
    async (task?: { projectName: string; id: string; line: string }) => {
      if (!task) {
        await vscode.window.showWarningMessage("Create Issue is available from the Phren explorer context menu.");
        return;
      }
      try {
        const raw = await phrenClient.promoteTaskToIssue(task.projectName, task.line);
        const data = (raw as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
        const issueUrl = typeof data?.issue_url === "string" ? data.issue_url : undefined;
        treeDataProvider.refresh();
        await vscode.window.showInformationMessage(`GitHub issue created for task "${task.id}".`);
        if (issueUrl) {
          await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
        }
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to create issue: ${toErrorMessage(error)}`);
      }
    },
  );

  // --- Session Start command ---
  const sessionStart = vscode.commands.registerCommand("phren.sessionStart", async () => {
    try {
      const project = statusBar.getActiveProjectName();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Phren: Starting session...", cancellable: false },
        async () => {
          await phrenClient.sessionStart(project);
        },
      );
      treeDataProvider.refresh();
      await vscode.window.showInformationMessage(`Phren: Session started${project ? ` for ${project}` : ""}.`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Phren session start failed: ${toErrorMessage(error)}`);
    }
  });

  // --- Session End command ---
  const sessionEnd = vscode.commands.registerCommand("phren.sessionEnd", async () => {
    try {
      const summary = await vscode.window.showInputBox({
        title: "End Session",
        prompt: "Optional session summary (leave blank to skip)",
        placeHolder: "What did you accomplish this session?",
      });
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Phren: Ending session...", cancellable: false },
        async () => {
          await phrenClient.sessionEnd(summary || undefined);
        },
      );
      treeDataProvider.refresh();
      await vscode.window.showInformationMessage("Phren: Session ended.");
    } catch (error) {
      await vscode.window.showErrorMessage(`Phren session end failed: ${toErrorMessage(error)}`);
    }
  });

  return [
    openTask,
    openQueueItem,
    openSessionOverview,
    copySessionId,
    addTask,
    completeTask,
    removeTask,
    pinTask,
    updateTask,
    linkTaskIssue,
    createTaskIssue,
    sessionStart,
    sessionEnd,
  ];
}
