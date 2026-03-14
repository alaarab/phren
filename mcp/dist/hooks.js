import * as fs from "fs";
import * as path from "path";
import { createHmac, randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { EXEC_TIMEOUT_QUICK_MS, PhrenError, debugLog, runtimeFile, homePath, installPreferencesFile } from "./shared.js";
import { errorMessage } from "./utils.js";
import { hookConfigPath } from "./provider-adapters.js";
import { PACKAGE_SPEC } from "./package-metadata.js";
function atomicWriteText(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${randomUUID()}`;
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
}
export function commandExists(cmd) {
    try {
        const whichCmd = process.platform === "win32" ? "where.exe" : "which";
        execFileSync(whichCmd, [cmd], { stdio: ["ignore", "ignore", "ignore"], timeout: EXEC_TIMEOUT_QUICK_MS });
        return true;
    }
    catch (err) {
        debugLog(`commandExists: ${cmd} not found: ${errorMessage(err)}`);
        return false;
    }
}
export function detectInstalledTools() {
    const tools = new Set();
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
function resolveToolBinary(tool) {
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
            if (resolved !== wrapperPath)
                return candidate;
        }
    }
    catch (err) {
        debugLog(`resolveToolBinary: failed for ${tool}: ${errorMessage(err)}`);
        return null;
    }
    return null;
}
function resolveCliEntryScript() {
    const local = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
    return fs.existsSync(local) ? local : null;
}
function phrenPackageSpec() {
    return PACKAGE_SPEC;
}
function buildPackageLifecycleCommands() {
    const packageSpec = phrenPackageSpec();
    return {
        sessionStart: `npx -y ${packageSpec} hook-session-start`,
        userPromptSubmit: `npx -y ${packageSpec} hook-prompt`,
        stop: `npx -y ${packageSpec} hook-stop`,
        hookTool: `npx -y ${packageSpec} hook-tool`,
    };
}
export function buildLifecycleCommands(phrenPath) {
    const entry = resolveCliEntryScript();
    const isWindows = process.platform === "win32";
    const escapedPhren = phrenPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    if (entry) {
        const escapedEntry = entry.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        if (isWindows) {
            return {
                sessionStart: `set "PHREN_PATH=${escapedPhren}" && node "${escapedEntry}" hook-session-start`,
                userPromptSubmit: `set "PHREN_PATH=${escapedPhren}" && node "${escapedEntry}" hook-prompt`,
                stop: `set "PHREN_PATH=${escapedPhren}" && node "${escapedEntry}" hook-stop`,
                hookTool: `set "PHREN_PATH=${escapedPhren}" && node "${escapedEntry}" hook-tool`,
            };
        }
        return {
            sessionStart: `PHREN_PATH="${escapedPhren}" node "${escapedEntry}" hook-session-start`,
            userPromptSubmit: `PHREN_PATH="${escapedPhren}" node "${escapedEntry}" hook-prompt`,
            stop: `PHREN_PATH="${escapedPhren}" node "${escapedEntry}" hook-stop`,
            hookTool: `PHREN_PATH="${escapedPhren}" node "${escapedEntry}" hook-tool`,
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
        sessionStart: `PHREN_PATH="${escapedPhren}" npx -y ${packageSpec} hook-session-start`,
        userPromptSubmit: `PHREN_PATH="${escapedPhren}" npx -y ${packageSpec} hook-prompt`,
        stop: `PHREN_PATH="${escapedPhren}" npx -y ${packageSpec} hook-stop`,
        hookTool: `PHREN_PATH="${escapedPhren}" npx -y ${packageSpec} hook-tool`,
    };
}
export function buildSharedLifecycleCommands() {
    return buildPackageLifecycleCommands();
}
function withHookToolEnv(command, tool) {
    if (process.platform === "win32") {
        return `set "PHREN_HOOK_TOOL=${tool}" && ${command}`;
    }
    return `PHREN_HOOK_TOOL="${tool}" ${command}`;
}
function withHookToolLifecycleCommands(lifecycle, tool) {
    return {
        sessionStart: withHookToolEnv(lifecycle.sessionStart, tool),
        userPromptSubmit: withHookToolEnv(lifecycle.userPromptSubmit, tool),
        stop: withHookToolEnv(lifecycle.stop, tool),
        hookTool: withHookToolEnv(lifecycle.hookTool, tool),
    };
}
function installSessionWrapper(tool, phrenPath) {
    const realBinary = resolveToolBinary(tool);
    if (!realBinary)
        return false;
    const entry = resolveCliEntryScript();
    const localBinDir = homePath(".local", "bin");
    const wrapperPath = path.join(localBinDir, tool);
    const escapedBinary = realBinary.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const escapedPhren = phrenPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const escapedEntry = entry ? entry.replace(/\\/g, "\\\\").replace(/"/g, '\\"') : "";
    const packageSpec = phrenPackageSpec();
    const sessionStartCmd = entry
        ? `env PHREN_PATH="$PHREN_PATH" node "$ENTRY_SCRIPT" hook-session-start`
        : `env PHREN_PATH="$PHREN_PATH" npx -y ${packageSpec} hook-session-start`;
    const stopCmd = entry
        ? `env PHREN_PATH="$PHREN_PATH" node "$ENTRY_SCRIPT" hook-stop`
        : `env PHREN_PATH="$PHREN_PATH" npx -y ${packageSpec} hook-stop`;
    const content = `#!/bin/sh
set -u

REAL_BIN="${escapedBinary}"
PHREN_PATH="\${PHREN_PATH:-${escapedPhren}}"
ENTRY_SCRIPT="${escapedEntry}"
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
    }
    catch (err) {
        debugLog(`installSessionWrapper: failed for ${tool}: ${errorMessage(err)}`);
        return false;
    }
}
function validateCopilotConfig(config) {
    return (typeof config.version === "number" &&
        Array.isArray(config.hooks?.sessionStart) &&
        Array.isArray(config.hooks?.userPromptSubmitted) &&
        Array.isArray(config.hooks?.sessionEnd));
}
function validateCursorConfig(config) {
    return (typeof config.version === "number" &&
        typeof config.sessionStart?.command === "string" &&
        typeof config.beforeSubmitPrompt?.command === "string" &&
        typeof config.stop?.command === "string");
}
function validateCodexConfig(config) {
    return (Array.isArray(config.hooks?.SessionStart) &&
        Array.isArray(config.hooks?.UserPromptSubmit) &&
        Array.isArray(config.hooks?.Stop));
}
function readHookPreferences(phrenPath) {
    try {
        const prefsPath = installPreferencesFile(phrenPath);
        const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
        const enabled = prefs.hooksEnabled !== false;
        const toolPrefs = prefs.hookTools && typeof prefs.hookTools === "object"
            ? prefs.hookTools
            : {};
        return { enabled, toolPrefs };
    }
    catch (err) {
        debugLog(`readHookPreferences: ${errorMessage(err)}`);
        return { enabled: true, toolPrefs: {} };
    }
}
export function isToolHookEnabled(phrenPath, tool) {
    const { enabled, toolPrefs } = readHookPreferences(phrenPath);
    if (!enabled)
        return false;
    const key = tool;
    if (key in toolPrefs)
        return toolPrefs[key] !== false;
    return true;
}
export const HOOK_EVENT_VALUES = [
    "pre-save", "post-save", "post-search",
    "pre-finding", "post-finding",
    "pre-index", "post-index",
    "post-session-end", "post-consolidate",
];
const VALID_HOOK_EVENTS = new Set(HOOK_EVENT_VALUES);
/** Return the target (URL or shell command) for display or matching. */
export function getHookTarget(h) {
    return "webhook" in h ? h.webhook : h.command;
}
const DEFAULT_CUSTOM_HOOK_TIMEOUT = 5000;
const HOOK_TIMEOUT_MS = parseInt(process.env.PHREN_HOOK_TIMEOUT_MS || '14000', 10);
const HOOK_ERROR_LOG_MAX_LINES = 1000;
export function readCustomHooks(phrenPath) {
    try {
        const prefsPath = installPreferencesFile(phrenPath);
        const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
        if (!Array.isArray(prefs.customHooks))
            return [];
        return prefs.customHooks.filter((h) => h &&
            typeof h.event === "string" &&
            VALID_HOOK_EVENTS.has(h.event) &&
            ((typeof h.command === "string" && h.command.trim().length > 0) ||
                (typeof h.webhook === "string" && h.webhook.trim().length > 0)));
    }
    catch (err) {
        debugLog(`readCustomHooks: ${errorMessage(err)}`);
        return [];
    }
}
function appendHookErrorLog(phrenPath, event, message) {
    const logPath = runtimeFile(phrenPath, "hook-errors.log");
    const line = `[${new Date().toISOString()}] [${event}] ${message}\n`;
    fs.appendFileSync(logPath, line);
    try {
        const stat = fs.statSync(logPath);
        if (stat.size > 200_000) {
            const content = fs.readFileSync(logPath, "utf-8");
            const lines = content.split("\n").filter(Boolean);
            atomicWriteText(logPath, lines.slice(-HOOK_ERROR_LOG_MAX_LINES).join("\n") + "\n");
        }
    }
    catch (err) {
        if (process.env.PHREN_DEBUG)
            process.stderr.write(`[phren] appendHookErrorLog rotate: ${errorMessage(err)}\n`);
    }
}
export function runCustomHooks(phrenPath, event, env = {}) {
    const hooks = readCustomHooks(phrenPath);
    const matching = hooks.filter((h) => h.event === event);
    const errors = [];
    const isWindows = process.platform === "win32";
    const shellCmd = isWindows ? "cmd" : "sh";
    for (const hook of matching) {
        if ("webhook" in hook) {
            // Webhook hook: fire-and-forget HTTP POST (async, does not block runCustomHooks)
            const payload = JSON.stringify({ event, env, timestamp: new Date().toISOString() });
            const headers = { "Content-Type": "application/json" };
            if (hook.secret) {
                headers["X-Phren-Signature"] = `sha256=${createHmac("sha256", hook.secret).update(payload).digest("hex")}`;
            }
            fetch(hook.webhook, {
                method: "POST",
                headers,
                body: payload,
                redirect: "manual",
                signal: AbortSignal.timeout(hook.timeout ?? DEFAULT_CUSTOM_HOOK_TIMEOUT),
            })
                .catch((err) => {
                const message = `${event}: ${hook.webhook}: ${errorMessage(err)}`;
                debugLog(`runCustomHooks webhook: ${message}`);
                try {
                    appendHookErrorLog(phrenPath, event, message);
                }
                catch (logErr) {
                    if (process.env.PHREN_DEBUG)
                        process.stderr.write(`[phren] runCustomHooks webhookErrorLog: ${errorMessage(logErr)}\n`);
                }
            });
            continue;
        }
        const shellArgs = isWindows ? ["/c", hook.command] : ["-c", hook.command];
        try {
            execFileSync(shellCmd, shellArgs, {
                cwd: phrenPath,
                encoding: "utf8",
                timeout: hook.timeout ?? DEFAULT_CUSTOM_HOOK_TIMEOUT,
                env: { ...process.env, PHREN_PATH: phrenPath, PHREN_HOOK_EVENT: event, ...env },
                stdio: ["ignore", "ignore", "pipe"],
            });
        }
        catch (err) {
            const message = `${event}: ${hook.command}: ${errorMessage(err)}`;
            debugLog(`runCustomHooks: ${message}`);
            errors.push({ code: PhrenError.VALIDATION_ERROR, message });
            try {
                appendHookErrorLog(phrenPath, event, errorMessage(err));
            }
            catch (logErr) {
                if (process.env.PHREN_DEBUG)
                    process.stderr.write(`[phren] runCustomHooks hookErrorLog: ${errorMessage(logErr)}\n`);
            }
        }
    }
    return { ran: matching.length, errors };
}
export function configureAllHooks(phrenPath, options = {}) {
    const configured = [];
    const detected = options.tools
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
            const config = {
                version: 1,
                hooks: {
                    sessionStart: [{ type: "command", bash: copilotLifecycle.sessionStart }],
                    userPromptSubmitted: [{ type: "command", bash: copilotLifecycle.userPromptSubmit }],
                    sessionEnd: [{ type: "command", bash: copilotLifecycle.stop }],
                },
            };
            if (!validateCopilotConfig(config))
                throw new Error("invalid copilot hook config shape");
            atomicWriteText(copilotFile, JSON.stringify(config, null, 2));
            configured.push("Copilot CLI");
        }
        catch (err) {
            debugLog(`configureAllHooks: copilot failed: ${errorMessage(err)}`);
        }
        if (isToolHookEnabled(phrenPath, "copilot"))
            installSessionWrapper("copilot", phrenPath);
    }
    // ── Cursor (user-level: ~/.cursor/hooks.json) ────────────────────────────
    if (detected.has("cursor")) {
        const cursorLifecycle = withHookToolLifecycleCommands(lifecycle, "cursor");
        const cursorFile = hookConfigPath("cursor", phrenPath);
        try {
            fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
            let existing = {};
            try {
                existing = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
            }
            catch (err) {
                if (process.env.PHREN_DEBUG)
                    process.stderr.write(`[phren] configureAllHooks cursorRead: ${errorMessage(err)}\n`);
            }
            const config = {
                ...existing,
                version: 1,
                // Cursor parity: sessionStart is best-effort where supported; wrapper also enforces lifecycle.
                sessionStart: { command: cursorLifecycle.sessionStart },
                beforeSubmitPrompt: { command: cursorLifecycle.userPromptSubmit },
                stop: { command: cursorLifecycle.stop },
            };
            if (!validateCursorConfig(config))
                throw new Error("invalid cursor hook config shape");
            atomicWriteText(cursorFile, JSON.stringify(config, null, 2));
            configured.push("Cursor");
        }
        catch (err) {
            debugLog(`configureAllHooks: cursor failed: ${errorMessage(err)}`);
        }
        if (isToolHookEnabled(phrenPath, "cursor"))
            installSessionWrapper("cursor", phrenPath);
    }
    // ── Codex (codex.json in phren path) ─────────────────────────────────────
    if (detected.has("codex")) {
        const codexFile = hookConfigPath("codex", phrenPath);
        try {
            const codexLifecycle = withHookToolLifecycleCommands(buildSharedLifecycleCommands(), "codex");
            let existing = {};
            try {
                existing = JSON.parse(fs.readFileSync(codexFile, "utf8"));
            }
            catch (err) {
                if (process.env.PHREN_DEBUG)
                    process.stderr.write(`[phren] configureAllHooks codexRead: ${errorMessage(err)}\n`);
            }
            const config = {
                ...existing,
                hooks: {
                    SessionStart: [{ type: "command", command: codexLifecycle.sessionStart }],
                    UserPromptSubmit: [{ type: "command", command: codexLifecycle.userPromptSubmit }],
                    Stop: [{ type: "command", command: codexLifecycle.stop }],
                },
            };
            if (!validateCodexConfig(config))
                throw new Error("invalid codex hook config shape");
            atomicWriteText(codexFile, JSON.stringify(config, null, 2));
            configured.push("Codex");
        }
        catch (err) {
            debugLog(`configureAllHooks: codex failed: ${errorMessage(err)}`);
        }
        if (isToolHookEnabled(phrenPath, "codex"))
            installSessionWrapper("codex", phrenPath);
    }
    return configured;
}
