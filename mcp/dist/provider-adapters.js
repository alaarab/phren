import * as fs from "fs";
import * as os from "os";
import * as path from "path";
export const HOOK_TOOL_NAMES = ["claude", "copilot", "cursor", "codex"];
function homeDir(env = process.env) {
    return env.HOME || env.USERPROFILE || os.homedir();
}
function joinPortable(base, ...parts) {
    const usePosix = base.startsWith("/") && !base.includes("\\");
    if (usePosix) {
        const normalizedBase = base.replace(/\/+$/g, "");
        const normalizedParts = parts.map((part) => part.replace(/^\/+|\/+$/g, ""));
        return [normalizedBase, ...normalizedParts].join("/").replace(/\/{2,}/g, "/");
    }
    return path.join(base, ...parts);
}
function homePathForEnv(env, ...parts) {
    return joinPortable(homeDir(env), ...parts);
}
function defaultPhrenPath(env = process.env) {
    return env.PHREN_PATH || env.PHREN_PATH || homePathForEnv(env, ".phren");
}
function normalizeWindowsPathToWsl(input) {
    if (!input)
        return undefined;
    if (input.startsWith("/"))
        return input;
    const match = input.match(/^([A-Za-z]):\\(.*)$/);
    if (!match)
        return input;
    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
}
function uniqStrings(values) {
    return Array.from(new Set(values.filter((value) => Boolean(value && value.trim()))));
}
export function pickExistingFile(candidates) {
    for (const candidate of candidates) {
        if (fs.existsSync(candidate))
            return candidate;
    }
    return null;
}
export function hookConfigPath(tool, phrenPath = defaultPhrenPath()) {
    switch (tool) {
        case "claude":
            return homePathForEnv(process.env, ".claude", "settings.json");
        case "copilot":
            return homePathForEnv(process.env, ".github", "hooks", "phren.json");
        case "cursor":
            return homePathForEnv(process.env, ".cursor", "hooks.json");
        case "codex":
            return path.join(phrenPath || defaultPhrenPath(), "codex.json");
    }
}
export function hookConfigPaths(phrenPath) {
    return {
        claude: hookConfigPath("claude", phrenPath),
        copilot: hookConfigPath("copilot", phrenPath),
        cursor: hookConfigPath("cursor", phrenPath),
        codex: hookConfigPath("codex", phrenPath),
    };
}
export function hookConfigRoots(phrenPath) {
    const roots = new Set([path.resolve(phrenPath)]);
    for (const target of Object.values(hookConfigPaths(phrenPath))) {
        roots.add(path.resolve(path.dirname(target)));
    }
    return Array.from(roots);
}
export function vscodeMcpCandidates(env = process.env) {
    const home = homeDir(env);
    const userProfile = normalizeWindowsPathToWsl(env.USERPROFILE);
    const username = env.USERNAME;
    const userProfileRoaming = userProfile ? joinPortable(userProfile, "AppData", "Roaming", "Code", "User") : undefined;
    const guessedWindowsRoaming = !userProfile && username
        ? path.posix.join("/mnt/c", "Users", username, "AppData", "Roaming", "Code", "User")
        : undefined;
    return uniqStrings([
        userProfileRoaming,
        guessedWindowsRoaming,
        joinPortable(home, ".config", "Code", "User"),
        joinPortable(home, ".vscode-server", "data", "User"),
        joinPortable(home, "Library", "Application Support", "Code", "User"),
        joinPortable(home, "AppData", "Roaming", "Code", "User"),
    ]);
}
export function probeVsCodeConfig(commandExists, env = process.env) {
    const home = homeDir(env);
    const userProfile = normalizeWindowsPathToWsl(env.USERPROFILE);
    const userProfileRoaming = userProfile
        ? joinPortable(userProfile, "AppData", "Roaming", "Code", "User")
        : undefined;
    const candidates = vscodeMcpCandidates(env);
    const existing = candidates.find((candidate) => fs.existsSync(candidate));
    const installed = Boolean(existing) ||
        commandExists("code") ||
        Boolean(userProfile &&
            (fs.existsSync(joinPortable(userProfile, "AppData", "Local", "Programs", "Microsoft VS Code")) ||
                fs.existsSync(joinPortable(userProfile, "AppData", "Roaming", "Code"))));
    return {
        targetDir: installed ? (existing || userProfileRoaming || joinPortable(home, ".config", "Code", "User")) : null,
        installed,
    };
}
export function cursorMcpCandidates(env = process.env) {
    const home = homeDir(env);
    return [
        joinPortable(home, ".cursor", "mcp.json"),
        joinPortable(home, ".config", "Cursor", "User", "mcp.json"),
        joinPortable(home, "Library", "Application Support", "Cursor", "User", "mcp.json"),
        joinPortable(home, "AppData", "Roaming", "Cursor", "User", "mcp.json"),
    ];
}
export function resolveCursorMcpConfig(commandExists, env = process.env) {
    const home = homeDir(env);
    const candidates = cursorMcpCandidates(env);
    const existing = pickExistingFile(candidates);
    const installed = Boolean(existing) ||
        fs.existsSync(path.join(home, ".cursor")) ||
        fs.existsSync(path.join(home, ".config", "Cursor")) ||
        fs.existsSync(path.join(home, "Library", "Application Support", "Cursor")) ||
        fs.existsSync(path.join(home, "AppData", "Roaming", "Cursor")) ||
        commandExists("cursor");
    return { installed, existing, target: existing || candidates[0] };
}
export function copilotMcpCandidates(env = process.env) {
    const home = homeDir(env);
    return [
        joinPortable(home, ".copilot", "mcp-config.json"),
        joinPortable(home, ".github", "mcp.json"),
        joinPortable(home, ".config", "github-copilot", "mcp.json"),
        joinPortable(home, "Library", "Application Support", "github-copilot", "mcp.json"),
        joinPortable(home, "AppData", "Roaming", "github-copilot", "mcp.json"),
    ];
}
export function resolveCopilotMcpConfig(commandExists, env = process.env) {
    const home = homeDir(env);
    const candidates = copilotMcpCandidates(env);
    const existing = pickExistingFile(candidates);
    const hasCliDir = fs.existsSync(path.join(home, ".copilot"));
    const installed = Boolean(existing) ||
        hasCliDir ||
        fs.existsSync(path.join(home, ".github")) ||
        fs.existsSync(path.join(home, ".config", "github-copilot")) ||
        fs.existsSync(path.join(home, "Library", "Application Support", "github-copilot")) ||
        fs.existsSync(path.join(home, "AppData", "Roaming", "github-copilot")) ||
        commandExists("gh");
    return { installed, existing, cliConfig: candidates[0], hasCliDir };
}
export function codexJsonCandidates(phrenPath, env = process.env) {
    const home = homeDir(env);
    return [
        joinPortable(home, ".codex", "config.json"),
        joinPortable(home, ".codex", "mcp.json"),
        path.join(phrenPath, "codex.json"),
    ];
}
export function resolveCodexMcpConfig(phrenPath, commandExists, env = process.env) {
    const home = homeDir(env);
    const tomlPath = joinPortable(home, ".codex", "config.toml");
    const jsonCandidates = codexJsonCandidates(phrenPath, env);
    const existingJson = pickExistingFile(jsonCandidates);
    const installed = fs.existsSync(tomlPath) ||
        Boolean(existingJson) ||
        fs.existsSync(path.join(home, ".codex")) ||
        commandExists("codex");
    return {
        installed,
        tomlPath,
        existingJson,
        preferToml: fs.existsSync(tomlPath) || !existingJson,
        jsonCandidates,
    };
}
