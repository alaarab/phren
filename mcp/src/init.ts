import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { buildLifecycleCommands, configureAllHooks } from "./hooks.js";
import { EXEC_TIMEOUT_QUICK_MS, GOVERNANCE_SCHEMA_VERSION, migrateGovernanceFiles } from "./shared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version as string;
const STARTER_DIR = path.join(ROOT, "starter");
const DEFAULT_CORTEX_PATH = path.join(os.homedir(), ".cortex");

export type McpMode = "on" | "off";
type McpConfigStatus = "installed" | "already_configured" | "disabled" | "already_disabled";
type McpRootKey = "mcpServers" | "servers";
type ToolStatus = McpConfigStatus | "no_settings" | "no_vscode" | "no_cursor" | "no_copilot" | "no_codex";

interface InstallPreferences {
  mcpEnabled?: boolean;
  hooksEnabled?: boolean;
  installedVersion?: string;
  updatedAt?: string;
}

function preferencesFile(cortexPath: string): string {
  return path.join(cortexPath, ".governance", "install-preferences.json");
}

function readInstallPreferences(cortexPath: string): InstallPreferences {
  const file = preferencesFile(cortexPath);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as InstallPreferences;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeInstallPreferences(cortexPath: string, patch: Partial<InstallPreferences>) {
  const file = preferencesFile(cortexPath);
  const current = readInstallPreferences(cortexPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
}

function parseVersion(version: string): { major: number; minor: number; patch: number; pre: string } {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/);
  if (!match) return { major: 0, minor: 0, patch: 0, pre: "" };
  return {
    major: Number.parseInt(match[1], 10) || 0,
    minor: Number.parseInt(match[2], 10) || 0,
    patch: Number.parseInt(match[3], 10) || 0,
    pre: match[4] || "",
  };
}

/**
 * Compare two semver strings. Returns true when `current` is strictly newer
 * than `previous`. Pre-release versions (e.g. 1.2.3-rc.1) sort before the
 * corresponding release (1.2.3). Among pre-release tags, comparison is
 * lexicographic.
 */
export function isVersionNewer(current: string, previous?: string): boolean {
  if (!previous) return false;
  const c = parseVersion(current);
  const p = parseVersion(previous);
  if (c.major !== p.major) return c.major > p.major;
  if (c.minor !== p.minor) return c.minor > p.minor;
  if (c.patch !== p.patch) return c.patch > p.patch;
  // Same major.minor.patch: release (no pre) beats any pre-release
  if (c.pre && !p.pre) return false;
  if (!c.pre && p.pre) return true;
  // Both have pre-release tags: lexicographic compare
  return c.pre > p.pre;
}

function copyStarterFile(src: string, dest: string) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Back up existing file if it differs from the new content
  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest);
    const incoming = fs.readFileSync(src);
    if (!existing.equals(incoming)) {
      fs.copyFileSync(dest, dest + ".bak");
    }
  }
  fs.copyFileSync(src, dest);
}

function applyStarterTemplateUpdates(cortexPath: string): string[] {
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

export function parseMcpMode(raw?: string): McpMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "on" || normalized === "off") return normalized;
  return undefined;
}

export function getMcpEnabledPreference(cortexPath: string): boolean {
  const prefs = readInstallPreferences(cortexPath);
  return prefs.mcpEnabled !== false;
}

export function setMcpEnabledPreference(cortexPath: string, enabled: boolean): void {
  writeInstallPreferences(cortexPath, { mcpEnabled: enabled });
}

export function getHooksEnabledPreference(cortexPath: string): boolean {
  const prefs = readInstallPreferences(cortexPath);
  return prefs.hooksEnabled !== false;
}

export function setHooksEnabledPreference(cortexPath: string, enabled: boolean): void {
  writeInstallPreferences(cortexPath, { hooksEnabled: enabled });
}

function log(msg: string) {
  process.stdout.write(msg + "\n");
}

function patchJsonFile(filePath: string, patch: (data: Record<string, any>) => void) {
  let data: Record<string, any> = {};
  if (fs.existsSync(filePath)) {
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new Error(`Malformed JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  patch(data);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: ["ignore", "ignore", "ignore"], timeout: EXEC_TIMEOUT_QUICK_MS });
    return true;
  } catch {
    return false;
  }
}

function pickExistingFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizeWindowsPathToWsl(input: string | undefined): string | undefined {
  if (!input) return undefined;
  if (input.startsWith("/")) return input;
  const match = input.match(/^([A-Za-z]):\\(.*)$/);
  if (!match) return input;
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

function uniqStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => Boolean(v && v.trim()))));
}

function buildMcpServerConfig(cortexPath: string) {
  return {
    command: "npx",
    args: ["-y", `@alaarab/cortex@${VERSION}`, cortexPath],
  };
}

function upsertMcpServer(
  data: Record<string, any>,
  mcpEnabled: boolean,
  preferredRoot: McpRootKey,
  cortexPath: string
): McpConfigStatus {
  const hadMcp = Boolean(data.mcpServers?.cortex || data.servers?.cortex);
  if (mcpEnabled) {
    const root: McpRootKey =
      data.mcpServers && typeof data.mcpServers === "object"
        ? "mcpServers"
        : data.servers && typeof data.servers === "object"
          ? "servers"
          : preferredRoot;
    if (!data[root] || typeof data[root] !== "object") data[root] = {};
    data[root].cortex = buildMcpServerConfig(cortexPath);
    return hadMcp ? "already_configured" : "installed";
  }

  if (data.mcpServers?.cortex) delete data.mcpServers.cortex;
  if (data.servers?.cortex) delete data.servers.cortex;
  return hadMcp ? "disabled" : "already_disabled";
}

function configureMcpAtPath(
  filePath: string,
  mcpEnabled: boolean,
  preferredRoot: McpRootKey,
  cortexPath: string
): McpConfigStatus {
  if (!mcpEnabled && !fs.existsSync(filePath)) return "already_disabled";
  let status: McpConfigStatus = "already_disabled";
  patchJsonFile(filePath, (data) => {
    status = upsertMcpServer(data, mcpEnabled, preferredRoot, cortexPath);
  });
  return status;
}

function removeMcpServerAtPath(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  let removed = false;
  patchJsonFile(filePath, (data) => {
    if (data.mcpServers?.cortex) {
      delete data.mcpServers.cortex;
      removed = true;
    }
    if (data.servers?.cortex) {
      delete data.servers.cortex;
      removed = true;
    }
  });
  return removed;
}

function resolveEntryScript(): string {
  // Find the actual index.js path so hooks can use `node <path>` instead of npx
  return path.join(ROOT, "mcp", "dist", "index.js");
}

export function ensureGovernanceFiles(cortexPath: string) {
  const govDir = path.join(cortexPath, ".governance");
  fs.mkdirSync(govDir, { recursive: true });
  const sv = GOVERNANCE_SCHEMA_VERSION;
  const policy = path.join(govDir, "memory-policy.json");
  const access = path.join(govDir, "access-control.json");
  const workflow = path.join(govDir, "memory-workflow-policy.json");
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

  // Migrate existing files that lack schemaVersion or have an older version
  migrateGovernanceFiles(cortexPath);

  // Runtime health is intentionally permissive; add schema metadata only when safe.
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
    } catch {
      // Keep malformed runtime health file untouched for compatibility/safety.
    }
  }
}

function isCortexCommand(command: string): boolean {
  // Split on path separators and spaces, check if any segment starts with "cortex"
  const segments = command.split(/[/\\\s]+/);
  return segments.some(seg => seg === "cortex" || seg.startsWith("cortex@") || seg.startsWith("@alaarab/cortex"));
}

export function configureClaude(cortexPath: string, opts: { mcpEnabled?: boolean; hooksEnabled?: boolean } = {}): McpConfigStatus {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const entryScript = resolveEntryScript();
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  const hooksEnabled = opts.hooksEnabled ?? getHooksEnabledPreference(cortexPath);
  const lifecycle = buildLifecycleCommands(cortexPath);
  let status: McpConfigStatus = "already_disabled";

  patchJsonFile(settingsPath, (data) => {
    // MCP server
    status = upsertMcpServer(data, mcpEnabled, "mcpServers", cortexPath);

    // Hooks: update to latest version when enabled, otherwise remove cortex hooks.
    if (!data.hooks) data.hooks = {};

    const upsertCortexHook = (eventName: "UserPromptSubmit" | "Stop" | "SessionStart", hookBody: Record<string, any>) => {
      if (!Array.isArray(data.hooks[eventName])) data.hooks[eventName] = [];
      const eventHooks = data.hooks[eventName] as any[];
      const marker = eventName === "UserPromptSubmit" ? "hook-prompt" : eventName === "Stop" ? "hook-stop" : "hook-session-start";
      const legacyMarker = eventName === "Stop" ? "auto-save" : eventName === "SessionStart" ? "doctor --fix" : "hook-prompt";
      const existingIdx = eventHooks.findIndex(
        (h: any) => h?.hooks?.some(
          (hook: any) =>
            typeof hook?.command === "string" &&
            (
              hook.command.includes(marker) ||
              hook.command.includes(legacyMarker) ||
              isCortexCommand(hook.command)
            )
        )
      );
      const payload = { matcher: "", hooks: [hookBody] };
      if (existingIdx >= 0) eventHooks[existingIdx] = payload;
      else eventHooks.push(payload);
    };

    if (hooksEnabled) {
      upsertCortexHook("UserPromptSubmit", {
        type: "command",
        command: lifecycle.userPromptSubmit || `node "${entryScript}" hook-prompt`,
        timeout: 3,
      });

      upsertCortexHook("Stop", {
        type: "command",
        command: lifecycle.stop,
      });

      upsertCortexHook("SessionStart", {
        type: "command",
        command: lifecycle.sessionStart,
      });
    } else {
      for (const hookEvent of ["UserPromptSubmit", "Stop", "SessionStart"] as const) {
        const hooks = data.hooks?.[hookEvent] as any[] | undefined;
        if (!Array.isArray(hooks)) continue;
        data.hooks[hookEvent] = hooks.filter(
          (h: any) => !h.hooks?.some(
            (hook: any) => typeof hook.command === "string" && isCortexCommand(hook.command)
          )
        );
      }
    }
  });
  return status;
}

let _vscodeProbeCache: { targetDir: string | null; installed: boolean } | null = null;

/** Reset the VS Code path probe cache (for testing). */
export function resetVSCodeProbeCache() { _vscodeProbeCache = null; }

function probeVSCodePath(): { targetDir: string | null; installed: boolean } {
  if (_vscodeProbeCache) return _vscodeProbeCache;
  const home = os.homedir();
  const userProfile = normalizeWindowsPathToWsl(process.env.USERPROFILE);
  const username = process.env.USERNAME;
  const userProfileRoaming = userProfile ? path.join(userProfile, "AppData", "Roaming", "Code", "User") : undefined;
  const guessedWindowsRoaming = !userProfile && username
    ? path.join("/mnt/c", "Users", username, "AppData", "Roaming", "Code", "User")
    : undefined;
  const candidates = uniqStrings([
    userProfileRoaming,
    guessedWindowsRoaming,
    path.join(home, ".config", "Code", "User"),
    path.join(home, ".vscode-server", "data", "User"),
    path.join(home, "Library", "Application Support", "Code", "User"),
    path.join(home, "AppData", "Roaming", "Code", "User"),
  ]);
  const existing = candidates.find((d) => fs.existsSync(d));
  const installed =
    Boolean(existing) ||
    commandExists("code") ||
    Boolean(
      userProfile &&
      (
        fs.existsSync(path.join(userProfile, "AppData", "Local", "Programs", "Microsoft VS Code")) ||
        fs.existsSync(path.join(userProfile, "AppData", "Roaming", "Code"))
      )
    );
  const targetDir = installed
    ? (existing || userProfileRoaming || path.join(home, ".config", "Code", "User"))
    : null;
  _vscodeProbeCache = { targetDir, installed };
  return _vscodeProbeCache;
}

export function configureVSCode(cortexPath: string, opts: { mcpEnabled?: boolean } = {}): McpConfigStatus | "no_vscode" {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  const probe = probeVSCodePath();
  if (!probe.installed || !probe.targetDir) return "no_vscode";
  const mcpFile = path.join(probe.targetDir, "mcp.json");
  return configureMcpAtPath(mcpFile, mcpEnabled, "servers", cortexPath);
}

export function configureCursorMcp(cortexPath: string, opts: { mcpEnabled?: boolean } = {}): ToolStatus {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  const home = os.homedir();
  const candidates = [
    path.join(home, ".cursor", "mcp.json"),
    path.join(home, ".config", "Cursor", "User", "mcp.json"),
    path.join(home, "Library", "Application Support", "Cursor", "User", "mcp.json"),
    path.join(home, "AppData", "Roaming", "Cursor", "User", "mcp.json"),
  ];
  const existing = pickExistingFile(candidates);
  const cursorInstalled =
    Boolean(existing) ||
    fs.existsSync(path.join(home, ".cursor")) ||
    fs.existsSync(path.join(home, ".config", "Cursor")) ||
    fs.existsSync(path.join(home, "Library", "Application Support", "Cursor")) ||
    fs.existsSync(path.join(home, "AppData", "Roaming", "Cursor")) ||
    commandExists("cursor");
  if (!cursorInstalled) return "no_cursor";
  return configureMcpAtPath(existing || candidates[0], mcpEnabled, "mcpServers", cortexPath);
}

export function configureCopilotMcp(cortexPath: string, opts: { mcpEnabled?: boolean } = {}): ToolStatus {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  const home = os.homedir();
  const candidates = [
    path.join(home, ".github", "mcp.json"),
    path.join(home, ".config", "github-copilot", "mcp.json"),
    path.join(home, "Library", "Application Support", "github-copilot", "mcp.json"),
    path.join(home, "AppData", "Roaming", "github-copilot", "mcp.json"),
  ];
  const existing = pickExistingFile(candidates);
  const copilotInstalled =
    Boolean(existing) ||
    fs.existsSync(path.join(home, ".github")) ||
    fs.existsSync(path.join(home, ".config", "github-copilot")) ||
    fs.existsSync(path.join(home, "Library", "Application Support", "github-copilot")) ||
    fs.existsSync(path.join(home, "AppData", "Roaming", "github-copilot")) ||
    commandExists("gh");
  if (!copilotInstalled) return "no_copilot";
  return configureMcpAtPath(existing || candidates[0], mcpEnabled, "servers", cortexPath);
}

export function configureCodexMcp(cortexPath: string, opts: { mcpEnabled?: boolean } = {}): ToolStatus {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  const home = os.homedir();
  const candidates = [
    path.join(home, ".codex", "config.json"),
    path.join(home, ".codex", "mcp.json"),
    path.join(cortexPath, "codex.json"),
  ];
  const existing = pickExistingFile(candidates);
  const codexInstalled =
    Boolean(existing) ||
    fs.existsSync(path.join(home, ".codex")) ||
    commandExists("codex");
  if (!codexInstalled) return "no_codex";
  return configureMcpAtPath(existing || candidates[0], mcpEnabled, "mcpServers", cortexPath);
}

export function logMcpTargetStatus(tool: string, status: string, phase: "Configured" | "Updated" = "Configured") {
  const text: Record<string, string> = {
    installed: `${phase} ${tool} MCP`,
    already_configured: `${tool} MCP already configured`,
    disabled: `${tool} MCP disabled`,
    already_disabled: `${tool} MCP already disabled`,
    no_settings: `${tool} settings not found`,
    no_vscode: `${tool} not detected`,
    no_cursor: `${tool} not detected`,
    no_copilot: `${tool} not detected`,
    no_codex: `${tool} not detected`,
  };
  if (text[status]) log(`  ${text[status]}`);
}

function updateMachinesYaml(cortexPath: string, machine?: string, profile?: string) {
  const machinesFile = path.join(cortexPath, "machines.yaml");
  if (!fs.existsSync(machinesFile)) return;
  const hostname = machine || os.hostname();
  const profileName = profile || "personal";
  let content = fs.readFileSync(machinesFile, "utf8");
  if (!content.includes(hostname)) {
    // Strip leading comment block (template placeholder), preserve the rest
    const lines = content.split("\n");
    let firstNonComment = 0;
    while (firstNonComment < lines.length && (lines[firstNonComment].startsWith("#") || lines[firstNonComment].trim() === "")) {
      firstNonComment++;
    }
    const rest = lines.slice(firstNonComment).join("\n").trim();
    content = rest ? `${hostname}: ${profileName}\n${rest}\n` : `${hostname}: ${profileName}\n`;
    fs.writeFileSync(machinesFile, content);
  }
}

export interface PostInitCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function runPostInitVerify(cortexPath: string): { ok: boolean; checks: PostInitCheck[] } {
  const checks: PostInitCheck[] = [];

  // Check MCP config in Claude settings
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
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
  } catch {
    // settings.json missing or unreadable
  }
  checks.push({
    name: "mcp-config",
    ok: mcpOk,
    detail: mcpOk ? "MCP server registered in Claude settings" : "MCP server not found in ~/.claude/settings.json",
  });
  checks.push({
    name: "hooks-registered",
    ok: hooksOk,
    detail: hooksOk ? "All lifecycle hooks registered" : "One or more hooks missing from ~/.claude/settings.json",
  });

  // Check ~/.cortex/global/ exists with CLAUDE.md
  const globalClaude = path.join(cortexPath, "global", "CLAUDE.md");
  const globalOk = fs.existsSync(globalClaude);
  checks.push({
    name: "global-claude",
    ok: globalOk,
    detail: globalOk ? "global/CLAUDE.md exists" : "global/CLAUDE.md missing",
  });

  // Check governance directory
  const govDir = path.join(cortexPath, ".governance");
  const govOk = fs.existsSync(govDir);
  checks.push({
    name: "governance",
    ok: govOk,
    detail: govOk ? ".governance/ directory exists" : ".governance/ directory missing",
  });

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

export interface InitOptions {
  machine?: string;
  profile?: string;
  mcp?: McpMode;
  applyStarterUpdate?: boolean;
}

export async function runInit(opts: InitOptions = {}) {
  const cortexPath = process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;

  if (fs.existsSync(cortexPath)) {
    const entries = fs.readdirSync(cortexPath);
    if (entries.length > 0) {
      ensureGovernanceFiles(cortexPath);
      const mcpEnabled = opts.mcp ? opts.mcp === "on" : getMcpEnabledPreference(cortexPath);
      const hooksEnabled = getHooksEnabledPreference(cortexPath);
      const mcpLabel = mcpEnabled ? "ON (recommended)" : "OFF (hooks-only fallback)";
      const hooksLabel = hooksEnabled ? "ON (active)" : "OFF (disabled)";
      log(`\ncortex already exists at ${cortexPath}`);
      log(`Updating configuration...\n`);
      log(`  MCP mode: ${mcpLabel}`);
      log(`  Hooks mode: ${hooksLabel}`);

      // Always reconfigure MCP and hooks (picks up new features on upgrade)
      try {
        const status = configureClaude(cortexPath, { mcpEnabled, hooksEnabled });
        if (status === "disabled" || status === "already_disabled") {
          log(`  Updated Claude Code hooks (MCP disabled)`);
        } else {
          log(`  Updated Claude Code MCP + hooks`);
        }
      } catch (e) {
        log(`  Could not configure Claude Code settings (${e}), add manually`);
      }

      try {
        const vscodeResult = configureVSCode(cortexPath, { mcpEnabled });
        logMcpTargetStatus("VS Code", vscodeResult, "Updated");
      } catch {}

      try {
        logMcpTargetStatus("Cursor", configureCursorMcp(cortexPath, { mcpEnabled }), "Updated");
      } catch {}

      try {
        logMcpTargetStatus("Copilot CLI", configureCopilotMcp(cortexPath, { mcpEnabled }), "Updated");
      } catch {}

      try {
        logMcpTargetStatus("Codex", configureCodexMcp(cortexPath, { mcpEnabled }), "Updated");
      } catch {}

      if (hooksEnabled) {
        try {
          const hooked = configureAllHooks(cortexPath);
          if (hooked.length) log(`  Updated hooks: ${hooked.join(", ")}`);
        } catch { /* best effort */ }
      } else {
        log(`  Hooks are disabled by preference (run: npx @alaarab/cortex hooks-mode on)`);
      }

      const prefs = readInstallPreferences(cortexPath);
      const previousVersion = prefs.installedVersion;
      if (isVersionNewer(VERSION, previousVersion)) {
        log(`\n  Starter template update available: v${previousVersion} -> v${VERSION}`);
        log(`  Run \`npx @alaarab/cortex init --apply-starter-update\` to refresh global/CLAUDE.md and global skills.`);
      }
      if (opts.applyStarterUpdate) {
        const updated = applyStarterTemplateUpdates(cortexPath);
        if (updated.length) {
          log(`  Applied starter template updates (${updated.length} file${updated.length === 1 ? "" : "s"}).`);
        } else {
          log(`  No starter template updates were applied (starter files not found).`);
        }
      }
      writeInstallPreferences(cortexPath, { mcpEnabled, hooksEnabled, installedVersion: VERSION });

      // Post-update verification
      log(`\nVerifying setup...`);
      const verify = runPostInitVerify(cortexPath);
      for (const check of verify.checks) {
        log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
      }

      log(`\nDone. Restart your coding agent to pick up changes.\n`);
      return;
    }
  }

  log("\nSetting up cortex...\n");

  // Copy bundled starter to ~/.cortex
  function copyDir(src: string, dest: string) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  if (fs.existsSync(STARTER_DIR)) {
    copyDir(STARTER_DIR, cortexPath);
    log(`  Created cortex v${VERSION} → ${cortexPath}`);
  } else {
    log(`  Starter not found in package, creating minimal structure...`);
    fs.mkdirSync(path.join(cortexPath, "global", "skills"), { recursive: true });
    fs.mkdirSync(path.join(cortexPath, "profiles"), { recursive: true });
    fs.mkdirSync(path.join(cortexPath, "my-first-project"), { recursive: true });
    fs.writeFileSync(
      path.join(cortexPath, "global", "CLAUDE.md"),
      `# Global Context\n\nThis file is loaded in every project.\n\n## General preferences\n\n<!-- Your coding style, preferred tools, things Claude should always know -->\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, "my-first-project", "summary.md"),
      `# my-first-project\n\n**What:** Replace this with one sentence about what the project does\n**Stack:** The key tech\n**Status:** active\n**Run:** the command you use most\n**Gotcha:** the one thing that will bite you if you forget\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, "my-first-project", "CLAUDE.md"),
      `# my-first-project\n\nOne paragraph about what this project is.\n\n## Commands\n\n\`\`\`bash\n# Install:\n# Run:\n# Test:\n\`\`\`\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, "my-first-project", "LEARNINGS.md"),
      `# my-first-project LEARNINGS\n\n<!-- Learnings are captured automatically during sessions and committed on exit -->\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, "my-first-project", "backlog.md"),
      `# my-first-project backlog\n\n## Active\n\n## Queue\n\n## Done\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, "profiles", "personal.yaml"),
      `name: personal\ndescription: Default profile\nprojects:\n  - global\n  - my-first-project\n`
    );
  }

  // Update machines.yaml with hostname (--machine overrides auto-detected hostname)
  const effectiveMachine = opts.machine || os.hostname();
  updateMachinesYaml(cortexPath, opts.machine, opts.profile);
  ensureGovernanceFiles(cortexPath);
  const mcpEnabled = opts.mcp ? opts.mcp === "on" : getMcpEnabledPreference(cortexPath);
  const hooksEnabled = getHooksEnabledPreference(cortexPath);
  const mcpLabel = mcpEnabled ? "ON (recommended)" : "OFF (hooks-only fallback)";
  const hooksLabel = hooksEnabled ? "ON (active)" : "OFF (disabled)";
  log(`  Updated machines.yaml with hostname "${effectiveMachine}"`);
  log(`  MCP mode: ${mcpLabel}`);
  log(`  Hooks mode: ${hooksLabel}`);

  // Configure Claude Code
  try {
    const status = configureClaude(cortexPath, { mcpEnabled, hooksEnabled });
    if (status === "disabled" || status === "already_disabled") {
      log(`  Configured Claude Code hooks (MCP disabled)`);
    } else {
      log(`  Configured Claude Code MCP + hooks`);
    }
  } catch (e) {
    log(`  Could not configure Claude Code settings (${e}), add manually`);
  }

  // Configure VS Code
  try {
    const vscodeResult = configureVSCode(cortexPath, { mcpEnabled });
    logMcpTargetStatus("VS Code", vscodeResult, "Configured");
  } catch {
    // skip
  }

  try {
    logMcpTargetStatus("Cursor", configureCursorMcp(cortexPath, { mcpEnabled }), "Configured");
  } catch { /* best effort */ }

  try {
    logMcpTargetStatus("Copilot CLI", configureCopilotMcp(cortexPath, { mcpEnabled }), "Configured");
  } catch { /* best effort */ }

  try {
    logMcpTargetStatus("Codex", configureCodexMcp(cortexPath, { mcpEnabled }), "Configured");
  } catch { /* best effort */ }

  // Configure hooks for other detected AI coding tools (Copilot CLI, Cursor, Codex)
  if (hooksEnabled) {
    try {
      const hooked = configureAllHooks(cortexPath);
      if (hooked.length) log(`  Configured hooks: ${hooked.join(", ")}`);
    } catch { /* best effort */ }
  } else {
    log(`  Hooks are disabled by preference (run: npx @alaarab/cortex hooks-mode on)`);
  }

  writeInstallPreferences(cortexPath, { mcpEnabled, hooksEnabled, installedVersion: VERSION });

  // Post-init verification
  log(`\nVerifying setup...`);
  const verify = runPostInitVerify(cortexPath);
  for (const check of verify.checks) {
    log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
  }

  log(`\nWhat was created:`);
  log(`  ${cortexPath}/global/CLAUDE.md    Global instructions loaded in every session`);
  log(`  ${cortexPath}/global/skills/      Cortex slash commands`);
  log(`  ${cortexPath}/profiles/           Machine-to-project mappings`);
  log(`  ${cortexPath}/.governance/        Memory governance policies`);

  log(`\nNext steps:`);
  log(`  1. Restart your coding agent to activate cortex`);
  log(`     (close and reopen Claude Code, or start a new session)`);
  log(`  2. Create a private GitHub repo and push your cortex:`);
  log(`     cd ${cortexPath}`);
  log(`     git init && git add . && git commit -m "Initial cortex setup"`);
  log(`     git remote add origin git@github.com:YOUR_USERNAME/cortex.git`);
  log(`     git push -u origin main`);
  if (!mcpEnabled) {
    log(`  3. Turn MCP on later: npx @alaarab/cortex mcp-mode on`);
  }
  log(`  4. Open a project and run /cortex-init <name> to add it`);
  log(`  5. Run \`npx @alaarab/cortex verify\` to check everything is wired up`);
  log(``);
}

export async function runMcpMode(modeArg?: string) {
  const cortexPath = process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getMcpEnabledPreference(cortexPath);
    const hooks = getHooksEnabledPreference(cortexPath);
    log(`MCP mode: ${current ? "on (recommended)" : "off (hooks-only fallback)"}`);
    log(`Hooks mode: ${hooks ? "on (active)" : "off (disabled)"}`);
    log(`Change mode: npx @alaarab/cortex mcp-mode on|off`);
    log(`Hooks toggle: npx @alaarab/cortex hooks-mode on|off`);
    return;
  }
  const mode = parseMcpMode(normalizedArg);
  if (!mode) {
    throw new Error(`Invalid mode "${modeArg}". Use: on | off | status`);
  }
  const enabled = mode === "on";
  setMcpEnabledPreference(cortexPath, enabled);

  let claudeStatus: ToolStatus = "no_settings";
  let vscodeStatus: ToolStatus = "no_vscode";
  let cursorStatus: ToolStatus = "no_cursor";
  let copilotStatus: ToolStatus = "no_copilot";
  let codexStatus: ToolStatus = "no_codex";
  try { claudeStatus = configureClaude(cortexPath, { mcpEnabled: enabled }) ?? claudeStatus; } catch { /* best effort */ }
  try { vscodeStatus = configureVSCode(cortexPath, { mcpEnabled: enabled }) ?? vscodeStatus; } catch { /* best effort */ }
  try { cursorStatus = configureCursorMcp(cortexPath, { mcpEnabled: enabled }) ?? cursorStatus; } catch { /* best effort */ }
  try { copilotStatus = configureCopilotMcp(cortexPath, { mcpEnabled: enabled }) ?? copilotStatus; } catch { /* best effort */ }
  try { codexStatus = configureCodexMcp(cortexPath, { mcpEnabled: enabled }) ?? codexStatus; } catch { /* best effort */ }

  log(`MCP mode set to ${mode}.`);
  log(`Claude status: ${claudeStatus}`);
  log(`VS Code status: ${vscodeStatus}`);
  log(`Cursor status: ${cursorStatus}`);
  log(`Copilot CLI status: ${copilotStatus}`);
  log(`Codex status: ${codexStatus}`);
  log(`Restart your agent to apply changes.`);
}

export async function runHooksMode(modeArg?: string) {
  const cortexPath = process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getHooksEnabledPreference(cortexPath);
    log(`Hooks mode: ${current ? "on (active)" : "off (disabled)"}`);
    log(`Change mode: npx @alaarab/cortex hooks-mode on|off`);
    return;
  }
  const mode = parseMcpMode(normalizedArg);
  if (!mode) {
    throw new Error(`Invalid mode "${modeArg}". Use: on | off | status`);
  }

  const enabled = mode === "on";
  setHooksEnabledPreference(cortexPath, enabled);

  let claudeStatus: ToolStatus = "no_settings";
  try {
    claudeStatus = configureClaude(cortexPath, {
      mcpEnabled: getMcpEnabledPreference(cortexPath),
      hooksEnabled: enabled,
    }) ?? claudeStatus;
  } catch { /* best effort */ }

  if (enabled) {
    try {
      const hooked = configureAllHooks(cortexPath);
      if (hooked.length) log(`Updated hooks: ${hooked.join(", ")}`);
    } catch { /* best effort */ }
  } else {
    log("Hooks will no-op immediately via preference and Claude hooks are removed.");
  }

  log(`Hooks mode set to ${mode}.`);
  log(`Claude status: ${claudeStatus}`);
  log(`Restart your agent to apply changes.`);
}

export async function runUninstall() {
  log("\nUninstalling cortex...\n");

  const home = os.homedir();
  const settingsPath = path.join(home, ".claude", "settings.json");

  // Remove from Claude Code settings.json
  if (fs.existsSync(settingsPath)) {
    try {
      patchJsonFile(settingsPath, (data) => {
        // Remove MCP server
        if (data.mcpServers?.cortex) {
          delete data.mcpServers.cortex;
          log(`  Removed cortex MCP server from Claude Code settings`);
        }

        // Remove hooks containing cortex references
        for (const hookEvent of ["UserPromptSubmit", "Stop", "SessionStart"] as const) {
          const hooks = data.hooks?.[hookEvent] as any[] | undefined;
          if (!Array.isArray(hooks)) continue;
          const before = hooks.length;
          data.hooks[hookEvent] = hooks.filter(
            (h: any) => !h.hooks?.some(
              (hook: any) => typeof hook.command === "string" && isCortexCommand(hook.command)
            )
          );
          const removed = before - data.hooks[hookEvent].length;
          if (removed > 0) log(`  Removed ${removed} cortex hook(s) from ${hookEvent}`);
        }
      });
    } catch (e) {
      log(`  Warning: could not update Claude Code settings (${e})`);
    }
  } else {
    log(`  Claude Code settings not found at ${settingsPath} — skipping`);
  }

  // Remove from VS Code mcp.json
  const vsCandidates = [
    path.join(home, ".config", "Code", "User", "mcp.json"),
    path.join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
    path.join(home, "AppData", "Roaming", "Code", "User", "mcp.json"),
  ];
  for (const mcpFile of vsCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed cortex from VS Code MCP config (${mcpFile})`);
      }
    } catch { /* skip */ }
  }

  // Remove from Cursor MCP config
  const cursorCandidates = [
    path.join(home, ".cursor", "mcp.json"),
    path.join(home, ".config", "Cursor", "User", "mcp.json"),
    path.join(home, "Library", "Application Support", "Cursor", "User", "mcp.json"),
    path.join(home, "AppData", "Roaming", "Cursor", "User", "mcp.json"),
  ];
  for (const mcpFile of cursorCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed cortex from Cursor MCP config (${mcpFile})`);
      }
    } catch { /* skip */ }
  }

  // Remove from Copilot CLI MCP config
  const copilotCandidates = [
    path.join(home, ".github", "mcp.json"),
    path.join(home, ".config", "github-copilot", "mcp.json"),
    path.join(home, "Library", "Application Support", "github-copilot", "mcp.json"),
    path.join(home, "AppData", "Roaming", "github-copilot", "mcp.json"),
  ];
  for (const mcpFile of copilotCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed cortex from Copilot CLI MCP config (${mcpFile})`);
      }
    } catch { /* skip */ }
  }

  // Remove from Codex MCP config
  const codexCandidates = [
    path.join(home, ".codex", "config.json"),
    path.join(home, ".codex", "mcp.json"),
    path.join(process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH, "codex.json"),
  ];
  for (const mcpFile of codexCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed cortex from Codex MCP config (${mcpFile})`);
      }
    } catch { /* skip */ }
  }

  log(`\nCortex hooks and MCP config removed.`);
  log(`\nYour knowledge base at ~/.cortex was NOT deleted.`);
  log(`To fully remove it, run: rm -rf ~/.cortex\n`);
  log(`Restart your agent(s) to apply changes.\n`);
}
