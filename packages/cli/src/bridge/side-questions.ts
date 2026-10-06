import { randomUUID } from "node:crypto";
import { validateTarget } from "./herdr.js";
import { terminalProvider } from "./terminal.js";
import { readPaneText } from "./pane-text.js";
import { BridgeError, type Json, type Target } from "./protocol.js";

/** Claude Code's `/btw` side questions from the phone.
 *
 * `/btw <question>` asks a quick question while Claude keeps working. Claude
 * 2.1.280 draws the answer in a panel under the conversation and writes
 * nothing to the session JSONL, so the Hook reads the settled panel from the
 * pane, scrolls it for a long answer, closes it with Escape and hands the text
 * to the phone as a `side-answer` frame. Nothing of it enters the transcript. */

export type SideState = "pending" | "answer" | "error" | "cancelled";

export interface SideAnswer {
  id: string;
  question: string;
  state: SideState;
  answer?: string;
}

interface SideRecord extends SideAnswer {
  target: Target;
  revision: number;
  settledAt?: number;
  cancel?: boolean;
}

/** The panel as the pane draws it: the asked questions (this session's
 * history, newest last and cut to the pane's width), the body lines, and
 * whether Claude is still answering. */
export interface SidePanel {
  questions: string[];
  body: string[];
  answering: boolean;
  settled: boolean;
}

const MAX_QUESTION = 4_000;
const MAX_ANSWER = 65_536;

/** The question in a `/btw ` prompt for Claude, or undefined for any other text. */
export function sideQuestionText(source: string, text: string): string | undefined {
  const match = /^\s*\/btw\s+(\S[\s\S]*)$/i.exec(text);
  if (source !== "claude" || !match) return undefined;
  // One terminal line: a newline would submit the command early.
  return match[1].replace(/\s+/g, " ").trim();
}

/** Parse the `/btw` panel out of visible pane text, or undefined when none is open. */
export function sidePanel(text: string): SidePanel | undefined {
  const lines = text.replace(/\r/g, "").split("\n");
  let close = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (/\bEsc to close\s*$/.test(lines[index])) { close = index; break; }
    if (lines[index].trim()) return undefined;
  }
  if (close < 0) return undefined;
  // The footer can wrap: "⇧←/→ to browse · c to copy · f to fork ·" then
  // "x to clear history · Esc to close" on a narrow pane.
  let footerStart = close;
  while (footerStart > 0 && lines[footerStart - 1].trim()) footerStart--;
  const footer = lines.slice(footerStart, close + 1).join(" ");
  // The panel's top edge is a run of ▔, which may carry the effort label.
  let top = -1;
  for (let index = footerStart - 1; index >= 0; index--) if (/^▔{3,}/.test(lines[index].trimStart())) { top = index; break; }
  if (top < 0) return undefined;
  let index = top + 1;
  while (index < footerStart && !lines[index].trim()) index++;
  const questions: string[] = [];
  while (index < footerStart && /^\s+\/btw\s/.test(lines[index])) questions.push(lines[index++].trim().replace(/^\/btw\s+/, ""));
  if (!questions.length) return undefined;
  const body = lines.slice(index, footerStart);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body.at(-1)!.trim()) body.pop();
  const answering = body.length === 1 && /^\s*\S\s+Answering…\s*$/.test(body[0]);
  return { questions, body: answering ? [] : body, answering, settled: !answering && /\bc to copy\b/.test(footer) };
}

/** Whether the newest question in the panel is the one the Hook asked: the
 * panel cuts a long question to the pane's width with an ellipsis. */
export function panelAsks(panel: SidePanel, question: string): boolean {
  const shown = panel.questions.at(-1) ?? "";
  if (shown.endsWith("…")) return question.startsWith(shown.slice(0, -1).trimEnd());
  return shown === question;
}

/** The lines `next` adds below `previous` after the panel scrolled, or
 * undefined when it did not move. Without an overlap the whole window is new. */
export function scrolledLines(previous: string[], next: string[]): string[] | undefined {
  if (previous.length === next.length && previous.every((line, index) => line === next[index])) return undefined;
  for (let shift = 1; shift < previous.length; shift++) {
    const kept = previous.length - shift;
    if (next.length < kept) continue;
    let same = true;
    for (let index = 0; index < kept && same; index++) same = previous[shift + index] === next[index];
    if (same) return next.slice(kept);
  }
  return next;
}

/** Remove the panel's indentation and the wrap-trailing spaces. */
export function answerText(lines: string[]): string {
  const indent = Math.min(...lines.filter(line => line.trim()).map(line => line.length - line.trimStart().length));
  const text = lines.map(line => line.slice(Number.isFinite(indent) ? indent : 0).trimEnd()).join("\n").trim();
  return text.length > MAX_ANSWER ? text.slice(0, MAX_ANSWER) + "…" : text;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class SideQuestions {
  private records = new Map<string, SideRecord>();
  private open = new Map<string, string>();
  constructor(private readonly options: { timeoutMs?: number; intervalMs?: number; openMs?: number; keepMs?: number } = {}) {}

  private paneKey(target: Target) { return `${target.server}\0${target.pane}`; }
  private read(target: Target) {
    return readPaneText(target.server, target.pane, { scope: "agent", source: "visible", lines: 80, timeoutMs: 2_000 });
  }

  /** While a side question owns the pane, typed input would land in its panel
   * (`x` clears the history, `f` forks), so every other input waits. */
  assertAvailable(target: Target): void {
    if (this.open.has(this.paneKey(target))) throw new BridgeError(409, "A side question is open in this terminal. Wait for its answer or dismiss it.");
  }

  /** The side answers the phone has not dismissed for this conversation. */
  list(target: Target): (SideAnswer & { revision: number })[] {
    this.prune();
    return [...this.records.values()].filter(record => record.target.server === target.server && record.target.pane === target.pane
      && record.target.session === target.session)
      .map(({ id, question, state, answer, revision }) => ({ id, question, state, ...(answer !== undefined ? { answer } : {}), revision }));
  }

  private prune() {
    const keep = this.options.keepMs ?? 30 * 60_000, now = Date.now();
    for (const [id, record] of this.records) if (record.settledAt && now - record.settledAt > keep) this.records.delete(id);
    while (this.records.size > 32) this.records.delete(this.records.keys().next().value!);
  }

  /** Type `/btw <question>` into the Claude pane and watch for its answer.
   * Returns at once; the answer arrives on the transcript stream. */
  async ask(target: Target, pane: Json, text: string): Promise<{ id: string }> {
    const question = sideQuestionText(target.source, text);
    if (!question) throw new BridgeError(422, "Side questions are for Claude Code: /btw followed by the question.");
    if (question.length > MAX_QUESTION) throw new BridgeError(413, "The side question is too long.");
    this.assertAvailable(target);
    const key = this.paneKey(target), id = randomUUID();
    this.open.set(key, id);
    try {
      // A panel the person opened in the terminal takes keys, not a prompt.
      if (sidePanel(await this.read(target))) throw new BridgeError(409, "The terminal already shows a side question. Close it there first.");
      await terminalProvider().prompt(target.server, target.pane, `/btw ${question}`);
    } catch (error) { this.open.delete(key); throw error; }
    const record: SideRecord = { id, question, state: "pending", target, revision: 1 };
    this.records.set(id, record);
    this.prune();
    void this.watch(record, String(pane.terminal_id ?? "")).finally(() => { if (this.open.get(key) === id) this.open.delete(key); });
    return { id };
  }

  /** The phone dismissed the card: cancel a pending question (closing its
   * panel) and stop delivering it. */
  dismiss(target: Target, id: string): { ok: true } {
    const record = this.records.get(id);
    if (!record || record.target.server !== target.server || record.target.pane !== target.pane || record.target.session !== target.session) {
      throw new BridgeError(404, "That side question is no longer open.");
    }
    if (record.state === "pending") record.cancel = true;
    else this.records.delete(id);
    return { ok: true };
  }

  private settle(record: SideRecord, state: SideState, answer?: string) {
    record.state = state; record.revision++; record.settledAt = Date.now();
    if (answer !== undefined) record.answer = answer;
    if (record.cancel) this.records.delete(record.id);
  }

  /** Close the panel only while it is still drawn: Escape anywhere else
   * would interrupt Claude's running turn. */
  private async close(target: Target): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!sidePanel(await this.read(target))) return;
      await terminalProvider().sendKeys(target.server, target.pane, ["esc"]);
      await sleep(Math.min(this.options.intervalMs ?? 700, 300));
    }
  }

  /** Scroll a long answer to its end, stitching the windows by their overlap. */
  private async collect(target: Target, first: SidePanel): Promise<string> {
    const lines = [...first.body];
    let window = first.body, perKey = 0, size = lines.join("\n").length;
    for (let step = 0; step < 200 && size < MAX_ANSWER; step++) {
      const presses = perKey > 0 ? Math.max(1, Math.floor((window.length - 2) / perKey)) : 1;
      await terminalProvider().sendKeys(target.server, target.pane, Array(presses).fill("down"));
      await sleep(Math.min(this.options.intervalMs ?? 700, 150));
      const panel = sidePanel(await this.read(target));
      if (!panel || panel.answering) break;
      const added = scrolledLines(window, panel.body);
      if (added === undefined) break;
      if (!perKey && added.length) perKey = added.length;
      lines.push(...added); size += added.join("\n").length;
      window = panel.body;
    }
    return answerText(lines);
  }

  private async watch(record: SideRecord, terminal: string): Promise<void> {
    const { target } = record, started = Date.now();
    const timeout = this.options.timeoutMs ?? 90_000, openWithin = this.options.openMs ?? 10_000;
    let opened = false, previous: string | undefined;
    try {
      for (;;) {
        await sleep(this.options.intervalMs ?? 700);
        const pane = await validateTarget(target, false, false).catch(() => undefined);
        if (!pane || (terminal && pane.terminal_id !== terminal)) return this.settle(record, "error", "The conversation in this pane changed.");
        const panel = sidePanel(await this.read(target));
        if (record.cancel) { if (panel) await this.close(target); return this.settle(record, "cancelled"); }
        if (!panel || !panelAsks(panel, record.question)) {
          // Closed in the terminal after it opened: the person dismissed it there.
          if (opened) return this.settle(record, "cancelled");
          if (Date.now() - started > openWithin) return this.settle(record, "error", "Claude did not open the side question.");
          continue;
        }
        opened = true;
        if (!panel.answering) {
          // A settled panel offers copy; without that hint, wait for the
          // same body twice so a still-drawing answer is not cut short.
          const body = panel.body.join("\n");
          if (panel.settled || body === previous) {
            const answer = await this.collect(target, panel);
            await this.close(target);
            return this.settle(record, "answer", answer);
          }
          previous = body;
        }
        if (Date.now() - started > timeout) {
          await this.close(target);
          return this.settle(record, "error", `No answer after ${Math.round(timeout / 1000)} seconds.`);
        }
      }
    } catch {
      this.settle(record, "error", "The side question could not be read from the terminal.");
    }
  }
}
