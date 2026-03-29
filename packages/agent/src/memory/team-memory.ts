/**
 * Team memory — auto-generate findings from team agent sessions.
 *
 * After a TeamAgent completes, this summarizes:
 * - How the work was split across agents
 * - What each agent learned/discovered
 * - Any failures and how they were resolved
 * - Cross-agent patterns (e.g., "agent A's output was used by agent B")
 */
import type { PhrenContext } from "./context.js";
import type { TeamTask } from "../multi/coordinator.js";
import type { AgentEntry } from "../multi/types.js";

export interface TeamSessionSummary {
  teamName: string;
  task: string;
  agents: Array<{
    id: string;
    task: string;
    status: string;
    resultPreview?: string;
  }>;
  tasks: Array<{
    id: string;
    subject: string;
    status: string;
    owner: string | null;
  }>;
  totalAgents: number;
  tasksCompleted: number;
  tasksFailed: number;
}

/**
 * Generate and save a team session summary as a phren finding.
 */
export async function saveTeamMemory(
  ctx: PhrenContext,
  summary: TeamSessionSummary,
): Promise<void> {
  try {
    const { addFinding } = await import("@phren/cli/core/finding");

    const project = ctx.project;
    if (!project) return;

    const finding = formatTeamFinding(summary);
    addFinding(ctx.phrenPath, project, finding);
  } catch {
    // Best effort
  }
}

function formatTeamFinding(summary: TeamSessionSummary): string {
  const lines: string[] = [
    `Team "${summary.teamName}" completed: ${summary.task.slice(0, 150)}`,
    `Agents: ${summary.totalAgents}, Tasks: ${summary.tasksCompleted} completed, ${summary.tasksFailed} failed`,
  ];

  // Agent summaries
  if (summary.agents.length > 0) {
    lines.push("Agent breakdown:");
    for (const agent of summary.agents.slice(0, 5)) {
      const preview = agent.resultPreview ? ` — ${agent.resultPreview.slice(0, 100)}` : "";
      lines.push(`  - ${agent.id} [${agent.status}]: ${agent.task.slice(0, 80)}${preview}`);
    }
    if (summary.agents.length > 5) {
      lines.push(`  ... and ${summary.agents.length - 5} more agents`);
    }
  }

  // Failed tasks
  const failed = summary.tasks.filter(t => t.status === "failed");
  if (failed.length > 0) {
    lines.push("Failed tasks:");
    for (const task of failed) {
      lines.push(`  - #${task.id} ${task.subject} (owner: ${task.owner ?? "unassigned"})`);
    }
  }

  lines.push("<!-- team_session -->");

  return lines.join("\n");
}

/**
 * Build a TeamSessionSummary from agent and task data.
 */
export function buildTeamSummary(
  teamName: string,
  task: string,
  agents: AgentEntry[],
  tasks: TeamTask[],
): TeamSessionSummary {
  return {
    teamName,
    task,
    agents: agents.map(a => ({
      id: a.id,
      task: a.task,
      status: a.status,
      resultPreview: a.result?.finalText?.slice(0, 200),
    })),
    tasks: tasks.map(t => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      owner: t.owner,
    })),
    totalAgents: agents.length,
    tasksCompleted: tasks.filter(t => t.status === "completed").length,
    tasksFailed: tasks.filter(t => t.status === "failed").length,
  };
}
