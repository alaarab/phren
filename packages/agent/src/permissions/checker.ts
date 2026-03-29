import type { PermissionConfig, PermissionRule, PermissionPattern } from "./types.js";
import { checkShellSafety, hasCommandChaining, extractFirstCommand } from "./shell-safety.js";
import { validatePath, checkSensitivePath } from "./sandbox.js";
import { isAllowed } from "./allowlist.js";

/** Tools that are safe in all modes — read-only, no side effects. */
const ALWAYS_SAFE_TOOLS = new Set([
  "phren_search",
  "phren_get_tasks",
  "ask_user",
  "cron_list",
]);

/** Tools that access file paths and need sensitive-path checks. */
const FILE_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
]);

/** Tools that auto-confirm mode allows without prompting. */
const AUTO_CONFIRM_TOOLS = new Set([
  "edit_file",
  "phren_add_finding",
  "phren_complete_task",
  "phren_add_task",
]);

/** Tools that are always denied regardless of mode. */
const DENY_LIST_TOOLS = new Set<string>([
  // Reserved for future use — e.g. "delete_project"
]);

/**
 * Match a glob-style pattern against a value.
 * Supports * (any chars) and ** (recursive path match).
 */
function matchPattern(pattern: string, value: string): boolean {
  // Convert glob to regex
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex chars
    .replace(/\*\*/g, "§GLOBSTAR§")        // preserve **
    .replace(/\*/g, "[^/]*")                // * matches anything except /
    .replace(/§GLOBSTAR§/g, ".*");          // ** matches anything

  return new RegExp(`^${regexStr}$`).test(value);
}

/**
 * Check granular permission patterns against a tool call.
 * Returns the first matching rule, or null if no pattern matches.
 */
function checkPatternRules(
  rules: PermissionPattern[] | undefined,
  toolName: string,
  input: Record<string, unknown>,
): PermissionRule | null {
  if (!rules || rules.length === 0) return null;

  for (const rule of rules) {
    if (rule.tool !== toolName) continue;

    // No pattern means match all invocations of this tool
    if (!rule.pattern) {
      return { verdict: rule.verdict, reason: `Pattern rule: ${rule.tool}` };
    }

    // Match pattern against the relevant input field
    let value = "";
    if (toolName === "shell") {
      value = (input.command as string) || "";
      // Security: if command has chaining operators, only match against the first command
      // to prevent "allowed-cmd && malicious-cmd" from matching "allowed-cmd *" rules
      if (rule.verdict === "allow" && hasCommandChaining(value)) {
        value = extractFirstCommand(value);
      }
    } else if (FILE_TOOLS.has(toolName)) {
      value = (input.path as string) || (input.file_path as string) || "";
    } else if (toolName === "web_fetch" || toolName === "web_search") {
      // domain:example.com pattern
      if (rule.pattern.startsWith("domain:")) {
        const domain = rule.pattern.slice(7);
        const url = (input.url as string) || (input.query as string) || "";
        try {
          const urlObj = new URL(url);
          if (urlObj.hostname === domain || urlObj.hostname.endsWith(`.${domain}`)) {
            return { verdict: rule.verdict, reason: `Pattern rule: ${rule.tool}(${rule.pattern})` };
          }
        } catch {
          // Not a URL, skip domain matching
        }
        continue;
      }
      value = (input.url as string) || "";
    } else {
      // For other tools, try common input fields
      value = (input.query as string) || (input.name as string) || "";
    }

    if (matchPattern(rule.pattern, value)) {
      return { verdict: rule.verdict, reason: `Pattern rule: ${rule.tool}(${rule.pattern})` };
    }
  }

  return null;
}

/**
 * Check whether a tool call should be allowed, asked about, or denied.
 */
export function checkPermission(
  config: PermissionConfig,
  toolName: string,
  input: Record<string, unknown>,
): PermissionRule {
  // Deny-list always wins
  if (DENY_LIST_TOOLS.has(toolName)) {
    return { verdict: "deny", reason: `Tool "${toolName}" is on the deny list.` };
  }

  // Shell commands get extra scrutiny
  if (toolName === "shell") {
    const cmd = (input.command as string) || "";
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
    const cwd = (input.cwd as string) || config.projectRoot;
    const cwdResult = validatePath(cwd, config.projectRoot, config.allowedPaths);
    if (!cwdResult.ok) {
      if (config.mode === "full-auto") {
        return { verdict: "ask", reason: `Shell cwd outside sandbox: ${cwdResult.error}` };
      }
      // suggest and auto-confirm will ask below anyway
    }
  }

  // Path-based tools: validate sandbox + sensitive path
  if (FILE_TOOLS.has(toolName)) {
    const filePath = (input.path as string) || "";
    if (filePath) {
      // Sensitive path check applies in ALL modes
      const sensitive = checkSensitivePath(filePath);
      if (sensitive.sensitive) {
        return { verdict: "deny", reason: `Sensitive path: ${sensitive.reason}` };
      }

      // Sandbox check: ask for out-of-sandbox paths in ALL modes (not just full-auto)
      const pathResult = validatePath(filePath, config.projectRoot, config.allowedPaths);
      if (!pathResult.ok) {
        return { verdict: "ask", reason: `Path outside sandbox: ${pathResult.error}` };
      }
    }
  }

  // Granular deny rules — checked before any allows
  const denyMatch = checkPatternRules(config.denyRules, toolName, input);
  if (denyMatch) {
    return denyMatch;
  }

  // Granular allow rules — checked before mode-based logic
  const allowMatch = checkPatternRules(config.allowRules, toolName, input);
  if (allowMatch && allowMatch.verdict === "allow") {
    return allowMatch;
  }

  // Always-safe tools pass in all modes
  if (ALWAYS_SAFE_TOOLS.has(toolName)) {
    return { verdict: "allow", reason: "Read-only tool, always allowed." };
  }

  // Session allowlist — user previously approved this tool+pattern via (a)llow-tool or (s)ession-allow.
  // Placed after deny-list, shell-safety blocks, and sensitive-path denials so those are never bypassed.
  if (isAllowed(toolName, input)) {
    return { verdict: "allow", reason: "Session allowlist." };
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
        const cwd = (input.cwd as string) || config.projectRoot;
        const cwdResult = validatePath(cwd, config.projectRoot, config.allowedPaths);
        if (cwdResult.ok) {
          const cmd = (input.command as string) || "";
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
