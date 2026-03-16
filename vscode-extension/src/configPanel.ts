import * as vscode from "vscode";
import { PhrenClient } from "./phrenClient";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function sourceLabel(source: string | undefined): { icon: string; detail: string } {
  if (source === "project") {
    return { icon: "$(edit)", detail: "project override — stored in phren.project.yaml" };
  }
  return { icon: "$(dash)", detail: "inherited from global default" };
}

// Show a warning if the MCP response included a registration warning.
function maybeWarn(raw: unknown): void {
  const data = asRecord(asRecord(raw)?.data);
  const warning = typeof data?.warning === "string" ? data.warning : undefined;
  if (warning) {
    void vscode.window.showWarningMessage(`Phren: ${warning}`);
  }
}

export async function showProjectConfigPanel(client: PhrenClient, project: string): Promise<void> {
  let configData: Record<string, unknown> | undefined;
  try {
    const raw = await client.getConfig(project);
    configData = asRecord(asRecord(raw)?.data);
  } catch (error) {
    await vscode.window.showErrorMessage(`Failed to load config for "${project}": ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (!configData) {
    await vscode.window.showErrorMessage(`No config data returned for "${project}".`);
    return;
  }

  const proactivityData = asRecord(configData.proactivity);
  const proactivityBase = typeof proactivityData?.base === "string" ? proactivityData.base : "high";
  const proactivitySource = asRecord(proactivityData?._source);
  const proactivityBaseSource = typeof proactivitySource?.base === "string" ? proactivitySource.base : undefined;

  const taskModeData = asRecord(configData.taskMode);
  const taskMode = typeof taskModeData?.taskMode === "string" ? taskModeData.taskMode : "auto";
  const taskModeSource = typeof taskModeData?._source === "string" ? taskModeData._source : undefined;

  const findingData = asRecord(configData.findingSensitivity);
  const findingSensitivity = typeof findingData?.level === "string" ? findingData.level : "balanced";
  const findingSource = typeof findingData?._source === "string" ? findingData._source : undefined;

  const retentionData = asRecord(configData.retention);
  const ttlDays = typeof retentionData?.ttlDays === "number" ? retentionData.ttlDays : 120;
  const retentionSource = typeof retentionData?._source === "string" ? retentionData._source : undefined;

  const proactivitySrc = sourceLabel(proactivityBaseSource);
  const taskModeSrc = sourceLabel(taskModeSource);
  const findingSrc = sourceLabel(findingSource);
  const retentionSrc = sourceLabel(retentionSource);

  const picks: vscode.QuickPickItem[] = [
    {
      label: `${proactivitySrc.icon} Proactivity`,
      description: proactivityBase,
      detail: `${proactivitySrc.detail}  •  high / medium / low`,
    },
    {
      label: `${taskModeSrc.icon} Task Mode`,
      description: taskMode,
      detail: `${taskModeSrc.detail}  •  off / manual / suggest / auto`,
    },
    {
      label: `${findingSrc.icon} Finding Sensitivity`,
      description: findingSensitivity,
      detail: `${findingSrc.detail}  •  minimal / conservative / balanced / aggressive`,
    },
    {
      label: `${retentionSrc.icon} Retention TTL`,
      description: `${ttlDays} days`,
      detail: `${retentionSrc.detail}  •  days before memories decay`,
    },
  ];

  const chosen = await vscode.window.showQuickPick(picks, {
    title: `Phren Config — ${project}`,
    placeHolder: "Select a setting to change",
  });
  if (!chosen) return;

  if (chosen.label.includes("Proactivity")) {
    await editProactivity(client, project, proactivityBase);
  } else if (chosen.label.includes("Task Mode")) {
    await editTaskMode(client, project, taskMode);
  } else if (chosen.label.includes("Finding Sensitivity")) {
    await editFindingSensitivity(client, project, findingSensitivity);
  } else if (chosen.label.includes("Retention TTL")) {
    await editRetentionTtl(client, project, ttlDays);
  }
}

async function editProactivity(client: PhrenClient, project: string, current: string): Promise<void> {
  const options: vscode.QuickPickItem[] = [
    { label: "high", description: "Always auto-capture findings and tasks", picked: current === "high" },
    { label: "medium", description: "Only capture on explicit signals", picked: current === "medium" },
    { label: "low", description: "Never auto-capture — fully manual", picked: current === "low" },
  ];
  const choice = await vscode.window.showQuickPick(options, {
    title: `Proactivity for "${project}"`,
    placeHolder: `Current: ${current}`,
  });
  if (!choice) return;

  try {
    const raw = await client.setProactivity(choice.label, project, "base");
    maybeWarn(raw);
    await vscode.window.showInformationMessage(`Proactivity for "${project}" set to "${choice.label}".`);
  } catch (error) {
    await vscode.window.showErrorMessage(`Failed to set proactivity: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function editTaskMode(client: PhrenClient, project: string, current: string): Promise<void> {
  const options: vscode.QuickPickItem[] = [
    { label: "off", description: "Task system completely disabled", picked: current === "off" },
    { label: "manual", description: "Tasks only created when explicitly requested", picked: current === "manual" },
    { label: "suggest", description: "Agent suggests tasks, you confirm", picked: current === "suggest" },
    { label: "auto", description: "Agent adds tasks automatically", picked: current === "auto" },
  ];
  const choice = await vscode.window.showQuickPick(options, {
    title: `Task Mode for "${project}"`,
    placeHolder: `Current: ${current}`,
  });
  if (!choice) return;

  try {
    const raw = await client.setTaskMode(choice.label, project);
    maybeWarn(raw);
    await vscode.window.showInformationMessage(`Task mode for "${project}" set to "${choice.label}".`);
  } catch (error) {
    await vscode.window.showErrorMessage(`Failed to set task mode: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function editFindingSensitivity(client: PhrenClient, project: string, current: string): Promise<void> {
  const options: vscode.QuickPickItem[] = [
    { label: "minimal", description: "Only explicit requests. No auto-capture.", picked: current === "minimal" },
    { label: "conservative", description: "Decisions and pitfalls only. Cap: 3/session.", picked: current === "conservative" },
    { label: "balanced", description: "Non-obvious patterns and decisions. Cap: 10/session.", picked: current === "balanced" },
    { label: "aggressive", description: "Capture everything worth remembering. Cap: 20/session.", picked: current === "aggressive" },
  ];
  const choice = await vscode.window.showQuickPick(options, {
    title: `Finding Sensitivity for "${project}"`,
    placeHolder: `Current: ${current}`,
  });
  if (!choice) return;

  try {
    const raw = await client.setFindingSensitivity(choice.label, project);
    maybeWarn(raw);
    await vscode.window.showInformationMessage(`Finding sensitivity for "${project}" set to "${choice.label}".`);
  } catch (error) {
    await vscode.window.showErrorMessage(`Failed to set finding sensitivity: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function editRetentionTtl(client: PhrenClient, project: string, current: number): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: `Retention TTL for "${project}"`,
    prompt: "Days before memories decay — written as a project-level override",
    value: String(current),
    validateInput: (v) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? null : "Enter a positive integer";
    },
  });
  if (!input) return;

  const ttlDays = parseInt(input, 10);
  try {
    const raw = await client.setRetentionPolicy({ ttlDays }, project);
    maybeWarn(raw);
    await vscode.window.showInformationMessage(`Retention TTL for "${project}" set to ${ttlDays} days.`);
  } catch (error) {
    await vscode.window.showErrorMessage(`Failed to set retention TTL: ${error instanceof Error ? error.message : String(error)}`);
  }
}
