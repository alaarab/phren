import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn } from "child_process";
import * as vscode from "vscode";
import { pathExists } from "./runtimeConfig";
import { toErrorMessage } from "./extensionContext";

const GLOBAL_PHREN_STORE_PATH = path.join(os.homedir(), ".phren");
const PHREN_PACKAGE_NAME = "@phren/cli";
const ONBOARDING_COMPLETE_SETTING = "onboardingComplete";

interface CommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

interface CommandOptions {
  env?: NodeJS.ProcessEnv;
}

export async function runOnboardingIfNeeded(
  config: vscode.WorkspaceConfiguration,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const markerFile = path.join(os.homedir(), ".phren", ".onboarding-complete");
  const completed = config.get<boolean>(ONBOARDING_COMPLETE_SETTING, false);
  if (completed) {
    return;
  }
  // Fallback: marker file catches the case where VS Code setting failed to persist
  // but only if the store still looks valid (not a stale marker from a removed install)
  if (fs.existsSync(markerFile) && pathExists(GLOBAL_PHREN_STORE_PATH) && hasPhrenMcpEntry(outputChannel)) {
    return;
  }

  outputChannel.appendLine("Running first-time Phren onboarding...");

  let setupSucceeded = false;
  try {
    // Initialize phren store — run automatically if missing or incomplete
    // No global install needed: init installs a CLI wrapper at ~/.local/bin/phren
    // A partial ~/.phren (e.g. from a failed clone) is not sufficient;
    // we check for the store AND MCP config before considering setup done.
    const needsInit = !pathExists(GLOBAL_PHREN_STORE_PATH) || !hasPhrenMcpEntry(outputChannel);
    if (needsInit) {
      const initChoice = await vscode.window.showInformationMessage(
        "Phren needs to be initialized. Set up now?",
        "Initialize Phren",
        "Skip",
      );
      if (initChoice === "Initialize Phren") {
        const cloneResult = await promptForCloneUrl();
        if (cloneResult.cancelled) return;

        const initArgs = [PHREN_PACKAGE_NAME, "init", "--yes"];
        if (cloneResult.url) {
          initArgs.push("--clone-url", cloneResult.url);
        }
        const result = await runCommandWithProgress(
          cloneResult.url ? "Cloning existing Phren store..." : "Initializing Phren...",
          getNpxCommand(),
          initArgs,
        );
        if (result.ok) {
          await vscode.window.showInformationMessage("Phren initialized successfully.");
          setupSucceeded = true;

          // Post-init: check if sync is broken (user intended sync but remote isn't working)
          try {
            const verifyResult = await runCommand(getNpxCommand(), [PHREN_PACKAGE_NAME, "verify"]);
            // verify exits non-zero when checks fail; look for git-remote FAIL in stdout
            if (verifyResult.stdout.includes("FAIL git-remote")) {
              // Read syncIntent from preferences to distinguish broken sync from intentional local
              const prefsPath = path.join(GLOBAL_PHREN_STORE_PATH, ".runtime", "install-preferences.json");
              if (fs.existsSync(prefsPath)) {
                const prefsData = safeParseJson(fs.readFileSync(prefsPath, "utf8"));
                if (prefsData?.syncIntent === "sync") {
                  const action = await vscode.window.showWarningMessage(
                    "Phren sync isn't working — your data is local-only. The clone URL may have been wrong or the remote is unreachable.",
                    "How to Fix",
                  );
                  if (action === "How to Fix") {
                    await vscode.window.showInformationMessage(
                      `Run in terminal:\n  cd ${GLOBAL_PHREN_STORE_PATH}\n  git remote add origin <YOUR_REPO_URL>\n  git push -u origin main`,
                    );
                  }
                }
              }
            }
          } catch {
            outputChannel.appendLine("Post-init sync verification skipped (non-critical).");
          }
        } else {
          await vscode.window.showErrorMessage(`Phren init failed: ${summarizeCommandError(result)}`);
        }
      }
    } else {
      setupSucceeded = true;
    }

    // Step 3: Track workspace (only offer if init succeeded)
    if (setupSucceeded) {
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
    }
  } finally {
    // Only mark onboarding complete if setup actually succeeded.
    // If it failed or was skipped, we'll ask again next activation.
    if (setupSucceeded) {
      try {
        await config.update(ONBOARDING_COMPLETE_SETTING, true, vscode.ConfigurationTarget.Global);
        outputChannel.appendLine("Phren onboarding complete (phren.onboardingComplete=true).");
      } catch (error) {
        outputChannel.appendLine(`Failed to persist onboarding flag: ${toErrorMessage(error)}`);
      }
      // Fallback marker file in case VS Code setting fails to persist
      try {
        fs.mkdirSync(path.dirname(markerFile), { recursive: true });
        fs.writeFileSync(markerFile, new Date().toISOString(), "utf8");
      } catch (markerErr) {
        outputChannel.appendLine(`Failed to write onboarding marker file: ${toErrorMessage(markerErr)}`);
      }
    } else {
      outputChannel.appendLine("Phren onboarding incomplete — will retry on next activation.");
    }
  }
}

/**
 * Register onboarding commands (available even without the backend running).
 */
export function registerOnboardingCommands(
  config: vscode.WorkspaceConfiguration,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable[] {
  const installBackend = vscode.commands.registerCommand("phren.installBackend", async () => {
    try {
      const cloneResult = await promptForCloneUrl();
      if (cloneResult.cancelled) return;

      const initArgs = [PHREN_PACKAGE_NAME, "init", "--yes"];
      if (cloneResult.url) {
        initArgs.push("--clone-url", cloneResult.url);
      }
      const result = await runCommandWithProgress(
        cloneResult.url ? "Cloning existing Phren store..." : "Installing Phren...",
        getNpxCommand(),
        initArgs,
      );
      if (result.ok) {
        await vscode.commands.executeCommand("setContext", "phren.backendInstalled", true);
        await vscode.commands.executeCommand("setContext", "phren.storeInitialized", true);
        const installChoice = await vscode.window.showInformationMessage(
          "Phren installed successfully. Reload to activate.",
          "Reload Window",
        );
        if (installChoice === "Reload Window") {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      } else {
        await vscode.window.showErrorMessage(
          `Phren install failed: ${summarizeCommandError(result)}. Try running 'npx @phren/cli init' in your terminal.`,
        );
      }
    } catch (error) {
      await vscode.window.showErrorMessage(`Phren install failed: ${toErrorMessage(error)}`);
    }
  });

  const initStore = vscode.commands.registerCommand("phren.initStore", async () => {
    try {
      const cloneResult = await promptForCloneUrl();
      if (cloneResult.cancelled) return;

      const initArgs = [PHREN_PACKAGE_NAME, "init", "--yes"];
      if (cloneResult.url) {
        initArgs.push("--clone-url", cloneResult.url);
      }
      const result = await runCommandWithProgress(
        cloneResult.url ? "Cloning existing Phren store..." : "Initializing Phren...",
        getNpxCommand(),
        initArgs,
      );
      if (result.ok) {
        await vscode.commands.executeCommand("setContext", "phren.storeInitialized", true);
        const initChoice = await vscode.window.showInformationMessage(
          "Phren initialized. Reload to activate.",
          "Reload Window",
        );
        if (initChoice === "Reload Window") {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      } else {
        await vscode.window.showErrorMessage(`Phren init failed: ${summarizeCommandError(result)}`);
      }
    } catch (error) {
      await vscode.window.showErrorMessage(`Phren init failed: ${toErrorMessage(error)}`);
    }
  });

  const openGettingStarted = vscode.commands.registerCommand("phren.openGettingStarted", () =>
    vscode.commands.executeCommand("workbench.action.openWalkthrough", "alaarab.phren-vscode#phren.gettingStarted", false),
  );

  return [installBackend, initStore, openGettingStarted];
}

/**
 * Check walkthrough state and handle missing backend / store scenarios.
 * Returns true if the extension should continue activating (backend + store ready).
 */
export async function handleWalkthroughChecks(
  runtimeConfig: { mcpServerPath?: string; storePath: string },
  outputChannel: vscode.OutputChannel,
): Promise<boolean> {
  const backendInstalled = !!runtimeConfig.mcpServerPath;
  const storeInitialized = pathExists(runtimeConfig.storePath) && hasPhrenMcpEntry(outputChannel);
  await vscode.commands.executeCommand("setContext", "phren.backendInstalled", backendInstalled);
  await vscode.commands.executeCommand("setContext", "phren.storeInitialized", storeInitialized);

  if (!runtimeConfig.mcpServerPath) {
    const choice = await vscode.window.showErrorMessage(
      "Phren not detected. Run init to set up.",
      "Run Init",
      "Run Doctor",
      "Open Settings",
    );
    if (choice === "Run Init") {
      await vscode.commands.executeCommand("phren.installBackend");
    } else if (choice === "Run Doctor") {
      await vscode.commands.executeCommand("phren.initStore");
    } else if (choice === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "phren.mcpServerPath");
    }
    await vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      "alaarab.phren-vscode#phren.gettingStarted",
      false,
    );
    return false;
  }

  const pathModule = require("path");
  if (!pathExists(runtimeConfig.mcpServerPath)) {
    const basename = pathModule.basename(runtimeConfig.mcpServerPath);
    const choice = await vscode.window.showErrorMessage(
      `Phren entrypoint not found: ${basename}. Try re-running init.`,
      "Re-run Init",
      "Run Doctor",
      "Open Settings",
    );
    if (choice === "Re-run Init") {
      await vscode.commands.executeCommand("phren.installBackend");
    } else if (choice === "Run Doctor") {
      await vscode.commands.executeCommand("phren.initStore");
    } else if (choice === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "phren.mcpServerPath");
    }
    return false;
  }

  if (!storeInitialized) {
    await vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      "alaarab.phren-vscode#phren.gettingStarted",
      false,
    );
    return false;
  }

  return true;
}

// ── Internal helpers ────────────────────────────────────────────────────────

export function hasPhrenMcpEntry(outputChannel?: vscode.OutputChannel): boolean {
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
    outputChannel?.appendLine(`Failed to read ${settingsPath}: ${toErrorMessage(error)}`);
    return false;
  }
}

async function promptForCloneUrl(): Promise<{ url?: string; cancelled: boolean }> {
  if (pathExists(GLOBAL_PHREN_STORE_PATH)) {
    return { cancelled: false };
  }
  const choice = await vscode.window.showQuickPick(
    [
      { label: "Create new store", description: "Start fresh on this machine" },
      { label: "Clone existing store", description: "I have a phren store on GitHub/GitLab" },
    ],
    { placeHolder: "Do you have an existing phren store?" },
  );
  if (!choice) return { cancelled: true };
  if (choice.label === "Create new store") return { cancelled: false };

  const url = await vscode.window.showInputBox({
    prompt: "Paste the git clone URL for your existing phren store",
    placeHolder: "https://github.com/you/phren-store.git",
    validateInput: (value) => {
      if (!value.trim()) return "Clone URL is required";
      if (!value.includes(".git") && !value.startsWith("git@") && !value.startsWith("https://")) {
        return "Enter a valid git clone URL";
      }
      return undefined;
    },
  });
  if (url === undefined) return { cancelled: true };
  return { url, cancelled: false };
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
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

async function runCommandWithProgress(
  title: string,
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    async () => runCommand(command, args, options),
  );
}

async function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
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
