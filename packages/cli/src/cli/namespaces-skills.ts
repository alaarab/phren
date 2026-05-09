import * as fs from "fs";
import * as path from "path";
import {
  expandHomePath,
  getPhrenPath,
  getProjectDirs,
  homePath,
  hookConfigPath,
} from "../shared.js";
import { isValidProjectName, errorMessage, getOptionValue } from "../utils.js";
import { logger } from "../logger.js";
import { readInstallPreferences, writeInstallPreferences, type InstallPreferences } from "../init/preferences.js";
import { buildSkillManifest, findLocalSkill, findSkill, getAllSkills } from "../skill/registry.js";
import { detectSkillCollisions } from "../link/skills.js";
import { setSkillEnabledAndSync, syncSkillLinksForScope } from "../skill/files.js";
import { findProjectDir } from "../project-locator.js";
import { readCustomHooks, getHookTarget, HOOK_EVENT_VALUES, validateCustomHookCommand, type CustomHookEntry } from "../hooks.js";
import { runtimeFile } from "../shared.js";
import {
  readProjectConfig,
  PROJECT_HOOK_EVENTS,
  isProjectHookEnabled,
} from "../project-config.js";
import { resolveProjectStorePath, openInEditor } from "./namespaces-utils.js";

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

function findSkillPath(name: string, profile: string, project?: string): string | null {
  const found = findSkill(getPhrenPath(), profile, project, name);
  if (!found || "error" in found) return null;
  return found.path;
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
      if ((process.env.PHREN_DEBUG)) logger.debug("cli-namespaces", `skill add symlinkFailed: ${errorMessage(err)}`);
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
    if (project && !isValidProjectName(project)) {
      console.error(`Project "${project}" not found.`);
      process.exit(1);
    }
    if (project) {
      const storePath = resolveProjectStorePath(phrenPath, project);
      if (!fs.existsSync(path.join(storePath, project))) {
        console.error(`Project "${project}" not found.`);
        process.exit(1);
      }
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
      if ((process.env.PHREN_DEBUG)) logger.debug("cli-namespaces", `skillList lstat: ${errorMessage(err)}`);
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
