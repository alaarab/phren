import * as fs from "fs";
import * as path from "path";
import { createHmac, randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { EXEC_TIMEOUT_QUICK_MS, CortexError, debugLog, runtimeFile, homePath, installPreferencesFile, type CortexErrorCode } from "./shared.js";
import { errorMessage } from "./utils.js";
import { hookConfigPath } from "./provider-adapters.js";
import { PACKAGE_SPEC } from "./package-metadata.js";

export interface HookError {
  code: CortexErrorCode;
  message: string;
}

function atomicWriteText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

export function commandExists(cmd: string): boolean {
  try {
    const whichCmd = process.platform === "win32" ? "where.exe" : "which";
    execFileSync(whichCmd, [cmd], { stdio: ["ignore", "ignore", "ignore"], timeout: EXEC_TIMEOUT_QUICK_MS });
    return true;
  } catch (err: unknown) {
    debugLog(`commandExists: ${cmd} not found: ${errorMessage(err)}`);
    return false;
  }
}

export function detectInstalledTools(): Set<string> {
  const tools = new Set<string>();
  if (commandExists("github-copilot-cli") || fs.existsSync(homePath(".local", "share", "gh", "extensions", "gh-copilot"))) {
    tools.add("copilot");
  }
  if (commandExists("cursor")) {
    tools.add("cursor");
  }
  if (commandExists("codex") || fs.existsSync(homePath(".codex"))) {
    tools.add("codex");
  }
  return tools;
}

function resolveToolBinary(tool: string): string | null {
  try {
    const wrapperPath = path.resolve(homePath(".local", "bin", tool));
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
  } catch (err: unknown) {
    debugLog(`resolveToolBinary: failed for ${tool}: ${errorMessage(err)}`);
    return null;
  }
  return null;
}

function resolveCliEntryScript(): string | null {
  const local = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  return fs.existsSync(local) ? local : null;
}

function cortexPackageSpec(): string {
  return PACKAGE_SPEC;
}

export interface LifecycleCommands {
  sessionStart: string;
  userPromptSubmit: string;
  stop: string;
  hookTool: string;
}

function buildPackageLifecycleCommands(): LifecycleCommands {
  const packageSpec = cortexPackageSpec();
  return {
    sessionStart: `npx -y ${packageSpec} hook-session-start`,
    userPromptSubmit: `npx -y ${packageSpec} hook-prompt`,
    stop: `npx -y ${packageSpec} hook-stop`,
    hookTool: `npx -y ${packageSpec} hook-tool`,
  };
}

export function buildLifecycleCommands(cortexPath: string): LifecycleCommands {
  const entry = resolveCliEntryScript();
  const isWindows = process.platform === "win32";
  const escapedCortex = cortexPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  if (entry) {
    const escapedEntry = entry.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

  const packageSpec = cortexPackageSpec();
  if (isWindows) {
    return {
      sessionStart: `set "CORTEX_PATH=${escapedCortex}" && npx -y ${packageSpec} hook-session-start`,
      userPromptSubmit: `set "CORTEX_PATH=${escapedCortex}" && npx -y ${packageSpec} hook-prompt`,
      stop: `set "CORTEX_PATH=${escapedCortex}" && npx -y ${packageSpec} hook-stop`,
      hookTool: `set "CORTEX_PATH=${escapedCortex}" && npx -y ${packageSpec} hook-tool`,
    };
  }
  return {
    sessionStart: `CORTEX_PATH="${escapedCortex}" npx -y ${packageSpec} hook-session-start`,
    userPromptSubmit: `CORTEX_PATH="${escapedCortex}" npx -y ${packageSpec} hook-prompt`,
    stop: `CORTEX_PATH="${escapedCortex}" npx -y ${packageSpec} hook-stop`,
    hookTool: `CORTEX_PATH="${escapedCortex}" npx -y ${packageSpec} hook-tool`,
  };
}

export function buildSharedLifecycleCommands(): LifecycleCommands {
  return buildPackageLifecycleCommands();
}

function installSessionWrapper(tool: string, cortexPath: string): boolean {
  const realBinary = resolveToolBinary(tool);
  if (!realBinary) return false;

  const entry = resolveCliEntryScript();

  const localBinDir = homePath(".local", "bin");
  const wrapperPath = path.join(localBinDir, tool);

  const escapedBinary = realBinary.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedCortex = cortexPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedEntry = entry ? entry.replace(/\\/g, "\\\\").replace(/"/g, '\\"') : "";
  const packageSpec = cortexPackageSpec();
  const sessionStartCmd = entry
    ? `env CORTEX_PATH="$CORTEX_PATH" node "$ENTRY_SCRIPT" hook-session-start`
    : `env CORTEX_PATH="$CORTEX_PATH" npx -y ${packageSpec} hook-session-start`;
  const stopCmd = entry
    ? `env CORTEX_PATH="$CORTEX_PATH" node "$ENTRY_SCRIPT" hook-stop`
    : `env CORTEX_PATH="$CORTEX_PATH" npx -y ${packageSpec} hook-stop`;
  const content = `#!/bin/sh
set -u

REAL_BIN="${escapedBinary}"
CORTEX_PATH="\${CORTEX_PATH:-${escapedCortex}}"
ENTRY_SCRIPT="${escapedEntry}"
export CORTEX_HOOK_TOOL="${tool}"

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

HOOK_TIMEOUT="\${CORTEX_HOOK_TIMEOUT_S:-${Math.ceil(HOOK_TIMEOUT_MS / 1000)}}s"

run_with_timeout "$HOOK_TIMEOUT" ${sessionStartCmd} >/dev/null 2>&1

"$REAL_BIN" "$@"
status=$?

run_with_timeout "$HOOK_TIMEOUT" ${stopCmd} >/dev/null 2>&1

exit $status
`;

  try {
    fs.mkdirSync(localBinDir, { recursive: true });
    atomicWriteText(wrapperPath, content);
    fs.chmodSync(wrapperPath, 0o755);
    return true;
  } catch (err: unknown) {
    debugLog(`installSessionWrapper: failed for ${tool}: ${errorMessage(err)}`);
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
    const prefsPath = installPreferencesFile(cortexPath);
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
    const enabled = prefs.hooksEnabled !== false;
    const toolPrefs: HookToolPreferences = prefs.hookTools && typeof prefs.hookTools === "object"
      ? prefs.hookTools
      : {};
    return { enabled, toolPrefs };
  } catch (err: unknown) {
    debugLog(`readHookPreferences: ${errorMessage(err)}`);
    return { enabled: true, toolPrefs: {} };
  }
}

export function isToolHookEnabled(cortexPath: string, tool: string): boolean {
  const { enabled, toolPrefs } = readHookPreferences(cortexPath);
  if (!enabled) return false;
  const key = tool as keyof HookToolPreferences;
  if (key in toolPrefs) return toolPrefs[key] !== false;
  return true;
}

// ── #218: Custom integration hooks ──────────────────────────────────────

export type CustomHookEvent =
  | "pre-save"         // Before push_changes commits
  | "post-save"        // After push_changes pushes
  | "post-search"      // After search_knowledge returns results
  | "pre-finding"      // Before a finding is written to FINDINGS.md
  | "post-finding"     // After a finding is written
  | "pre-index"        // Before FTS index rebuild
  | "post-index"       // After FTS index rebuild
  | "post-session-end" // After session_end completes
  | "post-consolidate"; // After FINDINGS.md consolidation runs

export interface CommandHookEntry {
  event: CustomHookEvent;
  command: string;
  timeout?: number; // ms, default 5000
}

export interface WebhookHookEntry {
  event: CustomHookEvent;
  webhook: string; // HTTP POST URL
  secret?: string; // Optional HMAC-SHA256 signing secret
  timeout?: number; // ms, default 5000
}

export type CustomHookEntry = CommandHookEntry | WebhookHookEntry;

export const HOOK_EVENT_VALUES = [
  "pre-save", "post-save", "post-search",
  "pre-finding", "post-finding",
  "pre-index", "post-index",
  "post-session-end", "post-consolidate",
] as const;

const VALID_HOOK_EVENTS = new Set<string>(HOOK_EVENT_VALUES);

/** Return the target (URL or shell command) for display or matching. */
export function getHookTarget(h: CustomHookEntry): string {
  return "webhook" in h ? h.webhook : h.command;
}

const DEFAULT_CUSTOM_HOOK_TIMEOUT = 5000;
const HOOK_TIMEOUT_MS = parseInt(process.env.CORTEX_HOOK_TIMEOUT_MS || '14000', 10);
const HOOK_ERROR_LOG_MAX_LINES = 1000;

export function readCustomHooks(cortexPath: string): CustomHookEntry[] {
  try {
    const prefsPath = installPreferencesFile(cortexPath);
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
    if (!Array.isArray(prefs.customHooks)) return [];
    return prefs.customHooks.filter(
      (h: Record<string, unknown>) =>
        h &&
        typeof h.event === "string" &&
        VALID_HOOK_EVENTS.has(h.event) &&
        (
          (typeof h.command === "string" && h.command.trim().length > 0) ||
          (typeof h.webhook === "string" && h.webhook.trim().length > 0)
        )
    );
  } catch (err: unknown) {
    debugLog(`readCustomHooks: ${errorMessage(err)}`);
    return [];
  }
}

function appendHookErrorLog(cortexPath: string, event: string, message: string): void {
  const logPath = runtimeFile(cortexPath, "hook-errors.log");
  const line = `[${new Date().toISOString()}] [${event}] ${message}\n`;
  fs.appendFileSync(logPath, line);
  try {
    const stat = fs.statSync(logPath);
    if (stat.size > 200_000) {
      const content = fs.readFileSync(logPath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      atomicWriteText(logPath, lines.slice(-HOOK_ERROR_LOG_MAX_LINES).join("\n") + "\n");
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] appendHookErrorLog rotate: ${errorMessage(err)}\n`);
  }
}

export function runCustomHooks(
  cortexPath: string,
  event: CustomHookEvent,
  env: Record<string, string> = {}
): { ran: number; errors: HookError[] } {
  const hooks = readCustomHooks(cortexPath);
  const matching = hooks.filter((h) => h.event === event);
  const errors: HookError[] = [];

  const isWindows = process.platform === "win32";
  const shellCmd = isWindows ? "cmd" : "sh";

  for (const hook of matching) {
    if ("webhook" in hook) {
      // Webhook hook: fire-and-forget HTTP POST (async, does not block runCustomHooks)
      const payload = JSON.stringify({ event, env, timestamp: new Date().toISOString() });
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (hook.secret) {
        headers["X-Cortex-Signature"] = `sha256=${createHmac("sha256", hook.secret).update(payload).digest("hex")}`;
      }
      fetch(hook.webhook, {
        method: "POST",
        headers,
        body: payload,
        redirect: "manual",
        signal: AbortSignal.timeout(hook.timeout ?? DEFAULT_CUSTOM_HOOK_TIMEOUT),
      })
        .catch((err: unknown) => {
          const message = `${event}: ${hook.webhook}: ${errorMessage(err)}`;
          debugLog(`runCustomHooks webhook: ${message}`);
          try {
            appendHookErrorLog(cortexPath, event, message);
          } catch (logErr: unknown) {
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] runCustomHooks webhookErrorLog: ${errorMessage(logErr)}\n`);
          }
        });
      continue;
    }
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
      const message = `${event}: ${hook.command}: ${errorMessage(err)}`;
      debugLog(`runCustomHooks: ${message}`);
      errors.push({ code: CortexError.VALIDATION_ERROR, message });
      try {
        appendHookErrorLog(cortexPath, event, errorMessage(err));
      } catch (logErr: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] runCustomHooks hookErrorLog: ${errorMessage(logErr)}\n`);
      }
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
    const copilotFile = hookConfigPath("copilot", cortexPath);
    const copilotHooksDir = path.dirname(copilotFile);
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
      atomicWriteText(copilotFile, JSON.stringify(config, null, 2));
      configured.push("Copilot CLI");
    } catch (err: unknown) {
      debugLog(`configureAllHooks: copilot failed: ${errorMessage(err)}`);
    }
    if (isToolHookEnabled(cortexPath, "copilot")) installSessionWrapper("copilot", cortexPath);
  }

  // ── Cursor (user-level: ~/.cursor/hooks.json) ────────────────────────────
  if (detected.has("cursor")) {
    const cursorFile = hookConfigPath("cursor", cortexPath);
    try {
      fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(fs.readFileSync(cursorFile, "utf8")); } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] configureAllHooks cursorRead: ${errorMessage(err)}\n`);
      }
      const config: CursorHookConfig = {
        ...existing,
        version: 1,
        // Cursor parity: sessionStart is best-effort where supported; wrapper also enforces lifecycle.
        sessionStart: { command: pullCmd },
        beforeSubmitPrompt: { command: promptCmd },
        stop: { command: stopCmd },
      };
      if (!validateCursorConfig(config)) throw new Error("invalid cursor hook config shape");
      atomicWriteText(cursorFile, JSON.stringify(config, null, 2));
      configured.push("Cursor");
    } catch (err: unknown) {
      debugLog(`configureAllHooks: cursor failed: ${errorMessage(err)}`);
    }
    if (isToolHookEnabled(cortexPath, "cursor")) installSessionWrapper("cursor", cortexPath);
  }

  // ── Codex (codex.json in cortex path) ────────────────────────────────────
  if (detected.has("codex")) {
    const codexFile = hookConfigPath("codex", cortexPath);
    try {
      const lifecycle = buildSharedLifecycleCommands();
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(fs.readFileSync(codexFile, "utf8")); } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] configureAllHooks codexRead: ${errorMessage(err)}\n`);
      }
      const config: CodexHookConfig = {
        ...existing,
        hooks: {
          SessionStart: [{ type: "command", command: lifecycle.sessionStart }],
          UserPromptSubmit: [{ type: "command", command: lifecycle.userPromptSubmit }],
          Stop: [{ type: "command", command: lifecycle.stop }],
        },
      };
      if (!validateCodexConfig(config)) throw new Error("invalid codex hook config shape");
      atomicWriteText(codexFile, JSON.stringify(config, null, 2));
      configured.push("Codex");
    } catch (err: unknown) {
      debugLog(`configureAllHooks: codex failed: ${errorMessage(err)}`);
    }
    if (isToolHookEnabled(cortexPath, "codex")) installSessionWrapper("codex", cortexPath);
  }

  return configured;
}
