import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { readInstallPreferences, writeInstallPreferences, updateInstallPreferences, type InstallPreferences } from "./init-preferences.js";
import { readCustomHooks, getHookTarget, HOOK_EVENT_VALUES, type CustomHookEntry, type CommandHookEntry, type WebhookHookEntry } from "./hooks.js";
import { hookConfigPath } from "./shared.js";
import { PROJECT_HOOK_EVENTS, isProjectHookEnabled, readProjectConfig, writeProjectHookConfig } from "./project-config.js";
import { isValidProjectName } from "./utils.js";

const HOOK_TOOLS = ["claude", "copilot", "cursor", "codex"] as const;
type HookTool = typeof HOOK_TOOLS[number];

const VALID_CUSTOM_EVENTS = HOOK_EVENT_VALUES;

/**
 * Validate a custom hook command at registration time.
 * Rejects obviously dangerous patterns to reduce confused-deputy risk
 * if install-preferences.json is ever compromised.
 * Returns an error string, or null if valid.
 */
function validateHookCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return "Command cannot be empty.";
  if (trimmed.length > 1000) return "Command too long (max 1000 characters).";
  // Reject shell metacharacters that allow injection or arbitrary execution
  // when the command is later run via `sh -c`.
  if (/[`$(){}&|;<>\n\r#]/.test(trimmed)) {
    return "Command contains disallowed shell characters: ` $ ( ) { } & | ; < >";
  }
  // eval and source can execute arbitrary code
  if (/\b(eval|source)\b/.test(trimmed)) return "eval and source are not permitted in hook commands.";
  // Command must start with a word character, path, or quoted string
  if (!/^[\w./~"'"]/.test(trimmed)) return "Command must begin with an executable name or path.";
  return null;
}

function normalizeHookTool(input: string | undefined): HookTool | null {
  if (!input) return null;
  const lower = input.toLowerCase() as HookTool;
  return HOOK_TOOLS.includes(lower) ? lower : null;
}

function normalizeProjectHookEvent(input: string | undefined): typeof PROJECT_HOOK_EVENTS[number] | null {
  if (!input) return null;
  const normalized = input.trim().toLowerCase();
  const aliasMap: Record<string, typeof PROJECT_HOOK_EVENTS[number]> = {
    userpromptsubmit: "UserPromptSubmit",
    prompt: "UserPromptSubmit",
    stop: "Stop",
    sessionstart: "SessionStart",
    start: "SessionStart",
    posttooluse: "PostToolUse",
    tool: "PostToolUse",
  };
  return aliasMap[normalized] ?? null;
}

export function register(server: McpServer, ctx: McpContext): void {
  const { phrenPath } = ctx;

  // ── list_hooks ───────────────────────────────────────────────────────────

  server.registerTool(
    "list_hooks",
    {
      title: "◆ phren · hooks",
      description:
        "List hook status for all tools (claude, copilot, cursor, codex) with enable/disable state, " +
        "config file paths, and custom integration hooks.",
      inputSchema: z.object({
        project: z.string().optional().describe("Optional project name to include project-level lifecycle hook overrides."),
      }),
    },
    async ({ project }) => {
      const prefs = readInstallPreferences(phrenPath);
      const globalEnabled = prefs.hooksEnabled !== false;
      const toolPrefs = prefs.hookTools && typeof prefs.hookTools === "object" ? prefs.hookTools : {};
      const paths = {
        claude: hookConfigPath("claude", phrenPath),
        copilot: hookConfigPath("copilot", phrenPath),
        cursor: hookConfigPath("cursor", phrenPath),
        codex: hookConfigPath("codex", phrenPath),
      };
      const customHooks = readCustomHooks(phrenPath);
      let projectHooks: {
        project: string;
        baseEnabled: boolean | null;
        configPath: string;
        events: Array<{ event: typeof PROJECT_HOOK_EVENTS[number]; configured: boolean | null; enabled: boolean }>;
      } | null = null;

      if (project !== undefined) {
        if (!isValidProjectName(project) || !fs.existsSync(path.join(phrenPath, project))) {
          return mcpResponse({ ok: false, error: `Project "${project}" not found.` });
        }
        const config = readProjectConfig(phrenPath, project);
        projectHooks = {
          project,
          baseEnabled: typeof config.hooks?.enabled === "boolean" ? config.hooks.enabled : null,
          configPath: path.join(phrenPath, project, "phren.project.yaml"),
          events: PROJECT_HOOK_EVENTS.map((event) => ({
            event,
            configured: typeof config.hooks?.[event] === "boolean" ? config.hooks[event]! : null,
            enabled: isProjectHookEnabled(phrenPath, project, event, config),
          })),
        };
      }

      const tools = HOOK_TOOLS.map(tool => ({
        tool,
        enabled: globalEnabled && toolPrefs[tool] !== false,
        configPath: paths[tool],
        configExists: fs.existsSync(paths[tool]),
      }));

      const lines = [
        `Hooks globally ${globalEnabled ? "enabled" : "disabled"}`,
        "",
        ...tools.map(t =>
          `${t.tool}: ${t.enabled ? "enabled" : "disabled"} | config: ${t.configExists ? t.configPath : "(not found)"}`
        ),
      ];

      if (projectHooks) {
        lines.push(
          "",
          `Project ${projectHooks.project}: base ${projectHooks.baseEnabled === null ? "inherit" : projectHooks.baseEnabled ? "enabled" : "disabled"} | config: ${projectHooks.configPath}`,
          ...projectHooks.events.map((event) => `${event.event}: ${event.enabled ? "enabled" : "disabled"}${event.configured === null ? " (inherit)" : ` (explicit ${event.configured ? "on" : "off"})`}`),
        );
      }

      if (customHooks.length > 0) {
        lines.push("", `${customHooks.length} custom hook(s):`);
        for (const h of customHooks) {
          const hookKind = "webhook" in h ? "[webhook] " : "";
          lines.push(`  ${h.event}: ${hookKind}${getHookTarget(h)}${h.timeout ? ` (${h.timeout}ms)` : ""}`);
        }
      }

      return mcpResponse({ ok: true, message: lines.join("\n"), data: { globalEnabled, tools, customHooks, projectHooks } });
    }
  );

  // ── toggle_hooks ─────────────────────────────────────────────────────────

  server.registerTool(
    "toggle_hooks",
    {
      title: "◆ phren · toggle hooks",
      description:
        "Enable or disable hooks globally, for a specific tool, or for a tracked project.",
      inputSchema: z.object({
        enabled: z.boolean().describe("true to enable, false to disable."),
        tool: z.string().optional().describe("Specific tool. Omit to toggle globally."),
        project: z.string().optional().describe("Tracked project name for project-level lifecycle hook overrides."),
        event: z.string().optional().describe("Optional lifecycle event for project-level overrides: UserPromptSubmit, Stop, SessionStart, PostToolUse."),
      }),
    },
    async ({ enabled, tool, project, event }) => {
      if (tool && project) {
        return mcpResponse({ ok: false, error: "Pass either tool or project, not both." });
      }

      if (event && !project) {
        return mcpResponse({ ok: false, error: "event requires project." });
      }

      if (project) {
        if (!isValidProjectName(project) || !fs.existsSync(path.join(phrenPath, project))) {
          return mcpResponse({ ok: false, error: `Project "${project}" not found.` });
        }
        const normalizedEvent = normalizeProjectHookEvent(event);
        if (event && !normalizedEvent) {
          return mcpResponse({ ok: false, error: `Invalid event "${event}". Use: ${PROJECT_HOOK_EVENTS.join(", ")}` });
        }
        if (normalizedEvent) {
          writeProjectHookConfig(phrenPath, project, { [normalizedEvent]: enabled });
          return mcpResponse({
            ok: true,
            message: `${enabled ? "Enabled" : "Disabled"} ${normalizedEvent} hook for ${project}.`,
            data: { project, event: normalizedEvent, enabled },
          });
        }
        writeProjectHookConfig(phrenPath, project, { enabled });
        return mcpResponse({
          ok: true,
          message: `${enabled ? "Enabled" : "Disabled"} hooks for project ${project}.`,
          data: { project, enabled },
        });
      }

      if (tool) {
        const normalized = normalizeHookTool(tool);
        if (!normalized) {
          return mcpResponse({ ok: false, error: `Invalid tool "${tool}". Use: ${HOOK_TOOLS.join(", ")}` });
        }
        updateInstallPreferences(phrenPath, (prefs) => ({
          hookTools: {
            ...(prefs.hookTools && typeof prefs.hookTools === "object" ? prefs.hookTools : {}),
            [normalized]: enabled,
          },
        } satisfies Partial<InstallPreferences>));
        return mcpResponse({ ok: true, message: `${enabled ? "Enabled" : "Disabled"} hooks for ${normalized}.`, data: { tool: normalized, enabled } });
      }

      updateInstallPreferences(phrenPath, () => ({ hooksEnabled: enabled }));
      return mcpResponse({ ok: true, message: `${enabled ? "Enabled" : "Disabled"} hooks globally.`, data: { global: true, enabled } });
    }
  );

  // ── add_custom_hook ──────────────────────────────────────────────────────

  server.registerTool(
    "add_custom_hook",
    {
      title: "◆ phren · add custom hook",
      description:
        "Add a custom integration hook. Valid events: " +
        VALID_CUSTOM_EVENTS.join(", ") + ". " +
        "Provide either command (shell) or webhook (HTTP POST URL), not both.",
      inputSchema: z.object({
        event: z.enum(VALID_CUSTOM_EVENTS).describe("Hook event name."),
        command: z.string().optional().describe("Shell command to execute."),
        webhook: z.string().optional().describe("HTTP POST URL to call asynchronously (webhook hook)."),
        secret: z.string().optional().describe("HMAC-SHA256 signing secret for webhook hooks. Sent as X-Phren-Signature header."),
        timeout: z.number().int().min(1).optional().describe("Timeout in ms (default 5000)."),
      }),
    },
    async ({ event, command, webhook, secret, timeout }) => {
      if (!command && !webhook) return mcpResponse({ ok: false, error: "Provide either command or webhook." });
      if (command && webhook) return mcpResponse({ ok: false, error: "Provide command or webhook, not both." });

      let newHook: CustomHookEntry;
      if (webhook) {
        const trimmed = webhook.trim();
        if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
          return mcpResponse({ ok: false, error: "webhook must be an http:// or https:// URL." });
        }
        // Reject private/loopback hostnames to prevent SSRF
        try {
          const { hostname } = new URL(trimmed);
          const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
          const ssrfBlocked =
            h === "localhost" ||
            // IPv4 private/loopback ranges
            /^127\./.test(h) ||
            /^10\./.test(h) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
            /^192\.168\./.test(h) ||
            /^169\.254\./.test(h) ||
            // IPv6 loopback
            h === "::1" ||
            // IPv6 ULA (fc00::/7 covers fc:: and fd::)
            h.startsWith("fc") ||
            h.startsWith("fd") ||
            // IPv6 link-local (fe80::/10)
            h.startsWith("fe80:") ||
            // IPv4-mapped IPv6 (::ffff:10.x.x.x, ::ffff:127.x.x.x, etc.)
            /^::ffff:/i.test(h) ||
            // Raw numeric IPv4 forms not normalized by all URL parsers:
            // decimal (2130706433), hex (0x7f000001), octal (0177.0.0.1 prefix)
            /^(0x[0-9a-f]+|0\d+)$/i.test(h) ||
            // Pure decimal integer that encodes an IPv4 address (8+ digits covers 0.0.0.0+)
            /^\d{8,10}$/.test(h) ||
            h.endsWith(".local") ||
            h.endsWith(".internal");
          if (ssrfBlocked) {
            return mcpResponse({ ok: false, error: `webhook hostname "${hostname}" is a private or loopback address.` });
          }
        } catch {
          return mcpResponse({ ok: false, error: "webhook is not a valid URL." });
        }
        newHook = { event, webhook: trimmed, ...(secret ? { secret } : {}), ...(timeout !== undefined ? { timeout } : {}) } satisfies WebhookHookEntry;
      } else {
        const cmdErr = validateHookCommand(command!);
        if (cmdErr) return mcpResponse({ ok: false, error: cmdErr });
        newHook = { event, command: command!, ...(timeout !== undefined ? { timeout } : {}) } satisfies CommandHookEntry;
      }

      return ctx.withWriteQueue(async () => {
        let totalAfter = 0;
        updateInstallPreferences(phrenPath, (prefs) => {
          const existing: CustomHookEntry[] = Array.isArray(prefs.customHooks) ? prefs.customHooks : [];
          totalAfter = existing.length + 1;
          return { customHooks: [...existing, newHook] };
        });
        return mcpResponse({ ok: true, message: `Added custom hook for "${event}": ${"webhook" in newHook ? "[webhook] " : ""}${getHookTarget(newHook)}`, data: { hook: newHook, total: totalAfter } });
      });
    }
  );

  // ── remove_custom_hook ───────────────────────────────────────────────────

  server.registerTool(
    "remove_custom_hook",
    {
      title: "◆ phren · remove custom hook",
      description: "Remove custom hook(s) by event and optional command text (partial match).",
      inputSchema: z.object({
        event: z.enum(VALID_CUSTOM_EVENTS).describe("Hook event name to match."),
        command: z.string().optional().describe("Partial command text. Omit to remove all hooks for the event."),
      }),
    },
    async ({ event, command }) => {
      return ctx.withWriteQueue(async () => {
        let removed = 0;
        let remainingCount = 0;
        updateInstallPreferences(phrenPath, (prefs) => {
          const existing: CustomHookEntry[] = Array.isArray(prefs.customHooks) ? prefs.customHooks : [];
          const remaining = existing.filter(h => h.event !== event || (command != null && !getHookTarget(h).includes(command)));
          removed = existing.length - remaining.length;
          remainingCount = remaining.length;
          return { customHooks: remaining };
        });
        if (removed === 0) {
          return mcpResponse({ ok: false, error: `No custom hooks matched event="${event}"${command ? ` command containing "${command}"` : ""}.` });
        }
        return mcpResponse({ ok: true, message: `Removed ${removed} custom hook(s) for "${event}".`, data: { removed, remaining: remainingCount } });
      });
    }
  );
}
