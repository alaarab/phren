import * as fs from "fs";
import {
  addTask,
  completeTask,
  readTasks,
  resolveTaskItem,
  updateTask,
  type TaskItem,
} from "./data-access.js";
import { parseGithubIssueUrl, resolveProjectGithubRepo } from "./tasks-github.js";
import { getProactivityLevelForTask, shouldAutoCaptureTaskForLevel, hasExecutionIntent, hasDiscoveryIntent, type ProactivityLevel } from "./proactivity.js";
import { getWorkflowPolicy } from "./shared-governance.js";
import { debugLog, sessionMarker } from "./shared.js";
import { errorMessage } from "./utils.js";

export type TaskMode = "off" | "manual" | "suggest" | "auto";

interface TaskSessionState {
  sessionId: string;
  project: string;
  stableId?: string;
  item: string;
  summary: string;
  mode: Extract<TaskMode, "suggest" | "auto">;
  createdAt: string;
  updatedAt: string;
}

export interface TaskPromptLifecycleResult {
  mode: TaskMode;
  noticeLines: string[];
}

const ACTION_PREFIX_RE = /^(?:please\s+|can you\s+|could you\s+|would you\s+|i want you to\s+|i want to\s+|let(?:'|’)s\s+|lets\s+|help me\s+)/i;
const EXPLICIT_TASK_PREFIX_RE = /^(?:add(?:\s+(?:this|that|it))?\s+(?:to\s+(?:the\s+)?)?(?:task|todo(?:\s+list)?|task(?:\s+list)?)|add\s+(?:a\s+)?task|put(?:\s+(?:this|that|it))?\s+(?:in|on)\s+(?:the\s+)?(?:task|todo(?:\s+list)?|task(?:\s+list)?))\s*(?::|-|,)?\s*/i;
const NON_ACTIONABLE_RE = /\b(brainstorm|idea|ideas|maybe|what if|should we|could we|would it make sense|question|explain|why is|how does)\b/i;
const ACTIONABLE_RE = /\b(add|build|change|complete|continue|create|delete|fix|implement|improve|investigate|make|move|refactor|remove|rename|repair|ship|start|update|wire)\b/i;
const CONTINUE_RE = /\b(continue|keep going|finish|resume|pick up|work on that|that task)\b/i;
const GITHUB_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+(?:[?#][^\s]*)?/g;
const GITHUB_ISSUE_RE = /(^|[^\w/])#(\d+)\b/g;
const TASK_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "auto",
  "automatic",
  "because",
  "before",
  "code",
  "cortex",
  "current",
  "during",
  "feature",
  "from",
  "have",
  "into",
  "just",
  "like",
  "make",
  "more",
  "need",
  "really",
  "should",
  "some",
  "something",
  "stuff",
  "task",
  "tasks",
  "that",
  "them",
  "then",
  "this",
  "thing",
  "want",
  "with",
  "work",
]);

function taskSessionPath(cortexPath: string, sessionId: string): string {
  return sessionMarker(cortexPath, `task-${sessionId}.json`);
}

function readTaskSessionState(cortexPath: string, sessionId: string): TaskSessionState | null {
  const file = taskSessionPath(cortexPath, sessionId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as TaskSessionState;
  } catch (err: unknown) {
    debugLog(`task lifecycle read session ${sessionId}: ${errorMessage(err)}`);
    return null;
  }
}

function writeTaskSessionState(cortexPath: string, state: TaskSessionState): void {
  const file = taskSessionPath(cortexPath, state.sessionId);
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

function clearTaskSessionState(cortexPath: string, sessionId: string): void {
  const file = taskSessionPath(cortexPath, sessionId);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err: unknown) {
    debugLog(`task lifecycle clear session ${sessionId}: ${errorMessage(err)}`);
  }
}

export function getTaskMode(cortexPath: string): TaskMode {
  return getWorkflowPolicy(cortexPath).taskMode;
}

function isActionablePrompt(prompt: string, intent: string): boolean {
  const normalized = prompt.trim();
  if (!normalized) return false;
  if (NON_ACTIONABLE_RE.test(normalized)) return false;
  if (intent === "general") return ACTIONABLE_RE.test(normalized);
  return true;
}

function normalizeTaskSummary(prompt: string): string {
  const withoutGithub = prompt
    .replace(GITHUB_URL_RE, " ")
    .replace(GITHUB_ISSUE_RE, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
  const stripped = withoutGithub.replace(ACTION_PREFIX_RE, "").trim();
  const withoutTaskPrefix = stripped.replace(EXPLICIT_TASK_PREFIX_RE, "").trim();
  const taskSource = withoutTaskPrefix || stripped;
  const firstClause = taskSource.split(/[\n.!?]/)[0]?.trim() || taskSource;
  const cleaned = firstClause
    .replace(/^to\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  const capped = cleaned.length > 110 ? `${cleaned.slice(0, 109).trimEnd()}…` : cleaned;
  if (!capped) return "Follow up on current work";
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

function tokenizeTaskText(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/<!--.*?-->/g, " ")
    .replace(/[`"'.,!?()[\]{}:/\\]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !TASK_STOP_WORDS.has(token));
}

function overlapScore(prompt: string, item: TaskItem): number {
  const promptTokens = new Set(tokenizeTaskText(prompt));
  if (promptTokens.size === 0) return 0;
  const itemTokens = tokenizeTaskText(item.line);
  let score = 0;
  for (const token of itemTokens) {
    if (promptTokens.has(token)) score += 1;
  }
  if (prompt.toLowerCase().includes(item.line.toLowerCase())) score += 3;
  return score;
}

function matchExistingActiveTask(prompt: string, activeItems: TaskItem[]): TaskItem | null {
  if (activeItems.length === 0) return null;
  if (activeItems.length === 1 && CONTINUE_RE.test(prompt)) return activeItems[0];

  const ranked = activeItems
    .map((item) => ({ item, score: overlapScore(prompt, item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return null;
  if (ranked[0].score >= 2 && (ranked.length === 1 || ranked[0].score > ranked[1].score)) {
    return ranked[0].item;
  }
  return null;
}

function resolveTrackedSessionTask(cortexPath: string, state: TaskSessionState): TaskItem | null {
  const match = state.stableId ? `bid:${state.stableId}` : state.item;
  const resolved = resolveTaskItem(cortexPath, state.project, match);
  return resolved.ok ? resolved.data : null;
}

function extractGithubMetadata(cortexPath: string, project: string, prompt: string): { github_issue?: number; github_url?: string } {
  const repo = resolveProjectGithubRepo(cortexPath, project);
  for (const match of prompt.matchAll(GITHUB_URL_RE)) {
    const parsed = parseGithubIssueUrl(match[0]);
    if (!parsed) continue;
    if (repo && parsed.repo && parsed.repo !== repo) continue;
    return {
      github_issue: parsed.issueNumber,
      github_url: parsed.url,
    };
  }

  if (!repo) return {};

  const issueMatch = GITHUB_ISSUE_RE.exec(prompt);
  GITHUB_ISSUE_RE.lastIndex = 0;
  if (!issueMatch) return {};
  return { github_issue: Number.parseInt(issueMatch[2], 10) };
}

function buildSuggestionNotice(project: string, line: string, issueMeta: { github_issue?: number; github_url?: string }): string[] {
  const githubLine = issueMeta.github_url
    ? `Suggested link: ${issueMeta.github_url}`
    : issueMeta.github_issue
      ? `Suggested GitHub link: #${issueMeta.github_issue}`
      : "";
  return [
    "<cortex-notice>",
    `Task suggestion for ${project}:`,
    `- ${line}`,
    ...(githubLine ? [githubLine] : []),
    "<cortex-notice>",
  ];
}

function persistTaskAttachment(cortexPath: string, sessionId: string, project: string, item: TaskItem, summary: string, mode: Extract<TaskMode, "suggest" | "auto">): void {
  writeTaskSessionState(cortexPath, {
    sessionId,
    project,
    stableId: item.stableId,
    item: item.line,
    summary,
    mode,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

export function handleTaskPromptLifecycle(args: {
  cortexPath: string;
  prompt: string;
  project: string | null;
  sessionId?: string;
  intent: string;
  taskLevel?: ProactivityLevel;
}): TaskPromptLifecycleResult {
  const mode = getTaskMode(args.cortexPath);
  if (mode === "off" || mode === "manual" || !args.project || !args.sessionId) {
    return { mode, noticeLines: [] };
  }
  if (!isActionablePrompt(args.prompt, args.intent)) {
    return { mode, noticeLines: [] };
  }
  const taskLevel = args.taskLevel ?? getProactivityLevelForTask();
  if (mode === "auto" && !shouldAutoCaptureTaskForLevel(taskLevel, args.prompt)) {
    debugLog(`task lifecycle skipped ${args.project}: task proactivity=${taskLevel}`);
    return { mode, noticeLines: [] };
  }

  const parsed = readTasks(args.cortexPath, args.project);
  if (!parsed.ok) return { mode, noticeLines: [] };

  const summary = normalizeTaskSummary(args.prompt);
  const issueMeta = extractGithubMetadata(args.cortexPath, args.project, args.prompt);
  const trackedState = readTaskSessionState(args.cortexPath, args.sessionId);
  const trackedItem = trackedState && trackedState.project === args.project
    ? resolveTrackedSessionTask(args.cortexPath, trackedState)
    : null;
  const activeItems = parsed.data.items.Active;
  const reusable = trackedItem && trackedItem.section === "Active"
    ? trackedItem
    : matchExistingActiveTask(args.prompt, activeItems);

  if (mode === "suggest") {
    const line = reusable?.line || summary;
    return {
      mode,
      noticeLines: buildSuggestionNotice(args.project, line, issueMeta),
    };
  }

  // Intent-aware auto mode: if the user is in discovery mode (brainstorming,
  // exploring ideas) and NOT in execution mode (approving, committing to work),
  // fall back to a suggestion instead of writing the task immediately.
  if (mode === "auto" && !hasExecutionIntent(args.prompt) && hasDiscoveryIntent(args.prompt)) {
    const line = reusable?.line || summary;
    debugLog(`task lifecycle auto→suggest ${args.project}: discovery intent detected`);
    return {
      mode: "auto",
      noticeLines: buildSuggestionNotice(args.project, line, issueMeta),
    };
  }

  const targetMatch = reusable?.stableId ? `bid:${reusable.stableId}` : reusable?.id;
  if (!reusable) {
    const add = addTask(args.cortexPath, args.project, summary);
    if (!add.ok) {
      debugLog(`task lifecycle add ${args.project}: ${add.error}`);
      return { mode, noticeLines: [] };
    }
  }

  const update = updateTask(args.cortexPath, args.project, targetMatch || summary, {
    section: "active",
    context: summary,
    replace_context: true,
    ...issueMeta,
  });
  if (!update.ok) {
    debugLog(`task lifecycle update ${args.project}: ${update.error}`);
    return { mode, noticeLines: [] };
  }

  const resolved = resolveTaskItem(args.cortexPath, args.project, targetMatch || summary);
  if (!resolved.ok) {
    debugLog(`task lifecycle resolve ${args.project}: ${resolved.error}`);
    return { mode, noticeLines: [] };
  }

  persistTaskAttachment(args.cortexPath, args.sessionId, args.project, resolved.data, summary, "auto");
  return {
    mode,
    noticeLines: [
      "<cortex-notice>",
      `Active task (${args.project}): ${resolved.data.line}`,
      "<cortex-notice>",
    ],
  };
}

export function finalizeTaskSession(args: {
  cortexPath: string;
  sessionId?: string;
  status: "clean" | "saved-local" | "saved-pushed" | "error";
  detail: string;
}): void {
  if (!args.sessionId || getTaskMode(args.cortexPath) !== "auto") return;
  const state = readTaskSessionState(args.cortexPath, args.sessionId);
  if (!state || state.mode !== "auto") return;

  const match = state.stableId ? `bid:${state.stableId}` : state.item;
  if (args.status === "saved-local" || args.status === "saved-pushed") {
    const completed = completeTask(args.cortexPath, state.project, match);
    if (!completed.ok) {
      debugLog(`task lifecycle complete ${state.project}: ${completed.error}`);
      return;
    }
    clearTaskSessionState(args.cortexPath, args.sessionId);
    return;
  }

  if (args.status === "error") {
    const blocked = updateTask(args.cortexPath, state.project, match, {
      section: "active",
      context: `Blocked: ${args.detail}`,
      replace_context: true,
    });
    if (!blocked.ok) {
      debugLog(`task lifecycle block ${state.project}: ${blocked.error}`);
      return;
    }
    writeTaskSessionState(args.cortexPath, {
      ...state,
      summary: `Blocked: ${args.detail}`,
      updatedAt: new Date().toISOString(),
    });
    return;
  }
}

export function clearTaskSession(cortexPath: string, sessionId?: string): void {
  if (!sessionId) return;
  clearTaskSessionState(cortexPath, sessionId);
}
