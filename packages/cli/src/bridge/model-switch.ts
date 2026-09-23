import { z } from "zod";
import { AgentHooks, visibleTerminalChoice } from "./agent-hooks.js";
import { rpc, validateTarget } from "./herdr.js";
import { ModelCatalog, type AgentModel } from "./models.js";
import { BridgeError, type Json, type Target } from "./protocol.js";
import { stripTerminal } from "../terminal-text.js";

export const MODEL_BUSY = "This agent is working. The model switch can happen when the turn ends. Choose Switch after this turn.";

/** Busy slash commands must never enter the harness's text queue. */
export function refuseWorkingSlash(pane: Json, text: string): void {
  if (pane.agent_status === "working" && /^\s*\//.test(text)) throw new BridgeError(409, MODEL_BUSY);
}

const request = z.object({ model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._\[\]:/-]{0,99}$/),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional() });
const cleanLabel = (label: string) => label.replace(/\s*\((?:current|default|recommended)\)/gi, "").trim().toLowerCase();
const effortLabel = (label: string) => cleanLabel(label).replace(/^extra\s+high$/, "xhigh");

/** Empty prompts can draw a dim placeholder. Only ANSI evidence that every
 * character after the prompt is dim distinguishes that from a person's draft. */
function emptyComposer(line: string): boolean {
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
      await rpc(target.server, "agent.send_keys", { target: target.pane, keys: values });
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
      if (target.source === "claude" && chosenEffort) throw new BridgeError(422, "Choose Claude's reasoning effort in its terminal.");
      const before = await this.hooks.paneLines(target, false);
      // Preserve a person's draft and any pre-existing menu. Never clear it.
      const composer = before.split(/\r?\n/).reverse().find(line => /^\s*[›❯>]/.test(stripTerminal(line)));
      if (!composer || !emptyComposer(composer) || visibleTerminalChoice(stripTerminal(before))) {
        throw new BridgeError(409, "The terminal has a draft or an unreadable prompt. Open terminal before switching models.");
      }
      await validate(true);
      opened = true;
      this.hooks.menuOpened(target, "/model");
      await rpc(target.server, "agent.prompt", { target: target.pane, text: target.source === "codex" ? "/model" : `/model ${id}` });
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
        await waitFor(text => text !== stripTerminal(before) && text.split(/\r?\n/).some(line => {
          const output = line.trim().replace(/^[⏺●]\s*/, "");
          return output.toLowerCase().startsWith("set model to ") && [model.name, model.id, id].some(name => {
            const result = output.slice("Set model to ".length).toLowerCase();
            return result === name.toLowerCase() || result.startsWith(name.toLowerCase() + " ") || result.startsWith(name.toLowerCase() + " (");
          });
        }) ? true : undefined, "Claude's model confirmation");
      }
      return { ok: true, model: model.id, name: model.name, ...(target.source === "codex" ? { effort } : {}) };
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
        } catch { /* Identity or activity changed. Do not type further. */ }
      }
      throw error;
    } finally {
      this.hooks.menuClosed(target); this.hooks.clearTerminalPrompt(target);
      this.active.delete(this.key(target));
    }
  }
}
