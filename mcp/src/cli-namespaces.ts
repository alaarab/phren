import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  expandHomePath,
  findProjectNameCaseInsensitive,
  getCortexPath,
  getProjectDirs,
  homePath,
  hookConfigPath,
  normalizeProjectNameForCreate,
} from "./shared.js";
import { isValidProjectName, errorMessage } from "./utils.js";
import { readInstallPreferences, writeInstallPreferences, type InstallPreferences } from "./init-preferences.js";

const HOOK_TOOLS = ["claude", "copilot", "cursor", "codex"] as const;
type HookToolName = typeof HOOK_TOOLS[number];

function printSkillsUsage() {
  console.log("Usage:");
  console.log("  cortex skills list [--project <name>]");
  console.log("  cortex skills show <name> [--project <name>]");
  console.log("  cortex skills edit <name> [--project <name>]");
  console.log("  cortex skills add <project> <path>");
  console.log("  cortex skills remove <project> <name>");
}

function printHooksUsage() {
  console.log("Usage:");
  console.log("  cortex hooks list");
  console.log("  cortex hooks show <tool>");
  console.log("  cortex hooks edit <tool>");
  console.log("  cortex hooks enable <tool>");
  console.log("  cortex hooks disable <tool>");
  console.log("  tools: claude|copilot|cursor|codex");
}

function normalizeHookTool(raw: string | undefined): HookToolName | null {
  if (!raw) return null;
  const tool = raw.toLowerCase();
  return HOOK_TOOLS.includes(tool as HookToolName) ? tool as HookToolName : null;
}

function findSkillPath(name: string, profile: string, project?: string): string | null {
  const needle = name.replace(/\.md$/i, "").toLowerCase();
  const seenPaths = new Set<string>();

  function search(root: string, sourceLabel: string): string | null {
    if (!fs.existsSync(root)) return null;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const isDir = entry.isDirectory();
      const filePath = isDir
        ? path.join(root, entry.name, "SKILL.md")
        : entry.name.endsWith(".md") ? path.join(root, entry.name) : null;
      if (!filePath || seenPaths.has(filePath) || !fs.existsSync(filePath)) continue;
      seenPaths.add(filePath);
      const entryName = isDir ? entry.name : entry.name.replace(/\.md$/, "");
      if (entryName.toLowerCase() === needle && (!project || sourceLabel.toLowerCase() === project.toLowerCase())) {
        return filePath;
      }
    }
    return null;
  }

  const cortexPath = getCortexPath();
  if (project) {
    const roots = project.toLowerCase() === "global"
      ? [path.join(cortexPath, "global", "skills")]
      : [
        path.join(cortexPath, project, "skills"),
        path.join(cortexPath, project, ".claude", "skills"),
      ];
    for (const root of roots) {
      const found = search(root, project);
      if (found) return found;
    }
    return null;
  }

  const globalMatch = search(path.join(cortexPath, "global", "skills"), "global");
  if (globalMatch) return globalMatch;

  for (const dir of getProjectDirs(cortexPath, profile)) {
    const projectName = path.basename(dir);
    if (projectName === "global") continue;
    const projectMatch = search(path.join(dir, "skills"), projectName);
    if (projectMatch) return projectMatch;
    const claudeMatch = search(path.join(dir, ".claude", "skills"), projectName);
    if (claudeMatch) return claudeMatch;
  }
  return null;
}

function openInEditor(filePath: string): void {
  const editor = process.env.EDITOR || process.env.VISUAL || "nano";
  try {
    execFileSync(editor, [filePath], { stdio: "inherit" });
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] openInEditor: ${errorMessage(err)}\n`);
    console.error(`Editor "${editor}" failed. Set $EDITOR to your preferred editor.`);
    process.exit(1);
  }
}

export function handleSkillsNamespace(args: string[], profile: string) {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printSkillsUsage();
    return;
  }

  if (subcommand === "list") {
    handleSkillList(profile);
    return;
  }

  if (subcommand === "show" || subcommand === "edit") {
    const name = args[1];
    if (!name) {
      printSkillsUsage();
      process.exit(1);
    }
    const projectIdx = args.indexOf("--project");
    const project = projectIdx !== -1 ? args[projectIdx + 1] : undefined;
    const skillPath = findSkillPath(name, profile, project);
    if (!skillPath) {
      console.error(`Skill not found: "${name}"${project ? ` in project "${project}"` : ""}`);
      process.exit(1);
    }
    if (subcommand === "show") {
      console.log(fs.readFileSync(skillPath, "utf8"));
    } else {
      openInEditor(skillPath);
    }
    return;
  }

  if (subcommand === "add") {
    const project = args[1];
    const skillPath = args[2];
    if (!project || !skillPath) {
      printSkillsUsage();
      process.exit(1);
    }
    if (!isValidProjectName(project)) {
      console.error(`Invalid project name: "${project}"`);
      process.exit(1);
    }

    const source = path.resolve(expandHomePath(skillPath));
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      console.error(`Skill file not found: ${source}`);
      process.exit(1);
    }

    const baseName = path.basename(source);
    const fileName = baseName.toLowerCase().endsWith(".md") ? baseName : `${baseName}.md`;
    const destDir = path.join(getCortexPath(), project, ".claude", "skills");
    const dest = path.join(destDir, fileName);
    fs.mkdirSync(destDir, { recursive: true });

    if (fs.existsSync(dest)) {
      console.error(`Skill already exists: ${dest}`);
      process.exit(1);
    }

    try {
      fs.symlinkSync(source, dest);
      console.log(`Linked skill ${fileName} into ${project}.`);
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] skill add symlinkFailed: ${errorMessage(err)}\n`);
      fs.copyFileSync(source, dest);
      console.log(`Copied skill ${fileName} into ${project}.`);
    }
    return;
  }

  if (subcommand === "remove") {
    const project = args[1];
    const name = args[2];
    if (!project || !name) {
      printSkillsUsage();
      process.exit(1);
    }
    if (!isValidProjectName(project)) {
      console.error(`Invalid project name: "${project}"`);
      process.exit(1);
    }

    const resolved = findSkillPath(name, profile, project);
    if (!resolved) {
      console.error(`Skill not found: "${name}" in project "${project}"`);
      process.exit(1);
    }
    const removePath = path.basename(resolved) === "SKILL.md" ? path.dirname(resolved) : resolved;
    if (fs.statSync(removePath).isDirectory()) {
      fs.rmSync(removePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(removePath);
    }
    console.log(`Removed skill ${name.replace(/\.md$/i, "")} from ${project}.`);
    return;
  }

  console.error(`Unknown skills subcommand: ${subcommand}`);
  printSkillsUsage();
  process.exit(1);
}

export function handleHooksNamespace(args: string[]) {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printHooksUsage();
    return;
  }

  if (subcommand === "list") {
    const prefs = readInstallPreferences(getCortexPath());
    const hooksEnabled = prefs.hooksEnabled !== false;
    const toolPrefs = prefs.hookTools && typeof prefs.hookTools === "object" ? prefs.hookTools : {};
    const rows = HOOK_TOOLS.map((tool) => ({
      tool,
      hookType: "lifecycle",
      status: hooksEnabled && toolPrefs[tool] !== false ? "enabled" : "disabled",
    }));

    console.log("Tool      Hook Type  Status");
    console.log("--------  ---------  --------");
    for (const row of rows) {
      console.log(`${row.tool.padEnd(8)}  ${row.hookType.padEnd(9)}  ${row.status}`);
    }
    return;
  }

  if (subcommand === "show" || subcommand === "edit") {
    const tool = normalizeHookTool(args[1]);
    if (!tool) {
      printHooksUsage();
      process.exit(1);
    }
    const configPath = hookConfigPath(tool, getCortexPath());
    if (!configPath || !fs.existsSync(configPath)) {
      console.error(`Hook config not found for "${tool}": ${configPath ?? "(unknown path)"}`);
      process.exit(1);
    }
    if (subcommand === "show") {
      console.log(fs.readFileSync(configPath, "utf8"));
    } else {
      openInEditor(configPath);
    }
    return;
  }

  if (subcommand === "enable" || subcommand === "disable") {
    const tool = normalizeHookTool(args[1]);
    if (!tool) {
      printHooksUsage();
      process.exit(1);
    }

    const prefs = readInstallPreferences(getCortexPath());
    writeInstallPreferences(getCortexPath(), {
      hookTools: {
        ...(prefs.hookTools && typeof prefs.hookTools === "object" ? prefs.hookTools : {}),
        [tool]: subcommand === "enable",
      },
    } satisfies Partial<InstallPreferences>);
    console.log(`${subcommand === "enable" ? "Enabled" : "Disabled"} hooks for ${tool}.`);
    return;
  }

  console.error(`Unknown hooks subcommand: ${subcommand}`);
  printHooksUsage();
  process.exit(1);
}

export function handleSkillList(profile: string) {
  const sources: Array<{ name: string; source: string; format: "flat" | "folder"; path: string }> = [];
  const seenPaths = new Set<string>();

  function collectSkills(root: string, sourceLabel: string) {
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const entryPath = path.join(root, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md")) {
        if (seenPaths.has(entryPath)) continue;
        seenPaths.add(entryPath);
        sources.push({
          name: entry.name.replace(/\.md$/, ""),
          source: sourceLabel,
          format: "flat",
          path: entryPath,
        });
        continue;
      }
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(entryPath, "SKILL.md");
      if (!fs.existsSync(skillFile) || seenPaths.has(skillFile)) continue;
      seenPaths.add(skillFile);
      sources.push({
        name: entry.name,
        source: sourceLabel,
        format: "folder",
        path: skillFile,
      });
    }
  }

  const cortexPath = getCortexPath();
  collectSkills(path.join(cortexPath, "global", "skills"), "global");

  for (const dir of getProjectDirs(cortexPath, profile)) {
    const projectName = path.basename(dir);
    if (projectName === "global") continue;
    collectSkills(path.join(dir, "skills"), projectName);
    collectSkills(path.join(dir, ".claude", "skills"), projectName);
  }

  if (!sources.length) {
    console.log("No skills found.");
    return;
  }

  const nameWidth = Math.max(4, ...sources.map((source) => source.name.length));
  const sourceWidth = Math.max(6, ...sources.map((source) => source.source.length));
  const formatWidth = Math.max(6, ...sources.map((source) => source.format.length));

  console.log(
    `${"Name".padEnd(nameWidth)}  ${"Source".padEnd(sourceWidth)}  ${"Format".padEnd(formatWidth)}  Path`
  );
  console.log(
    `${"─".repeat(nameWidth)}  ${"─".repeat(sourceWidth)}  ${"─".repeat(formatWidth)}  ${"─".repeat(30)}`
  );
  for (const skill of sources) {
    console.log(
      `${skill.name.padEnd(nameWidth)}  ${skill.source.padEnd(sourceWidth)}  ${skill.format.padEnd(formatWidth)}  ${skill.path}`
    );
  }
  console.log(`\n${sources.length} skill(s) found.`);
}

export function handleDetectSkills(args: string[], profile: string) {
  const importFlag = args.includes("--import");
  const nativeSkillsDir = homePath(".claude", "skills");
  if (!fs.existsSync(nativeSkillsDir)) {
    console.log("No native skills directory found at ~/.claude/skills/");
    return;
  }

  const trackedSkills = new Set<string>();
  const cortexPath = getCortexPath();
  const globalSkillsDir = path.join(cortexPath, "global", "skills");
  if (fs.existsSync(globalSkillsDir)) {
    for (const entry of fs.readdirSync(globalSkillsDir)) {
      trackedSkills.add(entry.replace(/\.md$/, ""));
      if (fs.statSync(path.join(globalSkillsDir, entry)).isDirectory()) {
        trackedSkills.add(entry);
      }
    }
  }
  for (const dir of getProjectDirs(cortexPath, profile)) {
    const projectSkillsDir = path.join(dir, ".claude", "skills");
    if (!fs.existsSync(projectSkillsDir)) continue;
    for (const entry of fs.readdirSync(projectSkillsDir)) {
      trackedSkills.add(entry.replace(/\.md$/, ""));
    }
  }

  const untracked: Array<{ name: string; path: string; isDir: boolean }> = [];
  for (const entry of fs.readdirSync(nativeSkillsDir)) {
    const entryPath = path.join(nativeSkillsDir, entry);
    const stat = fs.statSync(entryPath);
    try {
      if (fs.lstatSync(entryPath).isSymbolicLink()) continue;
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] skillList lstat: ${errorMessage(err)}\n`);
    }
    const name = entry.replace(/\.md$/, "");
    if (trackedSkills.has(name)) continue;
    if (stat.isFile() && entry.endsWith(".md")) {
      untracked.push({ name, path: entryPath, isDir: false });
    } else if (stat.isDirectory()) {
      const skillFile = path.join(entryPath, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        untracked.push({ name, path: entryPath, isDir: true });
      }
    }
  }

  if (!untracked.length) {
    console.log("All skills in ~/.claude/skills/ are already tracked by cortex.");
    return;
  }

  console.log(`Found ${untracked.length} untracked skill(s) in ~/.claude/skills/:\n`);
  for (const skill of untracked) {
    console.log(`  ${skill.name}  (${skill.path})`);
  }

  if (!importFlag) {
    console.log("\nRun with --import to copy these into cortex global skills.");
    return;
  }

  fs.mkdirSync(globalSkillsDir, { recursive: true });
  let imported = 0;
  for (const skill of untracked) {
    const dest = skill.isDir
      ? path.join(globalSkillsDir, skill.name)
      : path.join(globalSkillsDir, `${skill.name}.md`);
    if (fs.existsSync(dest)) {
      console.log(`  skip ${skill.name} (already exists in global/skills/)`);
      continue;
    }
    if (skill.isDir) {
      fs.cpSync(skill.path, dest, { recursive: true });
    } else {
      fs.copyFileSync(skill.path, dest);
    }
    const destDisplay = skill.isDir ? `global/skills/${skill.name}/` : `global/skills/${skill.name}.md`;
    console.log(`  imported ${skill.name} -> ${destDisplay}`);
    imported++;
  }
  console.log(`\nImported ${imported} skill(s). They are now tracked in cortex global skills.`);
}

export async function handleProjectsNamespace(args: string[], profile: string) {
  const subcommand = args[0];

  if (!subcommand || subcommand === "list" || subcommand === "--help" || subcommand === "-h") {
    if (subcommand === "--help" || subcommand === "-h") {
      console.log("Usage:");
      console.log("  cortex projects list               List all projects");
      console.log("  cortex projects remove <name>      Remove a project (asks for confirmation)");
      return;
    }
    return handleProjectsList(profile);
  }

  if (subcommand === "add") {
    const name = args[1];
    if (!name) {
      console.error("Usage: cortex projects add <name>");
      process.exit(1);
    }
    console.error("`cortex projects add` is legacy. Prefer `cd ~/your-project && cortex add`.");
    return handleProjectsAdd(name);
  }

  if (subcommand === "remove") {
    const name = args[1];
    if (!name) {
      console.error("Usage: cortex projects remove <name>");
      process.exit(1);
    }
    return handleProjectsRemove(name, profile);
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  console.error("Usage: cortex projects [list|remove]");
  process.exit(1);
}

function handleProjectsList(profile: string) {
  const cortexPath = getCortexPath();
  const projectDirs = getProjectDirs(cortexPath, profile);
  const projects = projectDirs
    .map((dir) => path.basename(dir))
    .filter((name) => name !== "global")
    .sort();

  if (!projects.length) {
    console.log("No projects found. Run: cd ~/your-project && cortex add");
    return;
  }

  console.log(`\nProjects in ${cortexPath}:\n`);
  for (const name of projects) {
    const projectDir = path.join(cortexPath, name);
    let dirFiles: Set<string>;
    try {
      dirFiles = new Set(fs.readdirSync(projectDir));
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] projects list readdir: ${errorMessage(err)}\n`);
      dirFiles = new Set();
    }
    const tags: string[] = [];
    if (dirFiles.has("FINDINGS.md")) tags.push("findings");
    if (dirFiles.has("backlog.md")) tags.push("backlog");
    const tagStr = tags.length ? `  [${tags.join(", ")}]` : "";
    console.log(`  ${name}${tagStr}`);
  }
  console.log(`\n${projects.length} project(s) total.`);
  console.log("Add another project: cd ~/your-project && cortex add");
}

function handleProjectsAdd(name: string) {
  const projectName = normalizeProjectNameForCreate(name);
  if (!isValidProjectName(projectName)) {
    console.error(`Invalid project name: "${name}". Use lowercase letters, numbers, and hyphens.`);
    process.exit(1);
  }

  const cortexPath = getCortexPath();
  const existingProject = findProjectNameCaseInsensitive(cortexPath, projectName);
  if (existingProject && existingProject !== projectName) {
    console.error(
      `Project "${existingProject}" already exists with different casing. Refusing to create "${projectName}" because it would split the same project on case-sensitive filesystems.`
    );
    process.exit(1);
  }
  const projectDir = path.join(cortexPath, projectName);

  if (fs.existsSync(projectDir)) {
    console.error(`Project "${projectName}" already exists at ${projectDir}`);
    process.exit(1);
  }

  fs.mkdirSync(projectDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);

  fs.writeFileSync(
    path.join(projectDir, "summary.md"),
    `# ${projectName}\n\n**What:** Replace this with one sentence about what the project does\n**Stack:** The key tech\n**Status:** active\n**Run:** the command you use most\n**Watch out:** the one thing that will bite you if you forget\n`
  );
  fs.writeFileSync(
    path.join(projectDir, "CLAUDE.md"),
    `# ${projectName}\n\nOne paragraph about what this project is.\n\n## Commands\n\n\`\`\`bash\n# Install:\n# Run:\n# Test:\n\`\`\`\n`
  );
  fs.writeFileSync(
    path.join(projectDir, "FINDINGS.md"),
    `# ${projectName} Findings\n\n<!-- created: ${today} -->\n`
  );
  fs.writeFileSync(
    path.join(projectDir, "backlog.md"),
    `# ${projectName} backlog\n\n## Active\n\n## Queue\n\n## Done\n`
  );

  console.log(`\nCreated project "${projectName}" at ${projectDir}`);
  console.log("\nFiles created:");
  console.log("  summary.md     — one-liner description, stack, run command");
  console.log("  CLAUDE.md      — project instructions for Claude");
  console.log("  FINDINGS.md    — auto-captured insights");
  console.log("  backlog.md     — task queue");
  console.log(`\nNext: edit ${projectDir}/summary.md to describe your project.`);
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

  const cortexPath = getCortexPath();
  const projectDir = path.join(cortexPath, name);

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
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] projects remove countFiles: ${errorMessage(err)}\n`);
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
