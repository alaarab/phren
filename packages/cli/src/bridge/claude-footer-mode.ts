import { stripTerminal } from "../terminal-text.js";
import type { PermissionModeName } from "./permission-mode.js";

/** Claude's permission mode from the footer line its TUI draws under the
 * composer. The transcript lags it: a `permission-mode` row is written only
 * when a prompt is submitted, and a fresh session has no file yet. The line may
 * trail hints ("(shift+tab to cycle) · 1 agent"), so only its start counts. A
 * mode the footer does not mark is `undefined`: "manual mode on" is default. */
export function claudeFooterMode(screen: string): PermissionModeName | undefined {
  for (const line of stripTerminal(screen).split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-8).reverse()) {
    const text = line.replace(/^[⏵⏸]+\s*/, "");
    if (text === line) continue;
    if (/bypass permissions on/i.test(text)) return "bypassPermissions";
    if (/^manual mode on\b/i.test(text)) return "default";
    if (/^accept edits on\b/i.test(text)) return "acceptEdits";
    if (/^plan mode on\b/i.test(text)) return "plan";
    if (/^auto mode on\b/i.test(text)) return "auto";
  }
  return undefined;
}

