import * as vscode from "vscode";
import { type ExtensionContext, toErrorMessage, asRecord, asArraySafe } from "../extensionContext";
import { showFindingDetail } from "../findingViewer";

export function registerFindingCommands(ctx: ExtensionContext): vscode.Disposable[] {
  const { phrenClient, statusBar, treeDataProvider } = ctx;
  const refreshTree = () => treeDataProvider.refresh();

  const addFinding = vscode.commands.registerCommand("phren.addFinding", async () => {
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

  const openFinding = vscode.commands.registerCommand(
    "phren.openFinding",
    (finding: { projectName: string; id: string; date: string; text: string; type?: string; confidence?: number }) => {
      showFindingDetail(phrenClient, finding, refreshTree);
    },
  );

  const removeFinding = vscode.commands.registerCommand(
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

  const supersedeFinding = vscode.commands.registerCommand(
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

  const retractFinding = vscode.commands.registerCommand(
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

  const resolveContradiction = vscode.commands.registerCommand(
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

  const pinMemory = vscode.commands.registerCommand("phren.pinMemory", async () => {
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

    const memoryText = await vscode.window.showInputBox({ prompt: "Enter memory text" });
    const trimmedMemoryText = memoryText?.trim();
    if (!trimmedMemoryText) return;

    try {
      await phrenClient.pinMemory(project, trimmedMemoryText);
      treeDataProvider.refresh();
      await vscode.window.showInformationMessage(`Memory pinned in ${project}`);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to pin memory: ${toErrorMessage(error)}`);
    }
  });

  const filterFindingsByDate = vscode.commands.registerCommand(
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

  return [
    addFinding,
    openFinding,
    removeFinding,
    supersedeFinding,
    retractFinding,
    resolveContradiction,
    pinMemory,
    filterFindingsByDate,
  ];
}
