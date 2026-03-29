import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { type ExtensionContext, toErrorMessage, asRecord, asArraySafe } from "../extensionContext";
import { showSearchQuickPick } from "../searchQuickPick";
import { showGraphWebview } from "../graphWebview";
import { showProjectFile } from "../projectFileViewer";
import { showSkillEditor } from "../skillEditor";
import { showProjectConfigPanel } from "../configPanel";
import { showSetupWizard } from "../setupWizard";

export function registerProjectCommands(ctx: ExtensionContext): vscode.Disposable[] {
  const { phrenClient, outputChannel, hooksOutputChannel, statusBar, treeDataProvider, runtimeConfig } = ctx;

  const setActiveProject = vscode.commands.registerCommand("phren.setActiveProject", async () => {
    try {
      await statusBar.promptForActiveProject();
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to load Phren projects: ${toErrorMessage(error)}`);
    }
  });

  const search = vscode.commands.registerCommand("phren.search", async () => {
    try {
      await showSearchQuickPick(phrenClient);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to search Phren knowledge: ${toErrorMessage(error)}`);
    }
  });

  const showGraph = vscode.commands.registerCommand("phren.showGraph", async () => {
    try {
      await showGraphWebview(phrenClient, ctx.context);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to show Phren graph: ${toErrorMessage(error)}`);
    }
  });

  const refresh = vscode.commands.registerCommand("phren.refresh", async () => {
    treeDataProvider.refresh();
    try {
      await statusBar.initialize();
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to refresh Phren extension state: ${toErrorMessage(error)}`);
    }
  });

  const openProjectFile = vscode.commands.registerCommand(
    "phren.openProjectFile",
    async (projectName: string, fileName: string) => {
      try {
        await showProjectFile(phrenClient, projectName, fileName);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to open project file: ${toErrorMessage(error)}`);
      }
    },
  );

  const openSkill = vscode.commands.registerCommand(
    "phren.openSkill",
    async (skillName: string, skillSource: string) => {
      try {
        await showSkillEditor(phrenClient, skillName, skillSource);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to open skill: ${toErrorMessage(error)}`);
      }
    },
  );

  const toggleSkill = vscode.commands.registerCommand(
    "phren.toggleSkill",
    async (skillName: string, skillSource: string, currentlyEnabled: boolean) => {
      try {
        const project = skillSource === "global" ? undefined : skillSource;
        await phrenClient.toggleSkill(skillName, !currentlyEnabled, project);
        treeDataProvider.refresh();
        await vscode.window.showInformationMessage(
          `Skill "${skillName}" ${currentlyEnabled ? "disabled" : "enabled"}.`,
        );
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to toggle skill: ${toErrorMessage(error)}`);
      }
    },
  );

  const toggleHook = vscode.commands.registerCommand(
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

  const toggleProjectHook = vscode.commands.registerCommand(
    "phren.toggleProjectHook",
    async (node: { projectName: string; event: string; enabled: boolean; configured: boolean | null }) => {
      try {
        // 3-state cycle: inherit → override-off → override-on → inherit
        // configured === null means inheriting global
        // configured === true means overridden on
        // configured === false means overridden off
        if (node.configured === null) {
          // Currently inheriting: set explicit override to OFF (opposite of enabled to make it visible)
          await phrenClient.toggleHooks(false, undefined, node.projectName, node.event);
          await vscode.window.showInformationMessage(`Hook "${node.event}" for "${node.projectName}" overridden: disabled.`);
        } else if (node.configured === false) {
          // Currently overridden off: flip to overridden on
          await phrenClient.toggleHooks(true, undefined, node.projectName, node.event);
          await vscode.window.showInformationMessage(`Hook "${node.event}" for "${node.projectName}" overridden: enabled.`);
        } else {
          // Currently overridden on: clear override, restore inheritance
          await phrenClient.clearProjectHookOverride(node.projectName, node.event);
          await vscode.window.showInformationMessage(`Hook "${node.event}" for "${node.projectName}" now inheriting from global.`);
        }
        treeDataProvider.refresh();
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to toggle project hook: ${toErrorMessage(error)}`);
      }
    },
  );

  const sync = vscode.commands.registerCommand("phren.sync", async () => {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Phren: Syncing...", cancellable: false },
        async () => {
          await phrenClient.pushChanges();
        },
      );
      treeDataProvider.refresh();
      await statusBar.initialize();
      await vscode.window.showInformationMessage("Phren: Sync complete.");
    } catch (error) {
      await vscode.window.showErrorMessage(`Phren sync failed: ${toErrorMessage(error)}`);
    }
  });

  const hooksStatus = vscode.commands.registerCommand("phren.hooksStatus", async () => {
    try {
      const raw = await phrenClient.listHooks();
      const data = asRecord(asRecord(raw)?.data);
      hooksOutputChannel.clear();
      hooksOutputChannel.appendLine("=== Phren Hooks Status ===");
      hooksOutputChannel.appendLine("");

      if (!data) {
        hooksOutputChannel.appendLine(JSON.stringify(raw, null, 2));
      } else {
        const globalEnabled = data.globalEnabled;
        if (typeof globalEnabled === "boolean") {
          hooksOutputChannel.appendLine(`Global: ${globalEnabled ? "enabled" : "disabled"}`);
        }

        const tools = asArraySafe(data.tools);
        if (tools.length > 0) {
          hooksOutputChannel.appendLine("");
          hooksOutputChannel.appendLine("Tools:");
          for (const toolEntry of tools) {
            const record = asRecord(toolEntry);
            const tool = typeof record?.tool === "string" ? record.tool : "unknown";
            const enabled = record?.enabled === true ? "enabled" : "disabled";
            hooksOutputChannel.appendLine(`  ${tool}: ${enabled}`);
          }
        } else {
          hooksOutputChannel.appendLine("No hooks reported.");
        }
      }

      hooksOutputChannel.appendLine("");
      hooksOutputChannel.appendLine("=== End ===");
      hooksOutputChannel.show(true);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to load hooks status: ${toErrorMessage(error)}`);
    }
  });

  const toggleHooks = vscode.commands.registerCommand("phren.toggleHooks", async () => {
    const choice = await vscode.window.showQuickPick(
      ["Enable All Hooks", "Disable All Hooks"],
      { placeHolder: "Select hook action" },
    );
    if (!choice) return;

    const enabled = choice === "Enable All Hooks";
    try {
      await phrenClient.toggleHooks(enabled);
      treeDataProvider.refresh();
      await vscode.window.showInformationMessage(`Phren hooks ${enabled ? "enabled" : "disabled"}.`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to toggle hooks: ${toErrorMessage(error)}`);
    }
  });

  const doctor = vscode.commands.registerCommand("phren.doctor", async () => {
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

  const doctorFix = vscode.commands.registerCommand("phren.doctorFix", async () => {
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

  const toggleProject = vscode.commands.registerCommand(
    "phren.toggleProject",
    async (node?: { projectName: string; archived?: boolean }) => {
      if (!node?.projectName) {
        await vscode.window.showWarningMessage("Toggle Project is available from the Phren explorer project context menu.");
        return;
      }
      const action = node.archived ? "unarchive" : "archive";
      const label = node.archived ? "Restore" : "Archive";
      const confirmed = await vscode.window.showWarningMessage(
        `${label} project "${node.projectName}"?`,
        { modal: false },
        label,
      );
      if (confirmed !== label) return;
      try {
        await phrenClient.manageProject(node.projectName, action);
        treeDataProvider.refresh();
        await vscode.window.showInformationMessage(`Project "${node.projectName}" ${action}d.`);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to ${action} project: ${toErrorMessage(error)}`);
      }
    },
  );

  const addProject = vscode.commands.registerCommand("phren.addProject", async (uri?: vscode.Uri) => {
    try {
      let selectedPath: string | undefined;

      if (uri) {
        selectedPath = uri.fsPath;
      } else {
        const projectsRaw = await phrenClient.listProjects();
        const projectsData = asRecord(asRecord(projectsRaw)?.data);
        const projects = asArraySafe(projectsData?.projects);
        const trackedPaths = new Set<string>();
        for (const p of projects) {
          const rec = asRecord(p);
          const src = typeof rec?.source === "string" ? rec.source : undefined;
          if (src) trackedPaths.add(src);
        }

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const untrackedFolders = workspaceFolders.filter((f) => !trackedPaths.has(f.uri.fsPath));

        if (workspaceFolders.length === 0) {
          const action = await vscode.window.showInformationMessage(
            "No workspace folders open. Browse to add a project folder.",
            "Browse...",
          );
          if (action !== "Browse...") return;
          const folders = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: "Add Project",
          });
          if (!folders || folders.length === 0) return;
          selectedPath = folders[0].fsPath;
        } else {
          const picks: vscode.QuickPickItem[] = untrackedFolders.map((f) => ({
            label: f.name,
            description: f.uri.fsPath,
          }));
          const browseDescription = untrackedFolders.length === 0
            ? "All workspace folders already tracked — browse for another"
            : "Choose a folder from disk";
          picks.push({ label: "$(folder-opened) Browse...", description: browseDescription });

          const choice = await vscode.window.showQuickPick(picks, {
            placeHolder: "Select a folder to track in Phren",
          });
          if (!choice) return;

          if (choice.label.includes("Browse...")) {
            const folders = await vscode.window.showOpenDialog({
              canSelectFolders: true,
              canSelectFiles: false,
              canSelectMany: false,
              openLabel: "Add Project",
            });
            if (!folders || folders.length === 0) return;
            selectedPath = folders[0].fsPath;
          } else {
            selectedPath = choice.description;
          }
        }
      }

      if (!selectedPath) return;

      const ownershipPick = await vscode.window.showQuickPick(
        [
          { label: "detached", description: "Phren stores findings & tasks; your repo keeps its own CLAUDE.md (recommended)" },
          { label: "phren-managed", description: "Phren creates and manages CLAUDE.md, skills, and agents in ~/.phren" },
          { label: "repo-managed", description: "Phren reads CLAUDE.md from your repo instead of creating its own copy" },
        ],
        { placeHolder: "Select ownership mode" },
      );
      const ownership = ownershipPick?.label;
      if (!ownership) return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Adding project to Phren...", cancellable: false },
        async () => {
          await phrenClient.addProject(selectedPath!, undefined, ownership);
        },
      );

      treeDataProvider.refresh();
      await vscode.commands.executeCommand("setContext", "phren.firstProjectAdded", true);
      await vscode.window.showInformationMessage(`Project added: ${path.basename(selectedPath)}`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to add project: ${toErrorMessage(error)}`);
    }
  });

  const openSetupWizard = vscode.commands.registerCommand("phren.openSetupWizard", async () => {
    try {
      showSetupWizard(phrenClient, ctx.context, { hostname: os.hostname() });
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to open setup wizard: ${toErrorMessage(error)}`);
    }
  });

  const projectConfig = vscode.commands.registerCommand("phren.projectConfig", async () => {
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

  return [
    setActiveProject,
    search,
    showGraph,
    refresh,
    openProjectFile,
    openSkill,
    toggleSkill,
    toggleHook,
    toggleProjectHook,
    sync,
    hooksStatus,
    toggleHooks,
    doctor,
    doctorFix,
    toggleProject,
    addProject,
    openSetupWizard,
    projectConfig,
  ];
}

