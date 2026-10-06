import type { PermissionConfig, PermissionRule } from "./types.js";
import { checkShellSafety } from "./shell-safety.js";
import { isAutoApprovableCommand } from "./shell-classify.js";
import { evaluateRules } from "./rules.js";
import { validatePath, checkSensitivePath } from "./sandbox.js";
import { isAllowed } from "./allowlist.js";
import { parsePatch, patchPaths } from "../tools/apply-patch.js";

/** Tools that are safe in all modes — read-only, no side effects. */
export const READ_ONLY_TOOLS = new Set([
  "read_file",
  "glob",
  "grep",
  "read_image",
  "git_status",
  "git_diff",
  "task_output",
  "list_mcp_resources",
  "read_mcp_resource",
  "phren_search",
  "phren_get_tasks",
  "list_agents",
]);

/** Tools that access file paths and need sensitive-path checks. */
const FILE_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "multi_edit",
  "glob",
  "grep",
]);

/** Tools that auto-confirm mode allows without prompting. */
const AUTO_CONFIRM_TOOLS = new Set([
  "edit_file",
  "multi_edit",
  "apply_patch",
  "phren_add_finding",
  "phren_complete_task",
  // Spawning forks a child process running with auto-confirm permissions —
  // suggest mode must ask first (these were unprompted in every mode before).
  "spawn_agent",
  "send_message_to_agent",
]);

/** Tools that are always denied regardless of mode. */
const DENY_LIST_TOOLS = new Set<string>([
  // Reserved for future use — e.g. "delete_project"
]);

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

  // apply_patch names its paths inside the patch text.
  let patchFiles: string[] = [];
  if (toolName === "apply_patch") {
    try {
      patchFiles = patchPaths(parsePatch(String(input.patch ?? "")));
    } catch {
      // Unparseable: the tool itself reports the error without writing.
    }
  }

  // Declarative rules (settings files, --allowedTools / --disallowedTools).
  // A deny rule wins at once; ask and allow apply below, after the checks no
  // rule may override (blocked commands, secret files, paths outside the
  // project).
  const rule = evaluateRules(config.rules, toolName, input, config.projectRoot, patchFiles);
  if (rule?.verdict === "deny") {
    return { verdict: "deny", reason: `Denied by the permission rule "${rule.rule}".` };
  }

  // Shell commands get extra scrutiny
  if (toolName === "shell") {
    const cmd = (input.command as string) || "";
    const safety = checkShellSafety(cmd);
    if (!safety.safe && safety.severity === "block") {
      return { verdict: "deny", reason: safety.reason };
    }
    // A warn pattern (command substitution, env, sudo, a force push) asks in
    // every mode but full-auto, which means allow: --yolo in a headless run,
    // where every ask is a denial, must not refuse `echo $(git rev-parse HEAD)`.
    if (!safety.safe && safety.severity === "warn" && config.mode !== "full-auto" && rule?.verdict !== "allow") {
      return { verdict: "ask", reason: safety.reason };
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

  // apply_patch: check every path the patch names.
  if (toolName === "apply_patch") {
    for (const p of patchFiles) {
      const sensitive = checkSensitivePath(p);
      if (sensitive.sensitive) {
        return { verdict: "deny", reason: `Sensitive path: ${sensitive.reason}` };
      }
      const pathResult = validatePath(p, config.projectRoot, config.allowedPaths);
      if (!pathResult.ok) {
        return { verdict: "ask", reason: `Path outside sandbox: ${pathResult.error}` };
      }
    }
  }

  if (rule?.verdict === "ask") {
    return { verdict: "ask", reason: `The permission rule "${rule.rule}" asks first.` };
  }

  // Always-safe tools pass in all modes
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { verdict: "allow", reason: "Read-only tool, always allowed." };
  }

  if (rule?.verdict === "allow") {
    return { verdict: "allow", reason: `Allowed by the permission rule "${rule.rule}".` };
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
        // Only commands that read, build or test; anything else (rm, git
        // push, npm publish, a redirect into a file) asks.
        if (cwdResult.ok && isAutoApprovableCommand((input.command as string) || "")) {
          return { verdict: "allow", reason: "Read, build or test command within sandbox." };
        }
      }
      return { verdict: "ask", reason: `Auto-confirm mode requires confirmation for "${toolName}".` };

    case "plan":
      // Plan mode: read-only tools are allowed; everything that mutates needs
      // explicit approval so the user can review the plan before it executes.
      return { verdict: "ask", reason: `Plan mode requires approval for "${toolName}".` };

    case "full-auto":
      // Full-auto: allow everything not denied or warned
      return { verdict: "allow", reason: "Full-auto mode." };

    default:
      return { verdict: "ask", reason: "Unknown permission mode." };
  }
}
