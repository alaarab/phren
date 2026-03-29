import * as vscode from "vscode";
import { PhrenClient } from "./phrenClient";
import { PhrenTreeProvider } from "./providers/PhrenTreeProvider";
import { PhrenStatusBar } from "./statusBar";

/**
 * Shared state passed to command registration modules.
 */
export interface ExtensionContext {
  phrenClient: PhrenClient;
  outputChannel: vscode.OutputChannel;
  hooksOutputChannel: vscode.OutputChannel;
  statusBar: PhrenStatusBar;
  treeDataProvider: PhrenTreeProvider;
  context: vscode.ExtensionContext;
  storePath: string;
  runtimeConfig: {
    mcpServerPath: string;
    storePath: string;
    nodePath: string;
  };
}

// ── Shared utility functions ────────────────────────────────────────────────

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function asArraySafe(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Helper to pick a project: uses active project from status bar, or prompts from list.
 * Returns undefined if cancelled.
 */
export async function pickProject(
  ctx: ExtensionContext,
): Promise<string | undefined> {
  const active = ctx.statusBar.getActiveProjectName();
  if (active) return active;

  let projectsRaw: unknown;
  try {
    projectsRaw = await ctx.phrenClient.listProjects();
  } catch (error) {
    await vscode.window.showErrorMessage(`Failed to list projects: ${toErrorMessage(error)}`);
    return undefined;
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
    return undefined;
  }
  return vscode.window.showQuickPick(projectNames, { placeHolder: "Select a project" });
}
