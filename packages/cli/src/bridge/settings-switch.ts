import { open, stat } from "node:fs/promises";
import { z } from "zod";
import { stripTerminal } from "../terminal-text.js";
import { AgentHooks, visibleTerminalChoice } from "./agent-hooks.js";
import { claudeSuggestion } from "./claude-suggestion.js";
import { type CodexNextTurn, codexServers } from "./codex-servers.js";
import { validateTarget } from "./herdr.js";
import { intervalFromEnv } from "./limits.js";
import { emptyComposer } from "./model-switch.js";
import { claudeFooterMode, type PermissionModeName, permissionModes } from "./permission-mode.js";
import { BridgeError, type Json, object, PERMISSION_MODES, type PermissionMode, type Target } from "./protocol.js";
import { terminalProvider } from "./terminal.js";
import { transcriptPath } from "./transcripts.js";

export { claudeFooterMode } from "./permission-mode.js";

/** T3's CodexSessionRuntime mapping. The reviewer is always sent: leaving it
 * out would keep `auto_review` from an earlier turn. */
export const CODEX_MODES: Record<PermissionMode, Pick<CodexNextTurn, "approvalPolicy" | "approvalsReviewer" | "sandboxPolicy">> = {
  supervised: { approvalPolicy: "untrusted", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" } },
  "auto-edits": { approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite" } },
  auto: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: { type: "workspaceWrite" } },
  "full-access": { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } },
};
/** Claude Code's `permissionMode` values, as the phone names them. */
const CLAUDE_MODES: Record<string, PermissionMode | "plan"> = { default: "supervised", acceptEdits: "auto-edits", auto: "auto", bypassPermissions: "full-access", plan: "plan" };
export const CLAUDE_NAMES: Record<string, string> = Object.fromEntries(Object.entries(CLAUDE_MODES).map(([raw, phone]) => [phone, raw]));

/** The same Codex mode as command-line flags, for a Codex started with no thread yet. */
export function codexModeFlags(mode: PermissionMode): string[] {
  const { approvalPolicy, approvalsReviewer, sandboxPolicy } = CODEX_MODES[mode];
  const sandbox = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" }[String(sandboxPolicy?.type)];
  return ["-a", String(approvalPolicy), "-s", String(sandbox), ...(approvalsReviewer === "auto_review" ? ["-c", 'approvals_reviewer="auto_review"'] : [])];
}

const MAX_PRESSES = 6, STEP_WAIT_MS = 2_000;

export interface SettingsCapabilities { permissionModes: string[]; plan: boolean; fast: boolean }

/** What this pane can change from the phone; undefined for harnesses that
 * offer nothing. A hand-started Codex TUI is empty: its state is still read
 * from its transcript, but switching is not offered. Claude's cycle holds
 * `full-access` only when it was launched allowing bypass. */
export function settingsCapabilities(source: string, codexServed: boolean, claudeBypass = false): SettingsCapabilities | undefined {
  if (source === "codex") return codexServed ? { permissionModes: [...PERMISSION_MODES], plan: true, fast: false } : { permissionModes: [], plan: false, fast: false };
  if (source === "claude") return { permissionModes: PERMISSION_MODES.filter(mode => mode !== "full-access" || claudeBypass), plan: true, fast: true };
  return undefined;
}

const request = z.object({ permissionMode: z.enum(PERMISSION_MODES).optional(), plan: z.boolean().optional(), fast: z.boolean().optional() })
  .strict().refine(value => value.permissionMode !== undefined || value.plan !== undefined || value.fast !== undefined, "Choose a setting to change.");

export interface SettingsState { permissionMode?: string; plan?: boolean; fast?: boolean }

/** A Claude pane's settings as its footer shows them, read at most once per
 * `PHREN_DIALOG_THROTTLE_MS` like the dialog check, and whether bypass was
 * ever seen in it (which is when full access is offered). The same read, with
 * its styles, carries the suggested next prompt in the input box. */
export class ClaudeSettingsReader {
  private cache = new Map<string, { terminal: unknown; at: number; mode?: PermissionModeName; bypass: boolean; suggestion?: string }>();
  constructor(private readonly hooks: AgentHooks, private readonly every = intervalFromEnv("PHREN_DIALOG_THROTTLE_MS", 3_000)) {}

  async read(target: Target, terminal: unknown): Promise<{ state?: SettingsState; bypass: boolean; suggestion?: { text: string; readAt: number }; permissionMode?: PermissionModeName; permissionModes?: PermissionModeName[] }> {
    const key = `${target.server}:${target.pane}`;
    let entry = this.cache.get(key);
    if (!entry || entry.terminal !== terminal) entry = { terminal, at: 0, bypass: false };
    // Re-set on every use so the Map's order is recency.
    this.cache.delete(key); this.cache.set(key, entry);
    if (Date.now() - entry.at >= this.every) {
      entry.at = Date.now();
      const screen = await this.hooks.paneAnsi(target).catch(() => undefined);
      if (screen !== undefined) entry.mode = claudeFooterMode(screen);
      entry.suggestion = screen === undefined ? undefined : claudeSuggestion(screen);
      if (entry.mode === "bypassPermissions") entry.bypass = true;
      while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    }
    const phone = entry.mode ? CLAUDE_MODES[entry.mode] : undefined;
    return { bypass: entry.bypass, ...(phone ? { state: phone === "plan" ? { plan: true } : { permissionMode: phone, plan: false } } : {}),
      ...(entry.suggestion ? { suggestion: { text: entry.suggestion, readAt: entry.at } } : {}),
      // The raw Claude mode the phone's mode picker shows, only when the footer
      // was read: an unreadable one is not a confident "default".
      ...(entry.mode ? { permissionMode: entry.mode, permissionModes: permissionModes(entry.bypass) } : {}) };
  }
}

/** Claude's answer to a slash command: the first `<local-command-stdout>` user
 * row appended after `from`. */
async function commandOutput(file: string, from: number): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat(), length = Math.min(Math.max(size - from, 0), 1_048_576), buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, from);
    for (const line of buffer.subarray(0, buffer.lastIndexOf(10) + 1).toString("utf8").split("\n")) {
      if (!line.includes("local-command-stdout")) continue;
      try {
        const content = object(object(JSON.parse(line)).message).content;
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(block => String(object(block).text ?? "")).join("") : "";
        const match = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
        if (match) return stripTerminal(match[1]).trim().slice(0, 300);
      } catch { /* Unrelated row. */ }
    }
    return undefined;
  } finally { await handle.close(); }
}

const fileSize = async (file: string | undefined) => file ? (await stat(file).catch(() => undefined))?.size ?? 0 : 0;

/** One settings transaction per pane owns its terminal input until it ends. */
export class SettingsSwitcher {
  private active = new Set<string>();
  private readonly reader: ClaudeSettingsReader;
  constructor(private readonly hooks: AgentHooks, private readonly wait = STEP_WAIT_MS) { this.reader = new ClaudeSettingsReader(hooks); }

  /** A Claude pane's footer-read settings and capabilities for the stream,
   * with the suggested next prompt its input box shows and the raw permission
   * mode (`agentStatus.permissionMode`) its picker offers. */
  async streamSettings(target: Target, terminal: unknown, codexServed: boolean): Promise<{ settings?: SettingsCapabilities; settingsState?: SettingsState; suggestion?: { text: string; readAt: number }; permissionMode?: PermissionModeName; permissionModes?: PermissionModeName[] }> {
    if (target.source !== "claude") { const settings = settingsCapabilities(target.source, codexServed); return settings ? { settings } : {}; }
    const { state, bypass, suggestion, permissionMode, permissionModes } = await this.reader.read(target, terminal);
    return { settings: settingsCapabilities("claude", false, bypass), ...(state ? { settingsState: state } : {}), ...(suggestion ? { suggestion } : {}),
      ...(permissionMode ? { permissionMode, permissionModes } : {}) };
  }

  private key(target: Target): string { return `${target.server}:${target.pane}`; }
  assertAvailable(target: Target): void {
    if (this.active.has(this.key(target))) throw new BridgeError(409, "A settings change is already in progress. Wait for it to finish.");
  }

  async switch(target: Target, data: Json): Promise<Json> {
    this.assertAvailable(target);
    // The route's own envelope is not a setting; anything else unknown is refused.
    const { target: _target, deliveryId: _delivery, ...settings } = data;
    const change = request.parse(settings);
    // A Codex pane on the Hook's own app-server takes the settings with its
    // next turn/start, whatever it is doing now, as with the model.
    const served = target.source === "codex" ? codexServers.forTarget(target) : undefined;
    if (served) return this.hold(served, change);
    if (target.source !== "claude") throw new BridgeError(422, "Changing these settings is not supported for this harness. Open terminal to change them.");
    this.active.add(this.key(target));
    try { return await this.claude(target, change); } finally { this.active.delete(this.key(target)); }
  }

  private hold(entry: NonNullable<ReturnType<typeof codexServers.forTarget>>, change: z.infer<typeof request>): Json {
    if (change.fast !== undefined) throw new BridgeError(422, "Fast mode is Claude's. Codex has no fast setting here.");
    try {
      codexServers.holdSettings(entry, { ...(change.permissionMode ? CODEX_MODES[change.permissionMode] : {}),
        ...(change.plan !== undefined ? { collaborationMode: { mode: change.plan ? "plan" : "default" } } : {}) });
    } catch (error) { throw new BridgeError(409, error instanceof Error ? error.message : "Codex could not take the setting."); }
    return { ok: true, ...(change.permissionMode ? { permissionMode: change.permissionMode } : {}), ...(change.plan !== undefined ? { plan: change.plan } : {}), applies: "next-turn" };
  }

  private async claude(target: Target, change: z.infer<typeof request>): Promise<Json> {
    if (change.permissionMode && change.plan === true) throw new BridgeError(422, "Claude's plan mode replaces the permission mode. Change one at a time.");
    if (change.permissionMode === "full-access") throw new BridgeError(422, "Claude only offers full access when it was launched allowing it. Open terminal to check.");
    const first = await validateTarget(target, false, true);
    if (!["idle", "done"].includes(String(first.agent_status))) {
      throw new BridgeError(409, "This agent is working. Settings change between turns; choose it again when the turn ends.");
    }
    const terminal = first.terminal_id;
    const validate = async () => {
      const pane = await validateTarget(target, false, true);
      if (pane.terminal_id !== terminal) throw new BridgeError(409, "The terminal changed during the settings change.");
      if (pane.agent_status === "working") throw new BridgeError(409, "The agent started working during the settings change. The result is unconfirmed; check the terminal.");
    };
    const screenMode = async () => claudeFooterMode(await this.hooks.paneLines(target));
    // The mode after a change: polled from the screen until it differs from `from`.
    const changed = async (from: string | undefined, wait: number) => {
      const deadline = Date.now() + wait;
      do {
        await new Promise(resolve => setTimeout(resolve, 150));
        await validate();
        const now = await screenMode();
        if (now && now !== from) return now;
      } while (Date.now() < deadline);
      throw new BridgeError(409, "Could not verify Claude's permission mode. Open terminal to check it.");
    };
    const slash = async (command: string) => {
      // Typing into a draft would corrupt both it and the command.
      const before = await this.hooks.paneLines(target, false);
      const composer = before.split(/\r?\n/).reverse().find(line => /^\s*[›❯>]/.test(stripTerminal(line)));
      if (!composer || !emptyComposer(composer) || visibleTerminalChoice(stripTerminal(before))) {
        throw new BridgeError(409, "The terminal has a draft or an unreadable prompt. Open terminal before changing settings.");
      }
      await validate();
      await terminalProvider().prompt(target.server, target.pane, command);
    };
    let verified: boolean | undefined;
    if (change.fast !== undefined) {
      const said = async () => [...stripTerminal(await this.hooks.paneLines(target, true)).matchAll(/fast mode (on|off)\b/gi)].map(match => match[1].toLowerCase());
      // Older answers, in the transcript or the scrollback, must not count.
      let file = await transcriptPath("claude", target.session).catch(() => undefined);
      const from = await fileSize(file), earlier = (await said()).length;
      await slash(`/fast ${change.fast ? "on" : "off"}`);
      verified = false;
      // Claude answers in the transcript, as a user row right after the command.
      const deadline = Date.now() + Math.round(this.wait * 1.5);
      let answer: string | undefined;
      do {
        await new Promise(resolve => setTimeout(resolve, 150));
        await validate();
        file ??= await transcriptPath("claude", target.session).catch(() => undefined);
        answer = file ? await commandOutput(file, from).catch(() => undefined) : undefined;
      } while (answer === undefined && Date.now() < deadline);
      if (answer !== undefined) {
        const state = /fast mode (?:is )?(on|off)\b/i.exec(answer)?.[1].toLowerCase();
        if (/unavailable|not available/i.test(answer)) throw new BridgeError(422, `Claude: ${answer}`);
        if (state) {
          if ((state === "on") !== change.fast) throw new BridgeError(409, `Claude answered Fast mode ${state}. Open terminal to check.`);
          verified = true;
        }
      } else {
        // No row in time: the screen is the fallback.
        const answers = await said(), last = answers.length > earlier ? answers.at(-1) : undefined;
        if (last) {
          if ((last === "on") !== change.fast) throw new BridgeError(409, `Claude answered Fast mode ${last}. Open terminal to check.`);
          verified = true;
        }
      }
    }
    let mode = await screenMode();
    if ((change.plan !== undefined || change.permissionMode) && !mode) throw new BridgeError(409, "Could not read Claude's permission mode from its screen. Open terminal to check.");
    const started = mode ?? "default"; // Only used once a change needs the mode, and then the footer was read.
    if (change.plan === true) {
      if (started !== "plan") { await slash("/plan"); mode = await changed(started, this.wait); if (mode !== "plan") throw new BridgeError(409, "Claude did not enter plan mode. Open terminal to check."); }
    } else if (change.permissionMode || change.plan === false) {
      const wanted = change.permissionMode ? CLAUDE_NAMES[change.permissionMode] : undefined;
      const reached = (raw: string) => wanted ? raw === wanted : raw !== "plan";
      // Shift+Tab steps through the modes Claude offers in this session; a
      // lap back to the start means it does not offer the one asked for.
      for (let presses = 0; !reached(mode!); presses++) {
        if (presses >= MAX_PRESSES || (presses > 0 && mode === started)) throw new BridgeError(422, "Claude doesn't offer that mode in this session.");
        await validate();
        // Herdr's name for the key (it sends ESC [ Z); shift-tab, backtab and btab are rejected.
        await terminalProvider().sendKeys(target.server, target.pane, ["shift+tab"]);
        mode = await changed(mode, this.wait);
      }
    }
    const phone = mode ? CLAUDE_MODES[mode] : undefined;
    // Only what the footer showed is reported; a fast-only change with an unreadable one says nothing of the mode.
    return { ok: true, ...(phone && phone !== "plan" ? { permissionMode: phone } : {}), ...(phone ? { plan: phone === "plan" } : {}),
      ...(change.fast !== undefined ? { fast: change.fast, verified: verified === true } : {}) };
  }
}
