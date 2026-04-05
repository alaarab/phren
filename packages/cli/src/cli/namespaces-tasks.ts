import { getPhrenPath } from "../shared.js";
import { addTask, completeTask, updateTask, reorderTask, pinTask, removeTask, workNextTask, tidyDoneTasks, linkTaskIssue, promoteTask, resolveTaskItem } from "../data/tasks.js";
import { buildTaskIssueBody, createGithubIssueForTask, parseGithubIssueUrl, resolveProjectGithubRepo } from "../task/github.js";

function printTaskUsage() {
  console.log("Usage:");
  console.log('  phren task add <project> "<text>"');
  console.log('  phren task complete <project> "<text>"');
  console.log('  phren task remove <project> "<text>"');
  console.log('  phren task next [project]');
  console.log('  phren task promote <project> "<text>" [--active]');
  console.log('  phren task tidy [project] [--keep=<n>] [--dry-run]');
  console.log('  phren task link <project> "<text>" --issue <number> [--url <url>]');
  console.log('  phren task link <project> "<text>" --unlink');
  console.log('  phren task create-issue <project> "<text>" [--repo <owner/name>] [--title "<title>"] [--done]');
  console.log('  phren task update <project> "<text>" [--priority=high|medium|low] [--section=Active|Queue|Done] [--context="..."]');
  console.log('  phren task pin <project> "<text>"');
  console.log('  phren task reorder <project> "<text>" --rank=<n>');
}

export async function handleTaskNamespace(args: string[]) {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printTaskUsage();
    return;
  }

  if (subcommand === "list") {
    // Delegate to the cross-project task view (same as `phren tasks`)
    const { handleTaskView } = await import("./ops.js");
    return handleTaskView(args[1] || "default");
  }

  if (subcommand === "add") {
    const project = args[1];
    const text = args.slice(2).join(" ");
    if (!project || !text) {
      console.error('Usage: phren task add <project> "<text>"');
      process.exit(1);
    }
    const result = addTask(getPhrenPath(), project, text);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`Task added: ${result.data.line}`);
    return;
  }

  if (subcommand === "complete") {
    const project = args[1];
    const match = args.slice(2).join(" ");
    if (!project || !match) {
      console.error('Usage: phren task complete <project> "<text>"');
      process.exit(1);
    }
    const result = completeTask(getPhrenPath(), project, match);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(result.data);
    return;
  }

  if (subcommand === "update") {
    const project = args[1];
    if (!project) {
      printTaskUsage();
      process.exit(1);
    }
    // Collect non-flag args as the match text, flags as updates
    const positional: string[] = [];
    const updates: { priority?: string; context?: string; section?: string } = {};
    for (const arg of args.slice(2)) {
      if (arg.startsWith("--priority=")) {
        updates.priority = arg.slice("--priority=".length);
      } else if (arg.startsWith("--section=")) {
        updates.section = arg.slice("--section=".length);
      } else if (arg.startsWith("--context=")) {
        updates.context = arg.slice("--context=".length);
      } else if (!arg.startsWith("--")) {
        positional.push(arg);
      }
    }
    const match = positional.join(" ");
    if (!match) {
      printTaskUsage();
      process.exit(1);
    }
    const result = updateTask(getPhrenPath(), project, match, updates);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(result.data);
    return;
  }

  if (subcommand === "pin") {
    const project = args[1];
    const match = args.slice(2).join(" ");
    if (!project || !match) {
      console.error('Usage: phren task pin <project> "<text>"');
      process.exit(1);
    }
    const result = pinTask(getPhrenPath(), project, match);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(result.data);
    return;
  }

  if (subcommand === "reorder") {
    const project = args[1];
    if (!project) {
      printTaskUsage();
      process.exit(1);
    }
    const positional: string[] = [];
    let rankArg: string | undefined;
    for (const arg of args.slice(2)) {
      if (arg.startsWith("--rank=")) {
        rankArg = arg.slice("--rank=".length);
      } else if (!arg.startsWith("--")) {
        positional.push(arg);
      }
    }
    const match = positional.join(" ");
    const rank = rankArg ? Number.parseInt(rankArg, 10) : Number.NaN;
    if (!match || !rankArg || !Number.isFinite(rank) || rank < 1) {
      console.error('Usage: phren task reorder <project> "<text>" --rank=<n>');
      process.exit(1);
    }
    const result = reorderTask(getPhrenPath(), project, match, rank);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(result.data);
    return;
  }

  if (subcommand === "remove") {
    const project = args[1];
    const match = args.slice(2).join(" ");
    if (!project || !match) {
      console.error('Usage: phren task remove <project> "<text>"');
      process.exit(1);
    }
    const result = removeTask(getPhrenPath(), project, match);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(result.data);
    return;
  }

  if (subcommand === "next") {
    const project = args[1];
    if (!project) {
      console.error("Usage: phren task next <project>");
      process.exit(1);
    }
    const result = workNextTask(getPhrenPath(), project);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(result.data);
    return;
  }

  if (subcommand === "promote") {
    const project = args[1];
    if (!project) {
      printTaskUsage();
      process.exit(1);
    }
    const positional: string[] = [];
    let moveToActive = false;
    for (const arg of args.slice(2)) {
      if (arg === "--active") {
        moveToActive = true;
      } else if (!arg.startsWith("--")) {
        positional.push(arg);
      }
    }
    const match = positional.join(" ");
    if (!match) {
      console.error('Usage: phren task promote <project> "<text>" [--active]');
      process.exit(1);
    }
    const result = promoteTask(getPhrenPath(), project, match, moveToActive);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`Promoted task "${result.data.line}" in ${project}${moveToActive ? " (moved to Active)" : ""}.`);
    return;
  }

  if (subcommand === "tidy") {
    const project = args[1];
    if (!project) {
      console.error("Usage: phren task tidy <project> [--keep=<n>] [--dry-run]");
      process.exit(1);
    }
    let keep = 30;
    let dryRun = false;
    for (const arg of args.slice(2)) {
      if (arg.startsWith("--keep=")) {
        const n = Number.parseInt(arg.slice("--keep=".length), 10);
        if (Number.isFinite(n) && n > 0) keep = n;
      } else if (arg === "--dry-run") {
        dryRun = true;
      }
    }
    const result = tidyDoneTasks(getPhrenPath(), project, keep, dryRun);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(result.data);
    return;
  }

  if (subcommand === "link") {
    const project = args[1];
    if (!project) {
      printTaskUsage();
      process.exit(1);
    }
    const positional: string[] = [];
    let issueArg: string | undefined;
    let urlArg: string | undefined;
    let unlink = false;
    const rest = args.slice(2);
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--issue" || arg === "-i") {
        issueArg = rest[++i];
      } else if (arg.startsWith("--issue=")) {
        issueArg = arg.slice("--issue=".length);
      } else if (arg === "--url") {
        urlArg = rest[++i];
      } else if (arg.startsWith("--url=")) {
        urlArg = arg.slice("--url=".length);
      } else if (arg === "--unlink") {
        unlink = true;
      } else if (!arg.startsWith("--")) {
        positional.push(arg);
      }
    }
    const match = positional.join(" ");
    if (!match) {
      console.error('Usage: phren task link <project> "<text>" --issue <number>');
      process.exit(1);
    }
    if (!unlink && !issueArg && !urlArg) {
      console.error("Provide --issue <number> or --url <url> to link, or --unlink to remove the link.");
      process.exit(1);
    }
    if (urlArg) {
      const parsed = parseGithubIssueUrl(urlArg);
      if (!parsed) {
        console.error("--url must be a valid GitHub issue URL.");
        process.exit(1);
      }
    }
    const result = linkTaskIssue(getPhrenPath(), project, match, {
      github_issue: issueArg,
      github_url: urlArg,
      unlink: unlink,
    });
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    if (unlink) {
      console.log(`Removed GitHub link from ${project} task.`);
    } else {
      console.log(`Linked ${project} task to ${result.data.githubIssue ? `#${result.data.githubIssue}` : result.data.githubUrl}.`);
    }
    return;
  }

  if (subcommand === "create-issue") {
    const project = args[1];
    if (!project) {
      printTaskUsage();
      process.exit(1);
    }
    const positional: string[] = [];
    let repoArg: string | undefined;
    let titleArg: string | undefined;
    let markDone = false;
    const rest = args.slice(2);
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--repo") {
        repoArg = rest[++i];
      } else if (arg.startsWith("--repo=")) {
        repoArg = arg.slice("--repo=".length);
      } else if (arg === "--title") {
        titleArg = rest[++i];
      } else if (arg.startsWith("--title=")) {
        titleArg = arg.slice("--title=".length);
      } else if (arg === "--done") {
        markDone = true;
      } else if (!arg.startsWith("--")) {
        positional.push(arg);
      }
    }
    const match = positional.join(" ");
    if (!match) {
      console.error('Usage: phren task create-issue <project> "<text>" [--repo <owner/name>] [--title "<title>"] [--done]');
      process.exit(1);
    }
    const phrenPath = getPhrenPath();
    const resolved = resolveTaskItem(phrenPath, project, match);
    if (!resolved.ok) {
      console.error(resolved.error);
      process.exit(1);
    }
    const targetRepo = repoArg || resolveProjectGithubRepo(phrenPath, project);
    if (!targetRepo) {
      console.error("Could not infer a GitHub repo. Provide --repo <owner/name> or add a GitHub URL to CLAUDE.md/summary.md.");
      process.exit(1);
    }
    const created = createGithubIssueForTask({
      repo: targetRepo,
      title: titleArg?.trim() || resolved.data.line.replace(/\s*\[(high|medium|low)\]\s*$/i, "").trim(),
      body: buildTaskIssueBody(project, resolved.data),
    });
    if (!created.ok) {
      console.error(created.error);
      process.exit(1);
    }
    const linked = linkTaskIssue(phrenPath, project, resolved.data.stableId ? `bid:${resolved.data.stableId}` : resolved.data.id, {
      github_issue: created.data.issueNumber,
      github_url: created.data.url,
    });
    if (!linked.ok) {
      console.error(linked.error);
      process.exit(1);
    }
    if (markDone) {
      const completionMatch = linked.data.stableId ? `bid:${linked.data.stableId}` : linked.data.id;
      const completed = completeTask(phrenPath, project, completionMatch);
      if (!completed.ok) {
        console.error(completed.error);
        process.exit(1);
      }
    }
    console.log(`Created GitHub issue ${created.data.issueNumber ? `#${created.data.issueNumber}` : created.data.url} for ${project} task.`);
    return;
  }

  console.error(`Unknown task subcommand: ${subcommand}`);
  printTaskUsage();
  process.exit(1);
}
