import { checkShellSafety } from "./shell-safety.js";
import { validatePath } from "./sandbox.js";
/** Tools that are safe in all modes — read-only, no side effects. */
const ALWAYS_SAFE_TOOLS = new Set([
    "read_file",
    "glob",
    "grep",
    "phren_search",
    "phren_get_tasks",
]);
/** Tools that auto-confirm mode allows without prompting. */
const AUTO_CONFIRM_TOOLS = new Set([
    "edit_file",
    "phren_add_finding",
    "phren_complete_task",
]);
/** Tools that are always denied regardless of mode. */
const DENY_LIST_TOOLS = new Set([
// Reserved for future use — e.g. "delete_project"
]);
/**
 * Check whether a tool call should be allowed, asked about, or denied.
 */
export function checkPermission(config, toolName, input) {
    // Deny-list always wins
    if (DENY_LIST_TOOLS.has(toolName)) {
        return { verdict: "deny", reason: `Tool "${toolName}" is on the deny list.` };
    }
    // Shell commands get extra scrutiny
    if (toolName === "shell") {
        const cmd = input.command || "";
        const safety = checkShellSafety(cmd);
        if (!safety.safe && safety.severity === "block") {
            return { verdict: "deny", reason: safety.reason };
        }
        if (!safety.safe && safety.severity === "warn") {
            // In full-auto, warn becomes ask. In other modes, it's already going to ask.
            if (config.mode === "full-auto") {
                return { verdict: "ask", reason: safety.reason };
            }
        }
        // Check cwd for shell
        const cwd = input.cwd || config.projectRoot;
        const cwdResult = validatePath(cwd, config.projectRoot, config.allowedPaths);
        if (!cwdResult.ok) {
            if (config.mode === "full-auto") {
                return { verdict: "ask", reason: `Shell cwd outside sandbox: ${cwdResult.error}` };
            }
            // suggest and auto-confirm will ask below anyway
        }
    }
    // Path-based tools: validate the path is in sandbox
    if (toolName === "write_file" || toolName === "edit_file") {
        const filePath = input.path || "";
        if (filePath) {
            const pathResult = validatePath(filePath, config.projectRoot, config.allowedPaths);
            if (!pathResult.ok) {
                if (config.mode === "full-auto") {
                    return { verdict: "ask", reason: `Path outside sandbox: ${pathResult.error}` };
                }
                // Other modes already ask for these tools
            }
        }
    }
    // Always-safe tools pass in all modes
    if (ALWAYS_SAFE_TOOLS.has(toolName)) {
        return { verdict: "allow", reason: "Read-only tool, always allowed." };
    }
    // Mode-specific logic
    switch (config.mode) {
        case "suggest":
            // Suggest mode: ask for everything except safe tools
            return { verdict: "ask", reason: `Suggest mode requires confirmation for "${toolName}".` };
        case "auto-confirm":
            if (AUTO_CONFIRM_TOOLS.has(toolName)) {
                // Auto-confirm tools are allowed if path is in sandbox
                return { verdict: "allow", reason: `Auto-confirm mode allows "${toolName}".` };
            }
            if (toolName === "shell") {
                const cwd = input.cwd || config.projectRoot;
                const cwdResult = validatePath(cwd, config.projectRoot, config.allowedPaths);
                if (cwdResult.ok) {
                    const cmd = input.command || "";
                    const safety = checkShellSafety(cmd);
                    if (safety.safe) {
                        return { verdict: "allow", reason: "Safe shell command within sandbox." };
                    }
                }
            }
            return { verdict: "ask", reason: `Auto-confirm mode requires confirmation for "${toolName}".` };
        case "full-auto":
            // Full-auto: allow everything not denied or warned
            return { verdict: "allow", reason: "Full-auto mode." };
        default:
            return { verdict: "ask", reason: "Unknown permission mode." };
    }
}
