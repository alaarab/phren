/**
 * Governance files, root file migration, verification, starter templates, bootstrap.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import {
  debugLog,
  findProjectNameCaseInsensitive,
  hookConfigPath,
  EXEC_TIMEOUT_QUICK_MS,
} from "./shared.js";
import { execFileSync } from "child_process";
import {
  GOVERNANCE_SCHEMA_VERSION,
  migrateGovernanceFiles,
} from "./shared-governance.js";
import { isValidProjectName, errorMessage } from "./utils.js";
import { ROOT, STARTER_DIR } from "./init-shared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PostInitCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

function commandVersion(cmd: string, args: string[] = ["--version"]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    }).trim();
  } catch (err: unknown) {
    debugLog(`commandVersion ${cmd} failed: ${errorMessage(err)}`);
    return null;
  }
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

function copyStarterFile(src: string, dest: string) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest);
    const incoming = fs.readFileSync(src);
    if (!existing.equals(incoming)) {
      fs.copyFileSync(dest, dest + ".bak");
    }
  }
  fs.copyFileSync(src, dest);
}

export function applyStarterTemplateUpdates(cortexPath: string): string[] {
  const updates: string[] = [];
  const starterGlobal = path.join(STARTER_DIR, "global");
  if (!fs.existsSync(starterGlobal)) return updates;

  const starterClaude = path.join(starterGlobal, "CLAUDE.md");
  const targetClaude = path.join(cortexPath, "global", "CLAUDE.md");
  if (fs.existsSync(starterClaude)) {
    copyStarterFile(starterClaude, targetClaude);
    updates.push("global/CLAUDE.md");
  }

  const starterSkillsDir = path.join(starterGlobal, "skills");
  const targetSkillsDir = path.join(cortexPath, "global", "skills");
  if (fs.existsSync(starterSkillsDir)) {
    fs.mkdirSync(targetSkillsDir, { recursive: true });
    for (const f of fs.readdirSync(starterSkillsDir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      copyStarterFile(path.join(starterSkillsDir, f.name), path.join(targetSkillsDir, f.name));
      updates.push(`global/skills/${f.name}`);
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
    fs.writeFileSync(
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
    fs.writeFileSync(
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
    fs.writeFileSync(
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
    fs.writeFileSync(
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
    fs.writeFileSync(runtimeHealth, JSON.stringify({ schemaVersion: sv }, null, 2) + "\n");
  } else {
    try {
      const current = JSON.parse(fs.readFileSync(runtimeHealth, "utf8"));
      if (current && typeof current === "object" && !Array.isArray(current)) {
        const existingSchema = typeof current.schemaVersion === "number" ? current.schemaVersion : 0;
        if (existingSchema < sv) {
          fs.writeFileSync(
            runtimeHealth,
            JSON.stringify({ ...current, schemaVersion: sv }, null, 2) + "\n"
          );
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
        fs.writeFileSync(dest, content);
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

  if (!claudeMdPath) {
    throw new Error(`No CLAUDE.md found in ${resolvedPath} or ${resolvedPath}/.claude/`);
  }

  const claudeContent = fs.readFileSync(claudeMdPath, "utf8");
  const projectName = path.basename(resolvedPath).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const existingProject = findProjectNameCaseInsensitive(cortexPath, projectName);
  if (existingProject && existingProject !== projectName) {
    throw new Error(
      `Project "${existingProject}" already exists with different casing. Refusing to bootstrap "${projectName}" because it would split the same project on case-sensitive filesystems.`
    );
  }
  const projDir = path.join(cortexPath, projectName);
  fs.mkdirSync(projDir, { recursive: true });

  fs.writeFileSync(path.join(projDir, "CLAUDE.md"), claudeContent);

  const lines = claudeContent.split("\n");
  const summaryLines: string[] = [];
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

  fs.writeFileSync(
    path.join(projDir, "summary.md"),
    `# ${projectName}\n\n**What:** Bootstrapped from ${resolvedPath}\n**Source CLAUDE.md:** ${claudeMdPath}\n\n${summaryLines.length > 1 ? summaryLines.slice(1).join("\n") : ""}\n`
  );

  if (!fs.existsSync(path.join(projDir, "FINDINGS.md"))) {
    fs.writeFileSync(
      path.join(projDir, "FINDINGS.md"),
      `# ${projectName} FINDINGS\n\n<!-- Bootstrapped from ${claudeMdPath} -->\n`
    );
  }
  if (!fs.existsSync(path.join(projDir, "backlog.md"))) {
    fs.writeFileSync(
      path.join(projDir, "backlog.md"),
      `# ${projectName} backlog\n\n## Active\n\n## Queue\n\n## Done\n`
    );
  }

  const profilesDir = path.join(cortexPath, "profiles");
  if (fs.existsSync(profilesDir)) {
    // Only update the explicitly selected profile (or the first one found if none specified)
    // to avoid leaking the project into unrelated profiles on other machines.
    const allProfiles = fs.readdirSync(profilesDir).filter(f => f.endsWith(".yaml"));
    const targetProfile = profile
      ? allProfiles.find(f => f === `${profile}.yaml` || f === profile) ?? allProfiles[0]
      : allProfiles[0];
    if (targetProfile) {
      const pfPath = path.join(profilesDir, targetProfile);
      const content = fs.readFileSync(pfPath, "utf8");
      if (!content.includes(projectName)) {
        fs.writeFileSync(pfPath, content.trimEnd() + `\n  - ${projectName}\n`);
      }
    }
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
  fs.writeFileSync(machinesFile, header + body);
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
    fix: hooksOk ? undefined : "Run `npx @alaarab/cortex init` to install hooks, or `cortex link` to re-register",
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
    fix: ftsOk ? undefined : "Create a project: `cortex add-finding my-project \"first insight\"`",
  });

  const distIndex = path.join(__dirname, "index.js");
  const hookEntrypointOk = fs.existsSync(distIndex);
  checks.push({
    name: "hook-entrypoint",
    ok: hookEntrypointOk,
    detail: hookEntrypointOk ? "Hook entrypoint (dist/index.js) exists" : "Hook entrypoint missing, hooks will fail",
    fix: hookEntrypointOk ? undefined : "Rebuild cortex: `npm run build` or reinstall the package",
  });

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}
