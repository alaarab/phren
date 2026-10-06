import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import { bootstrapPhrenDotEnv } from "./phren-dotenv.js";
// ── Shared Git helper ────────────────────────────────────────────────────────
/**
 * Git run by phren never asks a human anything. Without this, a store or
 * project with an HTTPS remote and no credential helper makes git read
 * "Username for 'https://github.com':" from the controlling terminal, which
 * inside an agent's pane stalls the agent before its first prompt.
 */
export const nonInteractiveGitEnv = (env = process.env) => ({
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    // A nonempty command overrides core.askPass and inherited GUI helpers.
    // Git for Windows also executes askpass commands through its bundled sh.
    GIT_ASKPASS: "false",
    SSH_ASKPASS: "false",
    SSH_ASKPASS_REQUIRE: "force",
});
export function runGitOrThrow(cwd, args, timeoutMs) {
    const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        env: nonInteractiveGitEnv(),
    });
    if (result.error)
        throw result.error;
    if (result.status !== 0) {
        const stderr = (result.stderr ?? "").trim();
        const suffix = stderr ? `: ${stderr}` : result.signal ? ` (signal: ${result.signal})` : "";
        throw new Error(`git ${args.join(" ")} exited with status ${result.status ?? "unknown"}${suffix}`);
    }
    return result.stdout ?? "";
}
export function runGit(cwd, args, timeoutMs, debugLogFn) {
    try {
        return runGitOrThrow(cwd, args, timeoutMs).trim();
    }
    catch (err) {
        const msg = errorMessage(err);
        if (debugLogFn)
            debugLogFn(`runGit: git ${args[0]} failed in ${cwd}: ${msg}`);
        return null;
    }
}
function needsCommandShell(cmd) {
    return /\.(cmd|bat)$/i.test(path.basename(cmd));
}
export function normalizeExecCommand(cmd, platform = process.platform, whereOutput) {
    if (platform !== "win32")
        return { command: cmd, shell: false };
    if (cmd.includes("\\") || cmd.includes("/") || /\.[A-Za-z0-9]+$/i.test(path.basename(cmd))) {
        return { command: cmd, shell: needsCommandShell(cmd) };
    }
    const candidate = (whereOutput || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
    const resolved = candidate || cmd;
    return { command: resolved, shell: needsCommandShell(resolved) };
}
export function resolveExecCommand(cmd) {
    if (process.platform !== "win32")
        return { command: cmd, shell: false };
    try {
        const whereOutput = execFileSync("where.exe", [cmd], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5000,
        });
        return normalizeExecCommand(cmd, process.platform, whereOutput);
    }
    catch {
        return normalizeExecCommand(cmd, process.platform, null);
    }
}
// ── Error message extractor ─────────────────────────────────────────────────
export function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
// ── Feature flag and clamping helpers ────────────────────────────────────────
export function isFeatureEnabled(envName, defaultValue = true) {
    bootstrapPhrenDotEnv();
    const raw = process.env[envName];
    if (!raw)
        return defaultValue;
    return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}
export function clampInt(raw, fallback, min, max) {
    const parsed = Number.parseInt(raw || "", 10);
    if (Number.isNaN(parsed))
        return fallback;
    return Math.min(max, Math.max(min, parsed));
}
export function clampFloat(raw, fallback, min, max) {
    const parsed = Number.parseFloat(raw || "");
    if (Number.isNaN(parsed))
        return fallback;
    return Math.min(max, Math.max(min, parsed));
}
// ── Argv parsing helpers ────────────────────────────────────────────────────
export function getOptionValue(args, name) {
    const exactIdx = args.indexOf(name);
    if (exactIdx !== -1)
        return args[exactIdx + 1];
    const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
    return prefixed ? prefixed.slice(name.length + 1) : undefined;
}
export function getPositionalArgs(args, optionNamesWithValues) {
    const positions = [];
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (optionNamesWithValues.includes(arg)) {
            i += 1;
            continue;
        }
        if (optionNamesWithValues.some((name) => arg.startsWith(`${name}=`))) {
            continue;
        }
        if (!arg.startsWith("--"))
            positions.push(arg);
    }
    return positions;
}
