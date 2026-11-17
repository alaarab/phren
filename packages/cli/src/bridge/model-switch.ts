import { z } from "zod";
import { AgentHooks, visibleTerminalChoice, type TerminalChoice } from "./agent-hooks.js";
import { validateTarget } from "./herdr.js";
import { servedPane } from "./opencode-panes.js";
import { switchOpencodeModel } from "./opencode-service.js";
import { terminalProvider } from "./terminal.js";
import { ModelCatalog, type AgentModel } from "./models.js";
import { BridgeError, type Json, type Target } from "./protocol.js";
import { sideQuestionText } from "./side-questions.js";
import { stripTerminal } from "../terminal-text.js";
import { codexServers } from "./codex-servers.js";

export const MODEL_BUSY = "This agent is working. The model switch can happen when the turn ends. Choose Switch after this turn.";
export const SLASH_BUSY = "This agent is working. Slash commands run between turns; send it again when this turn ends.";

/** Busy slash commands must never enter the harness's text queue. Claude's
 * `/btw` side question is the one made to run beside a working turn. Only
 * `/model` is told about the model switch; any other command (`/yolo`,
 * `/compact`) is told it runs between turns. */
export function refuseWorkingSlash(pane: Json, text: string, source?: string): void {
  if (source && sideQuestionText(source, text) !== undefined) return;
  if (pane.agent_status !== "working" || !/^\s*\//.test(text)) return;
  throw new BridgeError(409, /^\s*\/model(?:\s|$)/.test(text) ? MODEL_BUSY : SLASH_BUSY);
}

const request = z.object({ model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._\[\]:/-]{0,99}$/),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional() });
const cleanLabel = (label: string) => label.replace(/\s*\((?:current|default|recommended)\)/gi, "").trim().toLowerCase();
const effortLabel = (label: string) => cleanLabel(label).replace(/^extra\s+high$/, "xhigh");

/** The levels Claude Code's `/effort` takes (2.1.280) when the catalogue
 * lists none for a model; Claude still refuses one the model lacks. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

type EffortReply = { effort: string } | { error: string };

/** Claude Code's first reply to `/effort <level>` below its latest "Set model
 * to" line, the switch this transaction just verified, so an older reply in
 * the scrollback never confirms. A cap reports the level actually set; an
 * override or refusal is an error. */
export function claudeEffortReply(text: string): EffortReply | undefined {
  const lines = text.split(/\r?\n/).map(line => stripTerminal(line).trim().replace(/^[⏺●⎿]\s*/, ""));
  let start = -1;
  lines.forEach((line, index) => { if (line.startsWith("Set model to ")) start = index; });
  if (start < 0) return undefined;
  const replies: EffortReply[] = [];
  for (const output of lines.slice(start + 1)) {
    let match: RegExpMatchArray | null;
    if ((match = output.match(/^Set effort level to ([a-z]+)\b/))) replies.push({ effort: match[1] });
    else if ((match = output.match(/^Effort '[^']*' exceeds the cap\b.*; set to '([a-z]+)' instead/))) replies.push({ effort: match[1] });
    else if (/^(?:Not applied: )?CLAUDE_CODE_EFFORT_LEVEL=\S* overrides/.test(output)) {
      replies.push({ error: "CLAUDE_CODE_EFFORT_LEVEL on the computer overrides Claude's effort in this session." });
    } else if ((match = output.match(/^(?:Failed to set effort level: |Invalid argument: )(.*)/))) {
      replies.push({ error: `Claude did not set the effort: ${match[1].slice(0, 200)}` });
    }
  }
  return replies[0];
}

type ModelReply = { set: string } | { kept: string };

/** The screen down to Claude Code's reply to the last `/model` in its
 * transcript. A command still in the composer has a rule under it, no reply. */
function lastModelReply(screen: string): { head: string[]; output: string } | undefined {
  const lines = screen.split(/\r?\n/).map(line => stripTerminal(line).trim());
  let echo = -1;
  lines.forEach((line, index) => { if (/^[❯>]\s*\/model(?:\s|$)/.test(line)) echo = index; });
  const reply = echo < 0 ? -1 : lines.findIndex((line, index) => index > echo && line !== "");
  return reply < 0 ? undefined : { head: lines.slice(0, reply + 1), output: lines[reply].replace(/^[⏺●⎿]\s*/, "") };
}
const endsWith = (long: string[], short: string[]) => short.length <= long.length
  && short.every((line, index) => line === long[long.length - short.length + index]);

/** Claude Code's reply to the `/model` this transaction typed. `before` is the
 * screen from before it typed: a reply already there, the same one after the
 * screen scrolled, never answers this command, even one for the same model. */
function claudeModelReply(text: string, before: string): ModelReply | undefined {
  const now = lastModelReply(text), old = lastModelReply(before);
  if (!now || old && (endsWith(old.head, now.head) || endsWith(now.head, old.head))) return undefined;
  const set = now.output.match(/^Set model to (.+)$/i), kept = now.output.match(/^Kept model as (.+)$/i);
  return set ? { set: set[1] } : kept ? { kept: kept[1] } : undefined;
}

/** The Hook's own slash command still in Claude's composer (the composer's
 * rule under it), not its echo in the transcript (Claude's reply under it). */
function unsentCommand(text: string, command: string): boolean {
  const lines = text.split(/\r?\n/).map(line => stripTerminal(line).trim()).filter(Boolean);
  let composer = -1;
  lines.forEach((line, index) => { if (/^[›❯>]/.test(line)) composer = index; });
  return composer >= 0 && lines[composer].replace(/^[›❯>]\s*/, "") === command && /^─/.test(lines[composer + 1] ?? "");
}

/** Claude Code 2.1.326 asks before a switch that drops the conversation's
 * prompt cache: "Switch model?" with "Yes, switch to <name>" and "No, go back". */
function claudeSwitchQuestion(text: string): TerminalChoice | undefined {
  const choice = visibleTerminalChoice(stripTerminal(text));
  return choice?.options.some(option => /^yes, switch to\s/i.test(option.label)) ? choice : undefined;
}

/** Empty prompts can draw a dim placeholder. Only ANSI evidence that every
 * character after the prompt is dim distinguishes that from a person's draft. */
export function emptyComposer(line: string): boolean {
  if (!/^\s*[›❯>]\s*/.test(stripTerminal(line))) return false;
  let dim = false, prompt = false;
  for (const token of line.match(/\x1b\[[0-9;]*m|[^\x1b]/g) ?? []) {
    if (token.startsWith("\x1b")) {
      const codes = token.slice(2, -1).split(";").map(Number);
      for (let index = 0; index < codes.length; index++) {
        const code = codes[index];
        if ([38, 48, 58].includes(code)) { index += codes[index + 1] === 2 ? 4 : codes[index + 1] === 5 ? 2 : 0; continue; }
        if (code === 0 || code === 22) dim = false;
        else if (code === 2) dim = true;
      }
    } else if (!prompt && /[›❯>]/.test(token)) prompt = true;
    else if (prompt && token.trim() && !dim) return false;
  }
  return prompt;
}

/** Typing a slash command into a draft or an open menu would corrupt both, so
 * the terminal must show an empty composer and no menu first. The `code` says
 * which: the phone names the cause and offers the terminal. */
export function assertComposerReady(before: string, action: string): void {
  const composer = before.split(/\r?\n/).reverse().find(line => /^\s*[›❯>]/.test(stripTerminal(line)));
  if (visibleTerminalChoice(stripTerminal(before))) {
    throw new BridgeError(409, `A menu is open in the terminal. Open terminal to finish it, then ${action}.`, { code: "terminal-menu" });
  }
  if (!composer) {
    throw new BridgeError(409, `Phren couldn't find the terminal's input line. Open terminal to ${action}.`, { code: "terminal-unreadable" });
  }
  if (!emptyComposer(composer)) {
    throw new BridgeError(409, `There's unsent text in the terminal. Send or clear it, then ${action}.`, { code: "terminal-draft" });
  }
}

/** Only a footer below Codex's empty composer proves the active model. Text
 * in history, a menu, or the startup banner must never confirm a switch. */
export function codexModelStatus(text: string, model: AgentModel): boolean {
  const lines = text.split(/\r?\n/).reverse();
  const composer = lines.findIndex(line => /^\s*[›❯>]/.test(stripTerminal(line)));
  if (composer < 0 || !emptyComposer(lines[composer]) || visibleTerminalChoice(stripTerminal(text))) return false;
  return lines.slice(0, composer).filter(line => line.trim()).slice(0, 4).some(line => {
    const footer = stripTerminal(line).trim().toLowerCase();
    return [model.id, model.name].some(name => {
      const lower = name.toLowerCase();
      return footer === lower || footer.startsWith(lower + " ") || footer.startsWith(lower + " ·");
    });
  });
}

/** One model transaction owns terminal input until it finishes or escapes. */
export class ModelSwitcher {
  private active = new Set<string>();
  constructor(private readonly hooks: AgentHooks, private readonly catalog = new ModelCatalog(),
    private readonly timeout = 4_000) {}

  private key(target: Target): string { return `${target.server}:${target.pane}`; }
  assertAvailable(target: Target): void {
    if (this.active.has(this.key(target))) throw new BridgeError(409, "A model switch is already in progress. Wait for it to finish.");
  }

  async switch(target: Target, data: Json): Promise<Json> {
    this.assertAvailable(target);
    const { model: id, effort: chosenEffort } = request.parse(data);
    this.active.add(this.key(target));
    let opened = false;
    // The slash command typed into a Claude pane, until Claude answers it.
    let typed: string | undefined;
    let terminal: unknown;
    const validate = async (idle = false) => {
      const pane = await validateTarget(target, false, true);
      if (terminal !== undefined && pane.terminal_id !== terminal) throw new BridgeError(409, "The terminal changed during the model switch.");
      if (opened && pane.agent_status === "working") throw new BridgeError(409, "The agent started working during the model switch. The result is unconfirmed; check the terminal.");
      refuseWorkingSlash(pane, "/model");
      if (idle && !["idle", "done"].includes(String(pane.agent_status))) throw new BridgeError(409, "Open terminal and finish the pending input before switching models.");
      return pane;
    };
    const keys = async (values: string[]) => {
      await validate();
      await terminalProvider().sendKeys(target.server, target.pane, values);
    };
    const waitFor = async <T>(read: (text: string) => T | undefined, step: string, ansi = false): Promise<T> => {
      const deadline = Date.now() + this.timeout;
      do {
        await validate();
        const value = read(await this.hooks.paneLines(target, !ansi));
        if (value !== undefined) return value;
        await new Promise(resolve => setTimeout(resolve, 150));
      } while (Date.now() < deadline);
      throw new BridgeError(409, `Could not verify ${step}. Open terminal to check the model.`);
    };
    try {
      // A Codex pane on the Hook's own app-server takes the model and effort
      // with its next turn (turn/start overrides), as T3 does: no menu is
      // walked in its TUI, and a working turn is left alone.
      const served = target.source === "codex" ? codexServers.forTarget(target) : undefined;
      if (served) {
        const model = (await this.catalog.list("codex")).find(model => model.id === id);
        if (!model) throw new BridgeError(422, "That model is not in the computer's catalogue. Refresh the model list.");
        const effort = chosenEffort ?? model.defaultReasoningEffort;
        if (effort && model.supportedReasoningEfforts?.length && !model.supportedReasoningEfforts.includes(effort)) {
          throw new BridgeError(422, "The catalogue does not confirm that reasoning effort. Refresh the model list.");
        }
        codexServers.setNextTurn(served, model.id, effort);
        return { ok: true, model: model.id, name: model.name, ...(effort ? { effort } : {}), applies: "next-turn" };
      }
      // An OpenCode 2 pane takes the model over its service, for the turns
      // after this one: no picker is walked, and a working turn is left alone.
      const service = target.source === "opencode" ? servedPane(target.server, target.pane) : undefined;
      if (service?.api === 2) {
        const model = (await this.catalog.list("opencode")).find(model => model.id === id);
        if (!model) throw new BridgeError(422, "That model is not in the computer's catalogue. Refresh the model list.");
        await validateTarget(target, false, true);
        const held = await switchOpencodeModel({ ...service, session: target.session }, model.id, chosenEffort)
          .catch(() => { throw new BridgeError(409, "OpenCode did not take that model. Open terminal to check the model."); });
        if (held.id !== model.id) throw new BridgeError(409, `OpenCode kept ${held.id}. Open terminal to check the model.`);
        return { ok: true, model: model.id, name: model.name, ...(held.variant && held.variant !== "default" ? { effort: held.variant } : {}), applies: "next-turn" };
      }
      terminal = (await validate(true)).terminal_id;
      if (target.source === "opencode") throw new BridgeError(422, "OpenCode uses an interactive /models picker. Open terminal to switch models; remote selection cannot yet be verified.");
      if (!["codex", "claude"].includes(target.source)) throw new BridgeError(422, "Model switching is not supported for this harness. Open terminal to choose a model.");
      const models = await this.catalog.list(target.source);
      const model = models.find(model => model.id === id) ?? (target.source === "claude"
        ? models.find(model => id === "default" ? model.isDefault : ["opus", "sonnet", "haiku", "fable"].includes(id) && model.id.startsWith(`claude-${id}-`) && !model.id.endsWith("[1m]")) : undefined);
      if (!model) throw new BridgeError(422, "That model is not in the computer's catalogue. Refresh the model list.");
      const effort = chosenEffort ?? model.defaultReasoningEffort;
      if (target.source === "codex" && (!effort || !model.supportedReasoningEfforts?.includes(effort))) {
        throw new BridgeError(422, "The catalogue does not confirm that reasoning effort. Refresh the model list.");
      }
      if (target.source === "claude" && chosenEffort
        && !(model.supportedReasoningEfforts?.length ? model.supportedReasoningEfforts : CLAUDE_EFFORTS).includes(chosenEffort)) {
        throw new BridgeError(422, "Claude does not list that effort for this model. Refresh the model list.");
      }
      let claudeEffort: string | undefined;
      const before = await this.hooks.paneLines(target, false);
      // Preserve a person's draft and any pre-existing menu. Never clear it.
      assertComposerReady(before, "switch models");
      await validate(true);
      opened = true;
      this.hooks.menuOpened(target, "/model");
      if (target.source === "claude") typed = `/model ${id}`;
      await terminalProvider().prompt(target.server, target.pane, target.source === "codex" ? "/model" : `/model ${id}`);
      if (target.source === "codex") {
        let menu = await waitFor(text => {
          const choice = visibleTerminalChoice(text);
          return choice && /\b(?:select|choose) model\b/i.test(choice.title ?? "") ? choice : undefined;
        }, "the Codex model menu");
        const allModels = menu.options.filter(option => cleanLabel(option.label) === "all models");
        if (!menu.options.some(option => cleanLabel(option.label) === model.name.toLowerCase()) && allModels.length === 1) {
          // Codex 0.155 can put quick auto modes before its full catalogue.
          await this.hooks.moveDialogHighlight(target, menu, allModels[0].key, async () => { await validate(); });
          await keys(["enter"]);
          const previous = JSON.stringify(menu.options);
          menu = await waitFor(text => {
            const choice = visibleTerminalChoice(text);
            return choice && /\b(?:select|choose) model\b/i.test(choice.title ?? "")
              && JSON.stringify(choice.options) !== previous ? choice : undefined;
          }, "Codex's full model menu");
        }
        const rows = menu.options.filter(option => cleanLabel(option.label) === model.name.toLowerCase());
        if (rows.length !== 1) throw new BridgeError(409, "The chosen model row is missing or ambiguous in Codex's menu. Refresh the model list.");
        await this.hooks.moveDialogHighlight(target, menu, rows[0].key, async () => { await validate(); });
        await keys(["enter"]);
        const reasoning = await waitFor(text => {
          const choice = visibleTerminalChoice(text);
          return choice && /\breasoning (?:level|effort)\b/i.test(choice.title ?? "") ? choice : undefined;
        }, "the Codex reasoning effort menu");
        const options = reasoning.options.filter(option => effortLabel(option.label) === effort);
        if (options.length !== 1) throw new BridgeError(409, "The reasoning effort row is missing or ambiguous. Open terminal to check the model.");
        await this.hooks.moveDialogHighlight(target, reasoning, options[0].key, async () => { await validate(); });
        await keys(["enter"]);
        await waitFor(text => codexModelStatus(text, model) ? true : undefined, "the new model in Codex's status line", true);
      } else {
        const named = (value: string) => [model.name, model.id, id].some(name => {
          const result = value.toLowerCase(), lower = name.toLowerCase();
          return result === lower || result.startsWith(lower + " ") || result.startsWith(lower + " (");
        });
        let reply = await waitFor(text => claudeSwitchQuestion(text) ?? claudeModelReply(text, before), "Claude's model confirmation");
        if ("options" in reply) {
          // The picker already made this choice; Claude only warns that the
          // next reply re-reads the conversation for the new model.
          const yes = reply.options.find(option => /^yes, switch to\s/i.test(option.label))!;
          if (!named(yes.label.replace(/^yes, switch to\s+/i, ""))) throw new BridgeError(409, "Claude asked about a different model than the one chosen. Open terminal to check the model.");
          await this.hooks.moveDialogHighlight(target, reply, yes.key, async () => { await validate(); });
          await keys(["enter"]);
          reply = await waitFor(text => claudeSwitchQuestion(text) ? undefined : claudeModelReply(text, before), "Claude's model confirmation");
        }
        if ("options" in reply || "kept" in reply || !named(reply.set)) {
          throw new BridgeError(409, "kept" in reply ? `Claude kept ${reply.kept.slice(0, 80)}. Open terminal to check the model.`
            : "Could not verify Claude's model confirmation. Open terminal to check the model.");
        }
        typed = undefined;
        if (chosenEffort) {
          // `/effort` after the model, so the new model's own default never
          // replaces the chosen level.
          await validate(true);
          typed = `/effort ${chosenEffort}`;
          await terminalProvider().prompt(target.server, target.pane, typed);
          const reply = await waitFor(text => claudeEffortReply(text), "Claude's effort confirmation");
          typed = undefined;
          if ("error" in reply) throw new BridgeError(409, reply.error);
          claudeEffort = reply.effort;
        }
      }
      return { ok: true, model: model.id, name: model.name,
        ...(target.source === "codex" ? { effort } : claudeEffort ? { effort: claudeEffort } : {}) };
    } catch (error) {
      if (opened) {
        // Escape only the same, non-working pane. Never interrupt a new turn
        // or send cleanup input to a replacement session.
        try {
          for (let attempt = 0; attempt < 3; attempt++) {
            await keys(["escape"]);
            await new Promise(resolve => setTimeout(resolve, 150));
            const menu = visibleTerminalChoice(await this.hooks.paneLines(target));
            if (!menu || !/\b(?:(?:select|choose) model|reasoning (?:level|effort))\b/i.test(menu.title ?? "")) break;
          }
          // One Escape keeps a command that never submitted ("esc again to
          // clear"). The Hook typed it into an empty composer, so the Hook
          // removes it: left there, it refuses every later switch as unsent text.
          if (typed && unsentCommand(await this.hooks.paneLines(target), typed)) await keys(["ctrl+u"]);
        } catch { /* Identity or activity changed. Do not type further. */ }
      }
      throw error;
    } finally {
      this.hooks.menuClosed(target); this.hooks.clearTerminalPrompt(target);
      this.active.delete(this.key(target));
    }
  }
}
