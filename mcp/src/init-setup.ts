/**
 * Governance files, root file migration, verification, starter templates, bootstrap.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import {
  debugLog,
  findProjectNameCaseInsensitive,
  hookConfigPath,
  EXEC_TIMEOUT_QUICK_MS,
} from "./shared.js";
import { addProjectToProfile, listProfiles, resolveActiveProfile } from "./profile-store.js";
import { execFileSync } from "child_process";
import {
  GOVERNANCE_SCHEMA_VERSION,
  migrateGovernanceFiles,
} from "./shared-governance.js";
import { errorMessage } from "./utils.js";
import { ROOT, STARTER_DIR, VERSION } from "./init-shared.js";
import { readInstallPreferences } from "./init-preferences.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function atomicWriteText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

export interface PostInitCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

interface HookEntrypointCheckDeps {
  pathExists?: typeof fs.existsSync;
  versionReader?: typeof commandVersion;
}

function commandVersion(cmd: string, args: string[] = ["--version"]): string | null {
  const effectiveCmd = process.platform === "win32" && (cmd === "npm" || cmd === "npx") ? `${cmd}.cmd` : cmd;
  try {
    return execFileSync(effectiveCmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32" && effectiveCmd.endsWith(".cmd"),
      timeout: EXEC_TIMEOUT_QUICK_MS,
    }).trim();
  } catch (err: unknown) {
    debugLog(`commandVersion ${effectiveCmd} failed: ${errorMessage(err)}`);
    return null;
  }
}

export function getHookEntrypointCheck(deps: HookEntrypointCheckDeps = {}): PostInitCheck {
  const pathExists = deps.pathExists ?? fs.existsSync;
  const versionReader = deps.versionReader ?? commandVersion;
  const distIndex = path.join(__dirname, "index.js");
  const localEntrypointOk = pathExists(distIndex);
  const hookEntrypointOk = localEntrypointOk || Boolean(versionReader("npx", ["--version"]));
  const detail = localEntrypointOk
    ? "Hook entrypoint available via local dist/index.js"
    : hookEntrypointOk
      ? "Hook entrypoint available via npx fallback"
      : "Hook entrypoint missing and npx unavailable, hooks will fail";
  return {
    name: "hook-entrypoint",
    ok: hookEntrypointOk,
    detail,
    fix: hookEntrypointOk ? undefined : "Rebuild cortex: `npm run build` or reinstall the package, and ensure npm/npx is available for hook fallbacks",
  };
}

function parseSemverTriple(raw: string): [number, number, number] | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)];
}

function versionAtLeast(raw: string | null, major: number, minor: number = 0): boolean {
  if (!raw) return false;
  const parsed = parseSemverTriple(raw);
  if (!parsed) return false;
  const [m, n] = parsed;
  if (m !== major) return m > major;
  return n >= minor;
}

function nearestWritableTarget(filePath: string): boolean {
  let probe = fs.existsSync(filePath) ? filePath : path.dirname(filePath);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  try {
    fs.accessSync(probe, fs.constants.W_OK);
    return true;
  } catch (err: unknown) {
    debugLog(`nearestWritableTarget failed for ${filePath}: ${errorMessage(err)}`);
    return false;
  }
}

function gitRemoteStatus(cortexPath: string): { ok: boolean; detail: string } {
  try {
    execFileSync("git", ["-C", cortexPath, "rev-parse", "--is-inside-work-tree"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    });
  } catch {
    return { ok: false, detail: "cortex path is not a git repository" };
  }
  try {
    const remote = execFileSync("git", ["-C", cortexPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    }).trim();
    return remote ? { ok: true, detail: `origin=${remote}` } : { ok: false, detail: "git origin remote not configured" };
  } catch {
    return { ok: false, detail: "git origin remote not configured" };
  }
}

function copyStarterFile(cortexPath: string, src: string, dest: string): string | null {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(src, dest);
    return dest;
  }

  const existing = fs.readFileSync(dest);
  const incoming = fs.readFileSync(src);
  if (existing.equals(incoming)) {
    return null;
  }

  const relative = path.relative(cortexPath, dest);
  const stagingDir = path.join(cortexPath, ".runtime", "starter-updates", path.dirname(relative));
  fs.mkdirSync(stagingDir, { recursive: true });
  const currentPath = path.join(stagingDir, `${path.basename(dest)}.current`);
  const stagedPath = path.join(stagingDir, `${path.basename(dest)}.new`);
  fs.copyFileSync(dest, currentPath);
  fs.copyFileSync(src, stagedPath);
  return stagedPath;
}

export function applyStarterTemplateUpdates(cortexPath: string): string[] {
  const updates: string[] = [];
  const starterGlobal = path.join(STARTER_DIR, "global");
  if (!fs.existsSync(starterGlobal)) return updates;

  const starterClaude = path.join(starterGlobal, "CLAUDE.md");
  const targetClaude = path.join(cortexPath, "global", "CLAUDE.md");
  if (fs.existsSync(starterClaude)) {
    const written = copyStarterFile(cortexPath, starterClaude, targetClaude);
    if (written) updates.push(path.relative(cortexPath, written));
  }

  const starterSkillsDir = path.join(starterGlobal, "skills");
  const targetSkillsDir = path.join(cortexPath, "global", "skills");
  if (fs.existsSync(starterSkillsDir)) {
    fs.mkdirSync(targetSkillsDir, { recursive: true });
    for (const f of fs.readdirSync(starterSkillsDir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      const written = copyStarterFile(cortexPath, path.join(starterSkillsDir, f.name), path.join(targetSkillsDir, f.name));
      if (written) updates.push(path.relative(cortexPath, written));
    }
  }

  return updates;
}

/**
 * Migrate legacy files from the cortex root into proper subdirectories.
 * Called on every init/update to keep the root clean.
 */
export function migrateRootFiles(cortexPath: string): string[] {
  const moved: string[] = [];

  // Move session markers (.noticed-*, .extracted-*) to .sessions/
  try {
    for (const f of fs.readdirSync(cortexPath)) {
      if (f.startsWith(".noticed-") || f.startsWith(".extracted-")) {
        const sessDir = path.join(cortexPath, ".sessions");
        fs.mkdirSync(sessDir, { recursive: true });
        const src = path.join(cortexPath, f);
        const dest = path.join(sessDir, f.slice(1));
        try {
          fs.renameSync(src, dest);
          moved.push(`${f} -> .sessions/${f.slice(1)}`);
        } catch (err: unknown) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] migrateRootFiles sessionMarker: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] migrateRootFiles sessionScan: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Move quality markers (.quality-*) to .runtime/
  try {
    for (const f of fs.readdirSync(cortexPath)) {
      if (f.startsWith(".quality-")) {
        const rtDir = path.join(cortexPath, ".runtime");
        fs.mkdirSync(rtDir, { recursive: true });
        const src = path.join(cortexPath, f);
        const dest = path.join(rtDir, f.slice(1));
        try {
          fs.renameSync(src, dest);
          moved.push(`${f} -> .runtime/${f.slice(1)}`);
        } catch (err: unknown) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] migrateRootFiles qualityMarker: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] migrateRootFiles qualityScan: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Move debug.log to .runtime/debug.log
  const debugLogFile = path.join(cortexPath, "debug.log");
  if (fs.existsSync(debugLogFile)) {
    const rtDir = path.join(cortexPath, ".runtime");
    fs.mkdirSync(rtDir, { recursive: true });
    const dest = path.join(rtDir, "debug.log");
    try {
      if (fs.existsSync(dest)) {
        fs.appendFileSync(dest, fs.readFileSync(debugLogFile, "utf8"));
        fs.unlinkSync(debugLogFile);
      } else {
        fs.renameSync(debugLogFile, dest);
      }
      moved.push("debug.log -> .runtime/debug.log");
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] migrateRootFiles debugLog: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Move .cortex-audit.log to .runtime/audit.log
  const auditLog = path.join(cortexPath, ".cortex-audit.log");
  if (fs.existsSync(auditLog)) {
    const rtDir = path.join(cortexPath, ".runtime");
    fs.mkdirSync(rtDir, { recursive: true });
    const dest = path.join(rtDir, "audit.log");
    try {
      if (fs.existsSync(dest)) {
        fs.appendFileSync(dest, fs.readFileSync(auditLog, "utf8"));
        fs.unlinkSync(auditLog);
      } else {
        fs.renameSync(auditLog, dest);
      }
      moved.push(".cortex-audit.log -> .runtime/audit.log");
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] migrateRootFiles auditLog: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Move link.sh to scripts/link.sh
  const linkSh = path.join(cortexPath, "link.sh");
  if (fs.existsSync(linkSh)) {
    const scriptsDir = path.join(cortexPath, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    const dest = path.join(scriptsDir, "link.sh");
    if (!fs.existsSync(dest)) {
      try {
        fs.renameSync(linkSh, dest);
        moved.push("link.sh -> scripts/link.sh");
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] migrateRootFiles linkSh: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  // Move root-level SKILL.md files to global/skills/
  try {
    for (const f of fs.readdirSync(cortexPath)) {
      if (f.endsWith(".SKILL.md") || (f.endsWith(".md") && f.toLowerCase().includes("skill") && !f.startsWith("."))) {
        const skillsDir = path.join(cortexPath, "global", "skills");
        fs.mkdirSync(skillsDir, { recursive: true });
        const src = path.join(cortexPath, f);
        const skillName = f.replace(/\.SKILL\.md$/, "").replace(/\.md$/, "");
        const dest = path.join(skillsDir, `${skillName}.md`);
        if (!fs.existsSync(dest)) {
          try {
            fs.renameSync(src, dest);
            moved.push(`${f} -> global/skills/${skillName}.md`);
          } catch (err: unknown) {
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] migrateRootFiles skillFile: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] migrateRootFiles skillScan: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  return moved;
}

export function ensureGovernanceFiles(cortexPath: string) {
  const govDir = path.join(cortexPath, ".governance");
  fs.mkdirSync(govDir, { recursive: true });
  const sv = GOVERNANCE_SCHEMA_VERSION;
  const policy = path.join(govDir, "retention-policy.json");
  const access = path.join(govDir, "access-control.json");
  const workflow = path.join(govDir, "workflow-policy.json");
  const indexPolicy = path.join(govDir, "index-policy.json");
  const runtimeHealth = path.join(govDir, "runtime-health.json");

  if (!fs.existsSync(policy)) {
    atomicWriteText(
      policy,
      JSON.stringify({
        schemaVersion: sv,
        ttlDays: 120,
        retentionDays: 365,
        autoAcceptThreshold: 0.75,
        minInjectConfidence: 0.35,
        decay: { d30: 1.0, d60: 0.85, d90: 0.65, d120: 0.45 },
      }, null, 2) + "\n"
    );
  }
  if (!fs.existsSync(access)) {
    const user = process.env.USER || process.env.USERNAME || "owner";
    atomicWriteText(
      access,
      JSON.stringify({
        schemaVersion: sv,
        admins: [user],
        maintainers: [],
        contributors: [],
        viewers: [],
      }, null, 2) + "\n"
    );
  }
  if (!fs.existsSync(workflow)) {
    atomicWriteText(
      workflow,
      JSON.stringify({
        schemaVersion: sv,
        requireMaintainerApproval: true,
        lowConfidenceThreshold: 0.7,
        riskySections: ["Stale", "Conflicts"],
      }, null, 2) + "\n"
    );
  }
  if (!fs.existsSync(indexPolicy)) {
    atomicWriteText(
      indexPolicy,
      JSON.stringify({
        schemaVersion: sv,
        includeGlobs: ["**/*.md", ".claude/skills/**/*.md"],
        excludeGlobs: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/build/**"],
        includeHidden: false,
      }, null, 2) + "\n"
    );
  }

  migrateGovernanceFiles(cortexPath);

  if (!fs.existsSync(runtimeHealth)) {
    atomicWriteText(runtimeHealth, JSON.stringify({ schemaVersion: sv }, null, 2) + "\n");
  } else {
    try {
      const current = JSON.parse(fs.readFileSync(runtimeHealth, "utf8"));
      if (current && typeof current === "object" && !Array.isArray(current)) {
        const existingSchema = typeof current.schemaVersion === "number" ? current.schemaVersion : 0;
        if (existingSchema < sv) {
          atomicWriteText(runtimeHealth, JSON.stringify({ ...current, schemaVersion: sv }, null, 2) + "\n");
        }
      }
    } catch (err: unknown) {
      debugLog(`ensureGovernanceFiles: malformed runtime health file, leaving untouched: ${errorMessage(err)}`);
    }
  }
}

const TEMPLATES_DIR = path.join(ROOT, "starter", "templates");

export function listTemplates(): string[] {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  return fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

export function applyTemplate(projectDir: string, templateName: string, projectName: string): boolean {
  const templateDir = path.join(TEMPLATES_DIR, templateName);
  if (!fs.existsSync(templateDir)) return false;
  fs.mkdirSync(projectDir, { recursive: true });
  function copyTemplateDir(srcDir: string, destDir: string) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const src = path.join(srcDir, entry.name);
      const dest = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        copyTemplateDir(src, dest);
      } else {
        let content = fs.readFileSync(src, "utf8");
        content = content.replace(/\{\{project\}\}/g, projectName);
        content = content.replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10));
        atomicWriteText(dest, content);
      }
    }
  }
  copyTemplateDir(templateDir, projectDir);
  return true;
}

/** Bootstrap a cortex project from an existing project directory with CLAUDE.md.
 * @param profile - if provided, only this profile YAML is updated (avoids leaking project to unrelated profiles).
 */
export function bootstrapFromExisting(cortexPath: string, projectPath: string, profile?: string): string {
  const resolvedPath = path.resolve(projectPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Path does not exist: ${resolvedPath}`);
  }

  let claudeMdPath: string | null = null;
  const candidates = [
    path.join(resolvedPath, "CLAUDE.md"),
    path.join(resolvedPath, ".claude", "CLAUDE.md"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      claudeMdPath = c;
      break;
    }
  }

  const claudeContent = claudeMdPath ? fs.readFileSync(claudeMdPath, "utf8") : null;
  const projectName = path.basename(resolvedPath).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const existingProject = findProjectNameCaseInsensitive(cortexPath, projectName);
  if (existingProject && existingProject !== projectName) {
    throw new Error(
      `Project "${existingProject}" already exists with different casing. Refusing to bootstrap "${projectName}" because it would split the same project on case-sensitive filesystems.`
    );
  }
  const projDir = path.join(cortexPath, projectName);
  fs.mkdirSync(projDir, { recursive: true });

  const claudePath = path.join(projDir, "CLAUDE.md");
  if (claudeContent) {
    if (!fs.existsSync(claudePath)) {
      atomicWriteText(claudePath, claudeContent);
    }
  } else {
    // No CLAUDE.md found — create a starter one
    if (!fs.existsSync(claudePath)) {
      atomicWriteText(
        claudePath,
        `# ${projectName}\n\nOne paragraph about what this project is.\n\n## Commands\n\n\`\`\`bash\n# Install:\n# Run:\n# Test:\n\`\`\`\n`
      );
    }
  }

  const summaryLines: string[] = [];
  if (claudeContent) {
    const lines = claudeContent.split("\n");
    let foundHeading = false;
    for (const line of lines) {
      if (line.startsWith("# ") && !foundHeading) {
        foundHeading = true;
        summaryLines.push(line);
        continue;
      }
      if (foundHeading && line.trim() === "") {
        if (summaryLines.length > 1) break;
        continue;
      }
      if (foundHeading && summaryLines.length < 10) {
        summaryLines.push(line);
      }
    }
  }

  const sourceInfo = claudeMdPath ? `**Source CLAUDE.md:** ${claudeMdPath}` : `**Source:** ${resolvedPath}`;
  const summaryPath = path.join(projDir, "summary.md");
  if (!fs.existsSync(summaryPath)) {
    atomicWriteText(
      summaryPath,
      `# ${projectName}\n\n**What:** Bootstrapped from ${resolvedPath}\n${sourceInfo}\n\n${summaryLines.length > 1 ? summaryLines.slice(1).join("\n") : ""}\n`
    );
  }

  if (!fs.existsSync(path.join(projDir, "FINDINGS.md"))) {
    atomicWriteText(
      path.join(projDir, "FINDINGS.md"),
      `# ${projectName} FINDINGS\n\n<!-- Bootstrapped from ${resolvedPath} -->\n`
    );
  }
  if (!fs.existsSync(path.join(projDir, "backlog.md"))) {
    atomicWriteText(
      path.join(projDir, "backlog.md"),
      `# ${projectName} backlog\n\n## Active\n\n## Queue\n\n## Done\n`
    );
  }

  const activeProfile = resolveActiveProfile(cortexPath, profile);
  if (activeProfile.ok && activeProfile.data) {
    const addResult = addProjectToProfile(cortexPath, activeProfile.data, projectName);
    if (!addResult.ok) {
      throw new Error(addResult.error);
    }
  } else if (!activeProfile.ok && activeProfile.code !== "FILE_NOT_FOUND") {
    throw new Error(activeProfile.error);
  }

  return projectName;
}

export function updateMachinesYaml(cortexPath: string, machine?: string, profile?: string) {
  const machinesFile = path.join(cortexPath, "machines.yaml");
  if (!fs.existsSync(machinesFile)) return;
  const hostname = machine || os.hostname();
  const profileName = profile || "personal";
  const content = fs.readFileSync(machinesFile, "utf8");

  // Parse structurally to avoid substring false-positives and preserve comments
  let parsed: Record<string, unknown> = {};
  try {
    const loaded = yaml.load(content);
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
      parsed = loaded as Record<string, unknown>;
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] updateMachinesYaml parse: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // If the hostname key already exists (exact match), do not overwrite
  if (Object.prototype.hasOwnProperty.call(parsed, hostname)) return;

  // Set the new key and re-serialize, preserving the comment header
  parsed[hostname] = profileName;

  // Preserve leading comment lines from the original file
  const lines = content.split("\n");
  const commentLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("#") || line.trim() === "") {
      commentLines.push(line);
    } else {
      break;
    }
  }

  const header = commentLines.length ? commentLines.join("\n") + "\n" : "";
  const body = yaml.dump(parsed, { lineWidth: -1 });
  atomicWriteText(machinesFile, header + body);
}

/**
 * Detect if a directory looks like a project that should be bootstrapped.
 * Returns the path if it qualifies, null otherwise.
 * A directory qualifies if it:
 * - Is not the home directory or cortex directory
 * - Has a CLAUDE.md, .claude/CLAUDE.md, or .git directory
 */
export function detectProjectDir(dir: string, cortexPath: string): string | null {
  const home = os.homedir();
  const resolvedCortexPath = path.resolve(cortexPath);
  let current = path.resolve(dir);
  while (true) {
    if (current === home || current === resolvedCortexPath) return null;
    if (current.startsWith(resolvedCortexPath + path.sep)) return null;
    const hasClaude = fs.existsSync(path.join(current, "CLAUDE.md")) ||
      fs.existsSync(path.join(current, ".claude", "CLAUDE.md"));
    const hasGit = fs.existsSync(path.join(current, ".git"));
    if (hasClaude || hasGit) return current;
    const parent = path.dirname(current);
    if (parent === current || parent === home) break;
    current = parent;
  }
  return null;
}

/**
 * Check if a project name is already tracked in any profile.
 */
export function isProjectTracked(cortexPath: string, projectName: string, profile?: string): boolean {
  const profiles = listProfiles(cortexPath);
  if (profiles.ok) {
    if (profile) {
      return profiles.data.some((entry) => entry.name === profile && entry.projects.includes(projectName));
    }
    return profiles.data.some((entry) => entry.projects.includes(projectName));
  }
  const projDir = path.join(cortexPath, projectName);
  return fs.existsSync(projDir);
}

export function runPostInitVerify(cortexPath: string): { ok: boolean; checks: PostInitCheck[] } {
  const checks: PostInitCheck[] = [];
  const gitVersion = commandVersion("git");
  const nodeVersion = commandVersion("node");
  checks.push({
    name: "git-installed",
    ok: Boolean(gitVersion),
    detail: gitVersion || "git not found in PATH",
    fix: gitVersion ? undefined : "Install git and re-run `npx @alaarab/cortex init`.",
  });
  checks.push({
    name: "node-version",
    ok: versionAtLeast(nodeVersion, 20),
    detail: nodeVersion || "node not found in PATH",
    fix: versionAtLeast(nodeVersion, 20) ? undefined : "Install Node.js 20+ before using cortex.",
  });

  const gitRemote = gitRemoteStatus(cortexPath);
  checks.push({
    name: "git-remote",
    ok: gitRemote.ok,
    detail: gitRemote.detail,
    fix: gitRemote.ok ? undefined : "Initialize a repo and add an origin remote for cross-machine sync.",
  });

  const settingsPath = hookConfigPath("claude");
  const configWritable = nearestWritableTarget(settingsPath);
  checks.push({
    name: "config-writable",
    ok: configWritable,
    detail: configWritable ? `writable: ${settingsPath}` : `not writable: ${settingsPath}`,
    fix: configWritable ? undefined : "Fix permissions for ~/.claude or its settings.json before enabling hooks/MCP.",
  });
  let mcpOk = false;
  let hooksOk = false;
  try {
    const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    mcpOk = Boolean(cfg.mcpServers?.cortex || cfg.servers?.cortex);
    const hooks = cfg.hooks || {};
    const hasPrompt = JSON.stringify(hooks.UserPromptSubmit || []).includes("hook-prompt");
    const hasStop = JSON.stringify(hooks.Stop || []).includes("hook-stop") || JSON.stringify(hooks.Stop || []).includes("auto-save");
    const hasStart = JSON.stringify(hooks.SessionStart || []).includes("hook-session-start") || JSON.stringify(hooks.SessionStart || []).includes("doctor --fix");
    hooksOk = hasPrompt && hasStop && hasStart;
  } catch (err: unknown) {
    debugLog(`doctor: settings.json missing or unreadable: ${errorMessage(err)}`);
  }
  checks.push({
    name: "mcp-config",
    ok: mcpOk,
    detail: mcpOk ? "MCP server registered in Claude settings" : "MCP server not found in ~/.claude/settings.json",
    fix: mcpOk ? undefined : "Run `npx @alaarab/cortex init` to register the MCP server",
  });
  checks.push({
    name: "hooks-registered",
    ok: hooksOk,
    detail: hooksOk ? "All lifecycle hooks registered" : "One or more hooks missing from ~/.claude/settings.json",
    fix: hooksOk ? undefined : "Run `npx @alaarab/cortex init` to install or refresh hooks",
  });

  const globalClaude = path.join(cortexPath, "global", "CLAUDE.md");
  const globalOk = fs.existsSync(globalClaude);
  checks.push({
    name: "global-claude",
    ok: globalOk,
    detail: globalOk ? "global/CLAUDE.md exists" : "global/CLAUDE.md missing",
    fix: globalOk ? undefined : "Run `npx @alaarab/cortex init` to create starter files",
  });

  const govDir = path.join(cortexPath, ".governance");
  const govOk = fs.existsSync(govDir);
  checks.push({
    name: "config",
    ok: govOk,
    detail: govOk ? ".governance/ config directory exists" : ".governance/ config directory missing",
    fix: govOk ? undefined : "Run `npx @alaarab/cortex init` to create governance config",
  });

  const prefs = readInstallPreferences(cortexPath);
  const installedVersion = prefs.installedVersion;
  const versionOk = !govOk || installedVersion === VERSION;
  checks.push({
    name: "installed-version",
    ok: versionOk,
    detail: installedVersion
      ? (versionOk ? `install metadata matches running version (${VERSION})` : `install metadata is ${installedVersion}, runtime is ${VERSION}`)
      : "install metadata missing installedVersion",
    fix: versionOk ? undefined : "Run `cortex update` or `npx @alaarab/cortex init` to refresh install metadata.",
  });

  let ftsOk = false;
  try {
    const entries = fs.readdirSync(cortexPath, { withFileTypes: true });
    ftsOk = entries.some(d => d.isDirectory() && !d.name.startsWith("."));
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] runPostInitVerify projectScan: ${err instanceof Error ? err.message : String(err)}\n`);
    ftsOk = false;
  }
  checks.push({
    name: "fts-index",
    ok: ftsOk,
    detail: ftsOk ? "Project directories found for indexing" : "No project directories found in cortex path",
    fix: ftsOk ? undefined : "Create a project: `cd ~/your-project && cortex add`",
  });

  checks.push(getHookEntrypointCheck());

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}
