import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { readInstallPreferences, writeInstallPreferences, type InstallPreferences } from "./init-preferences.js";
import { readCustomHooks, type CustomHookEntry, type CustomHookEvent } from "./hooks.js";

const HOOK_TOOLS = ["claude", "copilot", "cursor", "codex"] as const;
type HookTool = typeof HOOK_TOOLS[number];

const VALID_CUSTOM_EVENTS = [
  "pre-save", "post-save", "post-search",
  "pre-finding", "post-finding",
  "pre-index", "post-index",
] as const;

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
  // Reject eval — allows arbitrary code execution bypass
  if (/\beval\b/.test(trimmed)) return "eval is not permitted in hook commands.";
  // Command must start with a word character, path, or quoted string
  if (!/^[\w./~"'(]/.test(trimmed)) return "Command must begin with an executable name or path.";
  return null;
}

function normalizeHookTool(input: string | undefined): HookTool | null {
  if (!input) return null;
  const lower = input.toLowerCase() as HookTool;
  return HOOK_TOOLS.includes(lower) ? lower : null;
}

function hookConfigPaths(_cortexPath: string): Record<HookTool, string> {
  return {
    claude: path.join(os.homedir(), ".claude", "settings.json"),
    copilot: path.join(os.homedir(), ".github", "hooks", "cortex.json"),
    cursor: path.join(os.homedir(), ".cursor", "hooks.json"),
    codex: path.join(os.homedir(), ".codex", "config.json"),
  };
}

export function register(server: McpServer, ctx: McpContext): void {
  const { cortexPath } = ctx;

  // ── list_hooks ───────────────────────────────────────────────────────────

  server.registerTool(
    "list_hooks",
    {
      title: "◆ cortex · hooks",
      description:
        "List hook status for all tools (claude, copilot, cursor, codex) with enable/disable state, " +
        "config file paths, and custom integration hooks.",
      inputSchema: z.object({}),
    },
    async () => {
      const prefs = readInstallPreferences(cortexPath);
      const globalEnabled = prefs.hooksEnabled !== false;
      const toolPrefs = prefs.hookTools && typeof prefs.hookTools === "object" ? prefs.hookTools : {};
      const paths = hookConfigPaths(cortexPath);
      const customHooks = readCustomHooks(cortexPath);

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

      if (customHooks.length > 0) {
        lines.push("", `${customHooks.length} custom hook(s):`);
        for (const h of customHooks) {
          lines.push(`  ${h.event}: ${h.command}${h.timeout ? ` (${h.timeout}ms)` : ""}`);
        }
      }

      return mcpResponse({ ok: true, message: lines.join("\n"), data: { globalEnabled, tools, customHooks } });
    }
  );

  // ── toggle_hooks ─────────────────────────────────────────────────────────

  server.registerTool(
    "toggle_hooks",
    {
      title: "◆ cortex · toggle hooks",
      description:
        "Enable or disable hooks globally or for a specific tool (claude, copilot, cursor, codex).",
      inputSchema: z.object({
        enabled: z.boolean().describe("true to enable, false to disable."),
        tool: z.string().optional().describe("Specific tool. Omit to toggle globally."),
      }),
    },
    async ({ enabled, tool }) => {
      if (tool) {
        const normalized = normalizeHookTool(tool);
        if (!normalized) {
          return mcpResponse({ ok: false, error: `Invalid tool "${tool}". Use: ${HOOK_TOOLS.join(", ")}` });
        }
        const prefs = readInstallPreferences(cortexPath);
        writeInstallPreferences(cortexPath, {
          hookTools: {
            ...(prefs.hookTools && typeof prefs.hookTools === "object" ? prefs.hookTools : {}),
            [normalized]: enabled,
          },
        } satisfies Partial<InstallPreferences>);
        return mcpResponse({ ok: true, message: `${enabled ? "Enabled" : "Disabled"} hooks for ${normalized}.`, data: { tool: normalized, enabled } });
      }

      writeInstallPreferences(cortexPath, { hooksEnabled: enabled });
      return mcpResponse({ ok: true, message: `${enabled ? "Enabled" : "Disabled"} hooks globally.`, data: { global: true, enabled } });
    }
  );

  // ── add_custom_hook ──────────────────────────────────────────────────────

  server.registerTool(
    "add_custom_hook",
    {
      title: "◆ cortex · add custom hook",
      description:
        "Add a custom integration hook. Valid events: " +
        VALID_CUSTOM_EVENTS.join(", ") + ".",
      inputSchema: z.object({
        event: z.enum(VALID_CUSTOM_EVENTS).describe("Hook event name."),
        command: z.string().describe("Shell command to execute."),
        timeout: z.number().int().min(1).optional().describe("Timeout in ms (default 5000)."),
      }),
    },
    async ({ event, command, timeout }) => {
      const cmdErr = validateHookCommand(command);
      if (cmdErr) return mcpResponse({ ok: false, error: cmdErr });

      return ctx.withWriteQueue(async () => {
        const prefs = readInstallPreferences(cortexPath);
        const existing: CustomHookEntry[] = Array.isArray(prefs.customHooks) ? prefs.customHooks : [];
        const newHook: CustomHookEntry = { event: event as CustomHookEvent, command, ...(timeout !== undefined ? { timeout } : {}) };

        writeInstallPreferences(cortexPath, { ...prefs, customHooks: [...existing, newHook] });
        return mcpResponse({ ok: true, message: `Added custom hook for "${event}": ${command}`, data: { hook: newHook, total: existing.length + 1 } });
      });
    }
  );

  // ── remove_custom_hook ───────────────────────────────────────────────────

  server.registerTool(
    "remove_custom_hook",
    {
      title: "◆ cortex · remove custom hook",
      description: "Remove custom hook(s) by event and optional command text (partial match).",
      inputSchema: z.object({
        event: z.enum(VALID_CUSTOM_EVENTS).describe("Hook event name to match."),
        command: z.string().optional().describe("Partial command text. Omit to remove all hooks for the event."),
      }),
    },
    async ({ event, command }) => {
      return ctx.withWriteQueue(async () => {
        const prefs = readInstallPreferences(cortexPath);
        const existing: CustomHookEntry[] = Array.isArray(prefs.customHooks) ? prefs.customHooks : [];
        const remaining = existing.filter(h => h.event !== event || (command && !h.command.includes(command)));
        const removed = existing.length - remaining.length;

        if (removed === 0) {
          return mcpResponse({ ok: false, error: `No custom hooks matched event="${event}"${command ? ` command containing "${command}"` : ""}.` });
        }

        writeInstallPreferences(cortexPath, { ...prefs, customHooks: remaining });
        return mcpResponse({ ok: true, message: `Removed ${removed} custom hook(s) for "${event}".`, data: { removed, remaining: remaining.length } });
      });
    }
  );
}
