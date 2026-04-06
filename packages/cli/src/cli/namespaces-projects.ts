import * as fs from "fs";
import * as path from "path";
import {
  expandHomePath,
  findArchivedProjectNameCaseInsensitive,
  findProjectNameCaseInsensitive,
  getPhrenPath,
  getProjectDirs,
  normalizeProjectNameForCreate,
  readRootManifest,
} from "../shared.js";
import { isValidProjectName, errorMessage } from "../utils.js";
import { logger } from "../logger.js";
import { TASK_FILE_ALIASES } from "../data/tasks.js";
import { FINDINGS_FILENAME } from "../data/access.js";
import {
  PROJECT_OWNERSHIP_MODES,
  parseProjectOwnershipMode,
  writeProjectConfig,
  writeProjectHookConfig,
} from "../project-config.js";
import { resolveProjectStorePath, parseMcpToggle } from "./namespaces-utils.js";

export async function handleProjectsNamespace(args: string[], profile: string) {
  const subcommand = args[0];

  if (!subcommand || subcommand === "list" || subcommand === "--help" || subcommand === "-h") {
    if (subcommand === "--help" || subcommand === "-h") {
      console.log("Usage:");
      console.log("  phren projects list               List all projects");
      console.log("  phren projects configure <name>   Update per-project enrollment settings");
      console.log("    flags: --ownership=<mode> --hooks=on|off");
      console.log("  phren projects remove <name>      Remove a project (asks for confirmation)");
      console.log("  phren projects export <name>      Export project data as JSON to stdout");
      console.log("  phren projects import <file>      Import project from a JSON file");
      console.log("  phren projects archive <name>     Archive a project (removes from active index)");
      console.log("  phren projects unarchive <name>   Restore an archived project");
      return;
    }
    return handleProjectsList(profile);
  }

  if (subcommand === "add") {
    console.error("`phren projects add` has been removed from the supported workflow.");
    console.error("Use `cd ~/your-project && phren add` so enrollment stays path-based.");
    process.exit(1);
  }

  if (subcommand === "remove") {
    const manifest = readRootManifest(getPhrenPath());
    if (manifest?.installMode === "project-local") {
      console.error("projects remove is unsupported in project-local mode. Use `phren uninstall`.");
      process.exit(1);
    }
    const name = args[1];
    if (!name) {
      console.error("Usage: phren projects remove <name>");
      process.exit(1);
    }
    return handleProjectsRemove(name, profile);
  }

  if (subcommand === "configure") {
    const name = args[1];
    if (!name) {
      console.error(`Usage: phren projects configure <name> [--ownership=${PROJECT_OWNERSHIP_MODES.join("|")}] [--hooks=on|off]`);
      process.exit(1);
    }
    if (!isValidProjectName(name)) {
      console.error(`Invalid project name: "${name}".`);
      process.exit(1);
    }
    if (!fs.existsSync(path.join(getPhrenPath(), name))) {
      console.error(`Project "${name}" not found.`);
      process.exit(1);
    }
    const ownershipArg = args.find((arg) => arg.startsWith("--ownership="))?.slice("--ownership=".length);
    const hooksArg = args.find((arg) => arg.startsWith("--hooks="))?.slice("--hooks=".length);
    const ownership = ownershipArg ? parseProjectOwnershipMode(ownershipArg) : undefined;
    const hooksEnabled = parseMcpToggle(hooksArg);
    if (!ownershipArg && hooksArg === undefined) {
      console.error(`Usage: phren projects configure <name> [--ownership=${PROJECT_OWNERSHIP_MODES.join("|")}] [--hooks=on|off]`);
      process.exit(1);
    }
    if (ownershipArg && !ownership) {
      console.error(`Usage: phren projects configure <name> [--ownership=${PROJECT_OWNERSHIP_MODES.join("|")}] [--hooks=on|off]`);
      process.exit(1);
    }
    if (hooksArg !== undefined && hooksEnabled === undefined) {
      console.error(`Invalid --hooks value "${hooksArg}". Use on or off.`);
      process.exit(1);
    }

    const updates: string[] = [];
    if (ownership) {
      writeProjectConfig(getPhrenPath(), name, { ownership });
      updates.push(`ownership=${ownership}`);
    }
    if (hooksEnabled !== undefined) {
      writeProjectHookConfig(getPhrenPath(), name, { enabled: hooksEnabled });
      updates.push(`hooks=${hooksEnabled ? "on" : "off"}`);
    }
    console.log(`Updated ${name}: ${updates.join(", ")}`);
    return;
  }

  if (subcommand === "export") {
    const name = args[1];
    if (!name) {
      console.error("Usage: phren projects export <name>");
      process.exit(1);
    }
    if (!isValidProjectName(name)) {
      console.error(`Invalid project name: "${name}".`);
      process.exit(1);
    }
    const phrenPath = getPhrenPath();
    const storePath = resolveProjectStorePath(phrenPath, name);
    const projectDir = path.join(storePath, name);
    if (!fs.existsSync(projectDir)) {
      console.error(`Project "${name}" not found.`);
      process.exit(1);
    }
    const { readFindings, readTasks, resolveTaskFilePath } = await import("../data/access.js");
    const exported: Record<string, unknown> = { project: name, exportedAt: new Date().toISOString(), version: 1 };
    const summaryPath = path.join(projectDir, "summary.md");
    if (fs.existsSync(summaryPath)) exported.summary = fs.readFileSync(summaryPath, "utf8");
    const learningsResult = readFindings(storePath, name);
    if (learningsResult.ok) exported.learnings = learningsResult.data;
    const findingsPath = path.join(projectDir, FINDINGS_FILENAME);
    if (fs.existsSync(findingsPath)) exported.findingsRaw = fs.readFileSync(findingsPath, "utf8");
    const taskResult = readTasks(storePath, name);
    if (taskResult.ok) {
      exported.task = taskResult.data.items;
      const taskRawPath = resolveTaskFilePath(storePath, name);
      if (taskRawPath && fs.existsSync(taskRawPath)) exported.taskRaw = fs.readFileSync(taskRawPath, "utf8");
    }
    const claudePath = path.join(projectDir, "CLAUDE.md");
    if (fs.existsSync(claudePath)) exported.claudeMd = fs.readFileSync(claudePath, "utf8");
    process.stdout.write(JSON.stringify(exported, null, 2) + "\n");
    return;
  }

  if (subcommand === "import") {
    const filePath = args[1];
    if (!filePath) {
      console.error("Usage: phren projects import <file>");
      process.exit(1);
    }
    const resolvedPath = path.resolve(expandHomePath(filePath));
    if (!fs.existsSync(resolvedPath)) {
      console.error(`File not found: ${resolvedPath}`);
      process.exit(1);
    }
    let rawData: string;
    try {
      rawData = fs.readFileSync(resolvedPath, "utf8");
    } catch (err: unknown) {
      console.error(`Failed to read file: ${errorMessage(err)}`);
      process.exit(1);
    }
    let decoded: Record<string, unknown>;
    try {
      decoded = JSON.parse(rawData);
    } catch {
      console.error("Invalid JSON in file.");
      process.exit(1);
    }
    if (!decoded || typeof decoded !== "object" || !decoded.project) {
      console.error("Invalid import payload: missing project field.");
      process.exit(1);
    }
    const { TASKS_FILENAME } = await import("../data/access.js");
    const phrenPath = getPhrenPath();
    const projectName = normalizeProjectNameForCreate(String(decoded.project));
    if (!isValidProjectName(projectName)) {
      console.error(`Invalid project name: "${decoded.project}".`);
      process.exit(1);
    }
    const existingProject = findProjectNameCaseInsensitive(phrenPath, projectName);
    if (existingProject && existingProject !== projectName) {
      console.error(`Project "${existingProject}" already exists with different casing. Refusing to import "${projectName}".`);
      process.exit(1);
    }
    const projectDir = path.join(phrenPath, projectName);
    if (fs.existsSync(projectDir)) {
      console.error(`Project "${projectName}" already exists. Remove it first or use the MCP tool with overwrite:true.`);
      process.exit(1);
    }
    const imported: string[] = [];
    const stagingRoot = fs.mkdtempSync(path.join(phrenPath, `.phren-import-${projectName}-`));
    const stagedProjectDir = path.join(stagingRoot, projectName);
    try {
      fs.mkdirSync(stagedProjectDir, { recursive: true });
      if (typeof decoded.summary === "string") {
        fs.writeFileSync(path.join(stagedProjectDir, "summary.md"), decoded.summary);
        imported.push("summary.md");
      }
      if (typeof decoded.claudeMd === "string") {
        fs.writeFileSync(path.join(stagedProjectDir, "CLAUDE.md"), decoded.claudeMd);
        imported.push("CLAUDE.md");
      }
      if (typeof decoded.findingsRaw === "string") {
        fs.writeFileSync(path.join(stagedProjectDir, FINDINGS_FILENAME), decoded.findingsRaw);
        imported.push(FINDINGS_FILENAME);
      } else if (Array.isArray(decoded.learnings) && decoded.learnings.length > 0) {
        const date = new Date().toISOString().slice(0, 10);
        const lines = [`# ${projectName} Findings`, "", `## ${date}`, ""];
        for (const item of decoded.learnings as Array<{ text: string }>) {
          if (item.text) lines.push(`- ${item.text}`);
        }
        lines.push("");
        fs.writeFileSync(path.join(stagedProjectDir, FINDINGS_FILENAME), lines.join("\n"));
        imported.push(FINDINGS_FILENAME);
      }
      if (typeof decoded.taskRaw === "string") {
        fs.writeFileSync(path.join(stagedProjectDir, TASKS_FILENAME), decoded.taskRaw);
        imported.push(TASKS_FILENAME);
      }
      fs.renameSync(stagedProjectDir, projectDir);
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      console.log(`Imported project "${projectName}": ${imported.join(", ") || "(no files)"}`);
    } catch (err: unknown) {
      try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
      console.error(`Import failed: ${errorMessage(err)}`);
      process.exit(1);
    }
    return;
  }

  if (subcommand === "archive" || subcommand === "unarchive") {
    const name = args[1];
    if (!name) {
      console.error(`Usage: phren projects ${subcommand} <name>`);
      process.exit(1);
    }
    if (!isValidProjectName(name)) {
      console.error(`Invalid project name: "${name}".`);
      process.exit(1);
    }
    const phrenPath = getPhrenPath();
    if (subcommand === "archive") {
      const activeProject = findProjectNameCaseInsensitive(phrenPath, name);
      const storePath = resolveProjectStorePath(phrenPath, activeProject ?? name);
      const projectDir = activeProject ? path.join(storePath, activeProject) : path.join(storePath, name);
      const archiveDir = path.join(storePath, `${activeProject ?? name}.archived`);
      if (!fs.existsSync(projectDir)) {
        console.error(`Project "${name}" not found.`);
        process.exit(1);
      }
      if (fs.existsSync(archiveDir)) {
        console.error(`Archive "${name}.archived" already exists. Unarchive or remove it first.`);
        process.exit(1);
      }
      try {
        fs.renameSync(projectDir, archiveDir);
        console.log(`Archived project "${name}". Data preserved at ${archiveDir}.`);
        console.log("Note: the search index will be updated on next search.");
      } catch (err: unknown) {
        console.error(`Archive failed: ${errorMessage(err)}`);
        process.exit(1);
      }
    } else {
      const activeProject = findProjectNameCaseInsensitive(phrenPath, name);
      if (activeProject) {
        console.error(`Project "${activeProject}" already exists as an active project.`);
        process.exit(1);
      }
      const archivedProject = findArchivedProjectNameCaseInsensitive(phrenPath, name);
      const storePath = resolveProjectStorePath(phrenPath, archivedProject ?? name);
      const projectDir = path.join(storePath, archivedProject ?? name);
      const archiveDir = path.join(storePath, `${archivedProject ?? name}.archived`);
      if (!fs.existsSync(archiveDir)) {
        const available = fs.readdirSync(phrenPath)
          .filter((e) => e.endsWith(".archived"))
          .map((e) => e.replace(/\.archived$/, ""));
        if (available.length > 0) {
          console.error(`No archive found for "${name}". Available archives: ${available.join(", ")}`);
        } else {
          console.error(`No archive found for "${name}".`);
        }
        process.exit(1);
      }
      try {
        fs.renameSync(archiveDir, projectDir);
        console.log(`Unarchived project "${archivedProject ?? name}". It is now active again.`);
        console.log("Note: the search index will be updated on next search.");
      } catch (err: unknown) {
        console.error(`Unarchive failed: ${errorMessage(err)}`);
        process.exit(1);
      }
    }
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  console.error("Usage: phren projects [list|configure|remove|export|import|archive|unarchive]");
  process.exit(1);
}

function handleProjectsList(profile: string) {
  const phrenPath = getPhrenPath();
  const projectDirs = getProjectDirs(phrenPath, profile);
  const projects = projectDirs
    .map((dir) => path.basename(dir))
    .filter((name) => name !== "global")
    .sort();

  if (!projects.length) {
    console.log("No projects found. Run: cd ~/your-project && phren add");
    return;
  }

  console.log(`\nProjects in ${phrenPath}:\n`);
  for (const name of projects) {
    const projectDir = path.join(phrenPath, name);
    let dirFiles: Set<string>;
    try {
      dirFiles = new Set(fs.readdirSync(projectDir));
    } catch (err: unknown) {
      if ((process.env.PHREN_DEBUG)) logger.debug("cli-namespaces", `projects list readdir: ${errorMessage(err)}`);
      dirFiles = new Set();
    }
    const tags: string[] = [];
    if (dirFiles.has(FINDINGS_FILENAME)) tags.push("findings");
    if (TASK_FILE_ALIASES.some((filename) => dirFiles.has(filename))) tags.push("tasks");
    const tagStr = tags.length ? `  [${tags.join(", ")}]` : "";
    console.log(`  ${name}${tagStr}`);
  }
  console.log(`\n${projects.length} project(s) total.`);
  console.log("Add another project: cd ~/your-project && phren add");
}

async function handleProjectsRemove(name: string, profile: string) {
  if (!isValidProjectName(name)) {
    console.error(`Invalid project name: "${name}".`);
    process.exit(1);
  }
  if (name === "global") {
    console.error('Cannot remove the "global" project.');
    process.exit(1);
  }

  const phrenPath = getPhrenPath();
  const projectDir = path.join(phrenPath, name);

  if (!fs.existsSync(projectDir)) {
    console.error(`Project "${name}" not found at ${projectDir}`);
    process.exit(1);
  }

  let fileCount = 0;
  const countFiles = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) countFiles(path.join(dir, entry.name));
      else fileCount++;
    }
  };
  try {
    countFiles(projectDir);
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG)) logger.debug("cli-namespaces", `projects remove countFiles: ${errorMessage(err)}`);
  }

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `Remove project "${name}" (${fileCount} file${fileCount === 1 ? "" : "s"})? This cannot be undone. Type the project name to confirm: `,
      (input) => { rl.close(); resolve(input.trim()); }
    );
  });

  if (answer !== name) {
    console.log("Aborted.");
    return;
  }

  fs.rmSync(projectDir, { recursive: true, force: true });
  console.log(`Removed project "${name}".`);
  console.log(`If this project was in a profile, remove it from profiles/${profile || "personal"}.yaml manually.`);
}
