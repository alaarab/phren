/**
 * Session-scoped allowlist for tool permissions.
 *
 * Tracks tool+pattern combos that the user has approved via "allow-session" (s)
 * in the permission prompt. Checked before mode-based rules so approved tools
 * skip the interactive prompt for the rest of the session.
 */
const sessionAllowlist = [];
/**
 * Extract a matchable pattern from tool input.
 * - File tools: the path argument
 * - Shell: first token of the command (the binary)
 * - Other tools: "*" (wildcard — allow all invocations)
 */
export function extractPattern(toolName, input) {
    if (toolName === "shell") {
        const cmd = (input.command || "").trim();
        // Use the first token (the binary) as the pattern
        return cmd.split(/\s+/)[0] || "*";
    }
    const filePath = input.path || input.file_path || "";
    if (filePath)
        return filePath;
    return "*";
}
/** Check if a tool call is in the session allowlist. */
export function isAllowed(toolName, input) {
    if (sessionAllowlist.length === 0)
        return false;
    const pattern = extractPattern(toolName, input);
    return sessionAllowlist.some((entry) => {
        if (entry.toolName !== toolName)
            return false;
        if (entry.pattern === "*")
            return true;
        // For file paths: exact match or child path (boundary-aware to prevent prefix collisions)
        if (pattern === entry.pattern || pattern.startsWith(entry.pattern.endsWith("/") ? entry.pattern : entry.pattern + "/"))
            return true;
        // For shell commands: match the binary name
        return entry.pattern === pattern;
    });
}
/** Add a tool+pattern to the session allowlist. */
export function addAllow(toolName, input, scope) {
    if (scope === "once")
        return; // "once" approvals don't persist
    // For shell commands, never allow "*" — always scope to the binary name
    const pattern = scope === "tool" && toolName !== "shell"
        ? "*"
        : extractPattern(toolName, input);
    // Avoid duplicates
    const exists = sessionAllowlist.some((e) => e.toolName === toolName && e.pattern === pattern);
    if (!exists) {
        sessionAllowlist.push({ toolName, pattern });
    }
}
/** Clear the session allowlist (e.g., on session reset). */
export function clearAllowlist() {
    sessionAllowlist.length = 0;
}
