import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { z } from "zod";
import {
  ForgeError,
  listAcross,
  parseRepoForProject,
  providerFor,
  repoForProject,
  type Issue,
  type IssueEdit,
  type IssueQuery,
  type IssueRef,
  type RepoRef,
} from "../forge/issues.js";
import { getProjectDirs } from "../phren-paths.js";
import { type McpContext, mcpResponse } from "./types.js";

/** Both repo and project left out, or a project with no issue repository. */
class IssueInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueInputError";
  }
}

function failure(error: unknown) {
  if (error instanceof ForgeError) {
    return mcpResponse({ ok: false, error: error.message, errorCode: error.code.toUpperCase().replace(/-/g, "_") });
  }
  if (error instanceof IssueInputError) {
    return mcpResponse({ ok: false, error: error.message, errorCode: "INVALID_ARGUMENT" });
  }
  throw error;
}

async function resolveRepo(ctx: McpContext, input: { repo?: string; project?: string }): Promise<RepoRef> {
  if (input.repo) return parseRepoForProject(input.repo, input.project, ctx.phrenPath);
  if (!input.project) throw new IssueInputError("Provide repo or project.");
  const repo = await repoForProject(input.project, ctx.phrenPath);
  if (!repo) throw new IssueInputError(`No issue repository for project "${input.project}". Set issues: in its phren.project.yaml or pass repo.`);
  return repo;
}

/** Every project with a resolvable issue repository, the same default the Hook uses. */
async function projectRepos(ctx: McpContext): Promise<RepoRef[]> {
  const repos = new Set<RepoRef>();
  for (const directory of getProjectDirs(ctx.phrenPath)) {
    const repo = await repoForProject(path.basename(directory), ctx.phrenPath).catch(() => undefined);
    if (repo) repos.add(repo);
  }
  return [...repos];
}

function issueLine(issue: Issue): string {
  const assignees = issue.assignees.length ? ` @${issue.assignees.join(", @")}` : "";
  const computer = issue.claimedBy?.computer ? ` working-on:${issue.claimedBy.computer}` : "";
  const labels = issue.labels.filter(label => !label.toLowerCase().startsWith("working-on:"));
  return `${issue.repo}#${issue.number} ${issue.state}${assignees}${computer}${labels.length ? ` [${labels.join(", ")}]` : ""} — ${issue.title}`;
}

function issueMessage(issue: Issue): string {
  const lines = [`## ${issue.repo}#${issue.number} ${issue.title}`, `${issue.state} · ${issue.url}`];
  if (issue.labels.length) lines.push(`labels: ${issue.labels.join(", ")}`);
  if (issue.assignees.length) lines.push(`assignees: ${issue.assignees.join(", ")}`);
  if (issue.claimedBy?.computer) lines.push(`claim: ${issue.claimedBy.computer}`);
  lines.push(`created ${issue.createdAt || "-"} · updated ${issue.updatedAt || "-"}`);
  if (issue.checklist.length) {
    lines.push("", "checklist:", ...issue.checklist.map((item, index) => `${index + 1}. [${item.done ? "x" : " "}] ${item.text}`));
  }
  if (issue.body.trim()) lines.push("", issue.body);
  return lines.join("\n");
}

const repoField = z.string().optional().describe("Repository: owner/name, domain/owner/name, or a URL. Omit when project is given.");
const projectField = z.string().optional().describe("Phren project whose issue repository to use: its issues: setting, else its checkout's origin.");
const numberField = z.number().int().min(1).describe("Issue number.");

const issueRefShape = {
  repo: repoField,
  project: projectField,
  number: numberField,
};

const checklistShape = z.array(z.object({
  text: z.string().describe("The step."),
  done: z.boolean().optional().describe("Whether the step is complete (default false)."),
}).strict()).describe("The issue's complete checklist; it replaces the managed block in the body. Pass the current items plus your changes.");

export function register(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "list_issues",
    {
      title: "◆ phren · issues",
      description: "List forge issues (GitHub or gitboy) for one or more repositories, or for a project. Defaults to open issues, 50 results (max 200), newest update first. A repository that is unreachable is reported in errors while the others still return.",
      inputSchema: z.object({
        repos: z.array(z.string()).optional().describe("Repository references: owner/name, domain/owner/name, or a URL. Omit to use project, or every project with a resolvable repository."),
        project: projectField,
        state: z.enum(["open", "closed", "all"]).optional().describe("Which issues to include (default open)."),
        assignee: z.string().optional().describe("Only issues assigned to this user; me means the signed-in forge user."),
        label: z.string().optional().describe("Only issues with this label."),
        search: z.string().optional().describe("Only issues whose title or body contains this text."),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum issues to return (default 50, max 200)."),
      }),
    },
    async input => {
      try {
        let repos: RepoRef[];
        if (input.repos?.length) {
          repos = await Promise.all(input.repos.map(repo => parseRepoForProject(repo, input.project, ctx.phrenPath)));
          repos = [...new Set(repos)];
        } else if (input.project) {
          repos = [await resolveRepo(ctx, { project: input.project })];
        } else {
          repos = await projectRepos(ctx);
          if (!repos.length) throw new IssueInputError("No project has an issue repository. Pass repos.");
        }
        const query: IssueQuery = {
          repos,
          state: input.state ?? "open",
          ...(input.assignee ? { assignee: input.assignee } : {}),
          ...(input.label ? { label: input.label } : {}),
          ...(input.search ? { search: input.search } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        };
        const { issues, errors } = await listAcross(query);
        const lines = issues.length ? issues.map(issueLine) : ["No issues."];
        for (const error of errors) lines.push(`! ${error.repo}: ${error.error}`);
        return mcpResponse({
          ok: true,
          message: lines.join("\n"),
          data: { repos, issues, errors },
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_issue",
    {
      title: "◆ phren · issue",
      description: "Read one forge issue by number: title, body, state, labels, assignees, claim and parsed checklist.",
      inputSchema: z.object(issueRefShape),
    },
    async input => {
      try {
        const ref: IssueRef = { repo: await resolveRepo(ctx, input), number: input.number };
        const issue = await providerFor(ref.repo).get(ref);
        return mcpResponse({ ok: true, message: issueMessage(issue), data: issue });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "create_issue",
    {
      title: "◆ phren · create issue",
      description: "Open a forge issue. A checklist becomes the managed block in the body; the rest of the body is kept as written.",
      inputSchema: z.object({
        repo: repoField,
        project: projectField,
        title: z.string().min(1).describe("Issue title."),
        body: z.string().optional().describe("Markdown body."),
        checklist: z.array(z.string()).optional().describe("Steps to add as an unchecked checklist."),
        labels: z.array(z.string()).optional().describe("Labels to set; missing labels are created."),
      }),
    },
    async input => {
      try {
        const repo = await resolveRepo(ctx, input);
        const issue = await providerFor(repo).create({
          repo,
          title: input.title,
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.checklist?.length ? { checklist: input.checklist } : {}),
          ...(input.labels?.length ? { labels: input.labels } : {}),
        });
        return mcpResponse({ ok: true, message: issueMessage(issue), data: issue });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "update_issue",
    {
      title: "◆ phren · update issue",
      description: "Change an issue's title, body, checklist, labels or state. checklist replaces the managed block in the body; pass the complete list. add_labels and remove_labels change individual labels (a working-on:<computer> label is how a claim is shown; use claim_issue for that).",
      inputSchema: z.object({
        ...issueRefShape,
        title: z.string().optional().describe("New title."),
        body: z.string().optional().describe("New Markdown body (the checklist block is rewritten inside it when checklist is also given)."),
        checklist: checklistShape.optional(),
        add_labels: z.array(z.string()).optional().describe("Labels to add."),
        remove_labels: z.array(z.string()).optional().describe("Labels to remove."),
        state: z.enum(["open", "closed"]).optional().describe("Reopen or close the issue."),
      }),
    },
    async input => {
      try {
        const ref: IssueRef = { repo: await resolveRepo(ctx, input), number: input.number };
        const edit: IssueEdit = {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.checklist ? { checklist: input.checklist.map(item => ({ text: item.text, done: item.done ?? false })) } : {}),
          ...(input.add_labels?.length ? { addLabels: input.add_labels } : {}),
          ...(input.remove_labels?.length ? { removeLabels: input.remove_labels } : {}),
          ...(input.state !== undefined ? { state: input.state } : {}),
        };
        const issue = await providerFor(ref.repo).edit(ref, edit);
        return mcpResponse({ ok: true, message: issueMessage(issue), data: issue });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "claim_issue",
    {
      title: "◆ phren · claim issue",
      description: "Assign an issue to the signed-in forge user and label it working-on:<this computer> if another computer has no claim. release undoes both for this computer. The claim is verified with a fresh read.",
      inputSchema: z.object({
        ...issueRefShape,
        release: z.boolean().optional().describe("Release this computer's claim instead of taking one."),
      }),
    },
    async input => {
      try {
        const ref: IssueRef = { repo: await resolveRepo(ctx, input), number: input.number };
        const { computerDisplayName } = await import("../bridge/pair.js");
        const computer = await computerDisplayName();
        const issue = await providerFor(ref.repo).claim(ref, computer, input.release === true);
        return mcpResponse({ ok: true, message: issueMessage(issue), data: issue });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "comment_issue",
    {
      title: "◆ phren · comment on issue",
      description: "Post one comment on an issue and return its URL.",
      inputSchema: z.object({
        ...issueRefShape,
        body: z.string().min(1).describe("Comment text (Markdown)."),
      }),
    },
    async input => {
      try {
        const ref: IssueRef = { repo: await resolveRepo(ctx, input), number: input.number };
        const result = await providerFor(ref.repo).comment(ref, input.body);
        return mcpResponse({ ok: true, message: `Commented on ${ref.repo}#${ref.number}: ${result.url}`, data: result });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "close_issue",
    {
      title: "◆ phren · close issue",
      description: "Close an issue, optionally posting one comment first.",
      inputSchema: z.object({
        ...issueRefShape,
        comment: z.string().optional().describe("Comment to post as the issue closes."),
      }),
    },
    async input => {
      try {
        const ref: IssueRef = { repo: await resolveRepo(ctx, input), number: input.number };
        const issue = await providerFor(ref.repo).close(ref, input.comment);
        return mcpResponse({ ok: true, message: issueMessage(issue), data: issue });
      } catch (error) {
        return failure(error);
      }
    },
  );
}
