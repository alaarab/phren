import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";
import { PhrenClient } from "./phrenClient";
import { PhrenTreeProvider } from "./providers/PhrenTreeProvider";
import { PhrenStatusBar } from "./statusBar";
import { resolveRuntimeConfig } from "./runtimeConfig";
import { type ExtensionContext as PhrenExtCtx, toErrorMessage, asRecord, asArraySafe } from "./extensionContext";
import { runOnboardingIfNeeded, registerOnboardingCommands, handleWalkthroughChecks } from "./onboarding";
import { registerFindingCommands } from "./commands/finding-commands";
import { registerTaskCommands } from "./commands/task-commands";
import { registerProjectCommands } from "./commands/project-commands";
import { registerMachineCommands } from "./commands/machine-commands";

let client: PhrenClient | undefined;
let outputChannel: vscode.OutputChannel;
let hooksOutputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Phren");
  context.subscriptions.push(outputChannel);
  hooksOutputChannel = vscode.window.createOutputChannel("Phren Hooks");
  context.subscriptions.push(hooksOutputChannel);
  outputChannel.appendLine("Phren extension activating...");
  const config = vscode.workspace.getConfiguration("phren");
  await runOnboardingIfNeeded(config, outputChannel);
  const runtimeConfig = resolveRuntimeConfig(vscode.workspace.getConfiguration("phren"));

  outputChannel.appendLine(`Phren store path: ${runtimeConfig.storePath}`);
  outputChannel.appendLine(`Node path: ${runtimeConfig.nodePath}`);
  outputChannel.appendLine(
    `MCP server path: ${runtimeConfig.mcpServerPath ?? "(not found; run 'npx @phren/cli init' or configure phren.mcpServerPath)"}`,
  );

  // --- Register onboarding commands (available even without backend) ---
  context.subscriptions.push(...registerOnboardingCommands(config, outputChannel));

  // --- Check walkthrough state; bail if backend/store not ready ---
  const ready = await handleWalkthroughChecks(runtimeConfig, outputChannel);
  if (!ready) return;

  // --- Create shared state ---
  const phrenClient = new PhrenClient({
    mcpServerPath: runtimeConfig.mcpServerPath!,
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

  const extCtx: PhrenExtCtx = {
    phrenClient,
    outputChannel,
    hooksOutputChannel,
    statusBar,
    treeDataProvider,
    context,
    storePath: runtimeConfig.storePath,
    runtimeConfig: {
      mcpServerPath: runtimeConfig.mcpServerPath!,
      storePath: runtimeConfig.storePath,
      nodePath: runtimeConfig.nodePath,
    },
  };

  // --- Register all commands from modules ---
  context.subscriptions.push(
    ...registerFindingCommands(extCtx),
    ...registerTaskCommands(extCtx),
    ...registerProjectCommands(extCtx),
    ...registerMachineCommands(extCtx),
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
        const modelChoice = await vscode.window.showWarningMessage(
          `Phren: "${llmModel}" is expensive for offline batch operations. Haiku is recommended and costs ~10x less.`,
          "Switch to Haiku",
        );
        if (modelChoice === "Switch to Haiku") {
          await updated.update("llmModel", "claude-haiku-4-5-20251001", vscode.ConfigurationTarget.Global);
        }
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

  let projectsRaw: unknown;
  try {
    projectsRaw = await phrenClient.listProjects();
  } catch (error) {
    outputChannel.appendLine(`Failed to fetch projects: ${toErrorMessage(error)}`);
  }

  try {
    await statusBar.initialize(projectsRaw);
    outputChannel.appendLine("Status bar initialized successfully");
  } catch (error) {
    outputChannel.appendLine(`Status bar init failed: ${toErrorMessage(error)}`);
    await vscode.window.showErrorMessage(`Failed to initialize active Phren project: ${toErrorMessage(error)}`);
  }

  // --- Set firstProjectAdded context key ---
  try {
    const projectsData = asRecord(asRecord(projectsRaw)?.data);
    const projects = asArraySafe(projectsData?.projects);
    const hasProjects = projects.length > 0;
    await vscode.commands.executeCommand("setContext", "phren.firstProjectAdded", hasProjects);
  } catch {
    // Non-critical — walkthrough step just won't auto-complete
  }

  // --- Workspace folder detection: offer to track untracked folders ---
  detectAndOfferWorkspaceFolders(phrenClient, context, treeDataProvider, projectsRaw);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      detectAndOfferWorkspaceFolders(phrenClient, context, treeDataProvider);
    }),
  );
}

export async function deactivate(): Promise<void> {
  if (!client) {
    return;
  }

  await client.dispose();
  client = undefined;
}

// ── Workspace folder detection ──────────────────────────────────────────────

async function detectAndOfferWorkspaceFolders(
  phrenClient: PhrenClient,
  context: vscode.ExtensionContext,
  treeDataProvider: PhrenTreeProvider,
  prefetchedProjectsRaw?: unknown,
): Promise<void> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return;

    const projectsRaw = prefetchedProjectsRaw ?? await phrenClient.listProjects();
    const projectsData = asRecord(asRecord(projectsRaw)?.data);
    const projects = asArraySafe(projectsData?.projects);
    const trackedPaths = new Set<string>();
    for (const p of projects) {
      const rec = asRecord(p);
      const src = typeof rec?.source === "string" ? rec.source : undefined;
      if (src) trackedPaths.add(src);
    }

    const dismissed: string[] = context.globalState.get("phren.dismissedFolders", []);
    const dismissedSet = new Set(dismissed);

    const untracked = workspaceFolders.filter(
      (f) => !trackedPaths.has(f.uri.fsPath) && !dismissedSet.has(f.uri.fsPath),
    );
    if (untracked.length === 0) return;

    if (untracked.length === 1) {
      const folder = untracked[0];
      const choice = await vscode.window.showInformationMessage(
        `Track "${folder.name}" in Phren?`,
        "Track Project",
        "Not Now",
      );
      if (choice === "Track Project") {
        await phrenClient.addProject(folder.uri.fsPath);
        treeDataProvider.refresh();
        await vscode.commands.executeCommand("setContext", "phren.firstProjectAdded", true);
        await vscode.window.showInformationMessage(`Project "${folder.name}" added to Phren.`);
      } else {
        await context.globalState.update("phren.dismissedFolders", [...dismissed, folder.uri.fsPath]);
      }
    } else {
      const choice = await vscode.window.showInformationMessage(
        `${untracked.length} workspace folders aren't tracked in Phren.`,
        "Choose...",
        "Not Now",
      );
      if (choice === "Choose...") {
        const picks = untracked.map((f) => ({
          label: f.name,
          description: f.uri.fsPath,
          picked: true,
        }));
        const selected = await vscode.window.showQuickPick(picks, {
          canPickMany: true,
          placeHolder: "Select folders to track in Phren",
        });
        if (selected && selected.length > 0) {
          for (const pick of selected) {
            await phrenClient.addProject(pick.description!);
          }
          treeDataProvider.refresh();
          await vscode.commands.executeCommand("setContext", "phren.firstProjectAdded", true);
          await vscode.window.showInformationMessage(`${selected.length} project(s) added to Phren.`);
        }
        // Dismiss folders not selected
        const selectedPaths = new Set(selected?.map((s) => s.description) ?? []);
        const nowDismissed = untracked
          .filter((f) => !selectedPaths.has(f.uri.fsPath))
          .map((f) => f.uri.fsPath);
        if (nowDismissed.length > 0) {
          await context.globalState.update("phren.dismissedFolders", [...dismissed, ...nowDismissed]);
        }
      } else if (choice === "Not Now") {
        await context.globalState.update(
          "phren.dismissedFolders",
          [...dismissed, ...untracked.map((f) => f.uri.fsPath)],
        );
      }
    }
  } catch (error) {
    outputChannel.appendLine(`Workspace folder detection failed: ${toErrorMessage(error)}`);
  }
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

  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  const sleep = (ms: number) => Atomics.wait(sleepBuf, 0, 0, ms);

  while (waited < maxWait) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: "wx" });
      hasLock = true;
      break;
    } catch {
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
