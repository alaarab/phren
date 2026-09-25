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

interface Row { number: number; label: string; checked?: boolean; answered: boolean; cursor: boolean }
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
export interface ClaudeReviewScreen { kind: "review"; tabs: string[]; answers: { question: string; answer: string }[] }
export type ClaudeDialogScreen = ClaudeQuestionScreen | ClaudeReviewScreen;

const TAB_BAR = /^\s*(?:←\s+)?((?:[☐☒]\s+\S[^☐☒✔→]*?\s*)+)(?:✔\s+Submit\s*)?(?:→\s*)?$/;
const ROW = /^\s*(❯)?\s*(\d)\.\s+(?:\[([ ✔])\]\s+)?(.*?)\s*$/;
const NEXT = /^\s*(❯)?\s+(?:Next|Submit)\s*$/;
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** The question dialog the pane is drawing now, or undefined when the last
 * lines are not one: the last tab bar anchors it, and an active dialog ends
 * with its "Esc to cancel" footer or the review's Submit/Cancel rows. */
export function claudeQuestionDialog(text: string): ClaudeDialogScreen | undefined {
  const lines = text.split(/\r?\n/);
  let bar = -1;
  for (let index = lines.length - 1; index >= 0; index--) if (TAB_BAR.test(lines[index]) && /[☐☒]/.test(lines[index])) { bar = index; break; }
  if (bar < 0) return undefined;
  const tabs = [...lines[bar].matchAll(/[☐☒]\s+([^☐☒✔→]+?)(?=\s{2,}|\s*[☐☒✔→]|\s*$)/g)].map(match => match[1].trim());
  const body = lines.slice(bar + 1);
  const content = body.map(line => line.trim()).filter(line => line && !/^─+$/.test(line));
  if (content[0] === "Review your answers") {
    if (!body.some(line => /^\s*❯?\s*1\.\s+Submit answers\s*$/.test(line))) return undefined;
    const answers: { question: string; answer: string }[] = [];
    for (const line of content.slice(1)) {
      if (/^Ready to submit/.test(line)) break;
      const question = /^●\s+(.+)$/.exec(line), answer = /^→\s+(.+)$/.exec(line), last = answers[answers.length - 1];
      if (question) answers.push({ question: question[1], answer: "" });
      else if (answer && last) last.answer = answer[1];
      // A long question or answer wraps onto the next line.
      else if (last) { if (last.answer) last.answer += " " + line; else last.question += " " + line; }
    }
    return { kind: "review", tabs, answers };
  }
  if (!content.some(line => /Esc to cancel/.test(line))) return undefined;
  const first = body.findIndex(line => ROW.test(line));
  if (first < 0) return undefined;
  const title = normalize(body.slice(0, first).filter(line => line.trim()).join(" "));
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
  if (!title || !chat || rows.length < 2) return undefined;
  // The last row above "Chat about this" is the typed answer ("Type
  // something." until something is typed there).
  const other = rows.pop()!;
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

const changed = (message: string) => new BridgeError(409, `${message} Nothing else was sent; check the question and answer again, or cancel it.`);
/** A typed answer, one key per character; herdr names the space bar. */
const typedKeys = (text: string) => [...text].map(character => character === " " ? "space" : character);

/** Answer `answers[i]` for question `from + i`, then submit the set when
 * `submit` is true. Each step is checked against a fresh read of the pane. */
export async function answerClaudeQuestionDialog(io: DialogIO, questions: DialogQuestion[], answers: DialogAnswer[], options: { from?: number; submit?: boolean } = {}): Promise<void> {
  const from = options.from ?? 0, submit = options.submit ?? true;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const matches = (screen: ClaudeDialogScreen | undefined, index: number): screen is ClaudeQuestionScreen =>
    screen?.kind === "question" && screen.title === normalize(questions[index].question);
  // Claude redraws a moment after a key; poll until the expected screen shows.
  const settle = async <T>(check: (screen: ClaudeDialogScreen | undefined) => T | undefined, ms = 2_000): Promise<T | undefined> => {
    for (let waited = 0; ; waited += 120) {
      const value = check(claudeQuestionDialog(await io.read()));
      if (value !== undefined || waited >= ms) return value;
      await sleep(120);
    }
  };
  const initial = await settle(screen => screen);
  if (!initial) throw changed("The terminal is not showing Claude's question.");
  // A set of several questions draws one tab per question; a single question
  // draws its own header. The tabs must be this set's, in this order.
  if (initial.tabs.length !== questions.length) throw changed("The terminal is asking a different set of questions.");

  const reach = async (index: number): Promise<ClaudeQuestionScreen> => {
    const screen = await settle(value => value);
    if (screen?.kind === "question" && screen.title === normalize(questions[index].question)) return screen;
    const at = screen?.kind === "review" ? questions.length
      : screen?.kind === "question" ? questions.findIndex(question => normalize(question.question) === screen.title) : -1;
    if (at < 0) throw changed("The terminal is showing a different question.");
    // Arrow keys would edit a typed answer; step off that row first.
    if (screen?.kind === "question" && screen.other && screen.cursor === screen.other.number) await io.keys(["up"]);
    await io.keys(Array<string>(Math.abs(index - at)).fill(index > at ? "right" : "left"));
    const moved = await settle(value => matches(value, index) ? value : undefined);
    if (!moved) throw changed("Could not move the terminal to the question being answered.");
    return moved;
  };
  const leaves = (index: number) => (value: ClaudeDialogScreen | undefined) =>
    value === undefined ? "gone" : !matches(value, index) ? "moved" : undefined;

  for (const [offset, answer] of answers.entries()) {
    const index = from + offset, question = questions[index];
    if (!question) throw new BridgeError(400, "The answer names a question that was not asked.");
    const typed = answer.text?.trim() ?? "";
    let screen: ClaudeQuestionScreen = await reach(index);
    if (screen.multiSelect !== !!question.multiSelect || screen.options.length !== question.options.length
      || screen.options.some((row, position) => row.label !== question.options[position].label.trim())) {
      throw changed("The terminal's options differ from the question being answered.");
    }
    if (!screen.multiSelect) {
      if (typed) {
        const other = screen.other!;
        await io.keys([String(other.number)]);
        const focused = await settle(value => matches(value, index) && value.cursor === other.number ? value : undefined);
        if (!focused) throw changed("Could not open the typed answer.");
        await io.keys(typedKeys(typed));
        const shown = await settle(value => matches(value, index) && value.other && normalize(value.other.label).startsWith(normalize(typed).slice(0, 20)) ? value : undefined);
        if (!shown) throw changed("The typed answer did not appear in the terminal.");
        await io.keys(["enter"]);
      } else {
        await io.keys([String(screen.options[answer.options[0]].number)]);
      }
      if (!await settle(leaves(index))) throw changed("The terminal did not take the answer.");
      continue;
    }
    // Multi-select: toggle only the boxes that differ, one key per write
    // (Ink reads "13" in one write as a single input and toggles nothing),
    // and check each box before the next.
    const rows = [...screen.options, ...(screen.other ? [screen.other] : [])];
    for (const [position, row] of rows.entries()) {
      const wanted = position < screen.options.length ? answer.options.includes(position) : !!row.checked && !!typed;
      if (wanted === !!row.checked) continue;
      const box = (value: ClaudeDialogScreen | undefined) => matches(value, index)
        ? !!(position < value.options.length ? value.options[position] : value.other)?.checked : undefined;
      // A key that lands while the tab is still drawing can be dropped; the
      // box itself says whether one more press is needed.
      for (let attempt = 0; attempt < 2 && box(screen) !== wanted; attempt++) {
        await io.keys([String(row.number)]);
        screen = await settle(value => box(value) === wanted ? value as ClaudeQuestionScreen : undefined, 1_000) ?? screen;
      }
      if (box(screen) !== wanted) throw changed("The terminal's checkboxes did not match the answer.");
    }
    if (typed) {
      const other = screen.other!, cursor = typeof screen.cursor === "number" ? screen.cursor : 1;
      if (cursor !== other.number) await io.keys(Array<string>(Math.abs(other.number - cursor)).fill(other.number > cursor ? "down" : "up"));
      if (!await settle(value => matches(value, index) && value.cursor === other.number ? value : undefined)) throw changed("Could not reach the typed answer row.");
      await io.keys(typedKeys(typed));
      const shown = await settle(value => matches(value, index) && value.other?.checked && normalize(value.other.label).startsWith(normalize(typed).slice(0, 20)) ? value : undefined);
      if (!shown) throw changed("The typed answer did not appear in the terminal.");
      // Tab moves from the typed row to Next; Enter there leaves the question.
      await io.keys(["tab"]);
      if (!await settle(value => matches(value, index) && value.cursor === "next" ? value : undefined)) throw changed("Could not reach the question's Next row.");
      await io.keys(["enter"]);
    } else {
      // Tab from the typed row would stop on Next instead of leaving.
      await io.keys(screen.other && screen.cursor === screen.other.number ? ["up", "tab"] : ["tab"]);
    }
    if (!await settle(leaves(index))) throw changed("The terminal did not move past the question.");
  }
  if (!submit) return;
  const review = await settle(value => value?.kind === "review" ? value : value === undefined ? "gone" as const : undefined);
  // A lone single-select question submits on its digit.
  if (review === "gone") return;
  if (!review) throw changed("The terminal did not reach the review of the answers.");
  const expected = questions.map(question => normalize(question.question));
  if (review.answers.length !== questions.length || review.answers.some((row, position) => normalize(row.question) !== expected[position] || !row.answer)) {
    throw changed("Not every question has an answer in the terminal.");
  }
  await io.keys(["1"]);
  if (await settle(value => value === undefined ? "gone" : undefined) !== "gone") throw changed("The terminal did not submit the answers.");
}
