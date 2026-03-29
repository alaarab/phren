import * as fs from "fs";
import * as path from "path";
import { createHmac } from "crypto";
import { lookup } from "dns/promises";
import { execFileSync } from "child_process";
import { isIP } from "net";
import { fileURLToPath } from "url";
import { EXEC_TIMEOUT_QUICK_MS, PhrenError, debugLog, runtimeFile, homePath, installPreferencesFile, atomicWriteText, type PhrenErrorCode } from "./shared.js";
import { errorMessage } from "./utils.js";
import { hookConfigPath } from "./provider-adapters.js";
import { PACKAGE_SPEC } from "./package-metadata.js";
import { logger } from "./logger.js";
import { withFileLock } from "./shared/governance.js";

export interface HookError {
  code: PhrenErrorCode;
  message: string;
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

function phrenPackageSpec(): string {
  return PACKAGE_SPEC;
}

/** Shell-escape a value by wrapping in single quotes with proper escaping of embedded single quotes. */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}


export interface LifecycleCommands {
  sessionStart: string;
  userPromptSubmit: string;
  stop: string;
  hookTool: string;
}

function buildPackageLifecycleCommands(): LifecycleCommands {
  const packageSpec = phrenPackageSpec();
  return {
    sessionStart: `npx -y ${packageSpec} hook-session-start`,
    userPromptSubmit: `npx -y ${packageSpec} hook-prompt`,
    stop: `npx -y ${packageSpec} hook-stop`,
    hookTool: `npx -y ${packageSpec} hook-tool`,
  };
}

export function buildLifecycleCommands(phrenPath: string): LifecycleCommands {
  const entry = resolveCliEntryScript();
  const isWindows = process.platform === "win32";
  const escapedPhren = phrenPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const quotedPhren = shellEscape(phrenPath);

  if (entry) {
    const escapedEntry = entry.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const quotedEntry = shellEscape(entry);
    if (isWindows) {
      return {
        sessionStart: `set "PHREN_PATH=${escapedPhren}" && node "${escapedEntry}" hook-session-start`,
        userPromptSubmit: `set "PHREN_PATH=${escapedPhren}" && node "${escapedEntry}" hook-prompt`,
        stop: `set "PHREN_PATH=${escapedPhren}" && node "${escapedEntry}" hook-stop`,
        hookTool: `set "PHREN_PATH=${escapedPhren}" && node "${escapedEntry}" hook-tool`,
      };
    }
    return {
      sessionStart: `PHREN_PATH=${quotedPhren} node ${quotedEntry} hook-session-start`,
      userPromptSubmit: `PHREN_PATH=${quotedPhren} node ${quotedEntry} hook-prompt`,
      stop: `PHREN_PATH=${quotedPhren} node ${quotedEntry} hook-stop`,
      hookTool: `PHREN_PATH=${quotedPhren} node ${quotedEntry} hook-tool`,
    };
  }

  const packageSpec = phrenPackageSpec();
  if (isWindows) {
    return {
      sessionStart: `set "PHREN_PATH=${escapedPhren}" && npx -y ${packageSpec} hook-session-start`,
      userPromptSubmit: `set "PHREN_PATH=${escapedPhren}" && npx -y ${packageSpec} hook-prompt`,
      stop: `set "PHREN_PATH=${escapedPhren}" && npx -y ${packageSpec} hook-stop`,
      hookTool: `set "PHREN_PATH=${escapedPhren}" && npx -y ${packageSpec} hook-tool`,
    };
  }
  return {
    sessionStart: `PHREN_PATH=${quotedPhren} npx -y ${packageSpec} hook-session-start`,
    userPromptSubmit: `PHREN_PATH=${quotedPhren} npx -y ${packageSpec} hook-prompt`,
    stop: `PHREN_PATH=${quotedPhren} npx -y ${packageSpec} hook-stop`,
    hookTool: `PHREN_PATH=${quotedPhren} npx -y ${packageSpec} hook-tool`,
  };
}

export function buildSharedLifecycleCommands(): LifecycleCommands {
  return buildPackageLifecycleCommands();
}

function withHookToolEnv(command: string, tool: "claude" | "copilot" | "cursor" | "codex"): string {
  if (process.platform === "win32") {
    return `set "PHREN_HOOK_TOOL=${tool}" && ${command}`;
  }
  return `PHREN_HOOK_TOOL=${shellEscape(tool)} ${command}`;
}

function withHookToolLifecycleCommands(
  lifecycle: LifecycleCommands,
  tool: "claude" | "copilot" | "cursor" | "codex",
): LifecycleCommands {
  return {
    sessionStart: withHookToolEnv(lifecycle.sessionStart, tool),
    userPromptSubmit: withHookToolEnv(lifecycle.userPromptSubmit, tool),
    stop: withHookToolEnv(lifecycle.stop, tool),
    hookTool: withHookToolEnv(lifecycle.hookTool, tool),
  };
}

function installSessionWrapper(tool: string, phrenPath: string): boolean {
  const realBinary = resolveToolBinary(tool);
  if (!realBinary) return false;

  const entry = resolveCliEntryScript();

  const localBinDir = homePath(".local", "bin");
  const wrapperPath = path.join(localBinDir, tool);

  const packageSpec = phrenPackageSpec();
  const sessionStartCmd = entry
    ? `env PHREN_PATH="$PHREN_PATH" node "$ENTRY_SCRIPT" hook-session-start`
    : `env PHREN_PATH="$PHREN_PATH" npx -y ${packageSpec} hook-session-start`;
  const stopCmd = entry
    ? `env PHREN_PATH="$PHREN_PATH" node "$ENTRY_SCRIPT" hook-stop`
    : `env PHREN_PATH="$PHREN_PATH" npx -y ${packageSpec} hook-stop`;
  const content = `#!/bin/sh
set -u

REAL_BIN=${shellEscape(realBinary)}
DEFAULT_PHREN_PATH=${shellEscape(phrenPath)}
PHREN_PATH="\${PHREN_PATH:-$DEFAULT_PHREN_PATH}"
ENTRY_SCRIPT=${shellEscape(entry || "")}
export PHREN_HOOK_TOOL="${tool}"

if [ ! -x "$REAL_BIN" ]; then
  echo "phren wrapper error: real ${tool} binary not executable: $REAL_BIN" >&2
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

HOOK_TIMEOUT="\${PHREN_HOOK_TIMEOUT_S:-${Math.ceil(HOOK_TIMEOUT_MS / 1000)}}s"

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

/**
 * Install a lightweight `phren` CLI wrapper at ~/.local/bin/phren so the bare
 * `phren` command works without a global npm install. The wrapper simply execs
 * `node <entry_script> "$@"`.
 */
export function installPhrenCliWrapper(phrenPath: string): boolean {
  const entry = resolveCliEntryScript();
  if (!entry) return false;

  const localBinDir = homePath(".local", "bin");
  const wrapperPath = path.join(localBinDir, "phren");

  // Don't overwrite a real global install — only our own wrapper
  if (fs.existsSync(wrapperPath)) {
    try {
      const existing = fs.readFileSync(wrapperPath, "utf8");
      if (!existing.includes("PHREN_CLI_WRAPPER")) return false;
    } catch {
      // File exists but unreadable — don't overwrite, could be a real binary
      return false;
    }
  }

  const content = `#!/bin/sh
# PHREN_CLI_WRAPPER — managed by phren init; safe to delete
set -u
PHREN_PATH="\${PHREN_PATH:-${phrenPath}}"
export PHREN_PATH
exec node ${shellEscape(entry)} "$@"
`;

  try {
    fs.mkdirSync(localBinDir, { recursive: true });
    atomicWriteText(wrapperPath, content);
    fs.chmodSync(wrapperPath, 0o755);
    return true;
  } catch (err: unknown) {
    debugLog(`installPhrenCliWrapper: failed: ${errorMessage(err)}`);
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

// ── mtime-based install-preferences cache (shared by readHookPreferences + readCustomHooks) ──
const _installPrefsJsonCache = new Map<string, { mtimeMs: number; parsed: Record<string, unknown> }>();

export function clearHookPrefsCache(): void {
  _installPrefsJsonCache.clear();
}

function cachedReadInstallPrefsJson(phrenPath: string): Record<string, unknown> | null {
  const prefsPath = installPreferencesFile(phrenPath);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(prefsPath).mtimeMs;
  } catch {
    _installPrefsJsonCache.delete(prefsPath);
    return null;
  }
  const cached = _installPrefsJsonCache.get(prefsPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.parsed;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(prefsPath, "utf8")) as Record<string, unknown>;
  } catch {
    _installPrefsJsonCache.delete(prefsPath);
    return null;
  }
  _installPrefsJsonCache.set(prefsPath, { mtimeMs, parsed });
  return parsed;
}

function readHookPreferences(phrenPath: string): { enabled: boolean; toolPrefs: HookToolPreferences } {
  try {
    const prefs = cachedReadInstallPrefsJson(phrenPath);
    if (!prefs) return { enabled: true, toolPrefs: {} };
    const enabled = prefs.hooksEnabled !== false;
    const toolPrefs: HookToolPreferences = prefs.hookTools && typeof prefs.hookTools === "object"
      ? prefs.hookTools as HookToolPreferences
      : {};
    return { enabled, toolPrefs };
  } catch (err: unknown) {
    debugLog(`readHookPreferences: ${errorMessage(err)}`);
    return { enabled: true, toolPrefs: {} };
  }
}

export function isToolHookEnabled(phrenPath: string, tool: string): boolean {
  const { enabled, toolPrefs } = readHookPreferences(phrenPath);
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
const MAX_HOOK_COMMAND_LENGTH = 1000;

/** Return the target (URL or shell command) for display or matching. */
export function getHookTarget(h: CustomHookEntry): string {
  return "webhook" in h ? h.webhook : h.command;
}

export function validateCustomHookCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return "Command cannot be empty.";
  if (trimmed.length > MAX_HOOK_COMMAND_LENGTH) return `Command too long (max ${MAX_HOOK_COMMAND_LENGTH} characters).`;
  if (/[`$(){}&|;<>\n\r#]/.test(trimmed)) {
    return "Command contains disallowed shell characters: ` $ ( ) { } & | ; < > # \\n \\r";
  }
  if (/\b(eval|source)\b/.test(trimmed)) return "eval and source are not permitted in hook commands.";
  if (!/^[\w./~"'"]/.test(trimmed)) return "Command must begin with an executable name or path.";
  return null;
}

function normalizeWebhookHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isPrivateOrLoopbackIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (octets[0] === 0 || octets[0] === 10 || octets[0] === 127) return true;
  if (octets[0] === 169 && octets[1] === 254) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  return false;
}

function isPrivateOrLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isPrivateOrLoopbackIpv4(normalized);
  if (ipVersion !== 6) return false;
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateOrLoopbackIpv4(mapped[1]);
  return false;
}

function blockedWebhookHostnameReason(hostname: string): string | null {
  const normalized = normalizeWebhookHostname(hostname);
  if (
    normalized === "localhost" ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    /^(0x[0-9a-f]+|0\d+)$/i.test(normalized) ||
    /^\d{8,10}$/.test(normalized)
  ) {
    return `webhook hostname "${hostname}" is a private or loopback address.`;
  }
  if (isPrivateOrLoopbackAddress(normalized)) {
    return `webhook hostname "${hostname}" is a private or loopback address.`;
  }
  return null;
}

export function validateCustomWebhookUrl(webhook: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(webhook.trim());
  } catch {
    return "webhook is not a valid URL.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "webhook must be an http:// or https:// URL.";
  }
  return blockedWebhookHostnameReason(parsed.hostname);
}

/**
 * Validate a webhook URL at execution time and return the resolved IP address
 * to use for the fetch. Resolving once and re-using the IP prevents DNS
 * rebinding attacks where the hostname resolves to a safe IP during validation
 * but a private/loopback IP when fetch performs its own lookup.
 *
 * Returns { error } if blocked, or { resolvedUrl, host } if safe.
 */
async function validateAndResolveWebhook(webhook: string): Promise<
  | { error: string; resolvedUrl?: undefined; host?: undefined }
  | { error?: undefined; resolvedUrl: string; host: string }
> {
  let parsed: URL;
  try {
    parsed = new URL(webhook);
  } catch {
    return { error: "webhook is not a valid URL." };
  }

  const literalBlock = blockedWebhookHostnameReason(parsed.hostname);
  if (literalBlock) return { error: literalBlock };

  // If the hostname is already a literal IP, validate it directly
  if (isIP(parsed.hostname)) {
    if (isPrivateOrLoopbackAddress(parsed.hostname)) {
      return { error: `webhook hostname "${parsed.hostname}" is a private or loopback address.` };
    }
    return { resolvedUrl: webhook, host: parsed.hostname };
  }

  try {
    const records = await lookup(parsed.hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      return { error: `webhook hostname "${parsed.hostname}" did not resolve to any address.` };
    }
    if (records.some((record) => isPrivateOrLoopbackAddress(record.address))) {
      return { error: `webhook hostname "${parsed.hostname}" resolved to a private or loopback address.` };
    }
    // Use the first resolved IP to build a pinned URL, preventing DNS rebinding
    const resolvedIp = records[0].address;
    const pinnedUrl = new URL(webhook);
    pinnedUrl.hostname = records[0].family === 6 ? `[${resolvedIp}]` : resolvedIp;
    return { resolvedUrl: pinnedUrl.href, host: parsed.host };
  } catch (err: unknown) {
    debugLog(`validateAndResolveWebhook lookup failed for ${parsed.hostname}: ${errorMessage(err)}`);
    return { error: `webhook hostname "${parsed.hostname}" could not be resolved: ${errorMessage(err)}` };
  }
}

const DEFAULT_CUSTOM_HOOK_TIMEOUT = 5000;
const HOOK_TIMEOUT_MS = parseInt(process.env.PHREN_HOOK_TIMEOUT_MS || '14000', 10);
const HOOK_ERROR_LOG_MAX_LINES = 1000;

export function readCustomHooks(phrenPath: string): CustomHookEntry[] {
  try {
    const prefs = cachedReadInstallPrefsJson(phrenPath);
    if (!prefs || !Array.isArray(prefs.customHooks)) return [];
    return (prefs.customHooks as unknown[]).filter(
      (h): h is CustomHookEntry => {
        if (!h || typeof h !== "object") return false;
        const rec = h as Record<string, unknown>;
        return (
          typeof rec.event === "string" &&
          VALID_HOOK_EVENTS.has(rec.event) &&
          (
            (typeof rec.command === "string" && rec.command.trim().length > 0) ||
            (typeof rec.webhook === "string" && rec.webhook.trim().length > 0)
          )
        );
      }
    );
  } catch (err: unknown) {
    debugLog(`readCustomHooks: ${errorMessage(err)}`);
    return [];
  }
}

function appendHookErrorLog(phrenPath: string, event: string, message: string): void {
  const logPath = runtimeFile(phrenPath, "hook-errors.log");
  const line = `[${new Date().toISOString()}] [${event}] ${message}\n`;
  try {
    withFileLock(logPath, () => {
      fs.appendFileSync(logPath, line);
      try {
        const stat = fs.statSync(logPath);
        if (stat.size > 200_000) {
          const content = fs.readFileSync(logPath, "utf-8");
          const lines = content.split("\n").filter(Boolean);
          atomicWriteText(logPath, lines.slice(-HOOK_ERROR_LOG_MAX_LINES).join("\n") + "\n");
        }
      } catch (err: unknown) {
        logger.debug("appendHookErrorLog rotate", errorMessage(err));
      }
    });
  } catch (err: unknown) {
    logger.debug("appendHookErrorLog lock", errorMessage(err));
  }
}

export function runCustomHooks(
  phrenPath: string,
  event: CustomHookEvent,
  env: Record<string, string> = {}
): { ran: number; errors: HookError[] } {
  const hooks = readCustomHooks(phrenPath);
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
        headers["X-Phren-Signature"] = `sha256=${createHmac("sha256", hook.secret).update(payload).digest("hex")}`;
      }
      void validateAndResolveWebhook(hook.webhook)
        .then((result) => {
          if ("error" in result && result.error) {
            const message = `${event}: skipped webhook ${hook.webhook}: ${result.error}`;
            debugLog(`runCustomHooks webhook: ${message}`);
            appendHookErrorLog(phrenPath, event, message);
            return;
          }
          // Use the pinned resolved URL to prevent DNS rebinding;
          // set Host header to the original hostname for correct routing.
          const { resolvedUrl, host } = result as { resolvedUrl: string; host: string };
          const fetchHeaders = { ...headers };
          if (host) {
            fetchHeaders["Host"] = host;
          }
          return fetch(resolvedUrl, {
            method: "POST",
            headers: fetchHeaders,
            body: payload,
            redirect: "manual",
            signal: AbortSignal.timeout(hook.timeout ?? DEFAULT_CUSTOM_HOOK_TIMEOUT),
          });
        })
        .catch((err: unknown) => {
          const message = `${event}: ${hook.webhook}: ${errorMessage(err)}`;
          debugLog(`runCustomHooks webhook: ${message}`);
          try {
            appendHookErrorLog(phrenPath, event, message);
          } catch (logErr: unknown) {
            logger.debug("runCustomHooks webhookErrorLog", errorMessage(logErr));
          }
        });
      continue;
    }
    const cmdErr = validateCustomHookCommand(hook.command);
    if (cmdErr) {
      const message = `${event}: skipped hook (re-validation failed): ${cmdErr}`;
      debugLog(`runCustomHooks: ${message}`);
      errors.push({ code: PhrenError.VALIDATION_ERROR, message });
      appendHookErrorLog(phrenPath, event, message);
      continue;
    }
    const shellArgs = isWindows ? ["/c", hook.command] : ["-c", hook.command];
    // On Windows, cmd /c expands %VAR% in the command string.
    // Sanitize env values to prevent shell metacharacter injection.
    const mergedEnv: Record<string, string | undefined> = { ...process.env, PHREN_PATH: phrenPath, PHREN_HOOK_EVENT: event, ...env };
    if (isWindows) {
      for (const [key, val] of Object.entries(mergedEnv)) {
        if (typeof val === "string") {
          mergedEnv[key] = val.replace(/[&|<>^%]/g, "");
        }
      }
    }
    try {
      execFileSync(shellCmd, shellArgs, {
        cwd: phrenPath,
        encoding: "utf8",
        timeout: hook.timeout ?? DEFAULT_CUSTOM_HOOK_TIMEOUT,
        env: mergedEnv,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err: unknown) {
      const message = `${event}: ${hook.command}: ${errorMessage(err)}`;
      debugLog(`runCustomHooks: ${message}`);
      errors.push({ code: PhrenError.VALIDATION_ERROR, message });
      try {
        appendHookErrorLog(phrenPath, event, errorMessage(err));
      } catch (logErr: unknown) {
        logger.debug("runCustomHooks hookErrorLog", errorMessage(logErr));
      }
    }
  }

  return { ran: matching.length, errors };
}

export interface HookConfigOptions {
  tools?: Set<string>;
  allTools?: boolean;
}

export function configureAllHooks(phrenPath: string, options: HookConfigOptions = {}): string[] {
  const configured: string[] = [];
  const detected: Set<string> = options.tools
    ? options.tools
    : options.allTools
      ? new Set(["copilot", "cursor", "codex"])
      : detectInstalledTools();

  const lifecycle = buildLifecycleCommands(phrenPath);

  // ── GitHub Copilot CLI (user-level: ~/.github/hooks/phren.json) ──────────
  if (detected.has("copilot")) {
    const copilotLifecycle = withHookToolLifecycleCommands(lifecycle, "copilot");
    const copilotFile = hookConfigPath("copilot", phrenPath);
    const copilotHooksDir = path.dirname(copilotFile);
    try {
      fs.mkdirSync(copilotHooksDir, { recursive: true });
      const config: CopilotHookConfig = {
        version: 1,
        hooks: {
          sessionStart: [{ type: "command", bash: copilotLifecycle.sessionStart }],
          userPromptSubmitted: [{ type: "command", bash: copilotLifecycle.userPromptSubmit }],
          sessionEnd: [{ type: "command", bash: copilotLifecycle.stop }],
        },
      };
      if (!validateCopilotConfig(config)) throw new Error("invalid copilot hook config shape");
      atomicWriteText(copilotFile, JSON.stringify(config, null, 2));
      configured.push("Copilot CLI");
    } catch (err: unknown) {
      console.warn(`configureAllHooks: copilot hook config failed: ${errorMessage(err)}`);
    }
    if (isToolHookEnabled(phrenPath, "copilot")) installSessionWrapper("copilot", phrenPath);
  }

  // ── Cursor (user-level: ~/.cursor/hooks.json) ────────────────────────────
  if (detected.has("cursor")) {
    const cursorLifecycle = withHookToolLifecycleCommands(lifecycle, "cursor");
    const cursorFile = hookConfigPath("cursor", phrenPath);
    try {
      fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(fs.readFileSync(cursorFile, "utf8")); } catch (err: unknown) {
        logger.debug("configureAllHooks cursorRead", errorMessage(err));
      }
      const config: CursorHookConfig = {
        ...existing,
        version: 1,
        // Cursor parity: sessionStart is best-effort where supported; wrapper also enforces lifecycle.
        sessionStart: { command: cursorLifecycle.sessionStart },
        beforeSubmitPrompt: { command: cursorLifecycle.userPromptSubmit },
        stop: { command: cursorLifecycle.stop },
      };
      if (!validateCursorConfig(config)) throw new Error("invalid cursor hook config shape");
      atomicWriteText(cursorFile, JSON.stringify(config, null, 2));
      configured.push("Cursor");
    } catch (err: unknown) {
      console.warn(`configureAllHooks: cursor hook config failed: ${errorMessage(err)}`);
    }
    if (isToolHookEnabled(phrenPath, "cursor")) installSessionWrapper("cursor", phrenPath);
  }

  // ── Codex (codex.json in phren path) ─────────────────────────────────────
  if (detected.has("codex")) {
    const codexFile = hookConfigPath("codex", phrenPath);
    try {
      const codexLifecycle = withHookToolLifecycleCommands(buildSharedLifecycleCommands(), "codex");
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(fs.readFileSync(codexFile, "utf8")); } catch (err: unknown) {
        logger.debug("configureAllHooks codexRead", errorMessage(err));
      }
      const config: CodexHookConfig = {
        ...existing,
        hooks: {
          SessionStart: [{ type: "command", command: codexLifecycle.sessionStart }],
          UserPromptSubmit: [{ type: "command", command: codexLifecycle.userPromptSubmit }],
          Stop: [{ type: "command", command: codexLifecycle.stop }],
        },
      };
      if (!validateCodexConfig(config)) throw new Error("invalid codex hook config shape");
      atomicWriteText(codexFile, JSON.stringify(config, null, 2));
      configured.push("Codex");
    } catch (err: unknown) {
      console.warn(`configureAllHooks: codex hook config failed: ${errorMessage(err)}`);
    }
    if (isToolHookEnabled(phrenPath, "codex")) installSessionWrapper("codex", phrenPath);
  }

  return configured;
}
