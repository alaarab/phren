import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { findCortexPath, detectProject, getProjectDirs, EXEC_TIMEOUT_QUICK_MS } from "./shared.js";
import { getMcpEnabledPreference, getHooksEnabledPreference } from "./init.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function check(ok: boolean): string {
  return ok ? `${GREEN}ok${RESET}` : `${RED}missing${RESET}`;
}

function countBullets(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, "utf8");
  return content.split("\n").filter((l) => l.startsWith("- ")).length;
}

function countQueueItems(cortexPath: string, project: string): number {
  const queueFile = path.join(cortexPath, project, "MEMORY_QUEUE.md");
  return countBullets(queueFile);
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_QUICK_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export async function runStatus() {
  const cortexPath = findCortexPath();
  if (!cortexPath) {
    console.log(`${RED}cortex not found${RESET}. Run ${CYAN}npx @alaarab/cortex init${RESET} to set up.`);
    process.exit(1);
  }

  const cwd = process.cwd();
  const profile = process.env.CORTEX_PROFILE || "";
  const activeProject = detectProject(cortexPath, cwd, profile);

  console.log(`\n${BOLD}cortex status${RESET}\n`);

  // Active project
  if (activeProject) {
    console.log(`  ${BOLD}Project:${RESET}  ${CYAN}${activeProject}${RESET} ${DIM}(detected from cwd)${RESET}`);
  } else {
    console.log(`  ${BOLD}Project:${RESET}  ${DIM}none detected${RESET}`);
  }

  // Cortex path
  console.log(`  ${BOLD}Path:${RESET}     ${cortexPath}`);
  if (profile) {
    console.log(`  ${BOLD}Profile:${RESET}  ${profile}`);
  }

  // MCP + hooks status
  const mcpEnabled = getMcpEnabledPreference(cortexPath);
  const hooksEnabled = getHooksEnabledPreference(cortexPath);
  console.log(`  ${BOLD}MCP:${RESET}      ${mcpEnabled ? `${GREEN}on${RESET}` : `${YELLOW}off${RESET}`}`);
  console.log(`  ${BOLD}Hooks:${RESET}    ${hooksEnabled ? `${GREEN}on${RESET}` : `${YELLOW}off${RESET}`}`);

  // Hook health: check ~/.claude/settings.json
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let hooksInstalled = false;
  let mcpConfigured = false;
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      mcpConfigured = Boolean(settings.mcpServers?.cortex || settings.servers?.cortex);
      const hookEvents = ["UserPromptSubmit", "Stop", "SessionStart"];
      hooksInstalled = hookEvents.some((event) => {
        const hooks = settings.hooks?.[event];
        if (!Array.isArray(hooks)) return false;
        return hooks.some((h: any) =>
          h.hooks?.some((hook: any) =>
            typeof hook.command === "string" && hook.command.includes("cortex")
          )
        );
      });
    } catch { /* malformed settings */ }
  }
  console.log(`  ${BOLD}MCP cfg:${RESET}  ${check(mcpConfigured)} ${DIM}(in settings.json)${RESET}`);
  console.log(`  ${BOLD}Hooks cfg:${RESET} ${check(hooksInstalled)} ${DIM}(in settings.json)${RESET}`);

  // Stats
  const projectDirs = getProjectDirs(cortexPath, profile);
  let totalLearnings = 0;
  let totalBacklog = 0;
  let totalQueue = 0;

  for (const dir of projectDirs) {
    const projName = path.basename(dir);
    totalLearnings += countBullets(path.join(cortexPath, projName, "LEARNINGS.md"));
    totalBacklog += countBullets(path.join(cortexPath, projName, "backlog.md"));
    totalQueue += countQueueItems(cortexPath, projName);
  }

  console.log(`\n  ${BOLD}Stats:${RESET}    ${projectDirs.length} projects, ${totalLearnings} learnings, ${totalBacklog} backlog, ${totalQueue} queued`);

  // Recent changes (git log)
  const isGitRepo = runGit(cortexPath, ["rev-parse", "--is-inside-work-tree"]);
  if (isGitRepo === "true") {
    const log = runGit(cortexPath, ["log", "--oneline", "-5", "--no-decorate"]);
    if (log) {
      console.log(`\n  ${BOLD}Recent changes:${RESET}`);
      for (const line of log.split("\n")) {
        console.log(`    ${DIM}${line}${RESET}`);
      }
    }
    const dirty = runGit(cortexPath, ["status", "--porcelain"]);
    if (dirty) {
      const count = dirty.split("\n").filter(Boolean).length;
      console.log(`    ${YELLOW}${count} uncommitted change(s)${RESET}`);
    }
  } else {
    console.log(`\n  ${DIM}~/.cortex is not a git repo${RESET}`);
  }

  console.log("");
}
