import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import { PhrenClient } from "./phrenClient";

/**
 * Validate a project name from webview messages.
 * Rejects path traversal characters, dots, slashes, and other unsafe patterns.
 * Mirrors the server-side isValidProjectName() from mcp/src/utils.ts.
 */
function isValidProjectName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name.length > 100) return false;
  if (name.includes("\0") || name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return /^[a-z0-9][a-z0-9_-]*$/.test(name);
}

/**
 * Load the web-ui graph script from the MCP dist.
 * This gives us the Sigma.js v3 renderer with ForceAtlas2 layout, drag, glow, etc.
 *
 * Resolution order:
 * 1. Same directory as compiled extension JS (works in .vsix packaging)
 * 2. Repo-relative path (works in source checkout)
 * Falls back to empty string if neither is available.
 */
function loadGraphScript(): string {
  const candidates = [
    path.resolve(__dirname, "memory-ui-graph.runtime.js"),
    path.resolve(__dirname, "..", "..", "mcp", "dist", "memory-ui-graph.runtime.js"),
    path.resolve(__dirname, "..", "..", "mcp", "dist", "generated", "memory-ui-graph.browser.js"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
    } catch {
      // Try next candidate
    }
  }
  return "";
}

/* ── Phren inline SVG for webview embedding ─────────────── */

/**
 * Pixel-art phren character SVG — same artwork as phren-icon-128.svg / media/icon.svg.
 * Replaces the old hand-drawn purple blob so loading/error screens match the real sprite.
 */
const PHREN_INLINE_SVG_SMALL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="64" height="64"><circle cx="64" cy="64" r="64" fill="#12122a"/><g fill="rgb(40,211,242)"><rect x="85.3" y="26.7" width="5.3" height="5.3"/></g><g fill="rgb(27,210,241)"><rect x="96.0" y="26.7" width="5.3" height="5.3"/></g><g fill="rgb(40,41,142)"><rect x="53.3" y="32.0" width="5.3" height="5.3"/></g><g fill="rgb(41,43,144)"><rect x="58.7" y="32.0" width="5.3" height="5.3"/><rect x="74.7" y="32.0" width="5.3" height="5.3"/></g><g fill="rgb(43,44,147)"><rect x="69.3" y="32.0" width="5.3" height="5.3"/></g><g fill="rgb(38,39,142)"><rect x="42.7" y="37.3" width="5.3" height="5.3"/></g><g fill="rgb(153,140,248)"><rect x="48.0" y="37.3" width="5.3" height="5.3"/></g><g fill="rgb(152,146,247)"><rect x="53.3" y="37.3" width="5.3" height="5.3"/></g><g fill="rgb(93,67,243)"><rect x="58.7" y="37.3" width="5.3" height="5.3"/></g><g fill="rgb(157,147,250)"><rect x="64.0" y="37.3" width="5.3" height="5.3"/></g><g fill="rgb(156,146,249)"><rect x="69.3" y="37.3" width="5.3" height="5.3"/></g><g fill="rgb(145,147,247)"><rect x="74.7" y="37.3" width="5.3" height="5.3"/></g><g fill="rgb(155,146,248)"><rect x="80.0" y="37.3" width="5.3" height="5.3"/></g><g fill="rgb(41,40,141)"><rect x="85.3" y="37.3" width="5.3" height="5.3"/></g><g fill="rgb(150,132,250)"><rect x="42.7" y="42.7" width="5.3" height="5.3"/></g><g fill="rgb(154,143,250)"><rect x="48.0" y="42.7" width="5.3" height="5.3"/></g><g fill="rgb(104,75,249)"><rect x="53.3" y="42.7" width="5.3" height="5.3"/></g><g fill="rgb(156,142,251)"><rect x="58.7" y="42.7" width="5.3" height="5.3"/></g><g fill="rgb(156,149,248)"><rect x="64.0" y="42.7" width="5.3" height="5.3"/></g><g fill="rgb(157,150,248)"><rect x="69.3" y="42.7" width="5.3" height="5.3"/></g><g fill="rgb(151,130,250)"><rect x="74.7" y="42.7" width="5.3" height="5.3"/></g><g fill="rgb(149,145,247)"><rect x="80.0" y="42.7" width="5.3" height="5.3"/></g><g fill="rgb(155,143,248)"><rect x="85.3" y="42.7" width="5.3" height="5.3"/></g><g fill="rgb(41,41,146)"><rect x="90.7" y="42.7" width="5.3" height="5.3"/></g><g fill="rgb(39,39,132)"><rect x="37.3" y="48.0" width="5.3" height="5.3"/></g><g fill="rgb(151,133,250)"><rect x="42.7" y="48.0" width="5.3" height="5.3"/><rect x="58.7" y="58.7" width="5.3" height="5.3"/></g><g fill="rgb(148,129,251)"><rect x="48.0" y="48.0" width="5.3" height="5.3"/></g><g fill="rgb(156,145,248)"><rect x="53.3" y="48.0" width="5.3" height="5.3"/></g><g fill="rgb(92,68,236)"><rect x="58.7" y="48.0" width="5.3" height="5.3"/></g><g fill="rgb(85,70,220)"><rect x="64.0" y="48.0" width="5.3" height="5.3"/></g><g fill="rgb(157,151,248)"><rect x="69.3" y="48.0" width="5.3" height="5.3"/></g><g fill="rgb(86,61,235)"><rect x="74.7" y="48.0" width="5.3" height="5.3"/></g><g fill="rgb(105,83,245)"><rect x="80.0" y="48.0" width="5.3" height="5.3"/></g><g fill="rgb(191,189,251)"><rect x="85.3" y="48.0" width="5.3" height="5.3"/></g><g fill="rgb(153,135,250)"><rect x="90.7" y="48.0" width="5.3" height="5.3"/></g><g fill="rgb(71,68,183)"><rect x="96.0" y="48.0" width="5.3" height="5.3"/></g><g fill="rgb(12,31,109)"><rect x="32.0" y="53.3" width="5.3" height="5.3"/></g><g fill="rgb(82,67,225)"><rect x="37.3" y="53.3" width="5.3" height="5.3"/></g><g fill="rgb(143,122,252)"><rect x="42.7" y="53.3" width="5.3" height="5.3"/></g><g fill="rgb(94,67,244)"><rect x="48.0" y="53.3" width="5.3" height="5.3"/></g><g fill="rgb(152,144,249)"><rect x="53.3" y="53.3" width="5.3" height="5.3"/></g><g fill="rgb(154,143,248)"><rect x="58.7" y="53.3" width="5.3" height="5.3"/></g><g fill="rgb(157,153,248)"><rect x="64.0" y="53.3" width="5.3" height="5.3"/></g><g fill="rgb(84,61,230)"><rect x="69.3" y="53.3" width="5.3" height="5.3"/></g><g fill="rgb(152,139,250)"><rect x="74.7" y="53.3" width="5.3" height="5.3"/></g><g fill="rgb(95,71,239)"><rect x="80.0" y="53.3" width="5.3" height="5.3"/></g><g fill="rgb(92,68,237)"><rect x="85.3" y="53.3" width="5.3" height="5.3"/></g><g fill="rgb(151,139,250)"><rect x="90.7" y="53.3" width="5.3" height="5.3"/></g><g fill="rgb(67,61,181)"><rect x="96.0" y="53.3" width="5.3" height="5.3"/></g><g fill="rgb(148,132,250)"><rect x="32.0" y="58.7" width="5.3" height="5.3"/></g><g fill="rgb(144,126,251)"><rect x="37.3" y="58.7" width="5.3" height="5.3"/></g><g fill="rgb(156,143,251)"><rect x="42.7" y="58.7" width="5.3" height="5.3"/></g><g fill="rgb(149,132,251)"><rect x="48.0" y="58.7" width="5.3" height="5.3"/></g><g fill="rgb(150,132,251)"><rect x="53.3" y="58.7" width="5.3" height="5.3"/></g><g fill="rgb(152,134,250)"><rect x="64.0" y="58.7" width="5.3" height="5.3"/></g><g fill="rgb(152,139,247)"><rect x="69.3" y="58.7" width="5.3" height="5.3"/></g><g fill="rgb(106,93,246)"><rect x="74.7" y="58.7" width="5.3" height="5.3"/></g><g fill="rgb(155,141,250)"><rect x="80.0" y="58.7" width="5.3" height="5.3"/></g><g fill="rgb(158,141,248)"><rect x="85.3" y="58.7" width="5.3" height="5.3"/></g><g fill="rgb(116,101,251)"><rect x="90.7" y="58.7" width="5.3" height="5.3"/></g><g fill="rgb(36,41,131)"><rect x="96.0" y="58.7" width="5.3" height="5.3"/></g><g fill="rgb(141,122,250)"><rect x="32.0" y="64.0" width="5.3" height="5.3"/></g><g fill="rgb(21,32,101)"><rect x="37.3" y="64.0" width="5.3" height="5.3"/></g><g fill="rgb(146,126,251)"><rect x="42.7" y="64.0" width="5.3" height="5.3"/><rect x="53.3" y="74.7" width="5.3" height="5.3"/></g><g fill="rgb(146,128,250)"><rect x="48.0" y="64.0" width="5.3" height="5.3"/><rect x="58.7" y="74.7" width="5.3" height="5.3"/></g><g fill="rgb(158,149,250)"><rect x="53.3" y="64.0" width="5.3" height="5.3"/></g><g fill="rgb(22,31,104)"><rect x="58.7" y="64.0" width="5.3" height="5.3"/></g><g fill="rgb(152,137,250)"><rect x="64.0" y="64.0" width="5.3" height="5.3"/></g><g fill="rgb(150,142,249)"><rect x="69.3" y="64.0" width="5.3" height="5.3"/></g><g fill="rgb(152,138,250)"><rect x="74.7" y="64.0" width="5.3" height="5.3"/></g><g fill="rgb(154,140,251)"><rect x="80.0" y="64.0" width="5.3" height="5.3"/></g><g fill="rgb(116,104,252)"><rect x="85.3" y="64.0" width="5.3" height="5.3"/></g><g fill="rgb(127,111,251)"><rect x="90.7" y="64.0" width="5.3" height="5.3"/></g><g fill="rgb(92,85,242)"><rect x="96.0" y="64.0" width="5.3" height="5.3"/></g><g fill="rgb(146,128,248)"><rect x="32.0" y="69.3" width="5.3" height="5.3"/></g><g fill="rgb(154,132,250)"><rect x="37.3" y="69.3" width="5.3" height="5.3"/></g><g fill="rgb(145,123,251)"><rect x="42.7" y="69.3" width="5.3" height="5.3"/></g><g fill="rgb(145,125,250)"><rect x="48.0" y="69.3" width="5.3" height="5.3"/><rect x="42.7" y="74.7" width="5.3" height="5.3"/></g><g fill="rgb(146,123,248)"><rect x="53.3" y="69.3" width="5.3" height="5.3"/></g><g fill="rgb(152,132,248)"><rect x="58.7" y="69.3" width="5.3" height="5.3"/></g><g fill="rgb(151,133,251)"><rect x="64.0" y="69.3" width="5.3" height="5.3"/></g><g fill="rgb(135,121,250)"><rect x="69.3" y="69.3" width="5.3" height="5.3"/></g><g fill="rgb(119,99,247)"><rect x="74.7" y="69.3" width="5.3" height="5.3"/></g><g fill="rgb(108,93,249)"><rect x="80.0" y="69.3" width="5.3" height="5.3"/></g><g fill="rgb(117,100,251)"><rect x="85.3" y="69.3" width="5.3" height="5.3"/></g><g fill="rgb(125,110,250)"><rect x="90.7" y="69.3" width="5.3" height="5.3"/></g><g fill="rgb(93,81,242)"><rect x="96.0" y="69.3" width="5.3" height="5.3"/></g><g fill="rgb(10,28,98)"><rect x="32.0" y="74.7" width="5.3" height="5.3"/></g><g fill="rgb(147,128,251)"><rect x="37.3" y="74.7" width="5.3" height="5.3"/></g><g fill="rgb(48,39,174)"><rect x="48.0" y="74.7" width="5.3" height="5.3"/></g><g fill="rgb(111,94,250)"><rect x="64.0" y="74.7" width="5.3" height="5.3"/></g><g fill="rgb(122,109,250)"><rect x="69.3" y="74.7" width="5.3" height="5.3"/></g><g fill="rgb(120,107,251)"><rect x="74.7" y="74.7" width="5.3" height="5.3"/></g><g fill="rgb(121,100,250)"><rect x="80.0" y="74.7" width="5.3" height="5.3"/></g><g fill="rgb(92,66,240)"><rect x="85.3" y="74.7" width="5.3" height="5.3"/></g><g fill="rgb(117,92,249)"><rect x="90.7" y="74.7" width="5.3" height="5.3"/></g><g fill="rgb(7,37,110)"><rect x="96.0" y="74.7" width="5.3" height="5.3"/></g><g fill="rgb(77,59,222)"><rect x="37.3" y="80.0" width="5.3" height="5.3"/></g><g fill="rgb(100,82,243)"><rect x="42.7" y="80.0" width="5.3" height="5.3"/></g><g fill="rgb(136,120,250)"><rect x="48.0" y="80.0" width="5.3" height="5.3"/></g><g fill="rgb(102,86,245)"><rect x="53.3" y="80.0" width="5.3" height="5.3"/></g><g fill="rgb(103,86,245)"><rect x="58.7" y="80.0" width="5.3" height="5.3"/></g><g fill="rgb(116,102,249)"><rect x="64.0" y="80.0" width="5.3" height="5.3"/></g><g fill="rgb(114,103,247)"><rect x="69.3" y="80.0" width="5.3" height="5.3"/></g><g fill="rgb(86,74,229)"><rect x="74.7" y="80.0" width="5.3" height="5.3"/></g><g fill="rgb(106,93,244)"><rect x="80.0" y="80.0" width="5.3" height="5.3"/></g><g fill="rgb(36,25,138)"><rect x="85.3" y="80.0" width="5.3" height="5.3"/></g><g fill="rgb(83,73,231)"><rect x="90.7" y="80.0" width="5.3" height="5.3"/></g><g fill="rgb(18,22,101)"><rect x="42.7" y="85.3" width="5.3" height="5.3"/></g><g fill="rgb(19,24,101)"><rect x="48.0" y="85.3" width="5.3" height="5.3"/></g><g fill="rgb(66,51,207)"><rect x="53.3" y="85.3" width="5.3" height="5.3"/></g><g fill="rgb(95,83,244)"><rect x="58.7" y="85.3" width="5.3" height="5.3"/></g><g fill="rgb(72,59,210)"><rect x="64.0" y="85.3" width="5.3" height="5.3"/></g><g fill="rgb(115,96,250)"><rect x="69.3" y="85.3" width="5.3" height="5.3"/></g><g fill="rgb(117,104,249)"><rect x="74.7" y="85.3" width="5.3" height="5.3"/></g><g fill="rgb(119,104,249)"><rect x="80.0" y="85.3" width="5.3" height="5.3"/></g><g fill="rgb(23,21,110)"><rect x="85.3" y="85.3" width="5.3" height="5.3"/></g><g fill="rgb(69,51,218)"><rect x="53.3" y="90.7" width="5.3" height="5.3"/></g><g fill="rgb(26,24,106)"><rect x="58.7" y="90.7" width="5.3" height="5.3"/></g><g fill="rgb(58,46,198)"><rect x="69.3" y="90.7" width="5.3" height="5.3"/></g><g fill="rgb(20,31,99)"><rect x="74.7" y="90.7" width="5.3" height="5.3"/></g><g fill="rgb(26,29,111)"><rect x="80.0" y="90.7" width="5.3" height="5.3"/></g><g fill="rgb(24,29,112)"><rect x="48.0" y="96.0" width="5.3" height="5.3"/></g><g fill="rgb(105,91,248)"><rect x="53.3" y="96.0" width="5.3" height="5.3"/></g><g fill="rgb(9,30,102)"><rect x="58.7" y="96.0" width="5.3" height="5.3"/></g><g fill="rgb(12,31,104)"><rect x="64.0" y="96.0" width="5.3" height="5.3"/></g><g fill="rgb(112,102,250)"><rect x="69.3" y="96.0" width="5.3" height="5.3"/></g><g fill="rgb(15,41,120)"><rect x="74.7" y="96.0" width="5.3" height="5.3"/></g><g fill="rgb(160,169,250)"><rect x="80.0" y="96.0" width="5.3" height="5.3"/></g><g fill="rgb(156,157,248)"><rect x="48.0" y="101.3" width="5.3" height="5.3"/></g><g fill="rgb(155,157,248)"><rect x="53.3" y="101.3" width="5.3" height="5.3"/></g><g fill="rgb(157,158,248)"><rect x="58.7" y="101.3" width="5.3" height="5.3"/></g><g fill="rgb(158,161,248)"><rect x="64.0" y="101.3" width="5.3" height="5.3"/></g><g fill="rgb(158,160,248)"><rect x="69.3" y="101.3" width="5.3" height="5.3"/></g><g fill="rgb(158,162,248)"><rect x="74.7" y="101.3" width="5.3" height="5.3"/></g><g fill="rgb(158,163,247)"><rect x="80.0" y="101.3" width="5.3" height="5.3"/></g></svg>`;

/* ── Interfaces ──────────────────────────────────────────── */

interface ProjectSummaryFile {
  filename: string;
  type: string;
}

interface ProjectSummaryData {
  name: string;
  summary: string;
  files: ProjectSummaryFile[];
  findingCount: number;
  taskCount: number;
}

interface FindingData {
  id: string;
  date: string;
  text: string;
  stableId?: string;
  topicSlug: string;
  topicLabel: string;
}

interface TaskData {
  id: string;
  line: string;
  section: string;
  checked: boolean;
  priority?: string;
}

interface EntityData {
  id?: string;
  name: string;
  type: string;
  refCount: number;
  docs: string[];
}

interface GraphNode {
  id: string;
  kind: "project" | "finding" | "task" | "entity" | "reference";
  projectName: string;
  label: string;
  subtype: string;
  text: string;
  radius: number;
  color: string;
  refCount?: number;
  date?: string;
  section?: string;
  priority?: string;
  entityType?: string;
  connectedProjects?: string[];
  qualityMultiplier?: number;
  lastUsedAt?: string;
  helpful?: number;
  stableId?: string;
  docs?: string[];
  topicSlug?: string;
  topicLabel?: string;
  scoreKey?: string;
  taskItemId?: string;
  checked?: boolean;
  store?: string;
}

interface GraphEdge {
  source: string;
  target: string;
}

interface MemoryScoreEntry {
  impressions: number;
  helpful: number;
  repromptPenalty: number;
  regressionPenalty: number;
  lastUsedAt: string;
}

interface MemoryScores {
  schemaVersion?: number;
  entries: Record<string, MemoryScoreEntry>;
}

interface TopicMeta {
  slug: string;
  label: string;
  keywords?: string[];
}

interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  summaries: Record<string, ProjectSummaryData>;
  scores: MemoryScores;
  topics: TopicMeta[];
}

/* ── Main entry ──────────────────────────────────────────── */

export async function showGraphWebview(client: PhrenClient, context: vscode.ExtensionContext): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "phren.fragmentGraph",
    "Phren Fragment Graph",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] },
  );

  panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, "media", "icon.svg"));
  panel.webview.html = renderLoadingHtml(panel.webview);

  let graphData: GraphPayload | undefined;

  try {
    graphData = await loadGraphData(client);
    panel.webview.html = renderGraphHtml(panel.webview, graphData);
  } catch (error) {
    panel.webview.html = renderErrorHtml(panel.webview, toErrorMessage(error));
    return;
  }

  // Handle messages from the webview
  panel.webview.onDidReceiveMessage(async (msg: unknown) => {
    const message = asRecord(msg);
    if (!message) return;
    const command = asString(message.command);

    async function refreshGraph(): Promise<void> {
      graphData = await loadGraphData(client);
      panel.webview.html = renderGraphHtml(panel.webview, graphData);
    }

    if (command === "saveFindingEdit") {
      const projectName = asString(message.projectName);
      const oldText = asString(message.oldText);
      const newText = asString(message.newText);
      if (!projectName || !oldText || !newText) return;
      if (!isValidProjectName(projectName)) return;

      try {
        await client.editFinding(projectName, oldText, newText);
        await refreshGraph();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to update finding: ${toErrorMessage(err)}`);
      }
      return;
    }

    if (command === "deleteFinding") {
      const projectName = asString(message.projectName);
      const text = asString(message.text);
      if (!projectName || !text) return;
      if (!isValidProjectName(projectName)) return;

      const confirmed = await vscode.window.showWarningMessage(
        `Delete this finding from ${projectName}?`,
        { modal: true },
        "Delete",
      );
      if (confirmed !== "Delete") return;

      try {
        await client.removeFinding(projectName, text);
        await refreshGraph();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to delete finding: ${toErrorMessage(err)}`);
      }
      return;
    }

    if (command === "saveTaskEdit") {
      const projectName = asString(message.projectName);
      const item = asString(message.item);
      const nextText = asString(message.text);
      const section = asString(message.section);
      const priority = asString(message.priority);
      if (!projectName || !item || !nextText) return;
      if (!isValidProjectName(projectName)) return;

      try {
        await client.updateTask(projectName, item, {
          text: nextText,
          section,
          priority,
        });
        await refreshGraph();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to update task: ${toErrorMessage(err)}`);
      }
      return;
    }

    if (command === "completeTask") {
      const projectName = asString(message.projectName);
      const item = asString(message.item);
      if (!projectName || !item) return;
      if (!isValidProjectName(projectName)) return;

      try {
        await client.completeTask(projectName, item);
        await refreshGraph();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to complete task: ${toErrorMessage(err)}`);
      }
      return;
    }

    if (command === "moveTask") {
      const projectName = asString(message.projectName);
      const item = asString(message.item);
      const section = asString(message.section);
      if (!projectName || !item || !section) return;
      if (!isValidProjectName(projectName)) return;

      try {
        await client.updateTask(projectName, item, { section });
        await refreshGraph();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to move task: ${toErrorMessage(err)}`);
      }
      return;
    }

    if (command === "deleteTask") {
      const projectName = asString(message.projectName);
      const item = asString(message.item);
      if (!projectName || !item) return;
      if (!isValidProjectName(projectName)) return;

      const confirmed = await vscode.window.showWarningMessage(
        `Delete this task from ${projectName}?`,
        { modal: true },
        "Delete",
      );
      if (confirmed !== "Delete") return;

      try {
        await client.removeTask(projectName, item);
        await refreshGraph();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to delete task: ${toErrorMessage(err)}`);
      }
      return;
    }

  });
}

/* ── Data loading ────────────────────────────────────────── */

async function loadGraphData(client: PhrenClient): Promise<GraphPayload> {
  const projects = await fetchProjects(client);

  // Parallel per-project fetches (including topic configs)
  const perProjectResults = await Promise.all(
    projects.map(async (p) => {
      const topicConfig = await fetchTopicConfig(client, p.name);
      const [summary, findings, tasks] = await Promise.all([
        fetchProjectSummary(client, p.name),
        fetchFindings(client, p.name, topicConfig),
        fetchTasks(client, p.name),
      ]);
      return { projectName: p.name, summary, findings, tasks, topicConfig, store: p.store };
    }),
  );

  // Fragment graph
  const entities = await fetchEntities(client);

  // Memory scores
  const scores = loadMemoryScores();
  const scoreLookup = buildScoreLookup(scores);

  // Merge all project topics into a deduplicated list
  const topicMetaMap = new Map<string, TopicMeta>();
  for (const { topicConfig } of perProjectResults) {
    for (const topic of topicConfig) {
      if (!topicMetaMap.has(topic.slug)) {
        topicMetaMap.set(topic.slug, topic);
      }
    }
  }
  const allTopics = Array.from(topicMetaMap.values());

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const summaryMap: Record<string, ProjectSummaryData> = {};
  // Build project nodes (skip empty orphans)
  for (const { projectName, summary, findings, tasks, topicConfig, store } of perProjectResults) {
    if (findings.length === 0 && tasks.length === 0) continue;

    const projectNodeId = `project:${projectName}`;
    summaryMap[projectName] = { ...summary, findingCount: findings.length, taskCount: tasks.length };

    nodes.push({
      id: projectNodeId,
      kind: "project",
      projectName,
      label: projectName,
      subtype: "project",
      text: summary.summary,
      radius: Math.min(14 + Math.sqrt(findings.length + tasks.length) * 1.5, 30),
      color: "#7B68AE",
      store,
    });

    // Finding nodes
    for (const finding of findings) {
      const findingId = `finding:${projectName}:${finding.id}`;
      const findingScoreKey = buildScoreKey(projectName, "FINDINGS.md", finding.text);
      const findingScore = scoreLookup.get(findingScoreKey);
      nodes.push({
        id: findingId,
        kind: "finding",
        projectName,
        label: finding.text.slice(0, 40) + (finding.text.length > 40 ? "..." : ""),
        subtype: finding.topicSlug,
        text: finding.text,
        radius: 8,
        color: "#5B4B8A", // placeholder; actual color determined by graph engine from topic slug
        date: finding.date,
        stableId: finding.stableId,
        topicSlug: finding.topicSlug,
        topicLabel: finding.topicLabel,
        scoreKey: findingScoreKey,
        qualityMultiplier: qualityMultiplierFromEntry(findingScore),
        lastUsedAt: findingScore?.lastUsedAt,
        helpful: findingScore?.helpful,
        store,
      });
      edges.push({ source: projectNodeId, target: findingId });
    }

    // Task nodes
    for (const task of tasks) {
      const taskId = `task:${projectName}:${task.id}`;
      const taskScoreKey = buildScoreKey(projectName, "tasks.md", task.line);
      const taskScore = scoreLookup.get(taskScoreKey);
      const sectionLower = task.section.toLowerCase();
      const taskColorMap: Record<string, string> = { active: "#10b981", queue: "#00E5FF", done: "#6b7280" };
      nodes.push({
        id: taskId,
        kind: "task",
        projectName,
        label: task.line.slice(0, 40) + (task.line.length > 40 ? "..." : ""),
        subtype: sectionLower,
        text: task.line,
        radius: 7,
        color: taskColorMap[sectionLower] || "#00E5FF",
        section: task.section,
        priority: task.priority,
        scoreKey: taskScoreKey,
        qualityMultiplier: qualityMultiplierFromEntry(taskScore),
        lastUsedAt: taskScore?.lastUsedAt,
        helpful: taskScore?.helpful,
        taskItemId: task.id,
        checked: task.checked,
        store,
      });
      edges.push({ source: projectNodeId, target: taskId });
    }
  }

  // Fragment nodes and edges
  const projectNameSet = new Set(projects.map((p) => p.name));
  for (const entity of entities) {
    const entityId = entity.id || `entity:${entity.name}`;
    const connectedProjects: string[] = [];
    for (const doc of entity.docs) {
      for (const pName of projectNameSet) {
        // Path-separator-aware matching: doc must start with "projectName/"
        if (doc === pName || doc.startsWith(pName + "/") || doc.startsWith(pName + "\\")) {
          connectedProjects.push(pName);
        }
      }
    }
    const uniqueConnected = [...new Set(connectedProjects)];

    nodes.push({
      id: entityId,
      kind: "entity",
      projectName: uniqueConnected[0] || "",
      label: entity.name,
      subtype: entity.type,
      text: `${entity.name} (${entity.type}) - ${entity.refCount} refs`,
      radius: Math.min(6 + entity.refCount, 16),
      color: "#00E5FF",
      refCount: entity.refCount,
      entityType: entity.type,
      connectedProjects: uniqueConnected,
      docs: entity.docs,
    });

    // Fragment → project edges
    for (const pName of uniqueConnected) {
      edges.push({ source: entityId, target: `project:${pName}` });
    }

    // Cross-project edges
    if (uniqueConnected.length > 1) {
      for (let i = 0; i < uniqueConnected.length; i++) {
        for (let j = i + 1; j < uniqueConnected.length; j++) {
          edges.push({ source: `project:${uniqueConnected[i]}`, target: `project:${uniqueConnected[j]}` });
        }
      }
    }

    // Reference doc nodes
    for (const doc of entity.docs) {
      const refId = `ref:${doc}`;
      if (!nodes.find((n) => n.id === refId)) {
        let refProject = "";
        for (const pName of projectNameSet) {
          if (doc.startsWith(pName + "/") || doc.startsWith(pName + "\\")) {
            refProject = pName;
            break;
          }
        }
        nodes.push({
          id: refId,
          kind: "reference",
          projectName: refProject,
          label: doc.split("/").pop() || doc,
          subtype: "reference",
          text: doc,
          radius: 6,
          color: "#14b8a6",
        });
      }
      edges.push({ source: entityId, target: `ref:${doc}` });
    }
  }

  // Deduplicate edges
  const edgeSet = new Set<string>();
  const uniqueEdges: GraphEdge[] = [];
  for (const e of edges) {
    const key = `${e.source}|${e.target}`;
    const reverseKey = `${e.target}|${e.source}`;
    if (!edgeSet.has(key) && !edgeSet.has(reverseKey)) {
      edgeSet.add(key);
      uniqueEdges.push(e);
    }
  }

  return { nodes, edges: uniqueEdges, summaries: summaryMap, scores, topics: allTopics };
}

/* ── Fetch helpers ───────────────────────────────────────── */

async function fetchProjects(client: PhrenClient): Promise<{ name: string; brief?: string; store?: string }[]> {
  const raw = await client.listProjects();
  const data = responseData(raw);
  const seen = new Set<string>();
  const parsed: { name: string; brief?: string; store?: string }[] = [];
  for (const entry of asArray(data?.projects)) {
    const record = asRecord(entry);
    const name = asString(record?.name);
    // Skip bogus entries: paths, reserved names, stale FTS entries
    if (!name) continue;
    if (name.includes(":") || name.includes("/") || name.includes("\\")) continue;
    if (name === "global" || name === "scripts" || name === "templates" || name === "profiles") continue;
    // Filter known stale/non-profile projects (should be fixed at MCP level long-term)
    if (name === "dendron" || name === "phren-framework") continue;
    // Deduplicate: same project name can appear across multiple stores — take first occurrence
    if (seen.has(name)) continue;
    seen.add(name);
    parsed.push({ name, brief: asString(record?.brief), store: asString(record?.store) });
  }
  return parsed;
}

async function fetchProjectSummary(client: PhrenClient, project: string): Promise<ProjectSummaryData> {
  const raw = await client.getProjectSummary(project);
  const data = responseData(raw);
  const files: ProjectSummaryFile[] = [];
  for (const file of asArray(data?.files)) {
    const record = asRecord(file);
    const filename = asString(record?.filename) ?? asString(record?.name);
    const type = asString(record?.type);
    if (filename && type) {
      files.push({ filename, type });
    }
  }
  return {
    name: asString(data?.name) ?? project,
    summary: asString(data?.summary) ?? "No summary.md found.",
    files,
    findingCount: 0,
    taskCount: 0,
  };
}

async function fetchFindings(client: PhrenClient, project: string, projectTopics?: TopicMeta[]): Promise<FindingData[]> {
  const raw = await client.getFindings(project);
  const data = responseData(raw);
  const parsed: FindingData[] = [];
  for (const entry of asArray(data?.findings)) {
    const record = asRecord(entry);
    const id = asString(record?.id) ?? asString(record?.stableId) ?? String(parsed.length);
    const text = asString(record?.text) ?? "";
    if (!text) continue;
    const topic = classifyFindingTopic(text, projectTopics);
    parsed.push({
      id,
      date: asString(record?.date) ?? "",
      text,
      stableId: asString(record?.stableId),
      topicSlug: topic.slug,
      topicLabel: topic.label,
    });
  }
  return parsed;
}

async function fetchTopicConfig(client: PhrenClient, project: string): Promise<TopicMeta[]> {
  try {
    const raw = await client.getTopicConfig(project);
    const data = responseData(raw);
    const topics: TopicMeta[] = [];
    for (const entry of asArray(data?.topics)) {
      const record = asRecord(entry);
      const slug = asString(record?.slug);
      const label = asString(record?.label);
      if (slug) {
        const keywords: string[] = [];
        for (const kw of asArray(record?.keywords)) {
          if (typeof kw === "string") keywords.push(kw);
        }
        topics.push({ slug, label: label ?? slug, keywords: keywords.length ? keywords : undefined });
      }
    }
    return topics;
  } catch {
    return [];
  }
}

async function fetchTasks(client: PhrenClient, project: string): Promise<TaskData[]> {
  const raw = await client.getTasks(project, { status: "all", done_limit: 10 });
  const data = responseData(raw);
  const items = asRecord(data?.items);
  const parsed: TaskData[] = [];

  for (const section of ["Active", "Queue"]) {
    for (const entry of asArray(items?.[section])) {
      const record = asRecord(entry);
      if (!record) continue;
      parsed.push({
        id: asString(record.id) ?? String(parsed.length),
        line: asString(record.line) ?? asString(record.item) ?? "",
        section,
        checked: record.checked === true,
        priority: asString(record.priority),
      });
    }
  }

  // Include up to 10 done items
  const doneItems = asArray(items?.Done).slice(0, 10);
  for (const entry of doneItems) {
    const record = asRecord(entry);
    if (!record) continue;
    parsed.push({
      id: asString(record.id) ?? String(parsed.length),
      line: asString(record.line) ?? asString(record.item) ?? "",
      section: "Done",
      checked: true,
      priority: asString(record.priority),
    });
  }

  return parsed;
}

async function fetchEntities(client: PhrenClient): Promise<EntityData[]> {
  try {
    const raw = await client.readGraph();
    const data = responseData(raw);
    const parsed: EntityData[] = [];
    for (const entry of asArray(data?.entities)) {
      const record = asRecord(entry);
      if (!record) continue;
      parsed.push({
        name: asString(record.name) ?? "",
        type: asString(record.type) ?? "unknown",
        refCount: typeof record.refCount === "number" ? record.refCount : 0,
        docs: asArray(record.docs).filter((d): d is string => typeof d === "string"),
      });
    }
    return parsed.slice(0, 500);
  } catch {
    return [];
  }
}

function loadMemoryScores(): MemoryScores {
  try {
    const scoresPath = path.join(os.homedir(), ".phren", ".runtime", "memory-scores.json");
    const raw = fs.readFileSync(scoresPath, "utf8");
    const parsed = JSON.parse(raw) as MemoryScores;
    return { schemaVersion: parsed.schemaVersion ?? 1, entries: parsed.entries ?? {} };
  } catch {
    return { schemaVersion: 1, entries: {} };
  }
}

function buildScoreLookup(scores: MemoryScores): Map<string, MemoryScoreEntry> {
  return new Map(Object.entries(scores.entries ?? {}));
}

function buildScoreKey(project: string, filename: string, snippet: string): string {
  const short = (snippet || "").slice(0, 160);
  const digest = crypto.createHash("sha1").update(`${project}:${filename}:${short}`).digest("hex").slice(0, 12);
  return `${project}/${filename}:${digest}`;
}

function qualityMultiplierFromEntry(entry?: MemoryScoreEntry): number | undefined {
  if (!entry) return undefined;
  const now = Date.now();
  const lastUsed = entry.lastUsedAt ? new Date(entry.lastUsedAt).getTime() : 0;
  const daysSince = lastUsed ? (now - lastUsed) / 86400000 : 999;

  let recencyBoost = 0;
  if (daysSince <= 7) recencyBoost = 0.15;
  else if (daysSince <= 30) recencyBoost = 0;
  else recencyBoost = Math.max(-0.3, -0.1 * Math.floor((daysSince - 30) / 30));

  const impressions = entry.impressions || 0;
  const frequencyBoost = Math.min(0.2, Math.log(impressions + 1) / Math.LN2 * 0.05);
  const helpful = entry.helpful || 0;
  const reprompt = entry.repromptPenalty || 0;
  const regression = entry.regressionPenalty || 0;
  const feedbackScore = helpful * 0.15 - (reprompt + regression * 2) * 0.2;

  return Math.max(0.2, Math.min(1.5, 1 + feedbackScore + recencyBoost + frequencyBoost));
}

/* Builtin topic keywords mirroring project-topics.ts BUILTIN_TOPICS */
const BUILTIN_TOPIC_KEYWORDS: Array<{ slug: string; label: string; keywords: string[] }> = [
  { slug: "api", label: "API", keywords: ["api", "endpoint", "route", "rest", "graphql", "grpc", "request", "response", "http", "url", "webhook", "cors"] },
  { slug: "database", label: "Database", keywords: ["database", "db", "sql", "query", "index", "migration", "schema", "table", "column", "postgres", "mysql", "sqlite", "mongo", "redis", "orm"] },
  { slug: "performance", label: "Performance", keywords: ["performance", "speed", "latency", "cache", "optimize", "memory", "cpu", "bottleneck", "profiling", "benchmark", "throughput", "lazy"] },
  { slug: "security", label: "Security", keywords: ["security", "vulnerability", "xss", "csrf", "injection", "sanitize", "escape", "encrypt", "decrypt", "hash", "salt", "tls", "ssl"] },
  { slug: "frontend", label: "Frontend", keywords: ["frontend", "ui", "ux", "css", "html", "dom", "render", "component", "layout", "responsive", "animation", "browser", "react", "vue", "angular"] },
  { slug: "testing", label: "Testing", keywords: ["test", "spec", "assert", "mock", "stub", "fixture", "coverage", "jest", "vitest", "playwright", "e2e", "unit", "integration"] },
  { slug: "devops", label: "DevOps", keywords: ["deploy", "ci", "cd", "pipeline", "docker", "kubernetes", "container", "infra", "terraform", "aws", "cloud", "monitoring", "logging"] },
  { slug: "architecture", label: "Architecture", keywords: ["architecture", "design", "pattern", "layer", "module", "system", "structure", "microservice", "monolith", "event-driven", "plugin"] },
  { slug: "debugging", label: "Debugging", keywords: ["debug", "bug", "error", "crash", "fix", "issue", "stack", "trace", "breakpoint", "log", "workaround", "pitfall", "caveat"] },
  { slug: "tooling", label: "Tooling", keywords: ["tool", "cli", "script", "build", "webpack", "vite", "eslint", "prettier", "npm", "package", "config", "plugin", "hook", "git"] },
  { slug: "auth", label: "Auth", keywords: ["auth", "login", "logout", "session", "token", "jwt", "oauth", "sso", "permission", "role", "access", "credential"] },
  { slug: "data", label: "Data", keywords: ["data", "model", "schema", "serialize", "deserialize", "json", "csv", "transform", "validate", "parse", "format", "encode"] },
  { slug: "mobile", label: "Mobile", keywords: ["mobile", "ios", "android", "react-native", "flutter", "native", "touch", "gesture", "push-notification", "app-store"] },
  { slug: "ai_ml", label: "AI / ML", keywords: ["ai", "ml", "model", "embedding", "vector", "llm", "prompt", "token", "inference", "training", "neural", "gpt", "claude"] },
];

function classifyFindingTopic(text: string, projectTopics?: TopicMeta[]): { slug: string; label: string } {
  const lower = text.toLowerCase();
  let bestSlug = "general";
  let bestLabel = "General";
  let bestScore = 0;

  // Use project topics (with keywords) when available, fall back to builtins
  const topicsToMatch: Array<{ slug: string; label: string; keywords: string[] }> = [];
  if (projectTopics?.length) {
    for (const t of projectTopics) {
      topicsToMatch.push({ slug: t.slug, label: t.label, keywords: t.keywords ?? [] });
    }
  }
  // Always include builtins as fallback (project topics may not have keywords for all categories)
  for (const t of BUILTIN_TOPIC_KEYWORDS) {
    if (!topicsToMatch.some((pt) => pt.slug === t.slug)) {
      topicsToMatch.push(t);
    }
  }

  for (const topic of topicsToMatch) {
    let score = 0;
    for (const kw of topic.keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSlug = topic.slug;
      bestLabel = topic.label;
    }
  }
  return { slug: bestSlug, label: bestLabel };
}

/* ── HTML renderers ──────────────────────────────────────── */

function renderLoadingHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Phren Fragment Graph</title>
  <style>
    body { margin:0; display:grid; place-items:center; min-height:100vh; color:var(--vscode-foreground); font-family:sans-serif; }
    .loading-container { text-align:center; }
    .loading-container svg { margin-bottom:16px; }
    .loading-text { font-size:14px; opacity:0.7; }
    @keyframes phren-bob { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-4px); } }
    .phren-loading { animation:phren-bob 1.2s ease-in-out infinite; }
  </style>
</head>
<body>
  <div class="loading-container">
    <div class="phren-loading">${PHREN_INLINE_SVG_SMALL}</div>
    <div class="loading-text">Loading fragment graph...</div>
  </div>
</body>
</html>`;
}

function renderErrorHtml(webview: vscode.Webview, errorMessage: string): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Phren Fragment Graph</title>
  <style>
    body { margin:0; display:grid; place-items:center; min-height:100vh; padding:24px; color:var(--vscode-errorForeground); font-family:sans-serif; }
    .panel { max-width:720px; border:1px solid; border-radius:10px; padding:16px; }
  </style>
</head>
<body><div class="panel"><div style="text-align:center;margin-bottom:12px">${PHREN_INLINE_SVG_SMALL}</div>Failed to render fragment graph: ${escapeHtml(errorMessage)}</div></body>
</html>`;
}

function renderGraphHtml(webview: vscode.Webview, payload: GraphPayload): string {
  const nonce = getNonce();
  const safePayload = JSON.stringify(payload).replace(/</g, "\\u003c");
  const payloadJson = safePayload;
  const graphScript = loadGraphScript();
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Phren Fragment Graph</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --border: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
      --surface: var(--vscode-editorWidget-background);
      --surface-raised: color-mix(in srgb, var(--vscode-editorWidget-background) 94%, transparent);
      --surface-sunken: color-mix(in srgb, var(--vscode-editorWidget-background) 82%, transparent);
      --ink: var(--vscode-foreground);
      --muted: color-mix(in srgb, var(--vscode-foreground) 52%, transparent);
      --accent: var(--vscode-textLink-foreground, #4da3ff);
      --danger: var(--vscode-errorForeground, #ff6b6b);
      --shadow: 0 16px 32px rgba(0, 0, 0, 0.34);
    }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; color: var(--ink); background: var(--vscode-editor-background); }
    #graph-filter, #graph-project-filter, #graph-limit-row {
      display: flex;
      gap: 8px;
      padding: 8px 12px;
      align-items: center;
      flex-wrap: wrap;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }
    .graph-shell { height: calc(100vh - 120px); position: relative; overflow: hidden; }
    .graph-container { position: relative; width: 100%; height: 100%; overflow: hidden; }
    #graph-canvas { width: 100%; height: 100%; display: block; }
    #ambient-canvas { position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:2; }
    #graph-tooltip {
      display: none;
      position: absolute;
      pointer-events: none;
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 12px;
      max-width: 320px;
      word-break: break-word;
      background: var(--surface);
      color: var(--ink);
      border: 1px solid var(--border);
      z-index: 14;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
    }
    #graph-tooltip.visible { display: block; }
    .graph-controls {
      position: absolute;
      top: 12px;
      right: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      z-index: 4;
    }
    .graph-controls button {
      width: 38px;
      height: 38px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: color-mix(in srgb, var(--surface) 88%, transparent);
      color: var(--ink);
      font-size: 16px;
      cursor: pointer;
      display: grid;
      place-items: center;
      backdrop-filter: blur(6px);
    }
    .graph-controls button:hover {
      background: var(--vscode-button-hoverBackground, var(--surface-sunken));
      color: var(--vscode-button-foreground, var(--ink));
    }
    .btn {
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
      color: var(--ink);
      font-size: 11px;
      cursor: pointer;
    }
    .btn:hover, .btn.active {
      background: var(--vscode-button-background, var(--surface-sunken));
      color: var(--vscode-button-foreground, var(--ink));
    }
    .btn-danger {
      border-color: color-mix(in srgb, var(--danger) 70%, var(--border));
      color: var(--danger);
    }
    #node-popover {
      display: none;
      position: absolute;
      left: 0;
      top: 0;
      z-index: 20;
      max-width: min(300px, calc(100% - 24px));
      pointer-events: none;
    }
    #node-popover-card {
      position: relative;
      pointer-events: auto;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--surface) 96%, transparent);
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
      padding: 8px 10px 8px;
    }
    #node-popover-handle {
      height: 3px;
      width: 28px;
      margin: 0 auto 4px;
      border-radius: 2px;
      background: var(--muted);
      cursor: grab;
      opacity: 0.45;
    }
    #node-popover-handle:active { cursor: grabbing; opacity: 0.8; }
    #node-popover-close {
      position: absolute;
      top: 5px;
      right: 5px;
      width: 22px;
      height: 22px;
      padding: 0;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface-raised);
      color: var(--ink);
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
      display: grid;
      place-items: center;
      z-index: 1;
    }
    #node-popover-content {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-right: 26px;
    }
    .node-date { font-size: 10px; color: var(--muted); }
    .node-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .node-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface-sunken);
      font-size: 11px;
      color: var(--ink);
    }
    .node-copy { white-space: pre-wrap; line-height: 1.5; font-size: 12px; }
    .node-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
    .node-metric {
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface-raised);
      padding: 5px 7px;
    }
    .node-metric-label {
      font-size: 9px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: .05em;
    }
    .node-metric-value {
      font-size: 15px;
      font-weight: 600;
      margin-top: 1px;
    }
    .node-docs {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .node-actions { display: flex; flex-wrap: wrap; gap: 5px; }
    .node-editor {
      width: 100%;
      min-height: 100px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 8px;
      background: var(--surface-sunken);
      color: var(--ink);
      font: inherit;
      font-size: 11px;
      line-height: 1.5;
      resize: vertical;
    }
    .node-select-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }
    .node-select-wrap {
      display: flex;
      flex-direction: column;
      gap: 3px;
      font-size: 10px;
      color: var(--muted);
    }
    .node-select-wrap select {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px 6px;
      font-size: 11px;
      background: var(--surface);
      color: var(--ink);
    }
    .node-ctx-menu {
      position: absolute;
      z-index: 25;
      min-width: 140px;
      padding: 3px 0;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .node-ctx-item {
      display: block;
      width: 100%;
      padding: 5px 10px;
      border: none;
      background: none;
      color: var(--ink);
      font-size: 11px;
      text-align: left;
      cursor: pointer;
    }
    .node-ctx-item:hover { background: var(--surface-sunken); }
  </style>
</head>
<body>
  <div id="graph-filter"></div>
  <div id="graph-project-filter"></div>
  <div id="graph-limit-row"></div>
  <main class="graph-shell">
    <section class="graph-container">
      <div id="graph-canvas"></div>
      <canvas id="ambient-canvas" aria-hidden="true"></canvas>
      <div id="graph-tooltip"></div>
      <div class="graph-controls">
        <button id="btn-zoom-in" title="Zoom in">+</button>
        <button id="btn-zoom-out" title="Zoom out">&minus;</button>
        <button id="btn-zoom-reset" title="Reset view">R</button>
        <button id="btn-layout-reset" title="Re-run layout">L</button>
      </div>
      <div id="node-popover" role="dialog" aria-label="Node detail">
        <div id="node-popover-card">
          <div id="node-popover-handle" title="Drag to move"></div>
          <button id="node-popover-close" title="Close" aria-label="Close">&times;</button>
          <div id="node-popover-content"></div>
        </div>
      </div>
      <div id="node-ctx-menu" class="node-ctx-menu" style="display:none"></div>
    </section>
  </main>
  <script nonce="${nonce}">
${graphScript}
(function() {
  var payload = ${payloadJson};
  var vscode = acquireVsCodeApi();
  var nodeLookup = {};
  for (var i = 0; i < payload.nodes.length; i++) nodeLookup[payload.nodes[i].id] = payload.nodes[i];

  function esc(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function nodeKindLabel(node) {
    if (node.kind === 'entity') return node.entityType ? 'Fragment · ' + node.entityType : 'Fragment';
    if (node.kind === 'finding') return node.topicLabel ? 'Finding · ' + node.topicLabel : 'Finding';
    if (node.kind === 'task') return 'Task';
    if (node.kind === 'reference') return 'Reference';
    if (node.kind === 'project') return 'Project';
    return node.kind || 'Node';
  }

  function chip(text) {
    return '<span class="node-chip">' + esc(text) + '</span>';
  }

  function neighbors(id) {
    var ids = [];
    for (var index = 0; index < payload.edges.length; index++) {
      var edge = payload.edges[index];
      if (edge.source === id) ids.push(edge.target);
      else if (edge.target === id) ids.push(edge.source);
    }
    return ids;
  }

  function projectCounts(node) {
    var counts = { finding: 0, task: 0, entity: 0, reference: 0 };
    var ids = neighbors(node.id);
    for (var index = 0; index < ids.length; index++) {
      var neighbor = nodeLookup[ids[index]];
      if (!neighbor) continue;
      if (neighbor.kind === 'finding') counts.finding++;
      else if (neighbor.kind === 'task') counts.task++;
      else if (neighbor.kind === 'entity') counts.entity++;
      else if (neighbor.kind === 'reference') counts.reference++;
    }
    return counts;
  }

  var graphNodes = [];
  var topicMap = {};
  for (var index = 0; index < payload.nodes.length; index++) {
    var n = payload.nodes[index];
    var group = 'other';
    if (n.kind === 'project') group = 'project';
    else if (n.kind === 'finding') {
      group = n.topicSlug ? 'topic:' + n.topicSlug : 'topic:general';
      if (n.topicSlug && !topicMap[n.topicSlug]) topicMap[n.topicSlug] = n.topicLabel || n.topicSlug;
    } else if (n.kind === 'task') group = 'task-' + (n.subtype || 'queue');
    else if (n.kind === 'entity') group = 'entity';
    else if (n.kind === 'reference') group = 'reference';

    graphNodes.push({
      id: n.id,
      group: group,
      project: n.projectName || '',
      label: n.label,
      fullLabel: n.text || n.label,
      scoreKey: n.scoreKey || '',
      refCount: n.refCount || 0,
      entityType: n.entityType || n.subtype || '',
      section: n.section || '',
      priority: n.priority || '',
      date: n.date || '',
      refDocs: (n.docs || []).map(function(doc) { return { doc: doc, project: n.projectName || '' }; }),
      connectedProjects: n.connectedProjects || [],
      topicSlug: n.topicSlug || '',
      topicLabel: n.topicLabel || '',
      tagged: n.kind === 'finding'
    });
  }

  var topics = [];
  if (payload.topics && payload.topics.length) {
    for (var topicIndex = 0; topicIndex < payload.topics.length; topicIndex++) {
      var pt = payload.topics[topicIndex];
      topics.push({ slug: pt.slug, label: pt.label || pt.slug });
    }
  } else {
    var topicSlugs = Object.keys(topicMap);
    for (var topicIndex = 0; topicIndex < topicSlugs.length; topicIndex++) {
      topics.push({ slug: topicSlugs[topicIndex], label: topicMap[topicSlugs[topicIndex]] });
    }
  }

  var graphLinks = payload.edges.map(function(edge) {
    return { source: edge.source, target: edge.target };
  });

  var scores = payload.scores && payload.scores.entries ? payload.scores.entries : {};
  var bodyBg = getComputedStyle(document.body).backgroundColor || '';
  var isDark = true;
  if (bodyBg) {
    var rgb = bodyBg.match(/\\d+/g);
    if (rgb && rgb.length >= 3) {
      var lum = (parseInt(rgb[0]) * 299 + parseInt(rgb[1]) * 587 + parseInt(rgb[2]) * 114) / 1000;
      isDark = lum < 128;
    }
  }
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

  var graphMountError = null;
  try {
    if (!window.phrenGraph || typeof window.phrenGraph.mount !== 'function') {
      throw new Error('Shared graph renderer is unavailable.');
    }
    window.phrenGraph.mount({ nodes: graphNodes, links: graphLinks, scores: scores, topics: topics });
  } catch (error) {
    graphMountError = error;
  }

  if (graphMountError) {
    var graphCanvas = document.getElementById('graph-canvas');
    if (graphCanvas) {
      graphCanvas.innerHTML = '<div style="display:grid;place-items:center;height:100%;padding:24px;text-align:center;color:var(--danger)">'
        + '<div><div style="font-size:16px;font-weight:600;margin-bottom:8px">Graph failed to load</div>'
        + '<div style="font-size:12px;opacity:.82">' + esc(graphMountError.message || graphMountError) + '</div></div></div>';
    }
  }

  var zoomInBtn = document.getElementById('btn-zoom-in');
  var zoomOutBtn = document.getElementById('btn-zoom-out');
  var zoomResetBtn = document.getElementById('btn-zoom-reset');
  var layoutResetBtn = document.getElementById('btn-layout-reset');
  if (zoomInBtn) zoomInBtn.addEventListener('click', function() { window.graphZoom(1.2); });
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', function() { window.graphZoom(0.8); });
  if (zoomResetBtn) zoomResetBtn.addEventListener('click', function() { window.graphReset(); });
  if (layoutResetBtn) layoutResetBtn.addEventListener('click', function() { if (typeof window.graphResetLayout === 'function') window.graphResetLayout(); });

  var popover = document.getElementById('node-popover');
  var popoverCard = document.getElementById('node-popover-card');
  var popoverContent = document.getElementById('node-popover-content');
  var popoverClose = document.getElementById('node-popover-close');
  var popoverHandle = document.getElementById('node-popover-handle');
  var ctxMenu = document.getElementById('node-ctx-menu');
  var currentNode = null;
  var editMode = null;

  // --- Draggable popover ---
  var isDraggingPopover = false;
  var dragOffsetX = 0;
  var dragOffsetY = 0;
  if (popoverHandle) {
    popoverHandle.addEventListener('mousedown', function(e) {
      if (!popover) return;
      isDraggingPopover = true;
      dragOffsetX = e.clientX - parseFloat(popover.style.left || '0');
      dragOffsetY = e.clientY - parseFloat(popover.style.top || '0');
      e.preventDefault();
    });
  }
  document.addEventListener('mousemove', function(e) {
    if (!isDraggingPopover || !popover) return;
    var container = document.querySelector('.graph-container');
    var cw = container ? container.getBoundingClientRect().width : 900;
    var ch = container ? container.getBoundingClientRect().height : 600;
    var newLeft = Math.max(0, Math.min(cw - 60, e.clientX - dragOffsetX));
    var newTop = Math.max(0, Math.min(ch - 40, e.clientY - dragOffsetY));
    popover.style.left = newLeft + 'px';
    popover.style.top = newTop + 'px';
  });
  document.addEventListener('mouseup', function() { isDraggingPopover = false; });

  // --- Date helpers ---
  function formatRelativeDate(dateStr) {
    if (!dateStr) return '';
    try {
      var d = new Date(dateStr);
      if (isNaN(d.getTime())) return '';
      var days = Math.floor((Date.now() - d.getTime()) / 86400000);
      if (days < 1) return 'today';
      if (days === 1) return 'yesterday';
      if (days < 30) return days + 'd ago';
      if (days < 365) return Math.floor(days / 30) + 'mo ago';
      return Math.floor(days / 365) + 'y ago';
    } catch (e) { return ''; }
  }
  function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      var d = new Date(dateStr);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) { return ''; }
  }

  // --- Context menu helpers ---
  function hideCtxMenu() { if (ctxMenu) ctxMenu.style.display = 'none'; }
  document.addEventListener('click', hideCtxMenu);

  function currentPoint() {
    return {
      x: popover ? parseFloat(popover.style.left || '24') : 24,
      y: popover ? parseFloat(popover.style.top || '24') : 24
    };
  }

  function clearGraphSelection() {
    if (window.phrenGraph && typeof window.phrenGraph.clearSelection === 'function') {
      window.phrenGraph.clearSelection();
      return;
    }
    if (typeof window.graphClearSelection === 'function') window.graphClearSelection();
  }

  function hidePopover(skipSelectionClear) {
    currentNode = null;
    editMode = null;
    if (popover) {
      popover.style.display = 'none';
      popover.setAttribute('aria-hidden', 'true');
    }
    if (skipSelectionClear !== true) clearGraphSelection();
  }

  function positionPopover(x, y) {
    if (!popover || !popoverCard) return;
    popover.style.display = 'block';
    popover.setAttribute('aria-hidden', 'false');
    popover.style.visibility = 'hidden';
    requestAnimationFrame(function() {
      var container = document.querySelector('.graph-container');
      var cw = container ? container.getBoundingClientRect().width : 900;
      var ch = container ? container.getBoundingClientRect().height : 600;
      var cardRect = popoverCard.getBoundingClientRect();
      var cardW = cardRect.width;
      var cardH = cardRect.height;
      var pad = 10;
      var gap = 12;
      var left, top;

      // Pick side with more space horizontally
      if (x + gap + cardW + pad < cw) {
        left = x + gap;
      } else if (x - gap - cardW > pad) {
        left = x - gap - cardW;
      } else {
        left = Math.max(pad, (cw - cardW) / 2);
      }
      // Pick side with more space vertically
      if (y - cardH / 2 > pad && y + cardH / 2 < ch - pad) {
        top = y - cardH / 2; // center vertically on click
      } else if (y + gap + cardH + pad < ch) {
        top = y + gap;
      } else if (y - gap - cardH > pad) {
        top = y - gap - cardH;
      } else {
        top = Math.max(pad, (ch - cardH) / 2);
      }

      popover.style.left = left + 'px';
      popover.style.top = top + 'px';
      popover.style.visibility = 'visible';
    });
  }

  function renderDocs(node) {
    var docs = node.docs || [];
    if (!docs.length) return '<div style="color:var(--muted);font-size:12px">No linked docs.</div>';
    return '<div class="node-docs">' + docs.slice(0, 12).map(function(doc) { return chip(doc); }).join('') + '</div>';
  }

  function renderView(node) {
    var title = node.label || node.text || node.id;
    var chips = [chip(nodeKindLabel(node))];
    if (node.projectName) chips.push(chip(node.projectName));
    if (node.store) chips.push(chip(node.store));
    if (node.kind === 'task' && node.section) chips.push(chip(node.section));
    if (node.kind === 'task' && node.priority) chips.push(chip('Priority ' + node.priority));
    if (node.kind === 'finding' && node.topicLabel) chips.push(chip(node.topicLabel));

    var body = '';
    var actions = [];

    if (node.kind === 'project') {
      var counts = projectCounts(node);
      body += '<div class="node-grid">'
        + '<div class="node-metric"><div class="node-metric-label">Findings</div><div class="node-metric-value">' + counts.finding + '</div></div>'
        + '<div class="node-metric"><div class="node-metric-label">Tasks</div><div class="node-metric-value">' + counts.task + '</div></div>'
        + '<div class="node-metric"><div class="node-metric-label">Fragments</div><div class="node-metric-value">' + counts.entity + '</div></div>'
        + '<div class="node-metric"><div class="node-metric-label">References</div><div class="node-metric-value">' + counts.reference + '</div></div>'
        + '</div>';
      if (node.text) body += '<div class="node-copy">' + esc(node.text) + '</div>';
    } else if (node.kind === 'finding') {
      var dateInfo = [];
      if (node.date && node.date !== 'unknown') dateInfo.push(formatDate(node.date));
      if (node.lastUsedAt) dateInfo.push('Seen ' + formatRelativeDate(node.lastUsedAt));
      if (dateInfo.length) body += '<div class="node-date">' + esc(dateInfo.join(' \u00b7 ')) + '</div>';
      body += '<div class="node-copy">' + esc(node.text || title) + '</div>';
      actions.push('<button type="button" class="btn" data-node-action="edit">Edit</button>');
      actions.push('<button type="button" class="btn btn-danger" data-node-action="delete">Delete</button>');
    } else if (node.kind === 'task') {
      body += '<div class="node-copy">' + esc(node.text || title) + '</div>';
      actions.push('<button type="button" class="btn" data-node-action="edit">Edit</button>');
      if ((node.section || '').toLowerCase() !== 'done') actions.push('<button type="button" class="btn" data-node-action="complete">Done</button>');
      if ((node.section || '').toLowerCase() !== 'active') actions.push('<button type="button" class="btn" data-node-action="move-active">Move to Active</button>');
      if ((node.section || '').toLowerCase() !== 'queue') actions.push('<button type="button" class="btn" data-node-action="move-queue">Move to Queue</button>');
      actions.push('<button type="button" class="btn btn-danger" data-node-action="delete">Delete</button>');
    } else if (node.kind === 'entity') {
      if (node.connectedProjects && node.connectedProjects.length) {
        body += '<div class="node-chips">' + node.connectedProjects.map(function(project) { return chip(project); }).join('') + '</div>';
      }
      body += renderDocs(node);
    } else if (node.kind === 'reference') {
      body += '<div class="node-copy">' + esc(node.text || title) + '</div>';
    } else {
      body += '<div class="node-copy">' + esc(node.text || title) + '</div>';
    }

    return '<div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">' + esc(nodeKindLabel(node)) + '</div>'
      + '<div style="font-size:15px;font-weight:600;line-height:1.2">' + esc(title) + '</div>'
      + '<div class="node-chips">' + chips.join('') + '</div>'
      + body
      + (actions.length ? '<div class="node-actions">' + actions.join('') + '</div>' : '');
  }

  function renderEdit(node) {
    var title = node.kind === 'task' ? 'Edit task' : 'Edit finding';
    var section = node.section || 'Queue';
    var priority = node.priority || '';
    return '<div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">' + esc(title) + '</div>'
      + '<div style="font-size:14px;font-weight:600;line-height:1.2">' + esc(node.projectName || nodeKindLabel(node)) + '</div>'
      + '<textarea id="node-editor" class="node-editor">' + esc(node.text || node.label || '') + '</textarea>'
      + (node.kind === 'task'
        ? '<div class="node-select-grid">'
          + '<label class="node-select-wrap">Status<select id="node-section"><option value="Queue"' + (section === 'Queue' ? ' selected' : '') + '>Queue</option><option value="Active"' + (section === 'Active' ? ' selected' : '') + '>Active</option><option value="Done"' + (section === 'Done' ? ' selected' : '') + '>Done</option></select></label>'
          + '<label class="node-select-wrap">Priority<select id="node-priority"><option value=""' + (!priority ? ' selected' : '') + '>None</option><option value="high"' + (priority === 'high' ? ' selected' : '') + '>High</option><option value="medium"' + (priority === 'medium' ? ' selected' : '') + '>Medium</option><option value="low"' + (priority === 'low' ? ' selected' : '') + '>Low</option></select></label>'
          + '</div>'
        : '')
      + '<div class="node-actions"><button type="button" class="btn" data-node-action="save">Save</button><button type="button" class="btn" data-node-action="cancel">Cancel</button></div>';
  }

  function bindActions() {
    if (popoverClose) popoverClose.onclick = function() { hidePopover(false); };
    function taskItemKey() {
      return (currentNode && (currentNode.taskItemId || currentNode.text)) || '';
    }
    document.querySelectorAll('[data-node-action]').forEach(function(button) {
      button.addEventListener('click', function() {
        if (!currentNode) return;
        var action = button.getAttribute('data-node-action');
        if (action === 'edit') {
          editMode = currentNode.kind === 'task' ? 'task' : 'finding';
          var point = currentPoint();
          renderPopover(currentNode, point.x, point.y);
          return;
        }
        if (action === 'cancel') {
          editMode = null;
          var point = currentPoint();
          renderPopover(currentNode, point.x, point.y);
          return;
        }
        if (action === 'save') {
          var editor = document.getElementById('node-editor');
          var nextText = editor ? editor.value.trim() : '';
          if (!nextText) return;
          if (editMode === 'task') {
            var sectionEl = document.getElementById('node-section');
            var priorityEl = document.getElementById('node-priority');
            vscode.postMessage({
              command: 'saveTaskEdit',
              projectName: currentNode.projectName,
              item: taskItemKey(),
              text: nextText,
              section: sectionEl ? sectionEl.value : currentNode.section,
              priority: priorityEl ? priorityEl.value : currentNode.priority
            });
          } else {
            vscode.postMessage({
              command: 'saveFindingEdit',
              projectName: currentNode.projectName,
              oldText: currentNode.text,
              newText: nextText
            });
          }
          return;
        }
        if (action === 'delete') {
          if (currentNode.kind === 'task') {
            vscode.postMessage({ command: 'deleteTask', projectName: currentNode.projectName, item: taskItemKey() });
          } else if (currentNode.kind === 'finding') {
            vscode.postMessage({ command: 'deleteFinding', projectName: currentNode.projectName, text: currentNode.text });
          }
          return;
        }
        if (action === 'complete') {
          vscode.postMessage({ command: 'completeTask', projectName: currentNode.projectName, item: taskItemKey() });
          return;
        }
        if (action === 'move-active') {
          vscode.postMessage({ command: 'moveTask', projectName: currentNode.projectName, item: taskItemKey(), section: 'Active' });
          return;
        }
        if (action === 'move-queue') {
          vscode.postMessage({ command: 'moveTask', projectName: currentNode.projectName, item: taskItemKey(), section: 'Queue' });
          return;
        }
      });
    });
  }

  function renderPopover(node, x, y) {
    if (!popoverContent || !node) {
      hidePopover(true);
      return;
    }
    currentNode = node;
    popoverContent.innerHTML = editMode ? renderEdit(node) : renderView(node);
    bindActions();
    positionPopover(x, y);
    if (editMode) {
      requestAnimationFrame(function() {
        var editor = document.getElementById('node-editor');
        if (editor && typeof editor.focus === 'function') {
          editor.focus();
          if (typeof editor.setSelectionRange === 'function') {
            var end = editor.value ? editor.value.length : 0;
            editor.setSelectionRange(end, end);
          }
        }
      });
    }
  }

  function outsidePointer(event) {
    if (!currentNode || !popoverCard) return;
    var target = event.target;
    if (target instanceof Node && popoverCard.contains(target)) return;
    hidePopover();
  }

  document.addEventListener('pointerdown', outsidePointer, true);
  document.addEventListener('keydown', function(event) {
    if (event.key !== 'Escape' || !currentNode) return;
    if (editMode) {
      editMode = null;
      var point = currentPoint();
      renderPopover(currentNode, point.x, point.y);
      return;
    }
    hidePopover();
  });

  if (window.phrenGraph && window.phrenGraph.onNodeSelect) {
    window.phrenGraph.onNodeSelect(function(node, x, y) {
      if (!node) {
        hidePopover(true);
        return;
      }
      currentNode = Object.assign({}, nodeLookup[node.id] || {}, node);
      editMode = null;
      renderPopover(currentNode, x, y);
    });
  }

  if (window.phrenGraph && window.phrenGraph.onSelectionClear) {
    window.phrenGraph.onSelectionClear(function() {
      hidePopover(true);
    });
  }

  // --- Right-click context menu on graph ---
  if (window.phrenGraph && window.phrenGraph.onRightClick) {
    window.phrenGraph.onRightClick(function(node, x, y) {
      hideCtxMenu();
      if (!ctxMenu || !node) return;
      var items = [];
      if (node.kind === 'project') {
        items.push('<button class="node-ctx-item" data-ctx-action="focus" data-ctx-node="' + esc(node.id) + '">Focus project</button>');
      } else {
        items.push('<button class="node-ctx-item" data-ctx-action="select" data-ctx-node="' + esc(node.id) + '">View details</button>');
      }
      if (!items.length) return;
      ctxMenu.innerHTML = items.join('');
      ctxMenu.style.left = x + 'px';
      ctxMenu.style.top = y + 'px';
      ctxMenu.style.display = 'block';
      ctxMenu.querySelectorAll('[data-ctx-action]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var act = btn.getAttribute('data-ctx-action');
          if (act === 'focus' || act === 'select') {
            var nid = btn.getAttribute('data-ctx-node');
            if (nid && window.phrenGraph) window.phrenGraph.selectNode(nid);
          }
          hideCtxMenu();
        });
      });
    });
  }

  // Ambient particle animation overlay
  (function() {
    var canvas = document.getElementById('ambient-canvas');
    if (!canvas || typeof canvas.getContext !== 'function') return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var W = 0, H = 0;
    function resize() {
      var rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : { width: 900, height: 600 };
      W = rect.width || canvas.offsetWidth;
      H = rect.height || canvas.offsetHeight;
      canvas.width = W;
      canvas.height = H;
    }
    resize();
    window.addEventListener('resize', resize);

    // Parse accent color from CSS variable, fallback to phren purple-blue
    var accentR = 100, accentG = 140, accentB = 255;
    try {
      var raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      if (raw.startsWith('#') && raw.length >= 7) {
        accentR = parseInt(raw.slice(1, 3), 16);
        accentG = parseInt(raw.slice(3, 5), 16);
        accentB = parseInt(raw.slice(5, 7), 16);
      }
    } catch (_e) {}

    var COUNT = 26;
    var particles = [];

    function spawn(fromBottom) {
      return {
        x: Math.random() * W,
        y: fromBottom ? H + Math.random() * 30 : Math.random() * H,
        vx: (Math.random() - 0.5) * 0.28,
        vy: -(0.18 + Math.random() * 0.42),
        r: 0.6 + Math.random() * 1.4,
        alpha: fromBottom ? 0 : Math.random() * 0.18,
        maxAlpha: 0.07 + Math.random() * 0.13,
        phase: Math.random() * Math.PI * 2,
        growing: true
      };
    }

    for (var i = 0; i < COUNT; i++) particles.push(spawn(false));

    var lastTs = 0;
    function tick(ts) {
      var dt = lastTs ? Math.min((ts - lastTs) / 16, 4) : 1;
      lastTs = ts;

      if (!document.hidden && W > 0 && H > 0) {
        ctx.clearRect(0, 0, W, H);

        for (var j = 0; j < particles.length; j++) {
          var p = particles[j];
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.phase += 0.018 * dt;

          if (p.growing) {
            p.alpha = Math.min(p.alpha + 0.0025 * dt, p.maxAlpha);
            if (p.alpha >= p.maxAlpha) p.growing = false;
          }

          // fade out as particle approaches top 15% of canvas
          if (p.y < H * 0.15) {
            p.alpha = Math.max(p.alpha - 0.006 * dt, 0);
          }

          if (p.y < -10 || p.alpha <= 0) {
            particles[j] = spawn(true);
            continue;
          }

          var pulse = 0.72 + 0.28 * Math.sin(p.phase);
          var a = Math.max(0, Math.min(1, p.alpha * pulse));
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(' + accentR + ',' + accentG + ',' + accentB + ',' + a + ')';
          ctx.fill();
        }
      }

      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })();

})();
  </script>
</body>
</html>`;
}

/* ── Helpers ──────────────────────────────────────────────── */

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function responseData(value: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(value)?.data);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
