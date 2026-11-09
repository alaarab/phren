import { claudeFooterMode } from "./claude-footer-mode.js";
import { dialogHasClosed } from "./dialog-observation.js";
import { joinDialogFooters } from "./terminal-dialog-text.js";
import { BridgeError } from "./protocol.js";

/** Claude Code's AskUserQuestion dialog as the pane draws it, and a walk that
 * answers it one verified key at a time. Claude's keys are not uniform: a
 * digit on a single-select question picks the row and moves to the next
 * question on its own, a digit on a multi-select question only toggles its
 * box, Tab leaves a multi-select question (or, from the typed "Other" row,
 * moves to its Next row), and a set of more than one question, or any
 * multi-select question, ends on a "Review your answers" tab that "1"
 * submits. Blind key sequences drift onto the wrong tab, so every step reads
 * the pane first and checks the result before the next. */

interface Row { number: number; label: string; checked?: boolean; answered: boolean; cursor: boolean; wrapped?: boolean }
export interface ClaudeQuestionScreen {
  kind: "question";
  /** Headers from the tab bar, without the trailing Submit tab. */
  tabs: string[];
  title: string;
  multiSelect: boolean;
  /** The asked options, in order; the typed "Other" row is `other`. */
  options: Row[];
  other?: Row;
  /** The row number under the cursor, or "next" on a multi-select Next/Submit row. */
  cursor?: number | "next";
}
export interface ClaudeReviewScreen { kind: "review"; tabs: string[]; answers: { question: string; answer: string; wrapped?: boolean }[] }
export type ClaudeDialogScreen = ClaudeQuestionScreen | ClaudeReviewScreen;

const TAB_BAR = /^\s*(?:←\s+)?((?:[☐☒]\s+\S[^☐☒✔→]*?\s*)+)(?:✔\s+Submit\s*)?(?:→\s*)?$/;
const ROW = /^\s*(❯)?\s*(\d)\.\s+(?:\[([ ✔])\]\s+)?(.*?)\s*$/;
const NEXT = /^\s*(❯)?\s+(?:Next|Submit)\s*$/;
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
/** Claude cuts a question at 2000 characters with "…" while the phone may send
 * more, so the pane's title matches when it is the question's own head. */
export const sameTitle = (shown: string, asked: string) => {
  const want = normalize(asked);
  if (shown === want) return true;
  return shown.endsWith("…") && shown.length > 200 && want.startsWith(shown.slice(0, -1).trimEnd());
};
/** Claude Code (2.1.284) draws a question that has a line break or is wider
 * than 80 columns inside a dimmed left border, "│ " before each line, on its
 * tab and in the review. The border is not part of the question. */
const GUTTER = /^(\s*)│(?: |$)/;

/** The question dialog the pane is drawing now, or undefined when the last
 * lines are not one: the last tab bar anchors it, and an active dialog ends
 * with its "Esc to cancel" footer or the review's Submit/Cancel rows. */
export function claudeQuestionDialog(text: string): ClaudeDialogScreen | undefined {
  const lines = joinDialogFooters(text.split(/\r?\n/));
  let bar = -1, barEnd = -1, tabBar = "";
  // A narrow pane soft-wraps the tab bar. Reading only its last physical
  // row either loses tabs (a false set mismatch) or misses the dialog when
  // that row contains only Submit. Keep the complete last bar and start
  // the body after all of its physical rows.
  for (let end = lines.length - 1; end >= 0 && bar < 0; end--) {
    let candidates: string[] = [];
    for (let start = end; start >= 0; start--) {
      const line = lines[start];
      if (!line.trim() || /^─+$/.test(line.trim())) break;
      // Terminal cell counts cannot reliably recover a wrap boundary (emoji
      // sequences vary by terminal), and a capture drops the space a row
      // wrapped after. Keep both joins of each wrap, no space first, while
      // they still end in the Submit suffix; a complete bar wins over one
      // that only has the suffix.
      const joins = candidates.length ? candidates.flatMap(value => [line + value, line + " " + value]) : [line];
      const viable = joins.filter(value => TAB_BAR.test(value) || /✔\s+Submit\s*(?:→\s*)?$/.test(value));
      candidates = (viable.length ? viable : joins.slice(0, 1)).slice(0, 16);
      const complete = candidates.find(value => TAB_BAR.test(value) && /[☐☒]/.test(value));
      if (complete) {
        bar = start; barEnd = end; tabBar = complete;
      }
      // The leading arrow is the start of this bar. A checkbox in earlier
      // output belongs to that output, even when there is no blank row.
      if (/^\s*←/.test(line)) break;
    }
  }
  if (bar < 0) return undefined;
  const tabs = [...tabBar.matchAll(/[☐☒]\s+([^☐☒✔→]+?)(?=\s{2,}|\s*[☐☒✔→]|\s*$)/g)].map(match => match[1].trim());
  const body = lines.slice(barEnd + 1);
  const tail = body.map(line => line.trim()).filter(line => line && !/^─+$/.test(line));
  if (!/^(?:Enter to .*Esc to cancel|2\. Cancel)$/.test(tail.at(-1) ?? "")) return undefined;
  if (lines.slice(0, bar).filter(line => /^\s*```/.test(line)).length % 2) return undefined;
  if (body.filter(line => ROW.exec(line)?.[1] || NEXT.exec(line)?.[1]).length !== 1) return undefined;
  const content = body.map(line => line.replace(GUTTER, "$1").trim()).filter(line => line && !/^─+$/.test(line));
  if (content[0] === "Review your answers") {
    if (!body.some(line => /^\s*❯?\s*1\.\s+Submit answers\s*$/.test(line))) return undefined;
    const answers: { question: string; answer: string; wrapped?: boolean }[] = [];
    for (const line of content.slice(1)) {
      if (/^Ready to submit/.test(line)) break;
      const question = /^●\s+(.+)$/.exec(line), answer = /^→\s+(.+)$/.exec(line), last = answers[answers.length - 1];
      if (question) answers.push({ question: question[1], answer: "" });
      else if (answer && last) last.answer = answer[1];
      // A long question or answer wraps onto the next line.
      else if (last) { if (last.answer) { last.answer += " " + line; last.wrapped = true; } else last.question += " " + line; }
    }
    return { kind: "review", tabs, answers };
  }
  if (!content.some(line => /Esc to cancel/.test(line))) return undefined;
  const first = body.findIndex(line => ROW.test(line));
  if (first < 0) return undefined;
  const title = normalize(body.slice(0, first).map(line => line.replace(GUTTER, "$1")).filter(line => line.trim()).join(" "));
  const rows: Row[] = [];
  let cursor: number | "next" | undefined, chat = false;
  for (const line of body.slice(first)) {
    const next = NEXT.exec(line);
    if (next) { if (next[1]) cursor = "next"; continue; }
    const match = ROW.exec(line);
    if (!match) continue;
    const number = Number(match[2]);
    if (match[1]) cursor = number;
    if (/^Chat about this$/.test(match[4])) { chat = true; continue; }
    const answered = !match[3] && / ✔$/.test(match[4]);
    rows.push({ number, label: answered ? match[4].slice(0, -2).trim() : match[4], answered, cursor: !!match[1],
      ...(match[3] ? { checked: match[3] === "✔" } : {}) });
  }
  if (!title || !chat || cursor === undefined || rows.length < 2) return undefined;
  // The last row above "Chat about this" is the typed answer ("Type
  // something." until something is typed there).
  const other = rows.pop()!;
  const otherLine = body.findIndex(line => Number(ROW.exec(line)?.[2]) === other.number);
  for (const line of body.slice(otherLine + 1)) {
    if (NEXT.test(line) || ROW.test(line) || /^─+$/.test(line.trim())) break;
    if (line.trim()) other.wrapped = true;
  }
  return { kind: "question", tabs, title, multiSelect: rows.some(row => row.checked !== undefined), options: rows, other, ...(cursor !== undefined ? { cursor } : {}) };
}

export interface DialogQuestion { question: string; multiSelect?: boolean; options: { label: string }[] }
/** Option indexes into the question's options, plus a typed "Other" answer. */
export interface DialogAnswer { options: number[]; text?: string }
export interface DialogIO {
  read(): Promise<string>;
  keys(keys: string[]): Promise<void>;
  sleep?(ms: number): Promise<void>;
}

/** A 409 that says whether any key reached the terminal: `question-not-shown`
 * (nothing typed, retrying is safe) or `question-unconfirmed` (keys were sent,
 * so look at the terminal before answering again). */
const refusal = (message: string, sent: boolean) => sent
  ? new BridgeError(409, `${message} Some keys were already sent, so check the terminal before answering again, or cancel the question.`, { code: "question-unconfirmed" })
  : new BridgeError(409, `${message} Nothing was sent; check the question and answer again, or cancel it.`, { code: "question-not-shown" });
/** A typed answer, one key per character; herdr names the space bar. */
const typedKeys = (text: string) => [...text].map(character => character === " " ? "space" : character);

/** Answer `answers[i]` for question `from + i`, then submit the set when
 * `submit` is true. Each step is checked against a fresh read of the pane. */
export async function answerClaudeQuestionDialog(io: DialogIO, questions: DialogQuestion[], answers: DialogAnswer[], options: { from?: number; submit?: boolean } = {}): Promise<void> {
  const from = options.from ?? 0, submit = options.submit ?? true;
  let sent = false;
  const changed = (message: string) => refusal(message, sent);
  if (submit && (from !== 0 || answers.length !== questions.length)) {
    throw changed("Cannot verify the full review from a partial answer set; send all answers together or finish in the terminal.");
  }
  const realKeys = io.keys.bind(io);
  io = { ...io, keys: async keys => { sent = true; await realKeys(keys); } };
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const matches = (screen: ClaudeDialogScreen | undefined, index: number): screen is ClaudeQuestionScreen =>
    screen?.kind === "question" && sameTitle(screen.title, questions[index].question);
  // Claude redraws a moment after a key; poll until the expected screen shows.
  const settle = async <T>(check: (screen: ClaudeDialogScreen | undefined, closed: boolean) => T | undefined, ms = 2_000): Promise<T | undefined> => {
    for (let waited = 0; ; waited += 120) {
      const text = await io.read(), screen = claudeQuestionDialog(text);
      // A bare cursor can itself be a partial question redraw. Closure must
      // also have Claude's live footer or working hint, after the dialog cues.
      const closed = !screen && dialogHasClosed(text)
        && (claudeFooterMode(text) !== undefined || /\besc to interrupt\b/i.test(text));
      const value = check(screen, closed);
      if (value !== undefined || waited >= ms) return value;
      await sleep(120);
    }
  };
  // After a key that answers, Claude may take seconds to redraw on a busy
  // computer; the answer was taken, so wait for the redraw instead of
  // calling it refused (the phone would say it was not confirmed).
  const ANSWERED_MS = 8_000;
  const initial = await settle(screen => screen);
  if (!initial) throw changed("The terminal is not showing Claude's question.");
  // A set of several questions draws one tab per question; a single question
  // draws its own header. The tabs must be this set's, in this order.
  if (initial.tabs.length !== questions.length) throw changed("The terminal is asking a different set of questions.");

  const moveCursor = async (index: number, screen: ClaudeQuestionScreen, to: number | "next") => {
    const position = (value: number | "next" | undefined) => value === "next" ? screen.other!.number + 1 : value;
    while (screen.cursor !== to) {
      const at = position(screen.cursor), target = position(to);
      if (at === undefined || target === undefined) throw changed("Could not locate the terminal cursor.");
      const next = at + (target > at ? 1 : -1);
      const expected = next === screen.other!.number + 1 ? "next" : next;
      await io.keys([target > at ? "down" : "up"]);
      const moved = await settle(value => matches(value, index) && value.cursor === expected ? value : undefined);
      if (!moved) throw changed("Could not move and verify the terminal cursor.");
      screen = moved;
    }
    return screen;
  };
  const commandCursor = async (index: number, screen: ClaudeQuestionScreen) => {
    if (screen.other && screen.cursor === screen.other.number) screen = await moveCursor(index, screen, screen.other.number - 1);
    if (!screen.options.some(row => row.number === screen.cursor) && !(screen.multiSelect && screen.cursor === "next")) {
      throw changed("The terminal cursor is not on an option or Next row.");
    }
    return screen;
  };
  const enterText = async (index: number, screen: ClaudeQuestionScreen, text: string) => {
    screen = await moveCursor(index, screen, screen.other!.number);
    const existing = screen.other!.label;
    if (screen.other!.wrapped) throw changed("The existing typed answer is wrapped and cannot be verified; edit it in the terminal.");
    const placeholder = existing === (screen.multiSelect ? "Type something" : "Type something.");
    // The terminal capture cannot prove an editor shortcut cleared a field,
    // or distinguish a literal placeholder answer from an empty field. Refuse
    // those cases rather than append to a draft or submit an empty answer.
    if ((placeholder && text === existing) || (!placeholder && existing !== text)) {
      throw changed("The existing typed answer differs from the phone's answer or cannot be verified; clear it in the terminal first.");
    }
    if (placeholder) {
      // Claude's numeric shortcuts can still select a row in an empty Other
      // field. Until text owns the input, a leading digit is unsafe.
      if (/^[0-9]/.test(text)) throw changed("A typed answer starting with a digit cannot be entered safely; answer it in the terminal.");
      await io.keys(typedKeys(text));
    }
    const shown = await settle(value => matches(value, index) && value.cursor === screen.other!.number
      && !value.other?.wrapped && value.other?.label === text && (!screen.multiSelect || value.other.checked) ? value : undefined);
    if (!shown) throw changed("The full typed answer did not appear exactly in the terminal.");
    return shown;
  };
  const reach = async (index: number): Promise<ClaudeQuestionScreen> => {
    const screen = await settle(value => value);
    if (screen?.kind === "question" && sameTitle(screen.title, questions[index].question)) return screen;
    const at = screen?.kind === "review" ? questions.length
      : screen?.kind === "question" ? questions.findIndex(question => sameTitle(screen.title, question.question)) : -1;
    if (at < 0) throw changed("The terminal is showing a different question.");
    // Arrow keys would edit a typed answer; step off that row first.
    if (screen?.kind === "question") await commandCursor(at, screen);
    await io.keys(Array<string>(Math.abs(index - at)).fill(index > at ? "right" : "left"));
    const moved = await settle(value => matches(value, index) ? value : undefined);
    if (!moved) throw changed("Could not move the terminal to the question being answered.");
    return moved;
  };
  const leaves = (index: number, mayClose: boolean) => (value: ClaudeDialogScreen | undefined, closed: boolean) => {
    if (mayClose && closed) return "gone";
    if (index + 1 < questions.length && matches(value, index + 1)) return "moved";
    if (index + 1 === questions.length && value?.kind === "review") return "moved";
    return undefined;
  };

  for (const [offset, answer] of answers.entries()) {
    const index = from + offset, question = questions[index];
    if (!question) throw new BridgeError(400, "The answer names a question that was not asked.");
    const typed = answer.text?.trim() ?? "";
    let screen: ClaudeQuestionScreen = await reach(index);
    if (screen.multiSelect !== !!question.multiSelect || screen.options.length !== question.options.length
      || screen.options.some((row, position) => row.label !== normalize(question.options[position].label))) {
      throw changed("The terminal's options differ from the question being answered.");
    }
    if (!screen.multiSelect) {
      if (typed) {
        await enterText(index, screen, typed);
        await io.keys(["enter"]);
      } else {
        screen = await commandCursor(index, screen);
        await io.keys([String(screen.options[answer.options[0]].number)]);
      }
      if (!await settle(leaves(index, questions.length === 1), ANSWERED_MS)) throw changed("The terminal did not confirm taking the answer.");
      continue;
    }
    screen = await commandCursor(index, screen);
    // Multi-select: toggle only the boxes that differ, one key per write
    // (Ink reads "13" in one write as a single input and toggles nothing),
    // and check each box before the next.
    const rows = [...screen.options, ...(screen.other ? [screen.other] : [])];
    for (const [position, row] of rows.entries()) {
      const wanted = position < screen.options.length ? answer.options.includes(position) : !!typed && row.label === typed;
      if (wanted === !!row.checked) continue;
      const box = (value: ClaudeDialogScreen | undefined) => matches(value, index)
        ? !!(position < value.options.length ? value.options[position] : value.other)?.checked : undefined;
      screen = await commandCursor(index, screen);
      await io.keys([String(row.number)]);
      const toggled = await settle(value => box(value) === wanted ? value as ClaudeQuestionScreen : undefined);
      if (!toggled) throw changed("The terminal's checkboxes did not match the answer.");
      screen = toggled;
    }
    if (typed) {
      screen = await enterText(index, screen, typed);
      // Tab moves from the typed row to Next; Enter there leaves the question.
      await io.keys(["tab"]);
      if (!await settle(value => matches(value, index) && value.cursor === "next" ? value : undefined)) throw changed("Could not reach the question's Next row.");
      await io.keys(["enter"]);
    } else {
      // Tab from the typed row would stop on Next instead of leaving.
      screen = await commandCursor(index, screen);
      await io.keys(["tab"]);
    }
    if (!await settle(leaves(index, false), ANSWERED_MS)) throw changed("The terminal did not move past the question.");
  }
  if (!submit) return;
  const review = await settle((value, closed) => value?.kind === "review" ? value
    : questions.length === 1 && !questions[0].multiSelect && closed ? "gone" as const : undefined, ANSWERED_MS);
  // A lone single-select question submits on its digit.
  if (review === "gone") return;
  if (!review) throw changed("The terminal did not reach the review of the answers.");
  if (review.answers.length !== questions.length || review.answers.some((row, position) => !sameTitle(normalize(row.question), questions[position].question) || !row.answer)) {
    throw changed("The terminal's review does not contain every expected question and answer.");
  }
  for (const [offset, answer] of answers.entries()) {
    const index = from + offset, question = questions[index], text = answer.text?.trim() ?? "";
    const labels = question.options.filter((_, position) => answer.options.includes(position)).map(option => normalize(option.label));
    const expected = question.multiSelect ? [...labels, ...(text ? [text] : [])].join(", ") : text || labels[0];
    if (review.answers[index]?.wrapped || review.answers[index]?.answer !== expected) throw changed("The terminal's review does not exactly match the phone's answers.");
  }
  await io.keys(["1"]);
  if (await settle((_value, closed) => closed ? "gone" : undefined, ANSWERED_MS) !== "gone") throw changed("The terminal did not submit the answers.");
}
