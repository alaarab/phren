/**
 * Scheduled task tools — create, list, and delete recurring or one-shot prompts.
 *
 * Session-scoped: all tasks are cancelled when the process exits.
 * Auto-expiry: recurring tasks expire after 3 days to prevent forgotten loops.
 */
import type { AgentTool, AgentToolResult } from "./types.js";

interface CronTask {
  id: string;
  expression: string;
  prompt: string;
  createdAt: number;
  lastRunAt: number | null;
  runCount: number;
  maxRuns: number | null; // null = unlimited
  expiresAt: number;
  timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null;
}

const tasks = new Map<string, CronTask>();
let taskCounter = 0;

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/** Callback invoked when a scheduled task fires. Set by the agent loop. */
let onTaskFire: ((taskId: string, prompt: string) => void) | null = null;

/** Set the callback for when tasks fire. */
export function setTaskFireCallback(cb: (taskId: string, prompt: string) => void): void {
  onTaskFire = cb;
}

/** Parse a simple interval string like "5m", "1h", "30s" to ms. */
function parseInterval(expr: string): number | null {
  const match = expr.match(/^(\d+)\s*(s|m|h)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === "s") return value * 1000;
  if (unit === "m") return value * 60 * 1000;
  if (unit === "h") return value * 60 * 60 * 1000;
  return null;
}

function fireTask(task: CronTask): void {
  task.lastRunAt = Date.now();
  task.runCount++;

  // Check expiry
  if (Date.now() > task.expiresAt) {
    cancelTask(task.id);
    return;
  }

  // Check max runs
  if (task.maxRuns !== null && task.runCount >= task.maxRuns) {
    onTaskFire?.(task.id, task.prompt);
    cancelTask(task.id);
    return;
  }

  onTaskFire?.(task.id, task.prompt);
}

function cancelTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task) return false;
  if (task.timer) {
    clearInterval(task.timer as ReturnType<typeof setInterval>);
    clearTimeout(task.timer as ReturnType<typeof setTimeout>);
  }
  tasks.delete(id);
  return true;
}

export const cronCreateTool: AgentTool = {
  name: "cron_create",
  description:
    "Schedule a recurring or one-shot prompt. The prompt will be injected into the conversation " +
    "at the specified interval. Use for polling CI status, reminders, or periodic checks. " +
    "Session-scoped: cancelled when the process exits. Auto-expires after 3 days.",
  input_schema: {
    type: "object",
    properties: {
      interval: {
        type: "string",
        description: "Interval like '5m', '30s', '1h'. For one-shot, use 'once:30s'.",
      },
      prompt: {
        type: "string",
        description: "The prompt to inject at each interval.",
      },
    },
    required: ["interval", "prompt"],
  },
  async execute(input): Promise<AgentToolResult> {
    const intervalStr = input.interval as string;
    const prompt = input.prompt as string;

    const isOnce = intervalStr.startsWith("once:");
    const expr = isOnce ? intervalStr.slice(5) : intervalStr;
    const ms = parseInterval(expr);

    if (!ms || ms < 5000) {
      return { output: "Invalid interval. Use format like '5m', '30s', '1h'. Minimum 5s.", is_error: true };
    }

    const id = `task-${++taskCounter}`;
    const task: CronTask = {
      id,
      expression: intervalStr,
      prompt,
      createdAt: Date.now(),
      lastRunAt: null,
      runCount: 0,
      maxRuns: isOnce ? 1 : null,
      expiresAt: Date.now() + THREE_DAYS_MS,
      timer: null,
    };

    if (isOnce) {
      task.timer = setTimeout(() => fireTask(task), ms);
    } else {
      task.timer = setInterval(() => fireTask(task), ms);
    }

    tasks.set(id, task);
    return { output: `Scheduled ${id}: "${prompt.slice(0, 60)}" every ${expr}${isOnce ? " (one-shot)" : ""}` };
  },
};

export const cronListTool: AgentTool = {
  name: "cron_list",
  description: "List all scheduled tasks with their IDs, intervals, and run counts.",
  input_schema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<AgentToolResult> {
    if (tasks.size === 0) return { output: "No scheduled tasks." };

    const lines = [...tasks.values()].map((t) => {
      const ago = t.lastRunAt ? `${((Date.now() - t.lastRunAt) / 1000).toFixed(0)}s ago` : "never";
      return `${t.id}: "${t.prompt.slice(0, 50)}" every ${t.expression} (runs: ${t.runCount}, last: ${ago})`;
    });

    return { output: lines.join("\n") };
  },
};

export const cronDeleteTool: AgentTool = {
  name: "cron_delete",
  description: "Cancel a scheduled task by ID.",
  input_schema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task ID from cron_list." },
    },
    required: ["task_id"],
  },
  async execute(input): Promise<AgentToolResult> {
    const id = input.task_id as string;
    const cancelled = cancelTask(id);
    return { output: cancelled ? `Cancelled ${id}.` : `Task ${id} not found.` };
  },
};

/** Cancel all tasks (call on session end). */
export function cancelAllCronTasks(): void {
  for (const id of [...tasks.keys()]) cancelTask(id);
}
