import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

export interface PriorSummaryInfo {
  summary: string;
  project?: string;
  endedAt?: string;
}

export interface CustomCommandHint {
  name: string;
  description?: string;
}

export interface SystemPromptOptions {
  /** Names of the tools registered for this session; the prompt lists only these. */
  toolNames?: string[];
  /** Configured MCP server names, to attribute `mcp_<server>_<tool>` tools. */
  mcpServers?: string[];
  /** Permission mode, shown in the environment block. */
  permissionMode?: string;
  /** A prebuilt environment block; build it once per session so the prompt stays byte-stable. */
  environment?: string;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, timeout: 2000, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * The environment block: cwd, platform, shell, date, git state. Nothing in it
 * changes per turn (the date, not the time), so the prompt caches.
 */
export function buildEnvironmentBlock(cwd: string = process.cwd(), permissionMode?: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const shell = process.env.SHELL ? path.basename(process.env.SHELL) : process.env.COMSPEC ? path.basename(process.env.COMSPEC) : "unknown";
  const lines = [
    `- Working directory: ${cwd}`,
    `- Platform: ${os.type()} ${os.release()} (${process.platform}, ${os.arch()})`,
    `- Shell: ${shell}`,
    `- Today's date: ${date}`,
  ];
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true") {
    const branch = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const detached = branch ? null : git(cwd, ["rev-parse", "--short", "HEAD"]);
    lines.push(`- Git repository: yes, ${branch ? `branch ${branch}` : detached ? `detached HEAD at ${detached}` : "no commits yet"}`);
  } else {
    lines.push("- Git repository: no");
  }
  if (permissionMode) lines.push(`- Permission mode: ${permissionMode}`);
  return `## Environment\n${lines.join("\n")}`;
}

const TOOL_GROUPS: Array<[string, string[]]> = [
  ["Files and editing", ["read_file", "write_file", "edit_file", "multi_edit", "apply_patch", "read_image"]],
  ["Search", ["glob", "grep"]],
  ["Shell", ["shell", "task_output", "task_stop"]],
  ["Git", ["git_status", "git_diff", "git_commit"]],
  ["Web", ["web_search", "web_fetch"]],
  ["Memory", ["phren_search", "phren_add_finding", "phren_get_tasks", "phren_complete_task", "phren_add_task", "run_skill"]],
  ["Planning and agents", ["update_plan", "spawn_agent", "send_message_to_agent", "list_agents", "list_mcp_resources", "read_mcp_resource"]],
];

const EDIT_HINTS: Array<[string, string]> = [
  ["edit_file", "`edit_file` for a small change"],
  ["multi_edit", "`multi_edit` for several changes in one file"],
  ["apply_patch", "`apply_patch` for changes across files"],
  ["write_file", "`write_file` for new files"],
];

/** The tools section, from the names actually registered. MCP tools are counted per server, not listed. */
export function buildToolSection(toolNames: string[], mcpServers: string[] = []): string {
  const registered = new Set(toolNames);
  const lines: string[] = [];
  const known = new Set<string>();
  for (const [label, names] of TOOL_GROUPS) {
    for (const n of names) known.add(n);
    const present = names.filter((n) => registered.has(n));
    if (present.length > 0) lines.push(`- ${label}: ${present.map((n) => `\`${n}\``).join(", ")}`);
  }
  const servers = [...mcpServers].sort((a, b) => b.length - a.length);
  const counts = new Map<string, number>();
  const other: string[] = [];
  for (const n of toolNames) {
    if (known.has(n)) continue;
    if (!n.startsWith("mcp_")) { other.push(n); continue; }
    const rest = n.slice(4);
    const server = servers.find((s) => rest.startsWith(`${s}_`)) ?? rest.split("_")[0];
    counts.set(server, (counts.get(server) ?? 0) + 1);
  }
  if (other.length > 0) lines.push(`- Other: ${other.map((n) => `\`${n}\``).join(", ")}`);
  if (counts.size > 0) {
    const summary = [...counts].map(([s, c]) => `${s} (${c})`).join(", ");
    lines.push(`- MCP: ${summary}. Tools are named \`mcp_<server>_<tool>\`.`);
  }
  const hints = EDIT_HINTS.filter(([n]) => registered.has(n)).map(([, text]) => text);
  if (hints.length > 1) lines.push("", `Edit tools: ${hints.join(", ")}.`);
  return `## Tools You Have\n${lines.join("\n")}`;
}

function workflowSteps(has: (name: string) => boolean): string[] {
  const steps: string[] = [];
  if (has("phren_search")) steps.push("**Search memory first** — `phren_search` for relevant past findings before starting work.");
  const reads = ["glob", "grep", "read_file"].filter(has);
  if (reads.length > 0) steps.push(`**Read before writing** — ${reads.map((n) => `\`${n}\``).join(", ")} to find and understand code.`);
  if (has("edit_file") && has("write_file")) steps.push("**Make changes** — `edit_file` for surgical edits, `write_file` for new files only.");
  else if (has("edit_file")) steps.push("**Make changes** — `edit_file` for surgical edits.");
  else if (has("write_file")) steps.push("**Make changes** — `write_file`.");
  const verify = [has("shell") && "`shell` to run tests/linters", has("git_diff") && "`git_diff` to review changes"].filter(Boolean);
  if (verify.length > 0) steps.push(`**Verify** — ${verify.join(", ")}.`);
  if (has("phren_add_finding")) steps.push("**Save learnings** — `phren_add_finding` for non-obvious discoveries (bugs, architecture decisions, gotchas). Skip obvious stuff.");
  steps.push("**Report concisely** — what changed and why. No fluff.");
  return steps.map((s, i) => `${i + 1}. ${s}`);
}

export function buildSystemPrompt(
  phrenContext: string,
  priorSummary: PriorSummaryInfo | string | null,
  providerInfo?: { name: string; model?: string },
  customCommands?: CustomCommandHint[],
  options: SystemPromptOptions = {},
): string {
  const registered = options.toolNames ? new Set(options.toolNames) : null;
  const has = (name: string) => !registered || registered.has(name);
  const modelNote = providerInfo ? ` You are running on ${providerInfo.name}${providerInfo.model ? ` (model: ${providerInfo.model})` : ""}.` : "";
  const parts = [
    `You are phren-agent, an autonomous coding agent with persistent memory.${modelNote}`,
    "",
    "## Core Behavior",
    "ACT IMMEDIATELY. When the user asks you to do something, DO IT. Don't describe what you're going to do — just do it. Use your tools without asking permission. Read files, search code, make edits, run commands. Only ask clarifying questions when the request is genuinely ambiguous.",
    "",
    "You have persistent memory via phren. Past decisions, discovered patterns, and project context are searchable across sessions. Use this to avoid repeating mistakes.",
    "",
    "## Workflow",
    ...workflowSteps(has),
    "",
    options.environment ?? buildEnvironmentBlock(process.cwd(), options.permissionMode),
    "",
    ...(options.toolNames ? [buildToolSection(options.toolNames, options.mcpServers), ""] : []),
    "## Important",
    "- Be direct and concise. Lead with the answer, not the reasoning.",
    "- Call multiple tools in parallel when they're independent.",
    "- NEVER ask 'should I read the file?' or 'would you like me to...' — just call the tool. If permission is needed, the system will prompt the user automatically. You don't handle permissions.",
    "- Don't describe your plan unless asked. Execute immediately.",
    "- Never write secrets, API keys, or PII to files or findings.",
    "- You ARE phren-agent. You can run `phren` CLI commands via shell to configure yourself.",
  ];

  if (priorSummary) {
    if (typeof priorSummary === "string") {
      parts.push("", `## Last session\n${priorSummary}`);
    } else {
      const meta: string[] = [];
      if (priorSummary.project) meta.push(`project: ${priorSummary.project}`);
      if (priorSummary.endedAt) meta.push(`ended: ${priorSummary.endedAt.slice(0, 16).replace("T", " ")}`);
      const header = meta.length > 0 ? `## Last session (${meta.join(", ")})` : "## Last session";
      parts.push("", `${header}\n${priorSummary.summary}`);
    }
  }

  if (phrenContext) {
    parts.push("", phrenContext);
  }

  if (customCommands && customCommands.length > 0) {
    const lines = customCommands.map((command) =>
      command.description ? `- /${command.name} — ${command.description}` : `- /${command.name}`,
    );
    parts.push("", `## Custom commands\nThe user has defined these slash commands; they expand to instructions you should follow:\n${lines.join("\n")}`);
  }

  return parts.join("\n");
}
