/**
 * Parse CLI permission pattern strings into PermissionPattern objects.
 *
 * Supported formats:
 *   "Bash(npm run *)"           → tool: "shell", pattern: "npm run *"
 *   "Read(/src/**)"             → tool: "read_file", pattern: "/src/**"
 *   "WebFetch(domain:x.com)"    → tool: "web_fetch", pattern: "domain:x.com"
 *   "edit_file"                 → tool: "edit_file", pattern: undefined (matches all)
 *   "shell"                     → tool: "shell", pattern: undefined
 */
import type { PermissionPattern, PermissionVerdict } from "./types.js";

/** Map of friendly tool names to internal names. */
const TOOL_ALIASES: Record<string, string> = {
  "Bash": "shell",
  "bash": "shell",
  "Shell": "shell",
  "Read": "read_file",
  "read": "read_file",
  "Write": "write_file",
  "write": "write_file",
  "Edit": "edit_file",
  "edit": "edit_file",
  "Glob": "glob",
  "Grep": "grep",
  "WebFetch": "web_fetch",
  "webfetch": "web_fetch",
  "WebSearch": "web_search",
  "websearch": "web_search",
};

/**
 * Parse a pattern string like "Bash(npm run *)" into a PermissionPattern.
 * Returns null if the pattern is malformed.
 */
export function parsePermissionPattern(rule: string, verdict: PermissionVerdict): PermissionPattern | null {
  const trimmed = rule.trim();
  if (!trimmed) return null;

  // Check for Tool(pattern) format
  const match = trimmed.match(/^(\w+)\((.+)\)$/);
  if (match) {
    const toolName = TOOL_ALIASES[match[1]] ?? match[1];
    return { tool: toolName, pattern: match[2], verdict };
  }

  // Bare tool name
  const toolName = TOOL_ALIASES[trimmed] ?? trimmed;
  return { tool: toolName, verdict };
}
