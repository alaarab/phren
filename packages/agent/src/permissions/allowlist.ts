/**
 * Session-scoped allowlist for tool permissions.
 *
 * Tracks tool+pattern combos that the user has approved via "allow-session" (s)
 * in the permission prompt. Checked before mode-based rules so approved tools
 * skip the interactive prompt for the rest of the session.
 */

/** An entry in the session allowlist. */
interface AllowEntry {
  toolName: string;
  /** Pattern to match: file path for file tools, command prefix for shell. "*" = any input. */
  pattern: string;
}

const sessionAllowlist: AllowEntry[] = [];

/**
 * Extract a matchable pattern from tool input.
 * - File tools: the path argument
 * - Shell: first token of the command (the binary)
 * - Other tools: "*" (wildcard — allow all invocations)
 */
export function extractPattern(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "shell") {
    const cmd = ((input.command as string) || "").trim();
    // Use the first token (the binary) as the pattern
    return cmd.split(/\s+/)[0] || "*";
  }

  const filePath = (input.path as string) || (input.file_path as string) || "";
  if (filePath) return filePath;

  return "*";
}

/** Check if a tool call is in the session allowlist. */
export function isAllowed(toolName: string, input: Record<string, unknown>): boolean {
  if (sessionAllowlist.length === 0) return false;
  const pattern = extractPattern(toolName, input);

  return sessionAllowlist.some((entry) => {
    if (entry.toolName !== toolName) return false;
    if (entry.pattern === "*") return true;
    // For file paths: exact match or child path
    if (pattern.startsWith(entry.pattern)) return true;
    // For shell commands: match the binary name
    return entry.pattern === pattern;
  });
}

/** Add a tool+pattern to the session allowlist. */
export function addAllow(
  toolName: string,
  input: Record<string, unknown>,
  scope: "once" | "session" | "tool",
): void {
  if (scope === "once") return; // "once" approvals don't persist

  const pattern = scope === "tool" ? "*" : extractPattern(toolName, input);

  // Avoid duplicates
  const exists = sessionAllowlist.some(
    (e) => e.toolName === toolName && e.pattern === pattern,
  );
  if (!exists) {
    sessionAllowlist.push({ toolName, pattern });
  }
}

/** Clear the session allowlist (e.g., on session reset). */
export function clearAllowlist(): void {
  sessionAllowlist.length = 0;
}

/** Get a snapshot of the current allowlist (for display). */
export function getAllowlist(): ReadonlyArray<Readonly<AllowEntry>> {
  return sessionAllowlist;
}
