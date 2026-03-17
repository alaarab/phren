import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn, spawnSync } from "child_process";
import * as vscode from "vscode";
import { PhrenClient } from "./phrenClient";
import { PhrenTreeProvider } from "./providers/PhrenTreeProvider";
import { showSearchQuickPick } from "./searchQuickPick";
import { PhrenStatusBar } from "./statusBar";
import { showGraphWebview } from "./graphWebview";
import { showFindingDetail } from "./findingViewer";
import { showProjectFile } from "./projectFileViewer";
import { showSkillEditor } from "./skillEditor";
import { showTaskDetail } from "./taskViewer";
import { showQueueItemDetail, type QueueItemData } from "./queueViewer";
import { showSessionOverview } from "./sessionViewer";
import { showProjectConfigPanel } from "./configPanel";
import { pathExists, resolveRuntimeConfig } from "./runtimeConfig";
import {
  listProfileConfigs,
  machineIdPath,
  machinesConfigPath,
  readDeviceContext,
  readMachineName,
  setMachineProfile,
  writeMachineName,
} from "./profileConfig";

let client: PhrenClient | undefined;
let outputChannel: vscode.OutputChannel;

const GLOBAL_PHREN_STORE_PATH = path.join(os.homedir(), ".phren");
const PHREN_PACKAGE_NAME = "@phren/cli";
const ONBOARDING_COMPLETE_SETTING = "onboardingComplete";

interface CommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Phren");
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine("Phren extension activating...");
  const config = vscode.workspace.getConfiguration("phren");
  await runOnboardingIfNeeded(config);
  const runtimeConfig = resolveRuntimeConfig(vscode.workspace.getConfiguration("phren"));

  outputChannel.appendLine(`Phren store path: ${runtimeConfig.storePath}`);
  outputChannel.appendLine(`Node path: ${runtimeConfig.nodePath}`);
  outputChannel.appendLine(
    `MCP server path: ${runtimeConfig.mcpServerPath ?? "(not found; configure phren.mcpServerPath or install Phren globally)"}`,
  );

  if (!runtimeConfig.mcpServerPath) {
    const choice = await vscode.window.showErrorMessage(
      "Phren MCP server entrypoint could not be auto-detected. Set phren.mcpServerPath or install Phren globally.",
      "Open Settings",
    );
    if (choice === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "phren.mcpServerPath");
    }
    return;
  }

  if (!pathExists(runtimeConfig.mcpServerPath)) {
    const basename = path.basename(runtimeConfig.mcpServerPath);
    const choice = await vscode.window.showErrorMessage(
      `Configured Phren MCP server entrypoint does not exist: ${basename}`,
      "Open Settings",
    );
    if (choice === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "phren.mcpServerPath");
    }
    return;
  }

  const phrenClient = new PhrenClient({
    mcpServerPath: runtimeConfig.mcpServerPath,
    storePath: runtimeConfig.storePath,
    nodePath: runtimeConfig.nodePath,
    clientVersion: context.extension.packageJSON.version,
  });
  client = phrenClient;

  const treeDataProvider = new PhrenTreeProvider(phrenClient, runtimeConfig.storePath);
  const treeView = vscode.window.createTreeView("phren.explorer", {
    treeDataProvider,
  });
  const statusBar = new PhrenStatusBar(phrenClient);

  statusBar.setOnHealthChanged((ok) => treeDataProvider.setHealthStatus(ok));

  context.subscriptions.push(treeDataProvider, treeView, statusBar);

  const setActiveProjectDisposable = vscode.commands.registerCommand("phren.setActiveProject", async () => {
    try {
      await statusBar.promptForActiveProject();
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to load Phren projects: ${toErrorMessage(error)}`);
    }
  });

  const addFindingDisposable = vscode.commands.registerCommand("phren.addFinding", async () => {
    const activeProject = statusBar.getActiveProjectName();
    if (!activeProject) {
      await vscode.window.showWarningMessage("No active Phren project selected.");
      return;
    }

    const findingText = await vscode.window.showInputBox({ prompt: "Enter finding text" });
    const trimmedFindingText = findingText?.trim();
    if (!trimmedFindingText) {
      return;
    }

    try {
      await phrenClient.addFinding(activeProject, trimmedFindingText);
      treeDataProvider.refresh();
      await vscode.window.showInformationMessage(`Finding added to ${activeProject}`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to add finding: ${toErrorMessage(error)}`);
    }
  });

  const searchDisposable = vscode.commands.registerCommand("phren.search", async () => {
    try {
      await showSearchQuickPick(phrenClient);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to search Phren knowledge: ${toErrorMessage(error)}`);
    }
  });

  const showGraphDisposable = vscode.commands.registerCommand("phren.showGraph", async () => {
    try {
      await showGraphWebview(phrenClient, context);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to show Phren graph: ${toErrorMessage(error)}`);
    }
  });

  const refreshDisposable = vscode.commands.registerCommand("phren.refresh", async () => {
    treeDataProvider.refresh();

    try {
      await statusBar.initialize();
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to refresh Phren extension state: ${toErrorMessage(error)}`);
    }
  });

  const refreshTree = () => treeDataProvider.refresh();

  const openFindingDisposable = vscode.commands.registerCommand(
    "phren.openFinding",
    (finding: { projectName: string; id: string; date: string; text: string; type?: string; confidence?: number }) => {
      showFindingDetail(phrenClient, finding, refreshTree);
    },
  );

  const openProjectFileDisposable = vscode.commands.registerCommand(
    "phren.openProjectFile",
    async (projectName: string, fileName: string) => {
      try {
        await showProjectFile(phrenClient, projectName, fileName);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to open project file: ${toErrorMessage(error)}`);
      }
    },
  );

  const openSkillDisposable = vscode.commands.registerCommand(
    "phren.openSkill",
    async (skillName: string, skillSource: string) => {
      try {
        await showSkillEditor(phrenClient, skillName, skillSource);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to open skill: ${toErrorMessage(error)}`);
      }
    },
  );

  const toggleSkillDisposable = vscode.commands.registerCommand(
    "phren.toggleSkill",
    async (skillName: string, skillSource: string, currentlyEnabled: boolean) => {
      try {
        const project = skillSource === "global" ? undefined : skillSource;
        if (currentlyEnabled) {
          await phrenClient.disableSkill(skillName, project);
        } else {
          await phrenClient.enableSkill(skillName, project);
        }
        treeDataProvider.refresh();
        await vscode.window.showInformationMessage(
          `Skill "${skillName}" ${currentlyEnabled ? "disabled" : "enabled"}.`,
        );
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to toggle skill: ${toErrorMessage(error)}`);
      }
    },
  );

  const toggleHookDisposable = vscode.commands.registerCommand(
    "phren.toggleHook",
    async (toolOrNode: string | { tool: string; enabled: boolean }, currentlyEnabled?: boolean) => {
      try {
        const tool = typeof toolOrNode === "string" ? toolOrNode : toolOrNode.tool;
        const enabled = typeof toolOrNode === "string" ? currentlyEnabled! : toolOrNode.enabled;
        await phrenClient.toggleHooks(!enabled, tool);
        treeDataProvider.refresh();
        await vscode.window.showInformationMessage(
          `Hooks for "${tool}" ${enabled ? "disabled" : "enabled"}.`,
        );
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to toggle hook: ${toErrorMessage(error)}`);
      }
    },
  );

  const openTaskDisposable = vscode.commands.registerCommand(
    "phren.openTask",
    (task: { projectName: string; id: string; line: string; section: string; checked: boolean; priority?: string; pinned?: boolean; issueUrl?: string; issueNumber?: number }) => {
      showTaskDetail(phrenClient, task, refreshTree);
    },
  );

  const openQueueItemDisposable = vscode.commands.registerCommand(
    "phren.openQueueItem",
    (item: QueueItemData) => {
      showQueueItemDetail(phrenClient, item, refreshTree);
    },
  );

  const openSessionOverviewDisposable = vscode.commands.registerCommand(
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

  const copySessionIdDisposable = vscode.commands.registerCommand(
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

  // --- Add Task command ---
  const addTaskDisposable = vscode.commands.registerCommand("phren.addTask", async () => {
    let project = statusBar.getActiveProjectName();
    if (!project) {
      const projectsRaw = await phrenClient.listProjects();
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
      await phrenClient.addTask(project, trimmedTaskText);
      treeDataProvider.refresh();
      await vscode.window.showInformationMessage(`Task added to ${project}`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to add task: ${toErrorMessage(error)}`);
    }
  });

  // --- Complete Task command (from tree view context menu) ---
  const completeTaskDisposable = vscode.commands.registerCommand(
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

  const removeTaskDisposable = vscode.commands.registerCommand(
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

  // --- Pin Task command (from tree view context menu) ---
  const pinTaskDisposable = vscode.commands.registerCommand(
    "phren.pinTask",
    async (task?: { projectName: string; id: string; line: string; section: string; checked: boolean }) => {
      if (!task) {
        await vscode.window.showWarningMessage("Pin Task is available from the Phren explorer context menu.");
        return;
      }
      try {
        await phrenClient.pinTask(task.projectName, task.line);
        treeDataProvider.refresh();
        await vscode.window.showInformationMessage(`Task "${task.id}" pinned.`);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to pin task: ${toErrorMessage(error)}`);
      }
    },
  );

  // --- Update Task command (priority, section, context) ---
  const updateTaskDisposable = vscode.commands.registerCommand(
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

  // --- Remove Finding command ---
  const removeFindingDisposable = vscode.commands.registerCommand(
    "phren.removeFinding",
    async (finding?: { projectName: string; id: string; text: string }) => {
      if (finding) {
        // Called from tree view context menu
        const confirmed = await vscode.window.showWarningMessage(
          `Remove finding "${finding.id}"?`,
          { modal: true },
          "Remove",
        );
        if (confirmed !== "Remove") return;
        try {
          await phrenClient.removeFinding(finding.projectName, finding.text);
          treeDataProvider.refresh();
          await vscode.window.showInformationMessage(`Finding "${finding.id}" removed.`);
        } catch (error) {
          await vscode.window.showErrorMessage(`Failed to remove finding: ${toErrorMessage(error)}`);
        }
      } else {
        // Called from command palette — prompt for project and text
        const activeProject = statusBar.getActiveProjectName();
        let project = activeProject;
        if (!project) {
          const projectsRaw = await phrenClient.listProjects();
          const projectsData = asRecord(asRecord(projectsRaw)?.data);
          const projects = asArraySafe(projectsData?.projects);
          const projectNames: string[] = [];
          for (const p of projects) {
            const rec = asRecord(p);
            const name = typeof rec?.name === "string" ? rec.name : undefined;
            if (name) projectNames.push(name);
          }
          project = await vscode.window.showQuickPick(projectNames, { placeHolder: "Select a project" });
          if (!project) return;
        }
        const findingText = await vscode.window.showInputBox({ prompt: "Enter exact finding text to remove" });
        if (!findingText?.trim()) return;
        try {
          await phrenClient.removeFinding(project, findingText.trim());
          treeDataProvider.refresh();
          await vscode.window.showInformationMessage("Finding removed.");
        } catch (error) {
          await vscode.window.showErrorMessage(`Failed to remove finding: ${toErrorMessage(error)}`);
        }
      }
    },
  );

  // --- Pin Memory command ---
  const pinMemoryDisposable = vscode.commands.registerCommand("phren.pinMemory", async () => {
    let project = statusBar.getActiveProjectName();
    if (!project) {
      const projectsRaw = await phrenClient.listProjects();
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

    const memoryText = await vscode.window.showInputBox({ prompt: "Enter memory text to pin" });
    const trimmedMemoryText = memoryText?.trim();
    if (!trimmedMemoryText) return;

    try {
      await phrenClient.pinMemory(project, trimmedMemoryText);
      await vscode.window.showInformationMessage(`Memory pinned to ${project}`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to pin memory: ${toErrorMessage(error)}`);
    }
  });

  // --- Supersede Finding command ---
  const supersedeFindingDisposable = vscode.commands.registerCommand(
    "phren.supersedeFinding",
    async (finding?: { projectName: string; id: string; text: string }) => {
      if (!finding) {
        await vscode.window.showWarningMessage("Supersede Finding is available from the Phren explorer context menu.");
        return;
      }
      const replacementText = await vscode.window.showInputBox({
        prompt: "Enter the replacement finding text",
        placeHolder: "New finding that supersedes this one",
      });
      if (!replacementText?.trim()) return;
      try {
        await phrenClient.supersedeFinding(finding.projectName, finding.text, replacementText.trim());
        treeDataProvider.refresh();
        await vscode.window.showInformationMessage(`Finding "${finding.id}" superseded.`);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to supersede finding: ${toErrorMessage(error)}`);
      }
    },
  );

  // --- Retract Finding command ---
  const retractFindingDisposable = vscode.commands.registerCommand(
    "phren.retractFinding",
    async (finding?: { projectName: string; id: string; text: string }) => {
      if (!finding) {
        await vscode.window.showWarningMessage("Retract Finding is available from the Phren explorer context menu.");
        return;
      }
      const reason = await vscode.window.showInputBox({
        prompt: "Enter reason for retracting this finding",
        placeHolder: "e.g. no longer accurate, superseded by new approach",
      });
      if (!reason?.trim()) return;
      try {
        await phrenClient.retractFinding(finding.projectName, finding.text, reason.trim());
        treeDataProvider.refresh();
        await vscode.window.showInformationMessage(`Finding "${finding.id}" retracted.`);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to retract finding: ${toErrorMessage(error)}`);
      }
    },
  );

  // --- Resolve Contradiction command ---
  const resolveContradictionDisposable = vscode.commands.registerCommand(
    "phren.resolveContradiction",
    async (finding?: { projectName: string; id: string; text: string }) => {
      if (!finding) {
        await vscode.window.showWarningMessage("Resolve Contradiction is available from the Phren explorer context menu.");
        return;
      }
      const otherText = await vscode.window.showInputBox({
        prompt: "Enter the contradicting finding text",
        placeHolder: "The other finding this one contradicts",
      });
      if (!otherText?.trim()) return;
      const resolution = await vscode.window.showInputBox({
        prompt: "Enter resolution",
        placeHolder: "How to resolve this contradiction",
      });
      if (!resolution?.trim()) return;
      try {
        await phrenClient.resolveContradiction(finding.projectName, finding.text, otherText.trim(), resolution.trim());
        treeDataProvider.refresh();
        await vscode.window.showInformationMessage("Contradiction resolved.");
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to resolve contradiction: ${toErrorMessage(error)}`);
      }
    },
  );

  // --- Link Task Issue command ---
  const linkTaskIssueDisposable = vscode.commands.registerCommand(
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

  // --- Create Task Issue command ---
  const createTaskIssueDisposable = vscode.commands.registerCommand(
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

  const syncDisposable = vscode.commands.registerCommand("phren.sync", async () => {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Phren: Syncing...", cancellable: false },
        async () => {
          await phrenClient.pushChanges();
        },
      );
      treeDataProvider.refresh();
      // Re-poll health immediately so the status bar updates
      await statusBar.initialize();
      await vscode.window.showInformationMessage("Phren: Sync complete.");
    } catch (error) {
      await vscode.window.showErrorMessage(`Phren sync failed: ${toErrorMessage(error)}`);
    }
  });

  // --- Doctor command ---
  const doctorDisposable = vscode.commands.registerCommand("phren.doctor", async () => {
    try {
      const raw = await phrenClient.healthCheck();
      const data = asRecord(asRecord(raw)?.data);
      outputChannel.clear();
      outputChannel.appendLine("=== Phren Doctor ===");
      outputChannel.appendLine("");
      if (data) {
        if (data.version) outputChannel.appendLine(`Version: ${data.version}`);
        if (data.profile) outputChannel.appendLine(`Profile: ${data.profile}`);
        if (data.machine) outputChannel.appendLine(`Machine: ${data.machine}`);
        if (data.projectCount !== undefined) outputChannel.appendLine(`Projects: ${data.projectCount}`);
        if (data.storePath) outputChannel.appendLine(`Store: ${data.storePath}`);
        const index = asRecord(data.index);
        if (index) {
          outputChannel.appendLine("");
          outputChannel.appendLine("FTS Index:");
          if (index.docCount !== undefined) outputChannel.appendLine(`  Documents: ${index.docCount}`);
          if (index.entityCount !== undefined) outputChannel.appendLine(`  Fragments: ${index.entityCount}`);
          if (index.stale !== undefined) outputChannel.appendLine(`  Stale: ${index.stale}`);
        }
        const hooks = asRecord(data.hooks);
        if (hooks) {
          outputChannel.appendLine("");
          outputChannel.appendLine("Hooks:");
          if (hooks.globalEnabled !== undefined) outputChannel.appendLine(`  Global: ${hooks.globalEnabled ? "enabled" : "disabled"}`);
          const tools = asArraySafe(hooks.tools);
          for (const t of tools) {
            const rec = asRecord(t);
            if (rec?.tool) outputChannel.appendLine(`  ${rec.tool}: ${rec.enabled ? "enabled" : "disabled"}`);
          }
        }
        // Print any remaining top-level keys as-is
        for (const key of Object.keys(data)) {
          if (["version", "profile", "machine", "projectCount", "storePath", "index", "hooks"].includes(key)) continue;
          outputChannel.appendLine(`${key}: ${JSON.stringify(data[key])}`);
        }
      } else {
        outputChannel.appendLine(JSON.stringify(raw, null, 2));
      }
      outputChannel.appendLine("");
      outputChannel.appendLine("=== End ===");
      outputChannel.show(true);
    } catch (error) {
      await vscode.window.showErrorMessage(`Phren doctor failed: ${toErrorMessage(error)}`);
    }
  });

  // --- Doctor Fix command ---
  const doctorFixDisposable = vscode.commands.registerCommand("phren.doctorFix", async () => {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Phren: Running doctor fix...", cancellable: false },
        async () => {
          await phrenClient.doctorFix();
        },
      );
      treeDataProvider.refresh();
      await statusBar.initialize();
      await vscode.window.showInformationMessage("Phren: Doctor fix complete. Hooks, symlinks, and context re-linked.");
    } catch (error) {
      await vscode.window.showErrorMessage(`Phren doctor fix failed: ${toErrorMessage(error)}`);
    }
  });

  // --- Session Start command ---
  const sessionStartDisposable = vscode.commands.registerCommand("phren.sessionStart", async () => {
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
  const sessionEndDisposable = vscode.commands.registerCommand("phren.sessionEnd", async () => {
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

  // --- Hooks Status command ---
  const hooksStatusDisposable = vscode.commands.registerCommand("phren.hooksStatus", async () => {
    try {
      const raw = await phrenClient.listHooks();
      const data = asRecord(asRecord(raw)?.data);
      outputChannel.clear();
      outputChannel.appendLine("=== Phren Hooks Status ===");
      outputChannel.appendLine("");
      if (data) {
        if (data.globalEnabled !== undefined) {
          outputChannel.appendLine(`Global: ${data.globalEnabled ? "enabled" : "disabled"}`);
        }
        outputChannel.appendLine("");
        const tools = asArraySafe(data.tools);
        for (const t of tools) {
          const rec = asRecord(t);
          if (!rec?.tool) continue;
          const status = rec.enabled ? "enabled" : "disabled";
          const exists = rec.exists ? "" : " (config not found)";
          outputChannel.appendLine(`  ${rec.tool}: ${status}${exists}`);
          if (rec.configPath) outputChannel.appendLine(`    Path: ${rec.configPath}`);
        }
        const customHooks = asArraySafe(data.customHooks);
        if (customHooks.length > 0) {
          outputChannel.appendLine("");
          outputChannel.appendLine("Custom Hooks:");
          for (const h of customHooks) {
            const rec = asRecord(h);
            if (rec) outputChannel.appendLine(`  ${rec.event}: ${rec.command}`);
          }
        }
      } else {
        outputChannel.appendLine(JSON.stringify(raw, null, 2));
      }
      outputChannel.appendLine("");
      outputChannel.appendLine("=== End ===");
      outputChannel.show(true);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to get hooks status: ${toErrorMessage(error)}`);
    }
  });

  // --- Toggle Hooks command ---
  const toggleHooksCommandDisposable = vscode.commands.registerCommand("phren.toggleHooksCommand", async () => {
    try {
      const raw = await phrenClient.listHooks();
      const data = asRecord(asRecord(raw)?.data);
      const tools = asArraySafe(data?.tools);
      const picks: vscode.QuickPickItem[] = [];
      for (const t of tools) {
        const rec = asRecord(t);
        if (!rec?.tool) continue;
        const toolName = String(rec.tool);
        const enabled = rec.enabled === true;
        picks.push({
          label: toolName,
          description: enabled ? "enabled" : "disabled",
          detail: `Click to ${enabled ? "disable" : "enable"} hooks for ${toolName}`,
        });
      }
      if (picks.length === 0) {
        await vscode.window.showInformationMessage("No hook tools configured.");
        return;
      }
      const choice = await vscode.window.showQuickPick(picks, { placeHolder: "Select a tool to toggle hooks" });
      if (!choice) return;
      const currentlyEnabled = choice.description === "enabled";
      await phrenClient.toggleHooks(!currentlyEnabled, choice.label);
      treeDataProvider.refresh();
      await vscode.window.showInformationMessage(`Hooks for "${choice.label}" ${currentlyEnabled ? "disabled" : "enabled"}.`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to toggle hooks: ${toErrorMessage(error)}`);
    }
  });

  // --- Manage Project command ---
  const manageProjectDisposable = vscode.commands.registerCommand("phren.manageProject", async () => {
    try {
      const projectsRaw = await phrenClient.listProjects();
      const projectsData = asRecord(asRecord(projectsRaw)?.data);
      const projects = asArraySafe(projectsData?.projects);
      const projectNames: string[] = [];
      for (const p of projects) {
        const rec = asRecord(p);
        const name = typeof rec?.name === "string" ? rec.name : undefined;
        if (name) projectNames.push(name);
      }
      if (projectNames.length === 0) {
        await vscode.window.showInformationMessage("No projects found.");
        return;
      }
      const projectChoice = await vscode.window.showQuickPick(projectNames, { placeHolder: "Select a project to manage" });
      if (!projectChoice) return;
      const actionChoice = await vscode.window.showQuickPick(
        [
          { label: "Archive", description: "Archive this project" },
          { label: "Unarchive", description: "Restore this project" },
        ],
        { placeHolder: `Action for "${projectChoice}"` },
      );
      if (!actionChoice) return;
      const action = actionChoice.label.toLowerCase() as "archive" | "unarchive";
      await phrenClient.manageProject(projectChoice, action);
      treeDataProvider.refresh();
      await vscode.window.showInformationMessage(`Project "${projectChoice}" ${action}d.`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to manage project: ${toErrorMessage(error)}`);
    }
  });

  const uninstallDisposable = vscode.commands.registerCommand("phren.uninstall", async () => {
    const proceed = await vscode.window.showWarningMessage(
      "Uninstall Phren from this machine?",
      {
        modal: true,
        detail: "This removes Phren MCP entries from editor configs, uninstalls the global npm package, and resets VS Code Phren settings.",
      },
      "Uninstall Phren",
    );
    if (proceed !== "Uninstall Phren") {
      return;
    }

    const deleteStoreChoice = await vscode.window.showWarningMessage(
      `Also delete ${GLOBAL_PHREN_STORE_PATH}?`,
      {
        modal: true,
        detail: "This permanently deletes Phren memory and project data on this machine.",
      },
      "Delete ~/.phren",
      "Keep Data",
    );
    const deleteStore = deleteStoreChoice === "Delete ~/.phren";

    const summary = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Phren: Uninstalling...", cancellable: false },
      async (progress) => {
        progress.report({ message: "Clearing Phren MCP entries from editor configs..." });
        const cleanupResult = clearPhrenMcpEntries();

        progress.report({ message: `Running npm uninstall -g ${PHREN_PACKAGE_NAME}...` });
        const npmResult = uninstallGlobalPhrenPackage();

        progress.report({ message: "Resetting VS Code Phren extension settings..." });
        const resetResult = await resetPhrenExtensionSettings(context);

        let storeRemoval: { removed: boolean; skipped: boolean; error?: string } = { removed: false, skipped: true };
        if (deleteStore) {
          progress.report({ message: `Deleting ${GLOBAL_PHREN_STORE_PATH}...` });
          storeRemoval = removePhrenStore(GLOBAL_PHREN_STORE_PATH);
        }

        return { cleanupResult, npmResult, resetResult, storeRemoval };
      },
    );

    outputChannel.appendLine("=== Phren Uninstall ===");
    for (const filePath of summary.cleanupResult.cleanedFiles) {
      outputChannel.appendLine(`Cleaned MCP entry: ${filePath}`);
    }
    for (const warning of summary.cleanupResult.warnings) {
      outputChannel.appendLine(`Warning: ${warning}`);
    }
    if (summary.npmResult.stdout) {
      outputChannel.appendLine(summary.npmResult.stdout.trim());
    }
    if (summary.npmResult.stderr) {
      outputChannel.appendLine(summary.npmResult.stderr.trim());
    }
    for (const warning of summary.resetResult.warnings) {
      outputChannel.appendLine(`Warning: ${warning}`);
    }
    if (deleteStore) {
      if (summary.storeRemoval.removed) {
        outputChannel.appendLine(`Removed ${GLOBAL_PHREN_STORE_PATH}`);
      } else if (summary.storeRemoval.error) {
        outputChannel.appendLine(`Warning: ${summary.storeRemoval.error}`);
      }
    }
    outputChannel.appendLine("=== End ===");

    const failedSteps: string[] = [];
    if (!summary.npmResult.ok) failedSteps.push("global npm uninstall");
    if (summary.storeRemoval.error) failedSteps.push("~/.phren deletion");
    if (summary.resetResult.warnings.length > 0) failedSteps.push("settings reset (partial)");

    treeDataProvider.refresh();

    if (failedSteps.length > 0) {
      await vscode.window.showWarningMessage(
        `Phren uninstall finished with warnings (${failedSteps.join(", ")}). See the Phren output channel for details.`,
      );
      outputChannel.show(true);
      return;
    }

    await vscode.window.showInformationMessage(
      `Phren uninstall complete. Removed ${summary.cleanupResult.cleanedFiles.length} MCP entr${summary.cleanupResult.cleanedFiles.length === 1 ? "y" : "ies"}${deleteStore ? " and deleted ~/.phren" : ""}.`,
    );
  });

  const openMachinesConfigDisposable = vscode.commands.registerCommand("phren.openMachinesConfig", async () => {
    try {
      const machinesPath = machinesConfigPath(runtimeConfig.storePath);
      if (!fs.existsSync(machinesPath)) {
        fs.mkdirSync(path.dirname(machinesPath), { recursive: true });
        fs.writeFileSync(machinesPath, "# machine-name: profile-name\n", "utf8");
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(machinesPath));
      await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to open machines.yaml: ${toErrorMessage(error)}`);
    }
  });

  const promptForReload = async (message: string, extraAction?: { label: string; run: () => Promise<void> }): Promise<void> => {
    const choices = extraAction ? ["Reload Window", extraAction.label, "Later"] : ["Reload Window", "Later"];
    const choice = await vscode.window.showInformationMessage(message, ...choices);
    if (choice === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
      return;
    }
    if (extraAction && choice === extraAction.label) {
      await extraAction.run();
    }
  };

  // --- Set this machine's profile mapping ---
  const switchProfileDisposable = vscode.commands.registerCommand("phren.switchProfile", async () => {
    try {
      const machine = readMachineName();
      const current = readDeviceContext(runtimeConfig.storePath);
      const profiles = listProfileConfigs(runtimeConfig.storePath);
      if (profiles.length === 0) {
        await vscode.window.showInformationMessage("No profiles found in the Phren store.", "Open machines.yaml")
          .then(async (choice) => {
            if (choice === "Open machines.yaml") {
              await vscode.commands.executeCommand("phren.openMachinesConfig");
            }
          });
        return;
      }

      const picks: vscode.QuickPickItem[] = profiles.map((profile) => ({
        label: profile.name,
        description: profile.name === current.profile ? "current" : undefined,
        detail: `${profile.projects.length} project${profile.projects.length === 1 ? "" : "s"}${profile.description ? ` • ${profile.description}` : ""}`,
      }));

      const choice = await vscode.window.showQuickPick(picks, {
        title: `Set profile for machine "${machine}"`,
        placeHolder: "This writes the real machine -> profile mapping in machines.yaml",
      });
      if (!choice) return;

      if (choice.label === current.profile) {
        await vscode.window.showInformationMessage(`Machine "${machine}" already uses profile "${choice.label}".`);
        return;
      }

      const machinesPath = setMachineProfile(runtimeConfig.storePath, machine, choice.label);
      treeDataProvider.refresh();
      await promptForReload(
        `Mapped machine "${machine}" to profile "${choice.label}" in machines.yaml. Reload VS Code to restart the Phren backend on the new profile.`,
        {
          label: "Open machines.yaml",
          run: async () => {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(machinesPath));
            await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
          },
        },
      );
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to update machine profile mapping: ${toErrorMessage(error)}`);
    }
  });

  const configureMachineDisposable = vscode.commands.registerCommand("phren.configureMachine", async () => {
    try {
      const currentMachine = readMachineName();
      const nextMachine = await vscode.window.showInputBox({
        title: "Set machine alias",
        prompt: "Stored in ~/.phren/.machine-id and used to look up this machine in machines.yaml",
        value: currentMachine,
        validateInput: (value) => value.trim() ? null : "Machine name cannot be empty",
      });
      if (!nextMachine) {
        return;
      }

      const normalized = nextMachine.trim();
      if (normalized === currentMachine) {
        await vscode.window.showInformationMessage(`Machine alias is already "${normalized}".`);
        return;
      }

      writeMachineName(normalized);
      treeDataProvider.refresh();
      await promptForReload(
        `Saved machine alias "${normalized}" to ${machineIdPath()}. Reload VS Code so Phren resolves the new machine identity.`,
        {
          label: "Open machines.yaml",
          run: async () => {
            await vscode.commands.executeCommand("phren.openMachinesConfig");
          },
        },
      );
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to update machine alias: ${toErrorMessage(error)}`);
    }
  });

  // --- Project Config command ---
  const projectConfigDisposable = vscode.commands.registerCommand("phren.projectConfig", async () => {
    try {
      const projectsRaw = await phrenClient.listProjects();
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
      const active = statusBar.getActiveProjectName();
      const sorted = active && projectNames.includes(active)
        ? [active, ...projectNames.filter((n) => n !== active)]
        : projectNames;
      const project = await vscode.window.showQuickPick(sorted, {
        title: "Phren: Project Config",
        placeHolder: "Select a project to view or edit config",
      });
      if (!project) return;
      await showProjectConfigPanel(phrenClient, project);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to open project config: ${toErrorMessage(error)}`);
    }
  });

  const filterFindingsByDateDisposable = vscode.commands.registerCommand(
    "phren.filterFindingsByDate",
    async () => {
      const current = treeDataProvider.getDateFilter();
      const picks: vscode.QuickPickItem[] = [
        { label: "Today", description: "Show only today's findings" },
        { label: "Last 7 days", description: "Show findings from the past week" },
        { label: "Last 30 days", description: "Show findings from the past month" },
        { label: "Custom range...", description: "Pick a start and end date" },
        { label: "Clear filter", description: current ? `Currently: ${current.label}` : "No filter active" },
      ];

      const choice = await vscode.window.showQuickPick(picks, { placeHolder: "Filter findings by date" });
      if (!choice) return;

      if (choice.label === "Clear filter") {
        treeDataProvider.setDateFilter(undefined);
        return;
      }

      const today = new Date();
      const fmt = (d: Date) => d.toISOString().slice(0, 10);

      if (choice.label === "Today") {
        const todayStr = fmt(today);
        treeDataProvider.setDateFilter({ from: todayStr, to: todayStr, label: "Today" });
      } else if (choice.label === "Last 7 days") {
        const from = new Date(today);
        from.setDate(from.getDate() - 7);
        treeDataProvider.setDateFilter({ from: fmt(from), to: fmt(today), label: "Last 7 days" });
      } else if (choice.label === "Last 30 days") {
        const from = new Date(today);
        from.setDate(from.getDate() - 30);
        treeDataProvider.setDateFilter({ from: fmt(from), to: fmt(today), label: "Last 30 days" });
      } else if (choice.label === "Custom range...") {
        const fromStr = await vscode.window.showInputBox({
          prompt: "Start date (YYYY-MM-DD)",
          placeHolder: "2026-01-01",
          validateInput: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : "Use YYYY-MM-DD format",
        });
        if (!fromStr) return;

        const toStr = await vscode.window.showInputBox({
          prompt: "End date (YYYY-MM-DD)",
          placeHolder: fmt(today),
          value: fmt(today),
          validateInput: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : "Use YYYY-MM-DD format",
        });
        if (!toStr) return;

        treeDataProvider.setDateFilter({ from: fromStr, to: toStr, label: `${fromStr} to ${toStr}` });
      }
    },
  );

  context.subscriptions.push(
    setActiveProjectDisposable,
    addFindingDisposable,
    searchDisposable,
    showGraphDisposable,
    refreshDisposable,
    openFindingDisposable,
    openProjectFileDisposable,
    openSkillDisposable,
    toggleSkillDisposable,
    toggleHookDisposable,
    openTaskDisposable,
    openQueueItemDisposable,
    openSessionOverviewDisposable,
    copySessionIdDisposable,
    filterFindingsByDateDisposable,
    switchProfileDisposable,
    configureMachineDisposable,
    openMachinesConfigDisposable,
    syncDisposable,
    doctorDisposable,
    doctorFixDisposable,
    sessionStartDisposable,
    sessionEndDisposable,
    hooksStatusDisposable,
    toggleHooksCommandDisposable,
    manageProjectDisposable,
    uninstallDisposable,
    addTaskDisposable,
    completeTaskDisposable,
    removeTaskDisposable,
    pinTaskDisposable,
    updateTaskDisposable,
    removeFindingDisposable,
    pinMemoryDisposable,
    supersedeFindingDisposable,
    retractFindingDisposable,
    resolveContradictionDisposable,
    linkTaskIssueDisposable,
    createTaskIssueDisposable,
    projectConfigDisposable,
  );

  // --- Sync VS Code settings to phren preference files ---
  syncSettingsToPreferences(runtimeConfig.storePath, config);
  const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (
      e.affectsConfiguration("phren.proactivity") ||
      e.affectsConfiguration("phren.proactivityFindings") ||
      e.affectsConfiguration("phren.proactivityTasks") ||
      e.affectsConfiguration("phren.autoExtract") ||
      e.affectsConfiguration("phren.autoCapture") ||
      e.affectsConfiguration("phren.taskMode") ||
      e.affectsConfiguration("phren.hooksEnabled") ||
      e.affectsConfiguration("phren.semanticDedup") ||
      e.affectsConfiguration("phren.semanticConflict") ||
      e.affectsConfiguration("phren.llmModel") ||
      e.affectsConfiguration("phren.findingSensitivity")
    ) {
      const updated = vscode.workspace.getConfiguration("phren");
      syncSettingsToPreferences(runtimeConfig.storePath, updated);
      outputChannel.appendLine("Phren settings synced to preference files.");

      // Notify when semantic features are toggled on
      const semanticDedup = updated.get<boolean>("semanticDedup", false);
      const semanticConflict = updated.get<boolean>("semanticConflict", false);
      const llmModel = updated.get<string>("llmModel", "") || "claude-haiku-4-5-20251001 (default)";
      const expensiveModels = ["claude-opus-4-6", "claude-sonnet-4-6", "gpt-4o"];
      const isExpensive = expensiveModels.some(m => llmModel.includes(m));

      if (e.affectsConfiguration("phren.semanticDedup") && semanticDedup) {
        const msg = `Phren: Semantic dedup enabled for offline batch operations (consolidate, extract). Model: ${llmModel}. ~$0.01/batch-session with Haiku. Live dedup uses the active agent — no extra cost.`;
        if (isExpensive) {
          await vscode.window.showWarningMessage(`${msg} Warning: expensive model selected — Haiku recommended for batch operations.`);
        } else {
          await vscode.window.showInformationMessage(msg);
        }
      }
      if (e.affectsConfiguration("phren.semanticConflict") && semanticConflict) {
        const msg = `Phren: Semantic conflict detection enabled for offline batch operations (consolidate, extract). Model: ${llmModel}. ~$0.01/batch-session with Haiku. Live conflict detection uses the active agent — no extra cost.`;
        if (isExpensive) {
          await vscode.window.showWarningMessage(`${msg} Warning: expensive model selected — Haiku recommended for batch operations.`);
        } else {
          await vscode.window.showInformationMessage(msg);
        }
      }
      if (e.affectsConfiguration("phren.llmModel") && isExpensive && (semanticDedup || semanticConflict)) {
        await vscode.window.showWarningMessage(
          `Phren: "${llmModel}" is expensive for offline batch operations. Haiku is recommended and costs ~10x less.`,
          "Switch to Haiku",
        ).then(async (choice) => {
          if (choice === "Switch to Haiku") {
            await updated.update("llmModel", "claude-haiku-4-5-20251001", vscode.ConfigurationTarget.Global);
          }
        });
      }
      if (e.affectsConfiguration("phren.findingSensitivity")) {
        const sensitivity = updated.get<string>("findingSensitivity", "balanced");
        const descriptions: Record<string, string> = {
          minimal: "Only save findings when explicitly asked. No auto-capture.",
          conservative: "Save decisions and pitfalls only. Auto-capture: 3/session max.",
          balanced: "Save non-obvious patterns and decisions. Auto-capture: 10/session.",
          aggressive: "Save everything worth remembering. Auto-capture: 20/session.",
        };
        const desc = descriptions[sensitivity] ?? "";
        await vscode.window.showInformationMessage(`Phren: Finding sensitivity set to "${sensitivity}". ${desc}`);
      }
    }
  });
  context.subscriptions.push(configChangeDisposable);

  try {
    await statusBar.initialize();
    outputChannel.appendLine("Status bar initialized successfully");
  } catch (error) {
    outputChannel.appendLine(`Status bar init failed: ${toErrorMessage(error)}`);
    await vscode.window.showErrorMessage(`Failed to initialize active Phren project: ${toErrorMessage(error)}`);
  }
}

export async function deactivate(): Promise<void> {
  if (!client) {
    return;
  }

  await client.dispose();
  client = undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asArraySafe(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function runOnboardingIfNeeded(config: vscode.WorkspaceConfiguration): Promise<void> {
  const completed = config.get<boolean>(ONBOARDING_COMPLETE_SETTING, false);
  if (completed) {
    return;
  }

  outputChannel.appendLine("Running first-time Phren onboarding...");

  try {
    const globallyInstalled = await isGlobalPhrenInstalled();
    if (!globallyInstalled) {
      const installChoice = await vscode.window.showInformationMessage(
        "Phren is not installed globally. Install it now to enable the extension backend?",
        "Install Phren",
        "Skip",
      );
      if (installChoice === "Install Phren") {
        const result = await runCommandWithProgress(
          "Installing Phren globally...",
          getNpmCommand(),
          ["install", "-g", PHREN_PACKAGE_NAME],
        );
        if (result.ok) {
          await vscode.window.showInformationMessage("Phren global install complete.");
        } else {
          await vscode.window.showErrorMessage(`Phren install failed: ${summarizeCommandError(result)}`);
        }
      }
    }

    if (!pathExists(GLOBAL_PHREN_STORE_PATH)) {
      const initChoice = await vscode.window.showInformationMessage(
        `${GLOBAL_PHREN_STORE_PATH} was not found. Initialize Phren now?`,
        "Initialize Phren",
        "Skip",
      );
      if (initChoice === "Initialize Phren") {
        const result = await runCommandWithProgress(
          "Initializing Phren store...",
          getNpxCommand(),
          [PHREN_PACKAGE_NAME, "init", "--yes"],
        );
        if (result.ok) {
          await vscode.window.showInformationMessage("Phren store initialized.");
        } else {
          await vscode.window.showErrorMessage(`Phren init failed: ${summarizeCommandError(result)}`);
        }
      }
    }

    if (!hasPhrenMcpEntry()) {
      const configureChoice = await vscode.window.showInformationMessage(
        "Phren MCP entry is missing in ~/.claude/settings.json. Configure it now?",
        "Configure MCP",
        "Skip",
      );
      if (configureChoice === "Configure MCP") {
        const result = await runCommandWithProgress(
          "Configuring Phren MCP entry...",
          getNpxCommand(),
          [PHREN_PACKAGE_NAME, "init", "--yes"],
        );
        if (result.ok) {
          await vscode.window.showInformationMessage("Phren MCP configuration updated.");
        } else {
          await vscode.window.showErrorMessage(`Phren MCP configuration failed: ${summarizeCommandError(result)}`);
        }
      }
    }

    const workspaceFolder = getPrimaryWorkspaceFolderPath();
    if (workspaceFolder) {
      const addProjectChoice = await vscode.window.showInformationMessage(
        `Track this workspace in Phren?\n${workspaceFolder}`,
        "Track Project",
        "Skip",
      );
      if (addProjectChoice === "Track Project") {
        const result = await runCommandWithProgress(
          "Adding workspace to Phren projects...",
          getNpxCommand(),
          [PHREN_PACKAGE_NAME, "add", workspaceFolder],
        );
        if (result.ok) {
          await vscode.window.showInformationMessage("Workspace added to Phren projects.");
        } else {
          await vscode.window.showErrorMessage(`Failed to add project: ${summarizeCommandError(result)}`);
        }
      }
    }
  } finally {
    try {
      await config.update(ONBOARDING_COMPLETE_SETTING, true, vscode.ConfigurationTarget.Global);
      outputChannel.appendLine("Phren onboarding complete (phren.onboardingComplete=true).");
    } catch (error) {
      outputChannel.appendLine(`Failed to persist onboarding flag: ${toErrorMessage(error)}`);
    }
  }
}

async function isGlobalPhrenInstalled(): Promise<boolean> {
  const result = await runCommand(getNpmCommand(), ["list", "-g", PHREN_PACKAGE_NAME, "--json"]);
  const parsed = safeParseJson(result.stdout);
  const dependencies = asRecord(parsed?.dependencies);
  const packageEntry = dependencies ? dependencies[PHREN_PACKAGE_NAME] : undefined;
  return Boolean(packageEntry);
}

function getNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function getNpxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function getPrimaryWorkspaceFolderPath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return folders[0]?.uri.fsPath;
}

function hasPhrenMcpEntry(): boolean {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return false;
  }

  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const json = safeParseJson(raw);
    const mcpServers = asRecord(json?.mcpServers);
    const servers = asRecord(json?.servers);
    return Boolean(mcpServers?.phren || servers?.phren);
  } catch (error) {
    outputChannel.appendLine(`Failed to read ${settingsPath}: ${toErrorMessage(error)}`);
    return false;
  }
}

async function runCommandWithProgress(title: string, command: string, args: string[]): Promise<CommandResult> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    async () => runCommand(command, args),
  );
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        status: null,
        stdout,
        stderr: `${stderr}\n${toErrorMessage(error)}`.trim(),
      });
    });
    child.on("close", (status) => {
      resolve({
        ok: status === 0,
        status,
        stdout,
        stderr,
      });
    });
  });
}

function safeParseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw);
    return asRecord(value);
  } catch {
    return undefined;
  }
}

function summarizeCommandError(result: CommandResult): string {
  if (result.stderr.trim()) {
    return result.stderr.trim().split("\n").slice(-1)[0];
  }
  if (result.stdout.trim()) {
    return result.stdout.trim().split("\n").slice(-1)[0];
  }
  return result.status === null ? "failed to start command" : `exit code ${result.status}`;
}

interface McpCleanupResult {
  cleanedFiles: string[];
  warnings: string[];
}

interface NpmUninstallResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

interface SettingsResetResult {
  resetKeys: string[];
  warnings: string[];
}

function clearPhrenMcpEntries(): McpCleanupResult {
  const cleanedFiles: string[] = [];
  const warnings: string[] = [];
  const candidateFiles = getMcpConfigCandidateFiles();

  for (const filePath of candidateFiles) {
    try {
      if (removeMcpServerAtPath(filePath)) {
        cleanedFiles.push(filePath);
      }
    } catch (error) {
      warnings.push(`${filePath}: ${toErrorMessage(error)}`);
    }
  }

  const codexTomlPath = path.join(os.homedir(), ".codex", "config.toml");
  try {
    if (removeTomlMcpServer(codexTomlPath)) {
      cleanedFiles.push(codexTomlPath);
    }
  } catch (error) {
    warnings.push(`${codexTomlPath}: ${toErrorMessage(error)}`);
  }

  return { cleanedFiles, warnings };
}

function getMcpConfigCandidateFiles(): string[] {
  const home = os.homedir();
  const files = [
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".cursor", "mcp.json"),
  ];

  return Array.from(new Set(files.filter((value): value is string => Boolean(value))));
}

function removeMcpServerAtPath(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    data = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`malformed JSON: ${toErrorMessage(error)}`);
  }

  let removed = false;
  for (const key of ["mcpServers", "servers"] as const) {
    const root = data[key];
    if (!root || typeof root !== "object" || Array.isArray(root)) continue;
    const objectRoot = root as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(objectRoot, "phren")) {
      delete objectRoot.phren;
      removed = true;
    }
  }

  if (removed) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
  return removed;
}

function removeTomlMcpServer(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, "utf8");
  const sectionRe = /^\[mcp_servers\.phren\]\s*\n(?:(?!\[)[^\n]*\n?)*/m;
  if (!sectionRe.test(content)) return false;
  const next = content.replace(sectionRe, "").replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

function uninstallGlobalPhrenPackage(): NpmUninstallResult {
  try {
    const result = spawnSync("npm", ["uninstall", "-g", PHREN_PACKAGE_NAME], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: toErrorMessage(error),
    };
  }
}

function removePhrenStore(storePath: string): { removed: boolean; skipped: boolean; error?: string } {
  if (!fs.existsSync(storePath)) return { removed: false, skipped: true };
  try {
    fs.rmSync(storePath, { recursive: true, force: true });
    return { removed: true, skipped: false };
  } catch (error) {
    return { removed: false, skipped: false, error: toErrorMessage(error) };
  }
}

async function resetPhrenExtensionSettings(context: vscode.ExtensionContext): Promise<SettingsResetResult> {
  const warnings: string[] = [];
  const resetKeys: string[] = [];
  const config = vscode.workspace.getConfiguration("phren");
  const packageJson = context.extension.packageJSON as Record<string, unknown>;
  const contributes = asRecord(packageJson.contributes);
  const configuration = asRecord(contributes?.configuration);
  const properties = asRecord(configuration?.properties) ?? {};
  const keys = Object.keys(properties).filter((key) => key.startsWith("phren."));

  for (const key of keys) {
    const section = key.slice("phren.".length);
    try {
      await config.update(section, undefined, vscode.ConfigurationTarget.Global);
      resetKeys.push(key);
    } catch (error) {
      warnings.push(`${key}: ${toErrorMessage(error)}`);
    }
  }

  return { resetKeys, warnings };
}

// ── Settings → phren preference file sync ──────────────────────────────────

interface ConfigSource {
  get<T>(section: string, defaultValue: T): T;
}

/**
 * Synchronous file lock matching the protocol used by the phren MCP server
 * (governance-locks.ts). Lock file is `filePath + ".lock"`, created with the
 * O_EXCL flag. Both processes must use this convention for mutual exclusion to work.
 */
function withFileLockSync<T>(filePath: string, fn: () => T): T {
  const lockPath = filePath + ".lock";
  const maxWait = 5000;
  const pollInterval = 100;
  const staleThreshold = 30000;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let waited = 0;
  let hasLock = false;

  // Use Atomics.wait for cross-platform sleep without busy-spin
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  const sleep = (ms: number) => Atomics.wait(sleepBuf, 0, 0, ms);

  while (waited < maxWait) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: "wx" });
      hasLock = true;
      break;
    } catch {
      // Lock held — check for staleness
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleThreshold) {
          try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
          continue;
        }
      } catch { /* lock file may have been released between checks */ }
      sleep(pollInterval);
      waited += pollInterval;
    }
  }

  if (!hasLock) {
    // Best-effort: proceed without lock rather than silently dropping the write
    try { return fn(); } catch { return {} as T; }
  }

  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

function readJsonFileSafe(filePath: string): Record<string, unknown> {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  } catch {
    // Corrupt or missing file — start fresh
  }
  return {};
}

function writeJsonFileAtomic(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmpPath, filePath);
}

function patchJsonFile(filePath: string, patch: Record<string, unknown>): void {
  withFileLockSync(filePath, () => {
    const current = readJsonFileSafe(filePath);
    writeJsonFileAtomic(filePath, { ...current, ...patch, updatedAt: new Date().toISOString() });
  });
}

function syncSettingsToPreferences(storePath: string, config: ConfigSource): void {
  try {
    const governancePrefsPath = path.join(storePath, ".config", "install-preferences.json");
    const runtimePrefsPath = path.join(storePath, ".runtime", "install-preferences.json");
    const workflowPolicyPath = path.join(storePath, ".config", "workflow-policy.json");

    // Proactivity → governance install-preferences.json
    const proactivity = config.get<string>("proactivity", "");
    const proactivityFindings = config.get<string>("proactivityFindings", "");
    const proactivityTasks = config.get<string>("proactivityTasks", "");
    const governancePatch: Record<string, unknown> = {};
    if (proactivity && ["high", "medium", "low"].includes(proactivity)) {
      governancePatch.proactivity = proactivity;
    }
    if (proactivityFindings && ["high", "medium", "low"].includes(proactivityFindings)) {
      governancePatch.proactivityFindings = proactivityFindings;
    }
    if (proactivityTasks && ["high", "medium", "low"].includes(proactivityTasks)) {
      governancePatch.proactivityTask = proactivityTasks;
    }
    if (Object.keys(governancePatch).length > 0) {
      patchJsonFile(governancePrefsPath, governancePatch);
    }

    // Hooks enabled → runtime install-preferences.json
    const hooksEnabled = config.get<boolean>("hooksEnabled", true);
    patchJsonFile(runtimePrefsPath, { hooksEnabled });

    // Auto-extract / auto-capture → runtime install-preferences.json
    const autoExtract = config.get<boolean>("autoExtract", true);
    const autoCapture = config.get<boolean>("autoCapture", false);
    patchJsonFile(runtimePrefsPath, { autoExtract, autoCapture });

    // Task mode → governance workflow-policy.json
    const taskMode = config.get<string>("taskMode", "");
    if (taskMode && ["off", "manual", "suggest", "auto"].includes(taskMode)) {
      patchJsonFile(workflowPolicyPath, { taskMode });
    }

    // Semantic dedup/conflict + LLM model → runtime install-preferences.json
    const semanticDedup = config.get<boolean>("semanticDedup", false);
    const semanticConflict = config.get<boolean>("semanticConflict", false);
    const llmModel = config.get<string>("llmModel", "");
    const semanticPatch: Record<string, unknown> = { semanticDedup, semanticConflict };
    if (llmModel) semanticPatch.llmModel = llmModel;
    patchJsonFile(runtimePrefsPath, semanticPatch);

    // Finding sensitivity → governance policy.json
    const findingSensitivity = config.get<string>("findingSensitivity", "");
    if (findingSensitivity && ["minimal", "conservative", "balanced", "aggressive"].includes(findingSensitivity)) {
      const policyPath = path.join(storePath, ".config", "policy.json");
      patchJsonFile(policyPath, { findingSensitivity });
    }
  } catch {
    // Best-effort: don't crash the extension if preference files can't be written
  }
}
