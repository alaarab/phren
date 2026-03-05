import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import * as yaml from "js-yaml";
import { execSync } from "child_process";
import { configureClaude, configureVSCode } from "./init.js";
import { configureAllHooks, detectInstalledTools } from "./hooks.js";

const MACHINE_FILE = path.join(os.homedir(), ".cortex-machine");
const CONTEXT_FILE = path.join(os.homedir(), ".cortex-context.md");

const DEFAULT_SEARCH_PATHS = [
  os.homedir(),
  path.join(os.homedir(), "Sites"),
  path.join(os.homedir(), "Projects"),
  path.join(os.homedir(), "Code"),
  path.join(os.homedir(), "dev"),
];

function log(msg: string) { process.stdout.write(msg + "\n"); }

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
    execSync(`git add machines.yaml`, { cwd: cortexPath, stdio: "ignore" });
    execSync(`git commit -m "Register machine: ${machine} (${profile})" --allow-empty`, {
      cwd: cortexPath, stdio: "ignore",
    });
  } catch { /* best effort */ }

  log(`\nRegistered ${machine} with profile ${profile}.`);
  return { machine, profile };
}

function setupSparseCheckout(cortexPath: string, projects: string[]) {
  try {
    execSync("git rev-parse --git-dir", { cwd: cortexPath, stdio: "ignore" });
  } catch { return; } // Not a git repo

  const alwaysInclude = ["profiles", "machines.yaml", "global", "link.sh", "README.md", ".gitignore"];
  const paths = [...alwaysInclude, ...projects];
  try {
    execSync(`git sparse-checkout set ${paths.join(" ")}`, { cwd: cortexPath, stdio: "ignore" });
    execSync("git pull --ff-only", { cwd: cortexPath, stdio: "ignore" });
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
  const cortexPathEscaped = cortexPath.replace(/"/g, '\\"');
  const pullCmd = `cd "${cortexPathEscaped}" && git pull --rebase --quiet 2>/dev/null || true`;
  const stopCmd = `cd "${cortexPathEscaped}" && git diff --quiet 2>/dev/null || (git add -A && git commit -m 'auto-save cortex' && git push 2>/dev/null || true)`;

  const content = `---
name: cortex
description: Long-term memory system — injects project context and saves learnings across sessions
version: "1.0"
license: MIT
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${pullCmd}"
  UserPromptSubmit:
    - hooks:
        - type: command
          command: "npx @alaarab/cortex hook-prompt"
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

- **SessionStart**: pulls latest cortex knowledge from remote
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
}

export async function runLink(cortexPath: string, opts: LinkOptions = {}) {
  log("cortex link\n");

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
  let mcpStatus = "no_settings";
  try { mcpStatus = configureClaude(cortexPath) ?? "installed"; } catch { /* best effort */ }

  const mcpMessages: Record<string, string> = {
    installed: "  Claude: installed cortex MCP server",
    already_configured: "  Claude: cortex MCP already configured",
    not_built: "  MCP: no local dist found and npx not available.",
    no_settings: "  Claude settings not found (skipping)",
    no_jq: "  Claude: skipped (install jq to auto-configure)",
  };
  if (mcpMessages[mcpStatus]) log(mcpMessages[mcpStatus]);

  let vsStatus = "no_vscode";
  try { vsStatus = configureVSCode(cortexPath) ?? "no_vscode"; } catch { /* best effort */ }

  const vsMessages: Record<string, string> = {
    installed: "  VS Code: installed cortex MCP server",
    already_configured: "  VS Code: cortex MCP already configured",
    no_jq: "  VS Code: mcp.json exists but jq not available",
  };
  if (vsMessages[vsStatus]) log(vsMessages[vsStatus]);

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
    writeContextDebugging(machine, profile, mcpStatus, projects, cortexPath);
  } else if (opts.task === "planning") {
    writeContextPlanning(machine, profile, mcpStatus, projects, cortexPath);
  } else if (opts.task === "clean") {
    writeContextClean(machine, profile, mcpStatus, projects);
  } else {
    writeContextDefault(machine, profile, mcpStatus, projects, cortexPath);
  }

  // Step 8: Memory
  rebuildMemory(cortexPath, projects);

  log(`\nDone. Profile '${profile}' is active.`);
  if (opts.task) log(`Task mode: ${opts.task}`);
}
