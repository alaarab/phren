import { z } from "zod";
import { stripTerminal } from "../terminal-text.js";
import type { AgentHooks } from "./agent-hooks.js";
import { validateTarget } from "./herdr.js";
import { BridgeError, id, type Json, serverName, type Target } from "./protocol.js";
import { terminalProvider } from "./terminal.js";
import { visibleTerminalChoice } from "./terminal-choice.js";

/** An agent's permission mode as its own footer names it, and the route that
 * changes it by pressing Shift+Tab through the harness's cycle. The phone's
 * mode picker reads `agentStatus.permissionMode` / `permissionModes` off the
 * chat status stream and posts one back here. Only Claude Code draws the mode
 * in its footer; Codex and OpenCode keep theirs in config, so they offer none. */

/** Claude Code's `permissionMode` values in Shift+Tab cycle order. "default" is
 * the footer's "manual mode on"; "auto" is "auto mode on". */
export const PERMISSION_CYCLE = ["default", "acceptEdits", "plan", "auto"] as const;
/** `bypassPermissions` is in the cycle only for a session launched allowing
 * bypass, so it is a valid mode but not part of the standard list. */
export const PERMISSION_MODE_VALUES = [...PERMISSION_CYCLE, "bypassPermissions"] as const;
export type PermissionModeName = (typeof PERMISSION_MODE_VALUES)[number];

/** The modes a Claude pane offers, in Shift+Tab cycle order. `bypass` adds the
 * one only a session launched with --allow-dangerously-skip-permissions has. */
export function permissionModes(bypass: boolean): PermissionModeName[] {
  return [...PERMISSION_CYCLE, ...(bypass ? ["bypassPermissions" as const] : [])];
}

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

/** A local agent's own pane, as the caller names it when it is not the owner. */
const callerPane = z.object({ server: serverName, workspace: id, tab: id, pane: id }).passthrough();

/** Who chose the mode, for the reply: the owner from the phone (no `origin`),
 * or the local agent that named its pane. */
function attribution(actor: unknown): Json {
  const pane = callerPane.safeParse(actor);
  return pane.success ? { setBy: "agent", setByPane: `${pane.data.server}:${pane.data.pane}` } : { setBy: "owner" };
}

const STEP_WAIT_MS = 2_000, POLL_MS = 100;

/** One Shift+Tab transaction per pane owns its terminal input until it ends,
 * like the settings switcher, so a mode change and a settings change never
 * press into the same composer at once. */
export class PermissionModeSwitcher {
  private active = new Set<string>();
  constructor(private readonly hooks: AgentHooks, private readonly wait = STEP_WAIT_MS) {}

  private key(target: Target): string { return `${target.server}:${target.pane}`; }
  assertAvailable(target: Target): void {
    if (this.active.has(this.key(target))) throw new BridgeError(409, "A permission-mode change is already in progress. Wait for it to finish.");
  }

  /** Steps the pane to `mode`, or refuses. Only Claude offers the cycle; the
   * machine's authority policy never caps an owner's own choice. */
  async set(target: Target, mode: PermissionModeName, actor?: unknown): Promise<Json> {
    this.assertAvailable(target);
    if (target.source !== "claude") throw new BridgeError(422, "Changing the permission mode is not supported for this harness. Open terminal to change it.");
    this.active.add(this.key(target));
    try { return await this.cycle(target, mode, actor); }
    finally { this.active.delete(this.key(target)); }
  }

  private async cycle(target: Target, mode: PermissionModeName, actor: unknown): Promise<Json> {
    const first = await validateTarget(target, false, true);
    const terminal = first.terminal_id, status = String(first.agent_status);
    // Shift+Tab is the composer's key: a turn or a dialog would take it first.
    if (status === "working") throw new BridgeError(409, "This agent is mid-turn. Permission changes happen between turns; choose the mode again when the turn ends.");
    const screen = await this.hooks.paneAnsi(target).catch(() => undefined);
    if (screen === undefined) throw new BridgeError(409, "Could not read Claude's permission mode from its screen. Open terminal to check.");
    if (status === "blocked" || status === "waiting" || this.hooks.approval(target) || this.hooks.terminalPrompt(target)
      || visibleTerminalChoice(stripTerminal(screen))) {
      throw new BridgeError(409, "A permission prompt or dialog is open. Answer it before changing the permission mode.");
    }
    let current = claudeFooterMode(screen);
    if (!current) throw new BridgeError(409, "Could not read Claude's permission mode from its screen. Open terminal to check.");
    if (current === mode) return { ok: true, permissionMode: current, ...attribution(actor) };
    // Shift+Tab steps through the modes this session offers. A full lap back to
    // the start (one more press than the cycle holds) means it does not offer
    // the one asked for. The bound grows if the cycle turns out to include one
    // more mode than the standard list (bypass).
    const modes = new Set<PermissionModeName>(PERMISSION_CYCLE);
    for (let presses = 0; ; presses++) {
      if (presses >= modes.size + 1) throw new BridgeError(422, `Claude doesn't offer ${mode} in this session.`, { permissionMode: current });
      await this.assertLive(target, terminal);
      await terminalProvider().sendKeys(target.server, target.pane, ["shift+tab"]);
      current = await this.changed(target, terminal, current);
      modes.add(current);
      if (current === mode) return { ok: true, permissionMode: current, ...attribution(actor) };
    }
  }

  /** The mode after a press: polled from the screen until it differs from
   * `from`, because the TUI redraws the footer asynchronously. */
  private async changed(target: Target, terminal: unknown, from: PermissionModeName): Promise<PermissionModeName> {
    const deadline = Date.now() + this.wait;
    do {
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
      await this.assertLive(target, terminal);
      const mode = claudeFooterMode(await this.hooks.paneAnsi(target).catch(() => ""));
      if (mode && mode !== from) return mode;
    } while (Date.now() < deadline);
    throw new BridgeError(409, "Could not verify Claude's permission mode. Open terminal to check it.");
  }

  private async assertLive(target: Target, terminal: unknown): Promise<void> {
    const pane = await validateTarget(target, false, true);
    if (pane.terminal_id !== terminal) throw new BridgeError(409, "The terminal changed during the permission-mode change.");
    if (pane.agent_status === "working") throw new BridgeError(409, "The agent started working during the permission-mode change. The result is unconfirmed; check the terminal.");
  }
}
