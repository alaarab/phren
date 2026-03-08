import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { readInstallPreferences, writeInstallPreferences, type InstallPreferences } from "./init-preferences.js";
import { readCustomHooks, getHookTarget, HOOK_EVENT_VALUES, type CustomHookEntry, type CommandHookEntry, type WebhookHookEntry, type CustomHookEvent } from "./hooks.js";

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
  if (/[`$(){}&|;<>]/.test(trimmed)) {
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
          const hookKind = "webhook" in h ? "[webhook] " : "";
          lines.push(`  ${h.event}: ${hookKind}${getHookTarget(h)}${h.timeout ? ` (${h.timeout}ms)` : ""}`);
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
        VALID_CUSTOM_EVENTS.join(", ") + ". " +
        "Provide either command (shell) or webhook (HTTP POST URL), not both.",
      inputSchema: z.object({
        event: z.enum(VALID_CUSTOM_EVENTS).describe("Hook event name."),
        command: z.string().optional().describe("Shell command to execute."),
        webhook: z.string().optional().describe("HTTP POST URL to call asynchronously (webhook hook)."),
        secret: z.string().optional().describe("HMAC-SHA256 signing secret for webhook hooks. Sent as X-Cortex-Signature header."),
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
            h === "::1" ||
            /^127\./.test(h) ||
            /^10\./.test(h) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
            /^192\.168\./.test(h) ||
            /^169\.254\./.test(h) ||
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
        const prefs = readInstallPreferences(cortexPath);
        const existing: CustomHookEntry[] = Array.isArray(prefs.customHooks) ? prefs.customHooks : [];
        writeInstallPreferences(cortexPath, { ...prefs, customHooks: [...existing, newHook] });
        return mcpResponse({ ok: true, message: `Added custom hook for "${event}": ${"webhook" in newHook ? "[webhook] " : ""}${getHookTarget(newHook)}`, data: { hook: newHook, total: existing.length + 1 } });
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
        const remaining = existing.filter(h => h.event !== event || (command && !getHookTarget(h).includes(command)));
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
