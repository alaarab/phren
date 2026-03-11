import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  EXEC_TIMEOUT_MS,
  findProjectNameCaseInsensitive,
  getCortexPath,
  normalizeProjectNameForCreate,
} from "./shared.js";
import { isValidProjectName, errorMessage } from "./utils.js";
import { readTasksAcrossProjects, TASKS_FILENAME } from "./data-access.js";
import { buildIndex, queryRows } from "./shared-index.js";
import { resolveSubprocessArgs } from "./cli-hooks.js";

export function handleTaskView(profile: string) {
  const docs = readTasksAcrossProjects(getCortexPath(), profile);
  if (!docs.length) {
    console.log("No tasks found.");
    return;
  }

  let totalActive = 0;
  let totalQueue = 0;

  for (const doc of docs) {
    const activeCount = doc.items.Active.length;
    const queueCount = doc.items.Queue.length;
    if (activeCount === 0 && queueCount === 0) continue;

    totalActive += activeCount;
    totalQueue += queueCount;

    console.log(`\n## ${doc.project}`);
    if (activeCount > 0) {
      console.log("  Active:");
      for (const item of doc.items.Active) {
        const tag = item.priority ? ` [${item.priority}]` : "";
        const github = item.githubIssue ? ` [gh:#${item.githubIssue}]` : item.githubUrl ? " [gh]" : "";
        console.log(`    - ${item.line}${tag}${github}`);
      }
    }
    if (queueCount > 0) {
      console.log("  Queue:");
      for (const item of doc.items.Queue) {
        const tag = item.priority ? ` [${item.priority}]` : "";
        const github = item.githubIssue ? ` [gh:#${item.githubIssue}]` : item.githubUrl ? " [gh]" : "";
        console.log(`    - ${item.line}${tag}${github}`);
      }
    }
  }

  if (totalActive === 0 && totalQueue === 0) {
    console.log("All tasks are empty.");
    return;
  }

  console.log(`\n${totalActive} active, ${totalQueue} queued across ${docs.length} project(s).`);
}

export async function handleQuickstart() {
  const { runInit } = await import("./init.js");
  const { runLink } = await import("./link.js");

  const dirBasename = path.basename(process.cwd());
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const projectName = await new Promise<string>((resolve) => {
    rl.question(`Project name [${dirBasename}]: `, (answer) => {
      rl.close();
      resolve(answer.trim() || dirBasename);
    });
  });

  const normalizedProjectName = normalizeProjectNameForCreate(projectName);
  if (!isValidProjectName(normalizedProjectName)) {
    console.error(`Error: invalid project name "${projectName}". Use lowercase letters, numbers, hyphens, or underscores.`);
    return;
  }

  console.log(`\nInitializing cortex for "${normalizedProjectName}"...\n`);

  await runInit({ yes: true });
  const cortexPath = getCortexPath();
  await runLink(cortexPath, {});

  const existingProject = findProjectNameCaseInsensitive(cortexPath, normalizedProjectName);
  if (existingProject && existingProject !== normalizedProjectName) {
    console.error(
      `Error: project "${existingProject}" already exists with different casing. Refusing to create "${normalizedProjectName}" because it would split the same project on case-sensitive filesystems.`
    );
    return;
  }

  const projectDir = path.join(cortexPath, normalizedProjectName);
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), `# ${normalizedProjectName} Findings\n`);
    fs.writeFileSync(path.join(projectDir, TASKS_FILENAME), `# ${normalizedProjectName} Tasks\n\n## Active\n\n## Queue\n\n## Done\n`);
  }

  console.log(`\n\u2713 cortex ready. Project: ${normalizedProjectName}. Try: cortex search 'your query'`);
}

export async function handleDebugInjection(args: string[], profile: string) {
  let cwd = process.cwd();
  let sessionId = `debug-${Date.now()}`;
  const promptParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--cwd") {
      cwd = args[++i] || cwd;
      continue;
    }
    if (arg === "--session") {
      sessionId = args[++i] || sessionId;
      continue;
    }
    if (arg === "--prompt") {
      promptParts.push(args[++i] || "");
      continue;
    }
    promptParts.push(arg);
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    console.error('Usage: cortex debug-injection --prompt "your prompt here" [--cwd <path>] [--session <id>]');
    process.exit(1);
  }

  const subprocessArgs = resolveSubprocessArgs("hook-prompt");
  if (!subprocessArgs) {
    console.error("Could not resolve cortex entrypoint for debug-injection.");
    process.exit(1);
  }

  const payload = JSON.stringify({
    prompt,
    cwd,
    session_id: sessionId,
  });

  try {
    const out = execFileSync(process.execPath, subprocessArgs, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      input: payload,
      env: {
        ...process.env,
        CORTEX_PATH: getCortexPath(),
        CORTEX_PROFILE: profile,
      },
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    if (!out) {
      console.log("(no context injected)");
      return;
    }
    console.log(out);
  } catch (err: unknown) {
    const stderr = err instanceof Error && "stderr" in err ? String((err as NodeJS.ErrnoException & { stderr?: unknown }).stderr || "").trim() : "";
    if (stderr) console.error(stderr);
    console.error(`debug-injection failed: ${errorMessage(err)}`);
    process.exit(1);
  }
}

export async function handleInspectIndex(args: string[], profile: string) {
  let project: string | undefined;
  let type: string | undefined;
  let limit = 20;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project") {
      project = args[++i];
      continue;
    }
    if (arg === "--type") {
      type = args[++i];
      continue;
    }
    if (arg === "--limit") {
      const parsed = Number.parseInt(args[++i] || "", 10);
      if (!Number.isNaN(parsed) && parsed > 0) limit = Math.min(parsed, 200);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: cortex inspect-index [--project <name>] [--type <doc-type>] [--limit <n>]");
      return;
    }
  }

  const db = await buildIndex(getCortexPath(), profile);
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (project) {
    where.push("project = ?");
    params.push(project);
  }
  if (type) {
    where.push("type = ?");
    params.push(type);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRows = queryRows(db, `SELECT count(*) FROM docs ${whereSql}`, params);
  const total = Number((totalRows?.[0]?.[0] as number | string | undefined) ?? 0);
  console.log(`FTS index docs: ${total}`);
  if (project) console.log(`Project filter: ${project}`);
  if (type) console.log(`Type filter: ${type}`);

  const sample = queryRows(
    db,
    `SELECT project, filename, type, path FROM docs ${whereSql} ORDER BY project, type, filename LIMIT ?`,
    [...params, limit]
  );
  if (!sample || sample.length === 0) {
    console.log("No rows for current filter.");
    return;
  }

  console.log("");
  for (const row of sample) {
    const [proj, filename, docType, filePath] = row as string[];
    console.log(`- ${proj}/${filename} (${docType})`);
    console.log(`  ${filePath}`);
  }
}
