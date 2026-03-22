import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  expandHomePath,
  findArchivedProjectNameCaseInsensitive,
  findProjectNameCaseInsensitive,
  getPhrenPath,
  getProjectDirs,
  homePath,
  hookConfigPath,
  normalizeProjectNameForCreate,
  readRootManifest,
} from "./shared.js";
import { isValidProjectName, errorMessage } from "./utils.js";
import { readInstallPreferences, writeInstallPreferences, type InstallPreferences } from "./init-preferences.js";
import { buildSkillManifest, findLocalSkill, findSkill, getAllSkills } from "./skill-registry.js";
import { detectSkillCollisions } from "./link-skills.js";
import { setSkillEnabledAndSync, syncSkillLinksForScope } from "./skill-files.js";
import { findProjectDir } from "./project-locator.js";
import { TASK_FILE_ALIASES, addTask, completeTask, updateTask, reorderTask, pinTask, removeTask, workNextTask, tidyDoneTasks, linkTaskIssue, promoteTask, resolveTaskItem } from "./data-tasks.js";
import { buildTaskIssueBody, createGithubIssueForTask, parseGithubIssueUrl, resolveProjectGithubRepo } from "./tasks-github.js";
import {
  PROJECT_HOOK_EVENTS,
  PROJECT_OWNERSHIP_MODES,
  isProjectHookEnabled,
  parseProjectOwnershipMode,
  readProjectConfig,
  writeProjectConfig,
  writeProjectHookConfig,
} from "./project-config.js";
import { addFinding, removeFinding } from "./core-finding.js";
import { supersedeFinding, retractFinding, resolveFindingContradiction } from "./finding-lifecycle.js";
import { readCustomHooks, getHookTarget, HOOK_EVENT_VALUES, validateCustomHookCommand, type CustomHookEntry } from "./hooks.js";
import { runtimeFile } from "./shared.js";
import { logDebug } from "./logger.js";

const HOOK_TOOLS = ["claude", "copilot", "cursor", "codex"] as const;
type HookToolName = typeof HOOK_TOOLS[number];

function printSkillsUsage() {
  console.log("Usage:");
  console.log("  phren skills list [--project <name>]");
  console.log("  phren skills show <name> [--project <name>]");
  console.log("  phren skills edit <name> [--project <name>]");
  console.log("  phren skills add <project> <path>");
  console.log("  phren skills resolve <project|global> [--json]");
  console.log("  phren skills doctor <project|global>");
  console.log("  phren skills sync <project|global>");
  console.log("  phren skills enable <project|global> <name>");
  console.log("  phren skills disable <project|global> <name>");
  console.log("  phren skills remove <project> <name>");
}

function printHooksUsage() {
  console.log("Usage:");
  console.log("  phren hooks list [--project <name>]");
  console.log("  phren hooks show <tool>");
  console.log("  phren hooks edit <tool>");
  console.log("  phren hooks enable <tool>");
  console.log("  phren hooks disable <tool>");
  console.log("  phren hooks add-custom <event> <command>");
  console.log("  phren hooks remove-custom <event> [<command>]");
  console.log("  phren hooks errors [--limit <n>]");
  console.log("  tools: claude|copilot|cursor|codex");
  console.log("  events: " + HOOK_EVENT_VALUES.join(", "));
}

function normalizeHookTool(raw: string | undefined): HookToolName | null {
  if (!raw) return null;
  const tool = raw.toLowerCase();
  return HOOK_TOOLS.includes(tool as HookToolName) ? tool as HookToolName : null;
}

function getOptionValue(args: string[], name: string): string | undefined {
  const exactIdx = args.indexOf(name);
  if (exactIdx !== -1) return args[exactIdx + 1];
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : undefined;
}

function parseMcpToggle(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "on" || normalized === "true" || normalized === "enabled") return true;
  if (normalized === "off" || normalized === "false" || normalized === "disabled") return false;
  return undefined;
}

function findSkillPath(name: string, profile: string, project?: string): string | null {
  const found = findSkill(getPhrenPath(), profile, project, name);
  if (!found || "error" in found) return null;
  return found.path;
}

function openInEditor(filePath: string): void {
  const editor = process.env.EDITOR || process.env.VISUAL || "nano";
  try {
    execFileSync(editor, [filePath], { stdio: "inherit" });
  } catch (err: unknown) {
    logDebug("openInEditor", errorMessage(err));
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
    const projectIdx = args.indexOf("--project");
    const project = projectIdx !== -1 ? args[projectIdx + 1] : undefined;
    handleSkillList(profile, project);
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
    const destDir = path.join(getPhrenPath(), project, "skills");
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
      logDebug("skill add symlinkFailed", errorMessage(err));
      fs.copyFileSync(source, dest);
      console.log(`Copied skill ${fileName} into ${project}.`);
    }
    return;
  }

  if (subcommand === "resolve" || subcommand === "doctor" || subcommand === "sync") {
    const scope = args[1];
    if (!scope) {
      printSkillsUsage();
      process.exit(1);
    }
    if (scope.toLowerCase() !== "global" && !isValidProjectName(scope)) {
      console.error(`Invalid project name: "${scope}"`);
      process.exit(1);
    }

    if (subcommand === "sync") {
      const syncedManifest = syncSkillLinksForScope(getPhrenPath(), scope);
      if (!syncedManifest) {
        console.error(`Project directory not found for "${scope}".`);
        process.exit(1);
      }
      const mirrorDir = resolveSkillMirrorDir(scope) || homePath(".claude", "skills");
      console.log(`Synced ${syncedManifest.skills.filter((skill) => skill.visibleToAgents).length} skill(s) for ${scope}.`);
      console.log(`  ${path.join(path.dirname(mirrorDir), "skill-manifest.json")}`);
      console.log(`  ${path.join(path.dirname(mirrorDir), "skill-commands.json")}`);
      return;
    }

    const destDir = resolveSkillMirrorDir(scope);
    const manifest = buildSkillManifest(getPhrenPath(), profile, scope, destDir || undefined);
    if (subcommand === "resolve") {
      if (args.includes("--json")) {
        console.log(JSON.stringify(manifest, null, 2));
        return;
      }
      printResolvedManifest(scope, manifest, destDir);
      return;
    }

    printSkillDoctor(scope, manifest, destDir);
    return;
  }

  if (subcommand === "enable" || subcommand === "disable") {
    const scope = args[1];
    const name = args[2];
    if (!scope || !name) {
      printSkillsUsage();
      process.exit(1);
    }
    if (scope.toLowerCase() !== "global" && !isValidProjectName(scope)) {
      console.error(`Invalid project name: "${scope}"`);
      process.exit(1);
    }
    const resolved = findSkill(getPhrenPath(), profile, scope, name);
    if (!resolved || "error" in resolved) {
      console.error(`Skill not found: "${name}" in "${scope}"`);
      process.exit(1);
    }
    setSkillEnabledAndSync(getPhrenPath(), scope, resolved.name, subcommand === "enable");
    console.log(`${subcommand === "enable" ? "Enabled" : "Disabled"} skill ${resolved.name} in ${scope}.`);
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

    const resolved = findLocalSkill(getPhrenPath(), project, name)?.path || null;
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
    const phrenPath = getPhrenPath();
    const prefs = readInstallPreferences(phrenPath);
    const hooksEnabled = prefs.hooksEnabled !== false;
    const toolPrefs = prefs.hookTools && typeof prefs.hookTools === "object" ? prefs.hookTools : {};
    const project = getOptionValue(args.slice(1), "--project");
    if (project && (!isValidProjectName(project) || !fs.existsSync(path.join(phrenPath, project)))) {
      console.error(`Project "${project}" not found.`);
      process.exit(1);
    }
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
    if (project) {
      const projectConfig = readProjectConfig(phrenPath, project);
      const base = projectConfig.hooks?.enabled;
      console.log("");
      console.log(`Project ${project}`);
      console.log(`  base: ${typeof base === "boolean" ? (base ? "enabled" : "disabled") : "inherit"}`);
      for (const event of PROJECT_HOOK_EVENTS) {
        const configured = projectConfig.hooks?.[event];
        const effective = isProjectHookEnabled(phrenPath, project, event, projectConfig);
        console.log(`  ${event}: ${effective ? "enabled" : "disabled"}${typeof configured === "boolean" ? ` (explicit ${configured ? "on" : "off"})` : " (inherit)"}`);
      }
    }
    const customHooks = readCustomHooks(phrenPath);
    if (customHooks.length > 0) {
      console.log("");
      console.log(`${customHooks.length} custom hook(s):`);
      for (const h of customHooks) {
        const hookKind = "webhook" in h ? "[webhook] " : "";
        console.log(`  ${h.event}: ${hookKind}${getHookTarget(h)}${h.timeout ? ` (${h.timeout}ms)` : ""}`);
      }
    }
    return;
  }

  if (subcommand === "show" || subcommand === "edit") {
    const tool = normalizeHookTool(args[1]);
    if (!tool) {
      printHooksUsage();
      process.exit(1);
    }
    const configPath = hookConfigPath(tool, getPhrenPath());
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

    const prefs = readInstallPreferences(getPhrenPath());
    writeInstallPreferences(getPhrenPath(), {
      hookTools: {
        ...(prefs.hookTools && typeof prefs.hookTools === "object" ? prefs.hookTools : {}),
        [tool]: subcommand === "enable",
      },
    } satisfies Partial<InstallPreferences>);
    console.log(`${subcommand === "enable" ? "Enabled" : "Disabled"} hooks for ${tool}.`);
    return;
  }

  if (subcommand === "add-custom") {
    const event = args[1];
    const command = args.slice(2).join(" ");
    if (!event || !command) {
      console.error('Usage: phren hooks add-custom <event> "<command>"');
      console.error("Events: " + HOOK_EVENT_VALUES.join(", "));
      process.exit(1);
    }
    if (!HOOK_EVENT_VALUES.includes(event as typeof HOOK_EVENT_VALUES[number])) {
      console.error(`Invalid event "${event}". Valid events: ${HOOK_EVENT_VALUES.join(", ")}`);
      process.exit(1);
    }
    const commandErr = validateCustomHookCommand(command);
    if (commandErr) {
      console.error(commandErr);
      process.exit(1);
    }
    const phrenPath = getPhrenPath();
    const prefs = readInstallPreferences(phrenPath);
    const existing: CustomHookEntry[] = Array.isArray(prefs.customHooks) ? prefs.customHooks : [];
    const newHook: CustomHookEntry = { event: event as typeof HOOK_EVENT_VALUES[number], command };
    writeInstallPreferences(phrenPath, { ...prefs, customHooks: [...existing, newHook] });
    console.log(`Added custom hook for "${event}": ${command}`);
    return;
  }

  if (subcommand === "remove-custom") {
    const event = args[1];
    if (!event) {
      console.error('Usage: phren hooks remove-custom <event> [<command>]');
      process.exit(1);
    }
    if (!HOOK_EVENT_VALUES.includes(event as typeof HOOK_EVENT_VALUES[number])) {
      console.error(`Invalid event "${event}". Valid events: ${HOOK_EVENT_VALUES.join(", ")}`);
      process.exit(1);
    }
    const command = args.slice(2).join(" ") || undefined;
    const phrenPath = getPhrenPath();
    const prefs = readInstallPreferences(phrenPath);
    const existing: CustomHookEntry[] = Array.isArray(prefs.customHooks) ? prefs.customHooks : [];
    const remaining = existing.filter(h => h.event !== event || (command && !getHookTarget(h).includes(command)));
    const removed = existing.length - remaining.length;
    if (removed === 0) {
      console.error(`No custom hooks matched event="${event}"${command ? ` command containing "${command}"` : ""}.`);
      process.exit(1);
    }
    writeInstallPreferences(phrenPath, { ...prefs, customHooks: remaining });
    console.log(`Removed ${removed} custom hook(s) for "${event}".`);
    return;
  }

  if (subcommand === "errors") {
    const phrenPath = getPhrenPath();
    const logPath = runtimeFile(phrenPath, "hook-errors.log");
    if (!fs.existsSync(logPath)) {
      console.log("No hook errors recorded.");
      return;
    }
    const content = fs.readFileSync(logPath, "utf8").trim();
    if (!content) {
      console.log("No hook errors recorded.");
      return;
    }
    const lines = content.split("\n");
    const limitArg = getOptionValue(args.slice(1), "--limit");
    const limit = limitArg ? Math.max(1, parseInt(limitArg, 10) || 20) : 20;
    const display = lines.slice(-limit);
    console.log(`Hook errors (last ${display.length} of ${lines.length}):\n`);
    for (const line of display) {
      console.log(line);
    }
    return;
  }

  console.error(`Unknown hooks subcommand: ${subcommand}`);
  printHooksUsage();
  process.exit(1);
}

export function handleSkillList(profile: string, project?: string) {
  if (project) {
    const manifest = buildSkillManifest(getPhrenPath(), profile, project, resolveSkillMirrorDir(project) || undefined);
    printResolvedManifest(project, manifest, resolveSkillMirrorDir(project));
    return;
  }

  const sources = getAllSkills(getPhrenPath(), profile);

  if (!sources.length) {
    console.log("No skills found.");
    return;
  }

  const nameWidth = Math.max(4, ...sources.map((source) => source.name.length));
  const sourceWidth = Math.max(6, ...sources.map((source) => source.source.length));
  const formatWidth = Math.max(6, ...sources.map((source) => source.format.length));
  const commandWidth = Math.max(7, ...sources.map((source) => source.command.length));
  const statusWidth = 8;

  console.log(
    `${"Name".padEnd(nameWidth)}  ${"Source".padEnd(sourceWidth)}  ${"Format".padEnd(formatWidth)}  ${"Command".padEnd(commandWidth)}  ${"Status".padEnd(statusWidth)}  Path`
  );
  console.log(
    `${"─".repeat(nameWidth)}  ${"─".repeat(sourceWidth)}  ${"─".repeat(formatWidth)}  ${"─".repeat(commandWidth)}  ${"─".repeat(statusWidth)}  ${"─".repeat(30)}`
  );
  for (const skill of sources) {
    console.log(
      `${skill.name.padEnd(nameWidth)}  ${skill.source.padEnd(sourceWidth)}  ${skill.format.padEnd(formatWidth)}  ${skill.command.padEnd(commandWidth)}  ${(skill.enabled ? "enabled" : "disabled").padEnd(statusWidth)}  ${skill.path}`
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
  const phrenPath = getPhrenPath();
  const globalSkillsDir = path.join(phrenPath, "global", "skills");
  if (fs.existsSync(globalSkillsDir)) {
    for (const entry of fs.readdirSync(globalSkillsDir)) {
      trackedSkills.add(entry.replace(/\.md$/, ""));
      if (fs.statSync(path.join(globalSkillsDir, entry)).isDirectory()) {
        trackedSkills.add(entry);
      }
    }
  }
  for (const dir of getProjectDirs(phrenPath, profile)) {
    for (const projectSkillsDir of [path.join(dir, "skills"), path.join(dir, ".claude", "skills")]) {
      if (!fs.existsSync(projectSkillsDir)) continue;
      for (const entry of fs.readdirSync(projectSkillsDir)) {
        trackedSkills.add(entry.replace(/\.md$/, ""));
      }
    }
  }

  const untracked: Array<{ name: string; path: string; isDir: boolean }> = [];
  for (const entry of fs.readdirSync(nativeSkillsDir)) {
    const entryPath = path.join(nativeSkillsDir, entry);
    const stat = fs.statSync(entryPath);
    try {
      if (fs.lstatSync(entryPath).isSymbolicLink()) continue;
    } catch (err: unknown) {
      logDebug("skillList lstat", errorMessage(err));
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
    console.log("All skills in ~/.claude/skills/ are already tracked by phren.");
    return;
  }

  console.log(`Found ${untracked.length} untracked skill(s) in ~/.claude/skills/:\n`);
  for (const skill of untracked) {
    console.log(`  ${skill.name}  (${skill.path})`);
  }

  if (!importFlag) {
    console.log("\nRun with --import to copy these into phren global skills.");
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
  console.log(`\nImported ${imported} skill(s). They are now tracked in phren global skills.`);
}

function resolveSkillMirrorDir(scope: string): string | null {
  if (scope.toLowerCase() === "global") return homePath(".claude", "skills");
  const projectDir = findProjectDir(scope);
  return projectDir ? path.join(projectDir, ".claude", "skills") : null;
}

function printResolvedManifest(scope: string, manifest: ReturnType<typeof buildSkillManifest>, destDir: string | null) {
  console.log(`Scope: ${scope}`);
  console.log(`Mirror: ${destDir || "(unavailable on disk)"}`);
  console.log("");
  for (const skill of manifest.skills) {
    const status = skill.visibleToAgents ? "visible" : "disabled";
    const overrideText = skill.overrides.length ? ` override:${skill.overrides.length}` : "";
    console.log(`${skill.command}  ${skill.name}  ${skill.source}  ${status}${overrideText}`);
    console.log(`  ${skill.path}`);
  }
  if (manifest.problems.length) {
    console.log("\nProblems:");
    for (const problem of manifest.problems) {
      console.log(`- ${problem.message}`);
    }
  }
}

function printSkillDoctor(scope: string, manifest: ReturnType<typeof buildSkillManifest>, destDir: string | null) {
  printResolvedManifest(scope, manifest, destDir);
  const problems: string[] = [];

  if (!destDir) {
    problems.push(`Mirror target for ${scope} is not discoverable on disk.`);
  } else {
    const parentDir = path.dirname(destDir);
    if (!fs.existsSync(path.join(parentDir, "skill-manifest.json"))) {
      problems.push(`Missing generated manifest: ${path.join(parentDir, "skill-manifest.json")}`);
    }
    if (!fs.existsSync(path.join(parentDir, "skill-commands.json"))) {
      problems.push(`Missing generated command registry: ${path.join(parentDir, "skill-commands.json")}`);
    }
    for (const skill of manifest.skills.filter((entry) => entry.visibleToAgents)) {
      const dest = path.join(destDir, skill.format === "folder" ? skill.name : path.basename(skill.path));
      try {
        if (!fs.existsSync(dest) || fs.realpathSync(dest) !== fs.realpathSync(skill.root)) {
          problems.push(`Mirror drift for ${skill.name}: expected ${dest} -> ${skill.root}`);
        }
      } catch {
        problems.push(`Mirror drift for ${skill.name}: expected ${dest} -> ${skill.root}`);
      }
    }

    // Check for user-owned files blocking phren skill links
    const phrenPath = getPhrenPath();
    const srcDir = scope.toLowerCase() === "global"
      ? path.join(phrenPath, "global", "skills")
      : path.join(phrenPath, scope, "skills");
    const collisions = detectSkillCollisions(srcDir, destDir, phrenPath);
    for (const collision of collisions) {
      problems.push(`Skill collision: ${collision.message}`);
    }
  }

  if (!manifest.problems.length && !problems.length) {
    console.log("\nDoctor: no skill pipeline issues detected.");
    return;
  }

  console.log("\nDoctor findings:");
  for (const problem of [...manifest.problems.map((entry) => entry.message), ...problems]) {
    console.log(`- ${problem}`);
  }
}

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
    console.error("Use `cd ~/your-project && npx phren add` so enrollment stays path-based.");
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
    const projectDir = path.join(phrenPath, name);
    if (!fs.existsSync(projectDir)) {
      console.error(`Project "${name}" not found.`);
      process.exit(1);
    }
    const { readFindings, readTasks, resolveTaskFilePath } = await import("./data-access.js");
    const exported: Record<string, unknown> = { project: name, exportedAt: new Date().toISOString(), version: 1 };
    const summaryPath = path.join(projectDir, "summary.md");
    if (fs.existsSync(summaryPath)) exported.summary = fs.readFileSync(summaryPath, "utf8");
    const learningsResult = readFindings(phrenPath, name);
    if (learningsResult.ok) exported.learnings = learningsResult.data;
    const findingsPath = path.join(projectDir, "FINDINGS.md");
    if (fs.existsSync(findingsPath)) exported.findingsRaw = fs.readFileSync(findingsPath, "utf8");
    const taskResult = readTasks(phrenPath, name);
    if (taskResult.ok) {
      exported.task = taskResult.data.items;
      const taskRawPath = resolveTaskFilePath(phrenPath, name);
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
    const { TASKS_FILENAME } = await import("./data-access.js");
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
        fs.writeFileSync(path.join(stagedProjectDir, "FINDINGS.md"), decoded.findingsRaw);
        imported.push("FINDINGS.md");
      } else if (Array.isArray(decoded.learnings) && decoded.learnings.length > 0) {
        const date = new Date().toISOString().slice(0, 10);
        const lines = [`# ${projectName} Findings`, "", `## ${date}`, ""];
        for (const item of decoded.learnings as Array<{ text: string }>) {
          if (item.text) lines.push(`- ${item.text}`);
        }
        lines.push("");
        fs.writeFileSync(path.join(stagedProjectDir, "FINDINGS.md"), lines.join("\n"));
        imported.push("FINDINGS.md");
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
      const projectDir = activeProject ? path.join(phrenPath, activeProject) : path.join(phrenPath, name);
      const archiveDir = path.join(phrenPath, `${activeProject ?? name}.archived`);
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
      const projectDir = path.join(phrenPath, archivedProject ?? name);
      const archiveDir = path.join(phrenPath, `${archivedProject ?? name}.archived`);
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
    console.log("No projects found. Run: cd ~/your-project && npx phren add");
    return;
  }

  console.log(`\nProjects in ${phrenPath}:\n`);
  for (const name of projects) {
    const projectDir = path.join(phrenPath, name);
    let dirFiles: Set<string>;
    try {
      dirFiles = new Set(fs.readdirSync(projectDir));
    } catch (err: unknown) {
      logDebug("projects list readdir", errorMessage(err));
      dirFiles = new Set();
    }
    const tags: string[] = [];
    if (dirFiles.has("FINDINGS.md")) tags.push("findings");
    if (TASK_FILE_ALIASES.some((filename) => dirFiles.has(filename))) tags.push("tasks");
    const tagStr = tags.length ? `  [${tags.join(", ")}]` : "";
    console.log(`  ${name}${tagStr}`);
  }
  console.log(`\n${projects.length} project(s) total.`);
  console.log("Add another project: cd ~/your-project && npx phren add");
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
    logDebug("projects remove countFiles", errorMessage(err));
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

// ── Task namespace ────────────────────────────────────────────────────────────

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
    const { handleTaskView } = await import("./cli-ops.js");
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

// ── Finding namespace ─────────────────────────────────────────────────────────

function printFindingUsage() {
  console.log("Usage:");
  console.log('  phren finding add <project> "<text>"');
  console.log('  phren finding remove <project> "<text>"');
  console.log('  phren finding supersede <project> "<text>" --by "<newer guidance>"');
  console.log('  phren finding retract <project> "<text>" --reason "<reason>"');
  console.log('  phren finding contradictions [project]');
  console.log('  phren finding resolve <project> "<finding_text>" "<other_text>" <keep_a|keep_b|keep_both|retract_both>');
}

export async function handleFindingNamespace(args: string[]) {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printFindingUsage();
    return;
  }

  if (subcommand === "list") {
    const project = args[1];
    if (!project) {
      console.error("Usage: phren finding list <project>");
      process.exit(1);
    }
    const { readFindings } = await import("./data-access.js");
    const result = readFindings(getPhrenPath(), project);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    const items = result.data;
    if (!items.length) {
      console.log(`No findings found for "${project}".`);
      return;
    }
    for (const entry of items.slice(0, 50)) {
      console.log(`- [${entry.id}] ${entry.date}: ${entry.text}`);
    }
    return;
  }

  if (subcommand === "add") {
    const project = args[1];
    const text = args.slice(2).join(" ");
    if (!project || !text) {
      console.error('Usage: phren finding add <project> "<text>"');
      process.exit(1);
    }
    const result = addFinding(getPhrenPath(), project, text);
    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }
    console.log(result.message);
    return;
  }

  if (subcommand === "remove") {
    const project = args[1];
    const text = args.slice(2).join(" ");
    if (!project || !text) {
      console.error('Usage: phren finding remove <project> "<text>"');
      process.exit(1);
    }
    const result = removeFinding(getPhrenPath(), project, text);
    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }
    console.log(result.message);
    return;
  }

  if (subcommand === "supersede") {
    const project = args[1];
    if (!project) {
      console.error('Usage: phren finding supersede <project> "<text>" --by "<newer guidance>"');
      process.exit(1);
    }
    const rest = args.slice(2);
    const byIdx = rest.indexOf("--by");
    const byEqIdx = rest.findIndex(a => a.startsWith("--by="));
    let text: string;
    let byValue: string;
    if (byEqIdx !== -1) {
      byValue = rest[byEqIdx].slice("--by=".length);
      text = rest.filter((_, i) => i !== byEqIdx && !rest[i].startsWith("--")).join(" ");
    } else if (byIdx !== -1) {
      text = rest.slice(0, byIdx).join(" ");
      byValue = rest.slice(byIdx + 1).join(" ");
    } else {
      text = "";
      byValue = "";
    }
    if (!text || !byValue) {
      console.error('Usage: phren finding supersede <project> "<text>" --by "<newer guidance>"');
      process.exit(1);
    }
    const result = supersedeFinding(getPhrenPath(), project, text, byValue);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`Finding superseded: "${result.data.finding}" -> "${result.data.superseded_by}"`);
    return;
  }

  if (subcommand === "retract") {
    const project = args[1];
    if (!project) {
      console.error('Usage: phren finding retract <project> "<text>" --reason "<reason>"');
      process.exit(1);
    }
    const rest = args.slice(2);
    const reasonIdx = rest.indexOf("--reason");
    const reasonEqIdx = rest.findIndex(a => a.startsWith("--reason="));
    let text: string;
    let reasonValue: string;
    if (reasonEqIdx !== -1) {
      reasonValue = rest[reasonEqIdx].slice("--reason=".length);
      text = rest.filter((_, i) => i !== reasonEqIdx && !rest[i].startsWith("--")).join(" ");
    } else if (reasonIdx !== -1) {
      text = rest.slice(0, reasonIdx).join(" ");
      reasonValue = rest.slice(reasonIdx + 1).join(" ");
    } else {
      text = "";
      reasonValue = "";
    }
    if (!text || !reasonValue) {
      console.error('Usage: phren finding retract <project> "<text>" --reason "<reason>"');
      process.exit(1);
    }
    const result = retractFinding(getPhrenPath(), project, text, reasonValue);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`Finding retracted: "${result.data.finding}" (reason: ${result.data.reason})`);
    return;
  }

  if (subcommand === "contradictions") {
    const project = args[1];
    const phrenPath = getPhrenPath();
    const RESERVED_DIRS = new Set(["global", ".runtime", ".sessions", ".config"]);
    const { readFindings } = await import("./data-access.js");
    const projects = project
      ? [project]
      : fs.readdirSync(phrenPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !RESERVED_DIRS.has(entry.name) && isValidProjectName(entry.name))
          .map((entry) => entry.name);

    const contradictions: Array<{ project: string; id: string; text: string; date: string; status_ref?: string }> = [];
    for (const p of projects) {
      const result = readFindings(phrenPath, p);
      if (!result.ok) continue;
      for (const finding of result.data) {
        if (finding.status !== "contradicted") continue;
        contradictions.push({ project: p, id: finding.id, text: finding.text, date: finding.date, status_ref: finding.status_ref });
      }
    }

    if (!contradictions.length) {
      console.log("No unresolved contradictions found.");
      return;
    }

    console.log(`${contradictions.length} unresolved contradiction(s):\n`);
    for (const c of contradictions) {
      console.log(`[${c.project}] ${c.date}  ${c.id}`);
      console.log(`  ${c.text}`);
      if (c.status_ref) console.log(`  contradicts: ${c.status_ref}`);
      console.log("");
    }
    return;
  }

  if (subcommand === "resolve") {
    const project = args[1];
    const findingText = args[2];
    const otherText = args[3];
    const resolution = args[4] as "keep_a" | "keep_b" | "keep_both" | "retract_both" | undefined;
    const validResolutions = ["keep_a", "keep_b", "keep_both", "retract_both"];
    if (!project || !findingText || !otherText || !resolution) {
      console.error('Usage: phren finding resolve <project> "<finding_text>" "<other_text>" <keep_a|keep_b|keep_both|retract_both>');
      process.exit(1);
    }
    if (!validResolutions.includes(resolution)) {
      console.error(`Invalid resolution "${resolution}". Valid values: ${validResolutions.join(", ")}`);
      process.exit(1);
    }
    const result = resolveFindingContradiction(getPhrenPath(), project, findingText, otherText, resolution);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`Resolved contradiction in "${project}" with "${resolution}".`);
    console.log(`  finding_a: ${result.data.finding_a.text} → ${result.data.finding_a.status}`);
    console.log(`  finding_b: ${result.data.finding_b.text} → ${result.data.finding_b.status}`);
    return;
  }

  console.error(`Unknown finding subcommand: ${subcommand}`);
  printFindingUsage();
  process.exit(1);
}
