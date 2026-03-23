import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as vscode from "vscode";
import { type ExtensionContext, toErrorMessage } from "../extensionContext";
import {
  listProfileConfigs,
  machineIdPath,
  machinesConfigPath,
  readDeviceContext,
  readMachineName,
  setMachineProfile,
  writeMachineName,
} from "../profileConfig";
import {
  cleanYamlScalar,
  isGlobalPhrenInstalled,
  removePhrenStore,
  runCommandWithProgress,
  summarizeCommandError,
  uninstallGlobalPhrenPackage,
} from "./command-utils";

export function registerMachineCommands(ctx: ExtensionContext): vscode.Disposable[] {
  const { phrenClient, outputChannel, treeDataProvider, statusBar, runtimeConfig } = ctx;

  const uninstall = vscode.commands.registerCommand("phren.uninstall", async () => {
    const confirmed = await vscode.window.showWarningMessage(
      "This will remove Phren config and hooks from this machine. Are you sure?",
      { modal: true },
      "Uninstall",
    );
    if (confirmed !== "Uninstall") {
      return;
    }

    try {
      const result = await runCommandWithProgress(
        "Phren: Uninstalling...",
        runtimeConfig.nodePath,
        [runtimeConfig.mcpServerPath!, "uninstall", "--yes"],
        { env: { PHREN_PATH: runtimeConfig.storePath } },
      );
      if (result.ok) {
        const warnings: string[] = [];
        const storeCleanup = removePhrenStore(runtimeConfig.storePath);
        if (storeCleanup.error) {
          warnings.push(`Store cleanup failed: ${storeCleanup.error}`);
        }

        if (await isGlobalPhrenInstalled()) {
          const packageCleanup = uninstallGlobalPhrenPackage();
          if (!packageCleanup.ok) {
            warnings.push(`Global package cleanup failed: ${summarizeCommandError(packageCleanup)}`);
          }
        }

        const config = vscode.workspace.getConfiguration("phren");
        const onboardingMarker = path.join(os.homedir(), ".phren", ".onboarding-complete");
        try { if (fs.existsSync(onboardingMarker)) fs.unlinkSync(onboardingMarker); } catch { /* best effort */ }
        try { await config.update("onboardingComplete", undefined, vscode.ConfigurationTarget.Global); } catch { /* best effort */ }

        treeDataProvider.refresh();
        if (warnings.length > 0) {
          for (const warning of warnings) {
            outputChannel.appendLine(`Phren uninstall warning: ${warning}`);
          }
          await vscode.window.showWarningMessage("Phren uninstall complete with warnings. See the Phren output channel.");
        } else {
          await vscode.window.showInformationMessage("Phren uninstall complete.");
        }
      } else {
        await vscode.window.showErrorMessage(`Phren uninstall failed: ${summarizeCommandError(result)}`);
      }
    } catch (error) {
      await vscode.window.showErrorMessage(`Phren uninstall failed: ${toErrorMessage(error)}`);
    }
  });

  const openMachinesYaml = vscode.commands.registerCommand("phren.openMachinesYaml", async () => {
    try {
      const machinesPath = path.join(os.homedir(), ".phren", "machines.yaml");
      if (!fs.existsSync(machinesPath)) {
        await vscode.window.showInformationMessage("No machines.yaml found at ~/.phren/machines.yaml.");
        return;
      }
      const document = await vscode.workspace.openTextDocument(machinesPath);
      await vscode.window.showTextDocument(document);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to open machines.yaml: ${toErrorMessage(error)}`);
    }
  });

  const setMachineAlias = vscode.commands.registerCommand("phren.setMachineAlias", async () => {
    const alias = await vscode.window.showInputBox({
      prompt: "Enter machine alias",
      placeHolder: "e.g. work-laptop",
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return "Machine alias cannot be empty.";
        if (/[:#]/.test(trimmed)) return "Machine alias cannot contain ':' or '#'.";
        return null;
      },
    });
    const trimmedAlias = alias?.trim();
    if (!trimmedAlias) return;

    const machinesPath = path.join(os.homedir(), ".phren", "machines.yaml");
    if (!fs.existsSync(machinesPath)) {
      await vscode.window.showInformationMessage("No machines.yaml found at ~/.phren/machines.yaml.");
      return;
    }

    try {
      const currentHostname = os.hostname();
      if (trimmedAlias === currentHostname) {
        await vscode.window.showInformationMessage(`Machine alias is already "${trimmedAlias}".`);
        return;
      }

      const raw = fs.readFileSync(machinesPath, "utf8");
      const lines = raw.split(/\r?\n/);

      for (const line of lines) {
        const match = line.match(/^(\s*)([^:#]+?)(\s*:\s*.+)$/);
        if (!match) continue;
        const machine = cleanYamlScalar(match[2]);
        if (machine === trimmedAlias && machine !== currentHostname) {
          await vscode.window.showWarningMessage(`machines.yaml already contains an entry for "${trimmedAlias}".`);
          return;
        }
      }

      let updated = false;
      const nextLines = lines.map((line) => {
        const match = line.match(/^(\s*)([^:#]+?)(\s*:\s*.+)$/);
        if (!match) return line;
        const machine = cleanYamlScalar(match[2]);
        if (machine !== currentHostname) return line;
        updated = true;
        return `${match[1]}${trimmedAlias}${match[3]}`;
      });

      if (!updated) {
        await vscode.window.showWarningMessage(
          `No machines.yaml entry found for hostname "${currentHostname}".`,
        );
        return;
      }

      const contentWithoutTrailingBlankLines = nextLines.join("\n").replace(/\n+$/, "");
      const nextContent = raw.endsWith("\n")
        ? `${contentWithoutTrailingBlankLines}\n`
        : contentWithoutTrailingBlankLines;
      fs.writeFileSync(machinesPath, nextContent, "utf8");
      treeDataProvider.refresh();
      await vscode.window.showInformationMessage(`Updated machine alias to "${trimmedAlias}".`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to set machine alias: ${toErrorMessage(error)}`);
    }
  });

  const openMachinesConfig = vscode.commands.registerCommand("phren.openMachinesConfig", async () => {
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

  const switchProfile = vscode.commands.registerCommand("phren.switchProfile", async () => {
    try {
      const machine = readMachineName();
      const current = readDeviceContext(runtimeConfig.storePath);
      const profiles = listProfileConfigs(runtimeConfig.storePath);
      if (profiles.length === 0) {
        const profileChoice = await vscode.window.showInformationMessage("No profiles found in the Phren store.", "Open machines.yaml");
        if (profileChoice === "Open machines.yaml") {
          await vscode.commands.executeCommand("phren.openMachinesConfig");
        }
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

  const configureMachine = vscode.commands.registerCommand("phren.configureMachine", async () => {
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

  return [
    uninstall,
    openMachinesYaml,
    setMachineAlias,
    openMachinesConfig,
    switchProfile,
    configureMachine,
  ];
}
