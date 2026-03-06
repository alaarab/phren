import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import * as yaml from "js-yaml";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import {
  configureClaude,
  configureCodexMcp,
  configureCopilotMcp,
  configureCursorMcp,
  configureVSCode,
  ensureGovernanceFiles,
  getMcpEnabledPreference,
  setMcpEnabledPreference,
  type McpMode,
} from "./init.js";
import { buildLifecycleCommands, configureAllHooks, detectInstalledTools } from "./hooks.js";

const MACHINE_FILE = path.join(os.homedir(), ".cortex-machine");
const CONTEXT_FILE = path.join(os.homedir(), ".cortex-context.md");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const DEFAULT_SEARCH_PATHS = [
  os.homedir(),
  path.join(os.homedir(), "Sites"),
  path.join(os.homedir(), "Projects"),
  path.join(os.homedir(), "Code"),
  path.join(os.homedir(), "dev"),
];

function log(msg: string) { process.stdout.write(msg + "\n"); }

function logMcpStatus(tool: string, status: string) {
  const text: Record<string, string> = {
    installed: `${tool}: installed cortex MCP server`,
    already_configured: `${tool}: cortex MCP already configured`,
    disabled: `${tool}: cortex MCP disabled`,
    already_disabled: `${tool}: cortex MCP already disabled`,
    no_settings: `${tool}: settings not found (skipping)`,
    no_vscode: `${tool}: not detected`,
    no_cursor: `${tool}: not detected`,
    no_copilot: `${tool}: not detected`,
    no_codex: `${tool}: not detected`,
  };
  if (text[status]) log(`  ${text[status]}`);
}

function getMachineName(): string {
  if (fs.existsSync(MACHINE_FILE)) return fs.readFileSync(MACHINE_FILE, "utf8").trim();
  return os.hostname();
}

function lookupProfile(cortexPath: string, machine: string): string {
  const machinesFile = path.join(cortexPath, "machines.yaml");
  if (!fs.existsSync(machinesFile)) return "";
  const data = yaml.load(fs.readFileSync(machinesFile, "utf8")) as Record<string, any>;
  return data?.[machine] ?? "";
}

function listProfiles(cortexPath: string): Array<{ name: string; description: string }> {
  const profilesDir = path.join(cortexPath, "profiles");
  if (!fs.existsSync(profilesDir)) return [];
  return fs.readdirSync(profilesDir)
    .filter(f => f.endsWith(".yaml"))
    .map(f => {
      const data = yaml.load(fs.readFileSync(path.join(profilesDir, f), "utf8")) as any;
      return { name: data?.name ?? "", description: data?.description ?? "" };
    })
    .filter(p => p.name);
}

function findProfileFile(cortexPath: string, profileName: string): string | null {
  const profilesDir = path.join(cortexPath, "profiles");
  if (!fs.existsSync(profilesDir)) return null;
  for (const f of fs.readdirSync(profilesDir)) {
    if (!f.endsWith(".yaml")) continue;
    const data = yaml.load(fs.readFileSync(path.join(profilesDir, f), "utf8")) as any;
    if (data?.name === profileName) return path.join(profilesDir, f);
  }
  return null;
}

function getProfileProjects(profileFile: string): string[] {
  const data = yaml.load(fs.readFileSync(profileFile, "utf8")) as any;
  return Array.isArray(data?.projects) ? data.projects : [];
}

function allKnownProjects(cortexPath: string): string[] {
  const profilesDir = path.join(cortexPath, "profiles");
  if (!fs.existsSync(profilesDir)) return [];
  const projects = new Set<string>();
  for (const f of fs.readdirSync(profilesDir)) {
    if (!f.endsWith(".yaml")) continue;
    const data = yaml.load(fs.readFileSync(path.join(profilesDir, f), "utf8")) as any;
    for (const p of (data?.projects ?? [])) projects.add(p);
  }
  return [...projects].sort();
}

function findProjectDir(name: string): string | null {
  const extra = process.env.PROJECTS_DIR ? [process.env.PROJECTS_DIR] : [];
  for (const base of [...extra, ...DEFAULT_SEARCH_PATHS]) {
    const candidate = path.join(base, name);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    } catch { /* skip */ }
  }
  return null;
}

function displayName(slug: string): string {
  return slug.split("-").map(w => w[0]?.toUpperCase() + w.slice(1)).join(" ");
}

function semverParts(version: string): [number, number, number] {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [
    Number.parseInt(match[1], 10) || 0,
    Number.parseInt(match[2], 10) || 0,
    Number.parseInt(match[3], 10) || 0,
  ];
}

function isVersionNewer(current: string, previous?: string): boolean {
  if (!previous) return false;
  const [ca, cb, cc] = semverParts(current);
  const [pa, pb, pc] = semverParts(previous);
  if (ca !== pa) return ca > pa;
  if (cb !== pb) return cb > pb;
  return cc > pc;
}

function currentPackageVersion(): string | null {
  try {
    const pkgPath = path.join(ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version || null;
  } catch {
    return null;
  }
}

function maybeOfferStarterTemplateUpdate(cortexPath: string) {
  const current = currentPackageVersion();
  if (!current) return;
  const prefsPath = path.join(cortexPath, ".governance", "install-preferences.json");
  if (!fs.existsSync(prefsPath)) return;
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8")) as { installedVersion?: string };
    if (isVersionNewer(current, prefs.installedVersion)) {
      log(`  Starter template update available: v${prefs.installedVersion} -> v${current}`);
      log(`  Run \`npx @alaarab/cortex init --apply-starter-update\` to refresh global/CLAUDE.md and global skills.`);
    }
  } catch {
    // best effort
  }
}

async function registerMachine(cortexPath: string): Promise<{ machine: string; profile: string }> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>(r => rl.question(q, r));

  log("This machine isn't registered with cortex yet.\n");
  const machine = (await ask("What should this machine be called? (e.g. work-desktop): ")).trim();
  if (!machine) { rl.close(); throw new Error("Machine name can't be empty."); }

  log("\nAvailable profiles:");
  for (const p of listProfiles(cortexPath)) log(`  ${p.name}  (${p.description})`);
  log("");

  const profile = (await ask("Which profile? ")).trim();
  rl.close();
  if (!profile) throw new Error("Profile name can't be empty.");
  if (!findProfileFile(cortexPath, profile)) throw new Error(`No profile named '${profile}' found.`);

  // Write machine file
  fs.writeFileSync(MACHINE_FILE, machine);

  // Append to machines.yaml
  const machinesFile = path.join(cortexPath, "machines.yaml");
  const existing = fs.existsSync(machinesFile) ? fs.readFileSync(machinesFile, "utf8") : "";
  fs.writeFileSync(machinesFile, existing.trimEnd() + `\n${machine}: ${profile}\n`);

  // Commit if in git repo
  try {
    execFileSync("git", ["add", "machines.yaml"], { cwd: cortexPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", `Register machine: ${machine} (${profile})`, "--allow-empty"], {
      cwd: cortexPath, stdio: "ignore",
    });
  } catch { /* best effort */ }

  log(`\nRegistered ${machine} with profile ${profile}.`);
  return { machine, profile };
}

function setupSparseCheckout(cortexPath: string, projects: string[]) {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: cortexPath, stdio: "ignore" });
  } catch { return; } // Not a git repo

  const alwaysInclude = ["profiles", "machines.yaml", "global", "link.sh", "README.md", ".gitignore"];
  const paths = [...alwaysInclude, ...projects];
  try {
    execFileSync("git", ["sparse-checkout", "set", ...paths], { cwd: cortexPath, stdio: "ignore" });
    execFileSync("git", ["pull", "--ff-only"], { cwd: cortexPath, stdio: "ignore" });
  } catch { /* best effort */ }
}

function symlinkFile(src: string, dest: string) {
  try {
    if (fs.lstatSync(dest)) fs.unlinkSync(dest);
  } catch { /* dest doesn't exist */ }
  fs.symlinkSync(src, dest);
}

// ── SKILL.md ──────────────────────────────────────────────────────────────────

function writeSkillMd(cortexPath: string) {
  const lifecycle = buildLifecycleCommands(cortexPath);
  const sessionStartCmd = lifecycle.sessionStart.replace(/"/g, '\\"');
  const promptCmd = lifecycle.userPromptSubmit.replace(/"/g, '\\"');
  const stopCmd = lifecycle.stop.replace(/"/g, '\\"');

  const content = `---
name: cortex
description: Long-term memory system — injects project context and saves learnings across sessions
version: "1.0"
license: MIT
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${sessionStartCmd}"
  UserPromptSubmit:
    - hooks:
        - type: command
          command: "${promptCmd}"
          timeout: 3
  Stop:
    - hooks:
        - type: command
          command: "${stopCmd}"
---

# cortex

Cortex is a long-term memory system for AI coding agents. It injects relevant project
context at the start of each prompt and saves learnings at session end via git.

## What it does

- **SessionStart**: pulls latest cortex knowledge and self-heals hook/symlink drift
- **UserPromptSubmit**: injects relevant project context, learnings, and backlog items
- **Stop**: commits and pushes any new learnings to remote

## MCP tools (when cortex MCP server is running)

- \`search_cortex\` — semantic search across all project knowledge
- \`get_project_summary\` — get summary + CLAUDE.md for a project
- \`list_projects\` — list all known projects
- \`save_learnings\` — save a new learning to a project
`;

  const dest = path.join(cortexPath, "cortex.SKILL.md");
  fs.writeFileSync(dest, content);
}

function linkGlobal(cortexPath: string, tools: Set<string>) {
  log("  global skills -> ~/.claude/skills/");
  const skillsDir = path.join(os.homedir(), ".claude", "skills");
  fs.mkdirSync(skillsDir, { recursive: true });

  const globalSkillsDir = path.join(cortexPath, "global", "skills");
  if (fs.existsSync(globalSkillsDir)) {
    for (const f of fs.readdirSync(globalSkillsDir)) {
      const src = path.join(globalSkillsDir, f);
      if (fs.statSync(src).isFile()) symlinkFile(src, path.join(skillsDir, f));
    }
  }

  const globalClaude = path.join(cortexPath, "global", "CLAUDE.md");
  if (fs.existsSync(globalClaude)) {
    symlinkFile(globalClaude, path.join(os.homedir(), ".claude", "CLAUDE.md"));
    if (tools.has("copilot")) {
      try {
        const copilotInstrDir = path.join(os.homedir(), ".github");
        fs.mkdirSync(copilotInstrDir, { recursive: true });
        symlinkFile(globalClaude, path.join(copilotInstrDir, "copilot-instructions.md"));
      } catch { /* best effort */ }
    }
  }
}

function addTokenAnnotation(filePath: string) {
  const content = fs.readFileSync(filePath, "utf8");
  if (content.startsWith("<!-- tokens:")) return;
  const tokens = Math.round(content.length / 4);
  if (tokens <= 500) return;
  const rounded = Math.round((tokens + 50) / 100) * 100;
  fs.writeFileSync(filePath, `<!-- tokens: ~${rounded} -->\n${content}`);
}

function linkProject(cortexPath: string, project: string, tools: Set<string>) {
  const target = findProjectDir(project);
  if (!target) { log(`  skip ${project} (not found on disk)`); return; }
  log(`  ${project} -> ${target}`);

  for (const f of ["CLAUDE.md", "KNOWLEDGE.md", "LEARNINGS.md"]) {
    const src = path.join(cortexPath, project, f);
    if (fs.existsSync(src)) {
      symlinkFile(src, path.join(target, f));
      if (f === "CLAUDE.md") {
        if (tools.has("codex")) {
          try { symlinkFile(src, path.join(target, "AGENTS.md")); } catch { /* best effort */ }
        }
        if (tools.has("copilot")) {
          try {
            const copilotDir = path.join(target, ".github");
            fs.mkdirSync(copilotDir, { recursive: true });
            symlinkFile(src, path.join(copilotDir, "copilot-instructions.md"));
          } catch { /* best effort */ }
        }
      }
    }
  }

  // CLAUDE-*.md split files
  const projectDir = path.join(cortexPath, project);
  if (fs.existsSync(projectDir)) {
    for (const f of fs.readdirSync(projectDir)) {
      if (/^CLAUDE-.+\.md$/.test(f)) symlinkFile(path.join(projectDir, f), path.join(target, f));
    }
  }

  // Token annotation on CLAUDE.md
  const claudeFile = path.join(cortexPath, project, "CLAUDE.md");
  if (fs.existsSync(claudeFile)) {
    try { addTokenAnnotation(claudeFile); } catch { /* best effort */ }
  }

  // Project-level skills
  const projectSkills = path.join(cortexPath, project, ".claude", "skills");
  if (fs.existsSync(projectSkills)) {
    const targetSkills = path.join(target, ".claude", "skills");
    fs.mkdirSync(targetSkills, { recursive: true });
    for (const f of fs.readdirSync(projectSkills)) {
      const src = path.join(projectSkills, f);
      if (fs.statSync(src).isFile()) symlinkFile(src, path.join(targetSkills, f));
    }
  }
}

function writeContextFile(managedContent: string) {
  const wrapped = `<!-- cortex-managed -->\n${managedContent}\n<!-- /cortex-managed -->`;
  if (fs.existsSync(CONTEXT_FILE)) {
    const existing = fs.readFileSync(CONTEXT_FILE, "utf8");
    if (existing.includes("<!-- cortex-managed -->")) {
      const startIdx = existing.indexOf("<!-- cortex-managed -->");
      const endIdx = existing.indexOf("<!-- /cortex-managed -->");
      const before = startIdx > 0 ? existing.slice(0, startIdx).trimEnd() : "";
      const after = endIdx !== -1 ? existing.slice(endIdx + "<!-- /cortex-managed -->".length).trimStart() : "";
      const parts = [before, wrapped, after].filter(Boolean);
      fs.writeFileSync(CONTEXT_FILE, parts.join("\n") + "\n");
      return;
    }
  }
  fs.writeFileSync(CONTEXT_FILE, wrapped + "\n");
}

function formatMcpStatus(status: string): string {
  if (status === "installed" || status === "already_configured") {
    return "MCP: active (search_cortex, get_project_summary, list_projects)";
  }
  if (status === "disabled" || status === "already_disabled") {
    return "MCP: disabled (hooks-only fallback active)";
  }
  if (status === "not_built") return "MCP: not built. Run: cd mcp && npm install && npm run build";
  return "";
}

function writeContextDefault(machine: string, profile: string, mcpStatus: string, projects: string[], cortexPath: string) {
  const all = allKnownProjects(cortexPath);
  const inactive = all.filter(p => !projects.includes(p));
  const mcpLine = formatMcpStatus(mcpStatus);
  const lines = [
    "# cortex context",
    `Machine: ${machine}`,
    `Profile: ${profile}`,
    `Active projects: ${projects.join(", ")}`,
    `Not on this machine: ${inactive.length ? inactive.join(", ") : "none"}`,
    ...(mcpLine ? [mcpLine] : []),
    `Last synced: ${new Date().toISOString().slice(0, 10)}`,
  ];
  writeContextFile(lines.join("\n"));
  log(`  wrote ${CONTEXT_FILE}`);
}

function writeContextDebugging(machine: string, profile: string, mcpStatus: string, projects: string[], cortexPath: string) {
  const mcpLine = formatMcpStatus(mcpStatus);
  let content = [
    "# cortex context (debugging)",
    `Machine: ${machine}`,
    `Profile: ${profile}`,
    `Last synced: ${new Date().toISOString().slice(0, 10)}`,
    ...(mcpLine ? [mcpLine] : []),
  ].join("\n") + "\n\n## Project Learnings\n";

  for (const project of projects) {
    if (project === "global") continue;
    const learnings = path.join(cortexPath, project, "LEARNINGS.md");
    if (fs.existsSync(learnings)) {
      content += `\n### ${project}\n${fs.readFileSync(learnings, "utf8")}\n`;
    }
  }
  writeContextFile(content);
  log(`  wrote ${CONTEXT_FILE} (debugging mode)`);
}

function writeContextPlanning(machine: string, profile: string, mcpStatus: string, projects: string[], cortexPath: string) {
  const mcpLine = formatMcpStatus(mcpStatus);
  let content = [
    "# cortex context (planning)",
    `Machine: ${machine}`,
    `Profile: ${profile}`,
    `Last synced: ${new Date().toISOString().slice(0, 10)}`,
    ...(mcpLine ? [mcpLine] : []),
  ].join("\n");

  for (const project of projects) {
    if (project === "global") continue;
    const summaryFile = path.join(cortexPath, project, "summary.md");
    const backlogFile = path.join(cortexPath, project, "backlog.md");
    if (!fs.existsSync(summaryFile) && !fs.existsSync(backlogFile)) continue;
    content += `\n\n## ${project}\n`;
    if (fs.existsSync(summaryFile)) content += fs.readFileSync(summaryFile, "utf8") + "\n";
    if (fs.existsSync(backlogFile)) content += `\n### Backlog\n${fs.readFileSync(backlogFile, "utf8")}\n`;
  }
  writeContextFile(content);
  log(`  wrote ${CONTEXT_FILE} (planning mode)`);
}

function writeContextClean(machine: string, profile: string, mcpStatus: string, projects: string[]) {
  const mcpLine = formatMcpStatus(mcpStatus);
  let content = `# cortex context (clean)\nMachine: ${machine} | Profile: ${profile} | Projects: ${projects.join(", ")}\n`;
  if (mcpLine) content += mcpLine + "\n";
  writeContextFile(content);
  log(`  wrote ${CONTEXT_FILE} (clean mode)`);
}

function rebuildMemory(cortexPath: string, projects: string[]) {
  const user = os.userInfo().username;
  const memoryDir = path.join(os.homedir(), ".claude", "projects", `-home-${user}`, "memory");
  const memoryFile = path.join(memoryDir, "MEMORY.md");

  const hasSummaries = projects.some(p =>
    p !== "global" && fs.existsSync(path.join(cortexPath, p, "summary.md"))
  );
  if (!hasSummaries) return;

  fs.mkdirSync(memoryDir, { recursive: true });

  let header = "";
  if (fs.existsSync(memoryFile)) {
    const existing = fs.readFileSync(memoryFile, "utf8");
    const idx = existing.indexOf("<!-- cortex:projects:start -->");
    if (idx !== -1) header = existing.slice(0, idx);
  }

  let managed = "<!-- cortex:projects:start -->\n<!-- Auto-generated by cortex link. Do not edit below this line. -->\n\n## Active Projects\n\n| Project | What | Memory |\n|---------|------|--------|\n";
  for (const project of projects) {
    if (project === "global") continue;
    const summaryFile = path.join(cortexPath, project, "summary.md");
    if (!fs.existsSync(summaryFile)) continue;
    const summary = fs.readFileSync(summaryFile, "utf8");
    const whatMatch = summary.match(/^\*\*What:\*\*\s*(.+)/m);
    const what = whatMatch?.[1]?.trim() ?? "(see summary)";
    managed += `| ${displayName(project)} | ${what} | MEMORY-${project}.md |\n`;
  }
  managed += "\n<!-- cortex:projects:end -->";

  const freshHeader = "# Root Memory\n\n## Machine Context\nRead `~/.cortex-context.md` for profile, active projects, last sync date.\n\n## Cross-Project Notes\n- Read a project's CLAUDE.md before making changes.\n- Per-project memory files (MEMORY-{name}.md) have commands, versions, gotchas.\n\n";
  fs.writeFileSync(memoryFile, (header || freshHeader) + managed + "\n");
  log(`  rebuilt ${memoryFile} (pointer format)`);

  for (const project of projects) {
    if (project === "global") continue;
    const summaryFile = path.join(cortexPath, project, "summary.md");
    if (!fs.existsSync(summaryFile)) continue;
    const projectMemory = path.join(memoryDir, `MEMORY-${project}.md`);
    if (!fs.existsSync(projectMemory)) {
      fs.writeFileSync(projectMemory, `# ${displayName(project)}\n\n${fs.readFileSync(summaryFile, "utf8")}\n\n## Notes\n<!-- Session learnings, patterns, decisions -->\n`);
      log(`  created ${projectMemory}`);
    }
  }
}

export interface LinkOptions {
  machine?: string;
  profile?: string;
  register?: boolean;
  task?: "debugging" | "planning" | "clean";
  allTools?: boolean;   // configure hooks for all tools regardless of detection
  mcp?: McpMode;
}

export interface DoctorResult {
  ok: boolean;
  machine?: string;
  profile?: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export async function runLink(cortexPath: string, opts: LinkOptions = {}) {
  log("cortex link\n");
  ensureGovernanceFiles(cortexPath);

  // Step 1: Identify machine + profile
  let machine = opts.machine ?? getMachineName();
  let profile = "";

  if (opts.profile) {
    profile = opts.profile;
  } else if (opts.register) {
    const reg = await registerMachine(cortexPath);
    machine = reg.machine;
    profile = reg.profile;
  } else {
    profile = lookupProfile(cortexPath, machine);
    if (!profile) {
      const reg = await registerMachine(cortexPath);
      machine = reg.machine;
      profile = reg.profile;
    }
  }

  if (!profile) throw new Error(`Could not determine profile for machine '${machine}'.`);

  // Step 2: Find profile file
  const profileFile = findProfileFile(cortexPath, profile);
  if (!profileFile) throw new Error(`Profile '${profile}' not found in profiles/.`);

  log(`Machine: ${machine}`);
  log(`Profile: ${profile} (${profileFile})\n`);

  // Step 3: Read projects
  const projects = getProfileProjects(profileFile);
  if (!projects.length) throw new Error(`Profile '${profile}' has no projects listed.`);

  // Step 4: Sparse checkout
  log("Setting up sparse checkout...");
  setupSparseCheckout(cortexPath, projects);
  log("");

  // Detect installed tools once — used for symlinks and hook registration
  const detectedTools = opts.allTools
    ? new Set(["copilot", "cursor", "codex"])
    : detectInstalledTools();

  // Step 5: Symlink
  log("Linking...");
  linkGlobal(cortexPath, detectedTools);
  for (const p of projects) {
    if (p !== "global") linkProject(cortexPath, p, detectedTools);
  }
  log("");

  // Step 6: Configure MCP
  log("Configuring MCP...");
  const mcpEnabled = opts.mcp ? opts.mcp === "on" : getMcpEnabledPreference(cortexPath);
  setMcpEnabledPreference(cortexPath, mcpEnabled);
  log(`  MCP mode: ${mcpEnabled ? "ON (recommended)" : "OFF (hooks-only fallback)"}`);
  maybeOfferStarterTemplateUpdate(cortexPath);
  let mcpStatus = "no_settings";
  try { mcpStatus = configureClaude(cortexPath, { mcpEnabled }) ?? "installed"; } catch { /* best effort */ }
  logMcpStatus("Claude", mcpStatus);

  let vsStatus = "no_vscode";
  try { vsStatus = configureVSCode(cortexPath, { mcpEnabled }) ?? "no_vscode"; } catch { /* best effort */ }
  logMcpStatus("VS Code", vsStatus);

  let cursorStatus = "no_cursor";
  try { cursorStatus = configureCursorMcp(cortexPath, { mcpEnabled }) ?? "no_cursor"; } catch { /* best effort */ }
  logMcpStatus("Cursor", cursorStatus);

  let copilotStatus = "no_copilot";
  try { copilotStatus = configureCopilotMcp(cortexPath, { mcpEnabled }) ?? "no_copilot"; } catch { /* best effort */ }
  logMcpStatus("Copilot CLI", copilotStatus);

  let codexStatus = "no_codex";
  try { codexStatus = configureCodexMcp(cortexPath, { mcpEnabled }) ?? "no_codex"; } catch { /* best effort */ }
  logMcpStatus("Codex", codexStatus);
  const mcpStatusForContext = [mcpStatus, vsStatus, cursorStatus, copilotStatus, codexStatus].some(
    (s) => s === "installed" || s === "already_configured"
  )
    ? "installed"
    : [mcpStatus, vsStatus, cursorStatus, copilotStatus, codexStatus].some(
      (s) => s === "disabled" || s === "already_disabled"
    )
      ? "disabled"
      : mcpStatus;

  // Register hooks for Copilot CLI, Cursor, Codex (reuse same detected set)
  const hookedTools = configureAllHooks(cortexPath, detectedTools);
  if (hookedTools.length) log(`  Hooks registered: ${hookedTools.join(", ")}`);

  // Write cortex.SKILL.md for agentskills-compatible tools
  try {
    writeSkillMd(cortexPath);
    log(`  cortex.SKILL.md written (agentskills-compatible tools)`);
  } catch { /* best effort */ }
  log("");

  // Step 7: Context file
  if (opts.task === "debugging") {
    writeContextDebugging(machine, profile, mcpStatusForContext, projects, cortexPath);
  } else if (opts.task === "planning") {
    writeContextPlanning(machine, profile, mcpStatusForContext, projects, cortexPath);
  } else if (opts.task === "clean") {
    writeContextClean(machine, profile, mcpStatusForContext, projects);
  } else {
    writeContextDefault(machine, profile, mcpStatusForContext, projects, cortexPath);
  }

  // Step 8: Memory
  rebuildMemory(cortexPath, projects);

  log(`\nDone. Profile '${profile}' is active.`);
  if (opts.task) log(`Task mode: ${opts.task}`);
}

function isWrapperActive(tool: string): boolean {
  const wrapperPath = path.join(os.homedir(), ".local", "bin", tool);
  if (!fs.existsSync(wrapperPath)) return false;
  try {
    const resolved = execFileSync("bash", ["-lc", `command -v ${tool}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return path.resolve(resolved) === path.resolve(wrapperPath);
  } catch {
    return false;
  }
}

export async function runDoctor(cortexPath: string, fix: boolean = false): Promise<DoctorResult> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const machine = getMachineName();
  const profile = lookupProfile(cortexPath, machine);

  checks.push({
    name: "machine-registered",
    ok: Boolean(profile),
    detail: profile
      ? `machine=${machine} profile=${profile}`
      : `no profile mapping for machine=${machine} in machines.yaml`,
  });

  const profileFile = profile ? findProfileFile(cortexPath, profile) : null;
  checks.push({
    name: "profile-exists",
    ok: Boolean(profileFile),
    detail: profileFile ? `profile file found: ${profileFile}` : "profile file missing",
  });

  const projects = profileFile ? getProfileProjects(profileFile) : [];
  checks.push({
    name: "profile-projects",
    ok: projects.length > 0,
    detail: projects.length ? `${projects.length} projects in profile` : "no projects listed",
  });

  const contextFile = path.join(os.homedir(), ".cortex-context.md");
  checks.push({
    name: "context-file",
    ok: fs.existsSync(contextFile),
    detail: fs.existsSync(contextFile) ? contextFile : "missing ~/.cortex-context.md",
  });

  const memoryFile = path.join(
    os.homedir(),
    ".claude",
    "projects",
    `-home-${os.userInfo().username}`,
    "memory",
    "MEMORY.md"
  );
  checks.push({
    name: "root-memory",
    ok: fs.existsSync(memoryFile),
    detail: fs.existsSync(memoryFile) ? memoryFile : "missing generated MEMORY.md",
  });

  const globalClaudeSrc = path.join(cortexPath, "global", "CLAUDE.md");
  const globalClaudeDest = path.join(os.homedir(), ".claude", "CLAUDE.md");
  let globalLinkOk = false;
  try {
    globalLinkOk = fs.existsSync(globalClaudeDest) && fs.realpathSync(globalClaudeDest) === fs.realpathSync(globalClaudeSrc);
  } catch {
    globalLinkOk = false;
  }
  checks.push({
    name: "global-link",
    ok: globalLinkOk,
    detail: globalLinkOk ? "global CLAUDE.md symlink ok" : "global CLAUDE.md link drifted/missing",
  });

  for (const project of projects) {
    if (project === "global") continue;
    const target = findProjectDir(project);
    if (!target) {
      checks.push({ name: `project-path:${project}`, ok: false, detail: "project directory not found on disk" });
      continue;
    }
    for (const f of ["CLAUDE.md", "KNOWLEDGE.md", "LEARNINGS.md"]) {
      const src = path.join(cortexPath, project, f);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(target, f);
      let ok = false;
      try {
        ok = fs.existsSync(dest) && fs.realpathSync(dest) === fs.realpathSync(src);
      } catch {
        ok = false;
      }
      checks.push({
        name: `symlink:${project}/${f}`,
        ok,
        detail: ok ? "ok" : `missing/drifted link at ${dest}`,
      });
    }
  }

  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let hookOk = false;
  let lifecycleOk = false;
  try {
    const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const hooks = cfg?.hooks || {};
    const promptHooks = JSON.stringify(hooks.UserPromptSubmit || []);
    const stopHooks = JSON.stringify(hooks.Stop || []);
    const startHooks = JSON.stringify(hooks.SessionStart || []);
    hookOk = promptHooks.includes("hook-prompt");
    const stopHookOk = stopHooks.includes("hook-stop") || stopHooks.includes("auto-save");
    const startHookOk = startHooks.includes("hook-session-start") || startHooks.includes("doctor --fix");
    lifecycleOk = stopHookOk && startHookOk;
  } catch {
    hookOk = false;
    lifecycleOk = false;
  }
  checks.push({
    name: "claude-hooks",
    ok: hookOk,
    detail: hookOk ? "prompt hook configured" : "missing prompt hook in ~/.claude/settings.json",
  });
  checks.push({
    name: "lifecycle-hooks",
    ok: lifecycleOk,
    detail: lifecycleOk
      ? "session-start + stop lifecycle hooks configured"
      : "missing lifecycle hooks (expected hook-session-start and hook-stop)",
  });

  const runtimeHealthPath = path.join(cortexPath, ".governance", "runtime-health.json");
  let runtime: any = null;
  if (fs.existsSync(runtimeHealthPath)) {
    try { runtime = JSON.parse(fs.readFileSync(runtimeHealthPath, "utf8")); } catch { runtime = null; }
  }
  checks.push({
    name: "runtime-health-file",
    ok: Boolean(runtime),
    detail: runtime ? runtimeHealthPath : "missing or unreadable .governance/runtime-health.json",
  });
  const autoSaveStatus = runtime?.lastAutoSave?.status as string | undefined;
  const autoSaveAt = runtime?.lastAutoSave?.at as string | undefined;
  checks.push({
    name: "runtime-auto-save",
    ok: autoSaveStatus === "saved-pushed" || autoSaveStatus === "saved-local" || autoSaveStatus === "clean",
    detail: autoSaveStatus
      ? `last auto-save: ${autoSaveStatus}${autoSaveAt ? ` @ ${autoSaveAt}` : ""}`
      : "no auto-save runtime record yet",
  });
  checks.push({
    name: "runtime-prompt",
    ok: Boolean(runtime?.lastPromptAt),
    detail: runtime?.lastPromptAt ? `last prompt hook run @ ${runtime.lastPromptAt}` : "no prompt runtime record yet",
  });

  const detected = detectInstalledTools();
  if (detected.has("copilot")) {
    const copilotHooks = path.join(os.homedir(), ".github", "hooks", "cortex.json");
    checks.push({
      name: "copilot-hooks",
      ok: fs.existsSync(copilotHooks),
      detail: fs.existsSync(copilotHooks) ? "copilot hooks config present" : "missing ~/.github/hooks/cortex.json",
    });
  }
  if (detected.has("cursor")) {
    const cursorHooks = path.join(os.homedir(), ".cursor", "hooks.json");
    checks.push({
      name: "cursor-hooks",
      ok: fs.existsSync(cursorHooks),
      detail: fs.existsSync(cursorHooks) ? "cursor hooks config present" : "missing ~/.cursor/hooks.json",
    });
  }
  if (detected.has("codex")) {
    const codexHooks = path.join(cortexPath, "codex.json");
    checks.push({
      name: "codex-hooks",
      ok: fs.existsSync(codexHooks),
      detail: fs.existsSync(codexHooks) ? "codex hooks config present" : "missing codex.json in cortex root",
    });
  }
  for (const tool of ["copilot", "cursor", "codex"]) {
    if (!detected.has(tool)) continue;
    const active = isWrapperActive(tool);
    checks.push({
      name: `wrapper:${tool}`,
      ok: active,
      detail: active
        ? `${tool} wrapper active via ~/.local/bin/${tool}`
        : `${tool} wrapper missing or not first in PATH`,
    });
  }

  if (fix && profile && profileFile) {
    await runLink(cortexPath, { machine, profile });
    checks.push({ name: "self-heal", ok: true, detail: "relinked hooks, symlinks, context, memory pointers" });
  } else if (fix) {
    checks.push({ name: "self-heal", ok: false, detail: "blocked: machine/profile not fully configured" });
  } else {
    const detectedTools = detectInstalledTools();
    const hooked = configureAllHooks(cortexPath, detectedTools);
    checks.push({
      name: "hooks",
      ok: hooked.length > 0 || detectedTools.size === 0,
      detail: hooked.length ? `hook configs present for: ${hooked.join(", ")}` : "no external tools detected",
    });
  }

  const ok = checks.every((c) => c.ok);
  return { ok, machine, profile: profile || undefined, checks };
}
