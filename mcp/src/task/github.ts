import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { EXEC_TIMEOUT_MS, phrenErr, phrenOk, type PhrenResult, PhrenError } from "../shared.js";
import { errorMessage, resolveExecCommand } from "../utils.js";
import type { TaskItem } from "../data/tasks.js";

const GITHUB_REPO_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/|\b|$)/;
const GITHUB_ISSUE_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)(?:[?#][^\s]*)?$/;

export interface GithubIssueRef {
  repo?: string;
  issueNumber?: number;
  url?: string;
}

export function parseGithubIssueUrl(url: string): GithubIssueRef | null {
  const trimmed = url.trim();
  const match = trimmed.match(GITHUB_ISSUE_URL);
  if (!match) return null;
  return {
    repo: match[1],
    issueNumber: Number.parseInt(match[2], 10),
    url: match[0],
  };
}

export function extractGithubRepoFromText(content: string): string | undefined {
  const match = content.match(GITHUB_REPO_URL);
  return match?.[1];
}

export function resolveProjectGithubRepo(phrenPath: string, project: string): string | undefined {
  for (const file of ["CLAUDE.md", "summary.md"]) {
    const fullPath = path.join(phrenPath, project, file);
    if (!fs.existsSync(fullPath)) continue;
    const repo = extractGithubRepoFromText(fs.readFileSync(fullPath, "utf8"));
    if (repo) return repo;
  }
  return undefined;
}

export function buildTaskIssueBody(project: string, item: TaskItem): string {
  const lines = [
    `Imported from phren task for project \`${project}\`.`,
    "",
    `Task item: ${item.line}`,
  ];
  if (item.context) {
    lines.push("", `Context: ${item.context}`);
  }
  if (item.stableId) {
    lines.push("", `Task ID: \`bid:${item.stableId}\``);
  }
  return lines.join("\n");
}

export function createGithubIssueForTask(args: {
  repo: string;
  title: string;
  body: string;
}): PhrenResult<{ repo: string; issueNumber?: number; url: string }> {
  try {
    const ghExec = resolveExecCommand("gh");
    const stdout = execFileSync(ghExec.command, [
      "issue",
      "create",
      "--repo",
      args.repo,
      "--title",
      args.title,
      "--body",
      args.body,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: ghExec.shell,
      timeout: EXEC_TIMEOUT_MS,
    }).trim();

    const parsed = parseGithubIssueUrl(stdout);
    return phrenOk({
      repo: args.repo,
      issueNumber: parsed?.issueNumber,
      url: parsed?.url || stdout,
    });
  } catch (err: unknown) {
    return phrenErr(
      `Could not create GitHub issue. Ensure GitHub CLI is installed and authenticated: ${errorMessage(err)}`,
      PhrenError.NETWORK_ERROR,
    );
  }
}
