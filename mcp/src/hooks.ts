import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { EXEC_TIMEOUT_QUICK_MS } from "./shared.js";

export function commandExists(cmd: string): boolean {
  try {
    const whichCmd = process.platform === "win32" ? "where.exe" : "which";
    execFileSync(whichCmd, [cmd], { stdio: ["ignore", "ignore", "ignore"], timeout: EXEC_TIMEOUT_QUICK_MS });
    return true;
  } catch { return false; }
}

export function detectInstalledTools(): Set<string> {
  const tools = new Set<string>();
  if (commandExists("github-copilot-cli") || fs.existsSync(path.join(os.homedir(), ".local", "share", "gh", "extensions", "gh-copilot"))) {
    tools.add("copilot");
  }
  if (commandExists("cursor") || fs.existsSync(path.join(os.homedir(), ".cursor"))) {
    tools.add("cursor");
  }
  if (commandExists("codex") || fs.existsSync(path.join(os.homedir(), ".codex"))) {
    tools.add("codex");
  }
  return tools;
}

function resolveToolBinary(tool: string): string | null {
  try {
    const wrapperPath = path.resolve(path.join(os.homedir(), ".local", "bin", tool));
    const whichCmd = process.platform === "win32" ? "where.exe" : "which";
    const whichArgs = process.platform === "win32" ? [tool] : ["-a", tool];
    const raw = execFileSync(whichCmd, whichArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: EXEC_TIMEOUT_QUICK_MS,
    });
    const candidates = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      if (resolved !== wrapperPath) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

function resolveCliEntryScript(): string | null {
  const local = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  return fs.existsSync(local) ? local : null;
}

export interface LifecycleCommands {
  sessionStart: string;
  userPromptSubmit: string;
  stop: string;
  hookTool: string;
}

export function buildLifecycleCommands(cortexPath: string): LifecycleCommands {
  const entry = resolveCliEntryScript();
  const isWindows = process.platform === "win32";

  if (entry) {
    const escapedEntry = entry.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const escapedCortex = cortexPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    if (isWindows) {
      return {
        sessionStart: `set "CORTEX_PATH=${escapedCortex}" && node "${escapedEntry}" hook-session-start`,
        userPromptSubmit: `set "CORTEX_PATH=${escapedCortex}" && node "${escapedEntry}" hook-prompt`,
        stop: `set "CORTEX_PATH=${escapedCortex}" && node "${escapedEntry}" hook-stop`,
        hookTool: `set "CORTEX_PATH=${escapedCortex}" && node "${escapedEntry}" hook-tool`,
      };
    }
    return {
      sessionStart: `CORTEX_PATH="${escapedCortex}" node "${escapedEntry}" hook-session-start`,
      userPromptSubmit: `CORTEX_PATH="${escapedCortex}" node "${escapedEntry}" hook-prompt`,
      stop: `CORTEX_PATH="${escapedCortex}" node "${escapedEntry}" hook-stop`,
      hookTool: `CORTEX_PATH="${escapedCortex}" node "${escapedEntry}" hook-tool`,
    };
  }

  const escapedCortex = cortexPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (isWindows) {
    return {
      sessionStart: `set "CORTEX_PATH=${escapedCortex}" && npx @alaarab/cortex hook-session-start`,
      userPromptSubmit: `set "CORTEX_PATH=${escapedCortex}" && npx @alaarab/cortex hook-prompt`,
      stop: `set "CORTEX_PATH=${escapedCortex}" && npx @alaarab/cortex hook-stop`,
      hookTool: `set "CORTEX_PATH=${escapedCortex}" && npx @alaarab/cortex hook-tool`,
    };
  }
  return {
    sessionStart: `CORTEX_PATH="${escapedCortex}" npx @alaarab/cortex hook-session-start`,
    userPromptSubmit: `CORTEX_PATH="${escapedCortex}" npx @alaarab/cortex hook-prompt`,
    stop: `CORTEX_PATH="${escapedCortex}" npx @alaarab/cortex hook-stop`,
    hookTool: `CORTEX_PATH="${escapedCortex}" npx @alaarab/cortex hook-tool`,
  };
}

function installSessionWrapper(tool: string, cortexPath: string): boolean {
  const realBinary = resolveToolBinary(tool);
  if (!realBinary) return false;

  const entry = resolveCliEntryScript();

  const localBinDir = path.join(os.homedir(), ".local", "bin");
  const wrapperPath = path.join(localBinDir, tool);

  const escapedBinary = realBinary.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedCortex = cortexPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedEntry = entry ? entry.replace(/\\/g, "\\\\").replace(/"/g, '\\"') : "";
  const sessionStartCmd = entry
    ? `env CORTEX_PATH="$CORTEX_PATH" node "$ENTRY_SCRIPT" hook-session-start`
    : `env CORTEX_PATH="$CORTEX_PATH" npx @alaarab/cortex hook-session-start`;
  const stopCmd = entry
    ? `env CORTEX_PATH="$CORTEX_PATH" node "$ENTRY_SCRIPT" hook-stop`
    : `env CORTEX_PATH="$CORTEX_PATH" npx @alaarab/cortex hook-stop`;
  const content = `#!/bin/sh
set -u

REAL_BIN="${escapedBinary}"
CORTEX_PATH="\${CORTEX_PATH:-${escapedCortex}}"
ENTRY_SCRIPT="${escapedEntry}"

if [ ! -x "$REAL_BIN" ]; then
  echo "cortex wrapper error: real ${tool} binary not executable: $REAL_BIN" >&2
  exit 127
fi

case "\${1:-}" in
  -h|--help|help|-V|--version|version|completion)
    exec "$REAL_BIN" "$@"
    ;;
esac

run_with_timeout() {
  _timeout_val="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$_timeout_val" "$@" || true
  else
    "$@" || true
  fi
}

run_with_timeout 14s ${sessionStartCmd} >/dev/null 2>&1

"$REAL_BIN" "$@"
status=$?

run_with_timeout 14s ${stopCmd} >/dev/null 2>&1

exit $status
`;

  try {
    fs.mkdirSync(localBinDir, { recursive: true });
    fs.writeFileSync(wrapperPath, content);
    fs.chmodSync(wrapperPath, 0o755);
    return true;
  } catch {
    return false;
  }
}

// Hook config schemas for each tool. Validates shape before writing to catch
// breaking changes if any tool updates its config format.
interface HookEntry { type: string; [k: string]: unknown }
interface CopilotHookConfig {
  version: number;
  hooks: {
    sessionStart: HookEntry[];
    userPromptSubmitted: HookEntry[];
    sessionEnd: HookEntry[];
  };
}
interface CursorHookConfig {
  version: number;
  sessionStart: { command: string };
  beforeSubmitPrompt: { command: string };
  stop: { command: string };
}
interface CodexHookConfig {
  hooks: {
    SessionStart: HookEntry[];
    UserPromptSubmit: HookEntry[];
    Stop: HookEntry[];
  };
}

function validateCopilotConfig(config: CopilotHookConfig): boolean {
  return (
    typeof config.version === "number" &&
    Array.isArray(config.hooks?.sessionStart) &&
    Array.isArray(config.hooks?.userPromptSubmitted) &&
    Array.isArray(config.hooks?.sessionEnd)
  );
}

function validateCursorConfig(config: CursorHookConfig): boolean {
  return (
    typeof config.version === "number" &&
    typeof config.sessionStart?.command === "string" &&
    typeof config.beforeSubmitPrompt?.command === "string" &&
    typeof config.stop?.command === "string"
  );
}

function validateCodexConfig(config: CodexHookConfig): boolean {
  return (
    Array.isArray(config.hooks?.SessionStart) &&
    Array.isArray(config.hooks?.UserPromptSubmit) &&
    Array.isArray(config.hooks?.Stop)
  );
}

export interface HookToolPreferences {
  claude?: boolean;
  copilot?: boolean;
  cursor?: boolean;
  codex?: boolean;
}

function readHookPreferences(cortexPath: string): { enabled: boolean; toolPrefs: HookToolPreferences } {
  try {
    const prefsPath = path.join(cortexPath, ".governance", "install-preferences.json");
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
    const enabled = prefs.hooksEnabled !== false;
    const toolPrefs: HookToolPreferences = prefs.hookTools && typeof prefs.hookTools === "object"
      ? prefs.hookTools
      : {};
    return { enabled, toolPrefs };
  } catch {
    return { enabled: true, toolPrefs: {} };
  }
}

function isToolHookEnabled(cortexPath: string, tool: string): boolean {
  const { enabled, toolPrefs } = readHookPreferences(cortexPath);
  if (!enabled) return false;
  const key = tool as keyof HookToolPreferences;
  if (key in toolPrefs) return toolPrefs[key] !== false;
  return true;
}

// ── #218: Custom integration hooks ──────────────────────────────────────

export type CustomHookEvent =
  | "pre-save"      // Before push_changes commits
  | "post-save"     // After push_changes pushes
  | "post-search"   // After search_cortex returns results
  | "pre-finding"   // Before a finding is written to FINDINGS.md
  | "post-finding"  // After a finding is written
  | "pre-index"     // Before FTS index rebuild
  | "post-index";   // After FTS index rebuild

export interface CustomHookEntry {
  event: CustomHookEvent;
  command: string;
  timeout?: number; // ms, default 5000
}

const VALID_HOOK_EVENTS = new Set<string>([
  "pre-save", "post-save", "post-search",
  "pre-finding", "post-finding",
  "pre-index", "post-index",
]);

const DEFAULT_CUSTOM_HOOK_TIMEOUT = 5000;

export function readCustomHooks(cortexPath: string): CustomHookEntry[] {
  try {
    const prefsPath = path.join(cortexPath, ".governance", "install-preferences.json");
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
    if (!Array.isArray(prefs.customHooks)) return [];
    return prefs.customHooks.filter(
      (h: Record<string, unknown>) =>
        h &&
        typeof h.event === "string" &&
        VALID_HOOK_EVENTS.has(h.event) &&
        typeof h.command === "string" &&
        h.command.trim().length > 0
    );
  } catch {
    return [];
  }
}

export function runCustomHooks(
  cortexPath: string,
  event: CustomHookEvent,
  env: Record<string, string> = {}
): { ran: number; errors: string[] } {
  const hooks = readCustomHooks(cortexPath);
  const matching = hooks.filter((h) => h.event === event);
  const errors: string[] = [];

  const isWindows = process.platform === "win32";
  const shellCmd = isWindows ? "cmd" : "sh";

  for (const hook of matching) {
    const shellArgs = isWindows ? ["/c", hook.command] : ["-c", hook.command];
    try {
      execFileSync(shellCmd, shellArgs, {
        cwd: cortexPath,
        encoding: "utf8",
        timeout: hook.timeout ?? DEFAULT_CUSTOM_HOOK_TIMEOUT,
        env: { ...process.env, CORTEX_PATH: cortexPath, CORTEX_HOOK_EVENT: event, ...env },
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err: unknown) {
      errors.push(`${event}: ${hook.command}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ran: matching.length, errors };
}

export interface HookConfigOptions {
  tools?: Set<string>;
  allTools?: boolean;
}

export function configureAllHooks(cortexPath: string, options: HookConfigOptions = {}): string[] {
  const configured: string[] = [];
  const detected: Set<string> = options.tools
    ? options.tools
    : options.allTools
      ? new Set(["copilot", "cursor", "codex"])
      : detectInstalledTools();

  const lifecycle = buildLifecycleCommands(cortexPath);
  const pullCmd = lifecycle.sessionStart;
  const promptCmd = lifecycle.userPromptSubmit;
  const stopCmd = lifecycle.stop;

  // ── GitHub Copilot CLI (user-level: ~/.github/hooks/cortex.json) ──────────
  if (detected.has("copilot")) {
    const copilotHooksDir = path.join(os.homedir(), ".github", "hooks");
    const copilotFile = path.join(copilotHooksDir, "cortex.json");
    try {
      fs.mkdirSync(copilotHooksDir, { recursive: true });
      const config: CopilotHookConfig = {
        version: 1,
        hooks: {
          sessionStart: [{ type: "command", bash: pullCmd }],
          userPromptSubmitted: [{ type: "command", bash: promptCmd }],
          sessionEnd: [{ type: "command", bash: stopCmd }],
        },
      };
      if (!validateCopilotConfig(config)) throw new Error("invalid copilot hook config shape");
      fs.writeFileSync(copilotFile, JSON.stringify(config, null, 2));
      configured.push("Copilot CLI");
    } catch { /* best effort */ }
    if (isToolHookEnabled(cortexPath, "copilot")) installSessionWrapper("copilot", cortexPath);
  }

  // ── Cursor (user-level: ~/.cursor/hooks.json) ────────────────────────────
  if (detected.has("cursor")) {
    const cursorFile = path.join(os.homedir(), ".cursor", "hooks.json");
    try {
      fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(fs.readFileSync(cursorFile, "utf8")); } catch { /* new file */ }
      const config: CursorHookConfig = {
        ...existing,
        version: 1,
        // Cursor parity: sessionStart is best-effort where supported; wrapper also enforces lifecycle.
        sessionStart: { command: pullCmd },
        beforeSubmitPrompt: { command: promptCmd },
        stop: { command: stopCmd },
      };
      if (!validateCursorConfig(config)) throw new Error("invalid cursor hook config shape");
      fs.writeFileSync(cursorFile, JSON.stringify(config, null, 2));
      configured.push("Cursor");
    } catch { /* best effort */ }
    if (isToolHookEnabled(cortexPath, "cursor")) installSessionWrapper("cursor", cortexPath);
  }

  // ── Codex (codex.json in cortex path) ────────────────────────────────────
  if (detected.has("codex")) {
    const codexFile = path.join(cortexPath, "codex.json");
    try {
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(fs.readFileSync(codexFile, "utf8")); } catch { /* new file */ }
      const config: CodexHookConfig = {
        ...existing,
        hooks: {
          SessionStart: [{ type: "command", command: pullCmd }],
          UserPromptSubmit: [{ type: "command", command: promptCmd }],
          Stop: [{ type: "command", command: stopCmd }],
        },
      };
      if (!validateCodexConfig(config)) throw new Error("invalid codex hook config shape");
      fs.writeFileSync(codexFile, JSON.stringify(config, null, 2));
      configured.push("Codex");
    } catch { /* best effort */ }
    if (isToolHookEnabled(cortexPath, "codex")) installSessionWrapper("codex", cortexPath);
  }

  return configured;
}
