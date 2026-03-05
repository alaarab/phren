import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import { configureAllHooks } from "./hooks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version as string;
const STARTER_DIR = path.join(ROOT, "starter");
const DEFAULT_CORTEX_PATH = path.join(os.homedir(), ".cortex");

export type McpMode = "on" | "off";

interface InstallPreferences {
  mcpEnabled?: boolean;
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

function log(msg: string) {
  process.stdout.write(msg + "\n");
}

function patchJsonFile(filePath: string, patch: (data: Record<string, any>) => void) {
  let data: Record<string, any> = {};
  if (fs.existsSync(filePath)) {
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      // malformed json, start fresh
    }
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  patch(data);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function resolveEntryScript(): string {
  // Find the actual index.js path so hooks can use `node <path>` instead of npx
  return path.join(ROOT, "mcp", "dist", "index.js");
}

export function ensureGovernanceFiles(cortexPath: string) {
  const govDir = path.join(cortexPath, ".governance");
  fs.mkdirSync(govDir, { recursive: true });
  const policy = path.join(govDir, "memory-policy.json");
  const access = path.join(govDir, "access-control.json");

  if (!fs.existsSync(policy)) {
    fs.writeFileSync(
      policy,
      JSON.stringify({
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
        admins: [user],
        maintainers: [],
        contributors: [],
        viewers: [],
      }, null, 2) + "\n"
    );
  }
}

export function configureClaude(cortexPath: string, opts: { mcpEnabled?: boolean } = {}) {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const entryScript = resolveEntryScript();
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  let status: "installed" | "already_configured" | "disabled" | "already_disabled" = "already_disabled";

  patchJsonFile(settingsPath, (data) => {
    // MCP server
    if (!data.mcpServers) data.mcpServers = {};
    const hadMcp = Boolean(data.mcpServers.cortex);
    if (mcpEnabled) {
      data.mcpServers.cortex = {
        command: "npx",
        args: ["-y", `@alaarab/cortex@${VERSION}`, cortexPath],
      };
      status = hadMcp ? "already_configured" : "installed";
    } else {
      if (hadMcp) delete data.mcpServers.cortex;
      status = hadMcp ? "disabled" : "already_disabled";
    }

    // Hooks: always update to latest version
    if (!data.hooks) data.hooks = {};

    // UserPromptSubmit hook: auto-inject cortex context into every prompt
    const promptHook = {
      type: "command",
      command: `node "${entryScript}" hook-prompt`,
      timeout: 3,
    };
    const existingPrompt = data.hooks.UserPromptSubmit as any[] | undefined;
    const hasCortexPromptHook = existingPrompt?.some(
      (h: any) => h.hooks?.some((hook: any) => hook.command?.includes("cortex") && hook.command?.includes("hook-prompt"))
    );
    if (!hasCortexPromptHook) {
      if (!data.hooks.UserPromptSubmit) data.hooks.UserPromptSubmit = [];
      data.hooks.UserPromptSubmit.push({ matcher: "", hooks: [promptHook] });
    }

    // Stop hook: auto-commit cortex changes
    const stopHook = {
      type: "command",
      command: `cd "${cortexPath}" && git diff --quiet 2>/dev/null || (git add -A && git commit -m 'auto-save cortex' && git push 2>/dev/null || true)`,
    };
    const existingStop = data.hooks.Stop as any[] | undefined;
    const hasCortexStopHook = existingStop?.some(
      (h: any) => h.hooks?.some((hook: any) => hook.command?.includes(".cortex") && hook.command?.includes("auto-save"))
    );
    if (!hasCortexStopHook) {
      if (!data.hooks.Stop) data.hooks.Stop = [];
      data.hooks.Stop.push({ matcher: "", hooks: [stopHook] });
    }

    // SessionStart hook: auto-pull cortex on session start
    const startHook = {
      type: "command",
      command: `cd "${cortexPath}" && (git pull --rebase --quiet 2>/dev/null || true) && (npx @alaarab/cortex doctor --fix >/dev/null 2>&1 || true)`,
    };
    const existingStart = data.hooks.SessionStart as any[] | undefined;
    const hasCortexStartHook = existingStart?.some(
      (h: any) => h.hooks?.some((hook: any) => hook.command?.includes(".cortex") && hook.command?.includes("git pull"))
    );
    if (!hasCortexStartHook) {
      if (!data.hooks.SessionStart) data.hooks.SessionStart = [];
      data.hooks.SessionStart.push({ matcher: "", hooks: [startHook] });
    }
  });
  return status;
}

export function configureVSCode(cortexPath: string, opts: { mcpEnabled?: boolean } = {}) {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  const candidates = [
    path.join(os.homedir(), ".config", "Code", "User"),
    path.join(os.homedir(), "Library", "Application Support", "Code", "User"),
    path.join(os.homedir(), "AppData", "Roaming", "Code", "User"),
  ];
  const vscodeDir = candidates.find((d) => fs.existsSync(d));
  if (!vscodeDir) return "no_vscode";

  const mcp_file = path.join(vscodeDir, "mcp.json");
  if (!mcpEnabled && !fs.existsSync(mcp_file)) return "already_disabled";
  let status: "installed" | "already_configured" | "disabled" | "already_disabled" = "already_disabled";
  patchJsonFile(mcp_file, (data) => {
    if (!data.servers) data.servers = {};
    const hadMcp = Boolean(data.servers.cortex);
    if (mcpEnabled) {
      data.servers.cortex = {
        command: "npx",
        args: ["-y", `@alaarab/cortex@${VERSION}`, cortexPath],
      };
      status = hadMcp ? "already_configured" : "installed";
    } else {
      if (hadMcp) delete data.servers.cortex;
      status = hadMcp ? "disabled" : "already_disabled";
    }
  });
  return status;
}

function updateMachinesYaml(cortexPath: string, machine?: string, profile?: string) {
  const machinesFile = path.join(cortexPath, "machines.yaml");
  if (!fs.existsSync(machinesFile)) return;
  const hostname = machine || os.hostname();
  const profileName = profile || "personal";
  let content = fs.readFileSync(machinesFile, "utf8");
  // Replace placeholder comment block with actual hostname entry
  if (!content.includes(hostname)) {
    content = content.replace(
      /^#.*\n/gm,
      ""
    ).trim();
    content = `${hostname}: ${profileName}\n\n` + content;
    fs.writeFileSync(machinesFile, content);
  }
}

export interface InitOptions {
  machine?: string;
  profile?: string;
  mcp?: McpMode;
}

export async function runInit(opts: InitOptions = {}) {
  const cortexPath = process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;
  const mcpEnabled = opts.mcp ? opts.mcp === "on" : getMcpEnabledPreference(cortexPath);
  const mcpLabel = mcpEnabled ? "ON (recommended)" : "OFF (hooks-only fallback)";

  if (fs.existsSync(cortexPath)) {
    const entries = fs.readdirSync(cortexPath);
    if (entries.length > 0) {
      log(`\ncortex already exists at ${cortexPath}`);
      log(`Updating configuration...\n`);
      log(`  MCP mode: ${mcpLabel}`);

      // Always reconfigure MCP and hooks (picks up new features on upgrade)
      try {
        const status = configureClaude(cortexPath, { mcpEnabled });
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
        if (vscodeResult === "installed") log(`  Updated VS Code MCP`);
        if (vscodeResult === "disabled") log(`  Disabled VS Code MCP`);
      } catch {}

      try {
        const hooked = configureAllHooks(cortexPath);
        if (hooked.length) log(`  Updated hooks: ${hooked.join(", ")}`);
      } catch { /* best effort */ }

      ensureGovernanceFiles(cortexPath);
      setMcpEnabledPreference(cortexPath, mcpEnabled);

      log(`\nDone. Restart Claude Code to pick up changes.\n`);
      process.exit(0);
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
  log(`  Updated machines.yaml with hostname "${effectiveMachine}"`);
  log(`  MCP mode: ${mcpLabel}`);

  // Configure Claude Code
  try {
    const status = configureClaude(cortexPath, { mcpEnabled });
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
    if (vscodeResult === "installed") log(`  Configured VS Code MCP`);
    else if (vscodeResult === "already_configured") log(`  VS Code MCP already configured`);
    else if (vscodeResult === "disabled") log(`  VS Code MCP disabled`);
    // no_vscode: skip silently
  } catch {
    // skip
  }

  // Configure hooks for other detected AI coding tools (Copilot CLI, Cursor, Codex)
  try {
    const hooked = configureAllHooks(cortexPath);
    if (hooked.length) log(`  Configured hooks: ${hooked.join(", ")}`);
  } catch { /* best effort */ }

  ensureGovernanceFiles(cortexPath);
  setMcpEnabledPreference(cortexPath, mcpEnabled);

  log(`\nDone. Your knowledge base is at ${cortexPath}\n`);
  log(`Next steps:`);
  log(`  1. Create a private GitHub repo and push your cortex:`);
  log(`     cd ${cortexPath}`);
  log(`     git init`);
  log(`     git add .`);
  log(`     git commit -m "Initial cortex setup"`);
  log(`     git remote add origin git@github.com:YOUR_USERNAME/cortex.git`);
  log(`     git push -u origin main`);
  if (mcpEnabled) {
    log(`  2. Restart Claude Code to activate the MCP server`);
  } else {
    log(`  2. Restart Claude Code to use hooks-only mode (no MCP tools)`);
    log(`     Turn MCP on later: npx @alaarab/cortex mcp-mode on`);
  }
  log(`  3. Open a project and run /cortex-init <name> to add it\n`);
}

export async function runMcpMode(modeArg?: string) {
  const cortexPath = process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getMcpEnabledPreference(cortexPath);
    log(`MCP mode: ${current ? "on (recommended)" : "off (hooks-only fallback)"}`);
    log(`Change mode: npx @alaarab/cortex mcp-mode on|off`);
    return;
  }
  const mode = parseMcpMode(normalizedArg);
  if (!mode) {
    log(`Invalid mode "${modeArg}". Use: on | off | status`);
    process.exit(1);
  }
  const enabled = mode === "on";
  setMcpEnabledPreference(cortexPath, enabled);

  let claudeStatus = "no_settings";
  let vscodeStatus = "no_vscode";
  try { claudeStatus = configureClaude(cortexPath, { mcpEnabled: enabled }) ?? claudeStatus; } catch { /* best effort */ }
  try { vscodeStatus = configureVSCode(cortexPath, { mcpEnabled: enabled }) ?? vscodeStatus; } catch { /* best effort */ }

  log(`MCP mode set to ${mode}.`);
  log(`Claude status: ${claudeStatus}`);
  log(`VS Code status: ${vscodeStatus}`);
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
              (hook: any) => typeof hook.command === "string" && hook.command.includes("cortex")
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
    if (!fs.existsSync(mcpFile)) continue;
    try {
      patchJsonFile(mcpFile, (data) => {
        if (data.servers?.cortex) {
          delete data.servers.cortex;
          log(`  Removed cortex from VS Code MCP config (${mcpFile})`);
        }
      });
    } catch { /* skip */ }
  }

  log(`\nCortex hooks and MCP config removed.`);
  log(`\nYour knowledge base at ~/.cortex was NOT deleted.`);
  log(`To fully remove it, run: rm -rf ~/.cortex\n`);
  log(`Restart Claude Code to apply changes.\n`);
}
