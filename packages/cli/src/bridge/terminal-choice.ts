import { z } from "zod";
import { BridgeError, object, objects, type Json } from "./protocol.js";
import { stripTerminal } from "../terminal-text.js";

/** Reading the question a terminal dialog or held permission is asking:
 * numbered option rows, the highlighted row, password reads, and a released
 * AskUserQuestion's questions and answers. Pure functions over text and input. */

/** The terminal keys an agent's own dialog accepts. Kept in step with
 * `ANSWER_KEYS` in server-pane-routes.ts; "p" is Codex's "don't ask again" answer. */
const choiceKeys = new Set(["Escape", "Enter", "Up", "Down", "Tab", "y", "n", "p", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
/** A question asks in a few lines; more than this is scrollback above it. */
const QUESTION_LINES = 12;
interface TerminalChoiceOption { label: string; description?: string; key: string; hasKey?: boolean }
/** The actual question a terminal dialog is asking, when its command and
 * options are visible to the Hook: a title, the command it is about, and one
 * row per choice. For keyless rows, key identifies the option to the phone;
 * the Hook navigates from highlightedIndex instead of typing that number. */
export interface TerminalChoice { title?: string; body?: string; options: TerminalChoiceOption[]; highlightedIndex?: number }

function choiceKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (!text) return undefined;
  if (text === "esc" || text === "escape") return "Escape";
  if (text === "enter" || text === "return") return "Enter";
  if (text === "up" || text === "down" || text === "tab") return text[0].toUpperCase() + text.slice(1);
  return choiceKeys.has(text) ? text : undefined;
}
function commandText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === "string" && !!part.trim());
    if (parts.length) return parts.join(" ");
  }
  return undefined;
}
function optionLabel(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const fields = object(value);
  for (const key of ["label", "name", "title", "text", "value"]) {
    if (typeof fields[key] === "string" && fields[key].trim()) return fields[key].trim();
  }
  return undefined;
}
function labeledOption(label: string, key: unknown): TerminalChoiceOption | undefined {
  let resolved = choiceKey(key);
  const trailing = /^(.+?)\s*\(([A-Za-z0-9]+)\)\s*$/.exec(label);
  if (!resolved && trailing) resolved = choiceKey(trailing[2]);
  return resolved ? { label, key: resolved } : undefined;
}
function structuredOptions(value: unknown): TerminalChoiceOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const label = optionLabel(item);
    if (!label) return [];
    const fields = object(item);
    const key = ["key", "shortcut", "hotkey", "accelerator", "value"].map(name => choiceKey(fields[name])).find(Boolean);
    const option = labeledOption(label, key);
    return option ? [{ ...option, ...(typeof fields.description === "string" && fields.description.trim() ? { description: fields.description.trim().slice(0, 4_000) } : {}) }] : [];
  });
}
/** Numbered options as Codex draws them: "1. Yes, proceed (y)", with the
 * cursor marker in front of the highlighted row. Harnesses draw that marker
 * with whatever glyph they like (Codex uses "›"), and missing one costs
 * the option twice over: the row is dropped and its text joins the question. The key in
 * trailing parentheses (y, p, n, esc, enter, a digit) is the answer when
 * present and is cut from the label. A row number alone is an identifier,
 * not evidence that the terminal accepts it as a shortcut. */
function numberedOptions(text: string): (TerminalChoiceOption & { highlighted: boolean; hasKey: boolean })[] {
  return text.split(/\r?\n/).flatMap(line => {
    const match = /^\s*([>❯›▸▶»•*])?\s*(\d+)[.)]\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    const columns = /^(.+?)\s{2,}(.+)$/.exec(match[3].trim());
    const label = columns?.[1] ?? match[3].trim();
    const description = columns?.[2].trim();
    const trailing = /^(.+?)\s*\(([A-Za-z0-9]+)\)\s*$/.exec(label);
    const descriptionKey = description ? /^(.+?)\s*\(([A-Za-z0-9]+)\)\s*$/.exec(description) : null;
    const labelKey = trailing ? choiceKey(trailing[2]) : undefined;
    const endKey = descriptionKey ? choiceKey(descriptionKey[2]) : undefined;
    const key = labelKey ?? endKey ?? choiceKey(match[2]);
    return key ? [{ label: labelKey && trailing ? trailing[1].trim() : label, key,
      highlighted: !!match[1], hasKey: !!(labelKey ?? endKey),
      ...(description ? { description: endKey && descriptionKey ? descriptionKey[1].trim() : description } : {}) }] : [];
  });
}
/** The question a pane's terminal lines are asking, in the same shape a held
 * permission request carries: every non-empty line above the first numbered
 * row (the "$ command" line included, the "Press enter" hint dropped), joined
 * with newlines, then one option per row. Keyless rows require exactly one
 * readable cursor so the Hook can navigate without confirming another row. */
/** Copilot CLI draws each select inside a box, so its rows read
 * "│ ❯ 1. Yes │". Strip the frame (nested boxes too) so rows and the
 * question read as bare lines. Inside a box the blank and border lines go,
 * so the box's whole body (title, command, question) is one block above its
 * options; the box's own edges become the blank lines around it. Text with
 * no framed line passes through unchanged. */
const BAR = "│┃║";
const framed = new RegExp(`^\\s*[${BAR}] ?(.*?)\\s*[${BAR}]\\s*$`);
const border = /^[\s╭╮╰╯┌┐└┘├┤─━═│┃║]*$/;
export function unframed(text: string): string {
  let lines = text.split(/\r?\n/);
  // Copilot's scrollbar: a "┃" closing most lines once the chat overflows.
  const filled = lines.filter(line => line.trim());
  if (filled.length && filled.filter(line => /┃\s*$/.test(line)).length * 2 > filled.length) {
    lines = lines.map(line => line.replace(/\s*┃\s*$/, ""));
  }
  if (!lines.some(line => framed.test(line))) return lines.join("\n");
  return lines.flatMap(line => {
    if (!framed.test(line)) return [border.test(line) ? "" : line];
    let inner = line, match: RegExpExecArray | null;
    while ((match = framed.exec(inner))) inner = match[1];
    return border.test(inner) ? [] : [inner];
  }).join("\n");
}
export function visibleTerminalChoice(text: string): TerminalChoice | undefined {
  text = unframed(text);
  const parsed = numberedOptions(text);
  const highlights = parsed.flatMap((option, index) => option.highlighted ? [index] : []);
  const highlightedIndex = highlights.length === 1 ? highlights[0] : undefined;
  if (parsed.some(option => !option.hasKey) && highlightedIndex === undefined) return undefined;
  const options = parsed.map(({ highlighted: _highlighted, ...option }) => option);
  if (options.length < 2 || new Set(options.map(option => option.key)).size !== options.length) return undefined;
  const lines = text.split(/\r?\n/);
  const firstOption = lines.findIndex(line => /^\s*[>❯›▸▶»•*]?\s*\d+[.)]\s+/.test(line));
  const above = firstOption < 0 ? lines.slice(0, 1) : lines.slice(0, firstOption);
  // Only the question's own block: everything above the last blank line is
  // whatever the agent printed before it asked, and reading a pane of
  // scrollback as the question is worse than reading none of it.
  while (above.length && !above[above.length - 1].trim()) above.pop();
  let start = above.length;
  while (start > 0 && above[start - 1].trim()) start -= 1;
  const menuStart = above.findIndex((line, index) => index >= above.length - QUESTION_LINES
    && /^\s*(?:select|choose) (?:model|reasoning (?:level|effort))\b/i.test(line));
  const question = above.slice(menuStart >= 0 ? menuStart : Math.max(start, above.length - QUESTION_LINES));
  const title = question.map(line => line.trim()).filter(line => line && !/^press enter\b/i.test(line)).join("\n").trim();
  if (!title) return undefined;
  return { title: title.slice(0, 4_000), options: options.slice(0, 12),
    ...(highlightedIndex !== undefined ? { highlightedIndex } : {}) };
}
const OPENCODE_OPTIONS = ["Allow once", "Allow always", "Reject"] as const;
/** OpenCode's permission prompt, read from the pane with its colors:
 * "△ Permission required", what it asks, then one row "Allow once  Allow
 * always  Reject" answered with ←/→ and Enter (Escape rejects). The row's
 * selected option is the one drawn on a background the others don't share.
 * The phone gets Allow once and Reject: Allow always opens OpenCode's own
 * second confirmation. `selected` is the cursor's index in the three-option
 * row; undefined when the colors do not say. */
export function opencodePermissionDialog(ansi: string): { choice: TerminalChoice; selected?: number } | undefined {
  const raw = ansi.split(/\r?\n/);
  const plain = raw.map(line => stripTerminal(line).replace(/\r/g, ""));
  const content = (line: string) => line.replace(/^\s*[┃│]?/, "");
  let header = -1;
  plain.forEach((line, index) => { if (/^\s*△\s*Permission required\s*$/.test(content(line))) header = index; });
  if (header < 0) return undefined;
  const row = plain.findIndex((line, index) => index > header && OPENCODE_OPTIONS.every(label => line.includes(label)));
  if (row < 0 || row - header > 24) return undefined;
  // Lines pushed far right are OpenCode's status column, not the question.
  const body = plain.slice(header + 1, row).map(content)
    .filter(line => line.trim() && !/^\s{24,}/.test(line)).map(line => line.trim());
  const title = ["Permission required", ...body].join("\n").slice(0, 4_000);
  const backgrounds = OPENCODE_OPTIONS.map(label => {
    const at = raw[row].indexOf(label);
    if (at < 0) return undefined;
    const before = [...raw[row].slice(0, at).matchAll(/\x1b\[[0-9;]*48;2;(\d+;\d+;\d+)[0-9;]*m/g)];
    return before.at(-1)?.[1];
  });
  const unique = backgrounds.flatMap((background, index) =>
    background !== undefined && backgrounds.filter(other => other === background).length === 1 ? [index] : []);
  const selected = unique.length === 1 && backgrounds.every(background => background !== undefined) ? unique[0] : undefined;
  return { choice: { title, options: [{ label: "Allow once", key: "1", hasKey: false }, { label: "Reject", key: "Escape", hasKey: true }],
    ...(selected === 0 ? { highlightedIndex: 0 } : {}) }, ...(selected !== undefined ? { selected } : {}) };
}
/** The pane's last non-empty line is a password read: sudo's "[sudo] password
 * for user", or any "… Password:" prompt. */
export function passwordLine(text: string): boolean {
  if (text.includes("[sudo] password for")) return true;
  const last = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop() ?? "";
  return /password[^\n]*:\s*$/i.test(last);
}
/** The numbered dialog Claude Code and opencode draw straight in the pane when
 * a permission ask falls back to the terminal (no PermissionRequest hook
 * fires): the last non-empty line above the first "1." row is the question,
 * each row is an option keyed by its own number with its text cut at the first
 * " · ", and a footer offering "Esc to cancel" gains the Escape option.
 * Undefined without two numbered rows and a question. */
export function numberedDialog(text: string): TerminalChoice | undefined {
  text = unframed(text);
  const row = /^\s*[>❯›▸▶»•*]?\s*(\d+)\.\s+(.+?)\s*$/;
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex(line => row.test(line));
  if (first < 0) return undefined;
  const title = lines.slice(0, first).map(line => line.trim()).filter(Boolean).pop();
  if (!title) return undefined;
  const options: TerminalChoiceOption[] = [];
  for (const line of lines.slice(first)) {
    const match = row.exec(line);
    if (!match) continue;
    const label = match[2].split(" · ")[0].trim();
    if (label) options.push({ label, key: match[1] });
  }
  if (options.length < 2) return undefined;
  if (lines.some(line => line.includes("Esc to cancel"))) options.push({ label: "Cancel", key: "Escape" });
  return { title: title.slice(0, 4_000), options: options.slice(0, 12) };
}
/** Read the question a terminal dialog is asking from the request it carries:
 * an explicit options list, or numbered lines inside its text. Undefined when
 * there are not at least two answerable choices. */
export function terminalChoice(input: unknown): TerminalChoice | undefined {
  const fields = object(input), command = commandText(fields.command ?? fields.cmd);
  let options = [fields.options, fields.choices, fields.actions, fields.answers].map(structuredOptions).find(list => list.length >= 2) ?? [];
  if (options.length < 2) {
    const text = [fields.question, fields.description, fields.justification, fields.prompt, fields.message, fields.text, fields.content, fields.display]
      .filter((value): value is string => typeof value === "string").join("\n");
    const parsed = numberedOptions(text);
    if (parsed.length >= 2) options = parsed.map(({ highlighted: _highlighted, hasKey: _hasKey, ...option }) => option);
  }
  if (options.length < 2) return undefined;
  const title = [fields.question, fields.description, fields.justification, fields.prompt]
    .find((value): value is string => typeof value === "string" && !!value.trim() && value.trim() !== command);
  if (!title && !command) return undefined;
  return { ...(title ? { title: String(title).slice(0, 4_000) } : {}), ...(command ? { body: command.slice(0, 4_000) } : {}), options: options.slice(0, 12) };
}

/** Keep structured tool arguments in details, never in the asking sentence. */
function permissionTitle(tool: string, input: unknown): string | undefined {
  const fields = object(input);
  const sentence = [fields.question, fields.prompt, fields.description, fields.justification, fields.message]
    .find((value): value is string => typeof value === "string" && !!value.trim() && !/^[{[]/.test(value.trim()));
  if (sentence) return sentence.trim().slice(0, 4_000);
  const mcp = /^mcp__([^_]+)__(.+)$/.exec(tool);
  const server = mcp?.[1] ?? fields.server;
  const name = mcp?.[2] ?? fields.tool;
  if (typeof server === "string" && typeof name === "string") return `Allow the ${server} MCP server to run tool ${name}?`;
  return tool && tool !== "action" ? `Allow ${tool}?` : undefined;
}
function samePermission(choice: TerminalChoice, title: string | undefined, tool: string, input: unknown): boolean {
  const text = choice.title?.toLowerCase() ?? "";
  if (title && text.includes(title.toLowerCase())) return true;
  const command = commandText(object(input).command ?? object(input).cmd);
  if (command && text.includes(command.toLowerCase())) return true;
  const name = tool.split("__").pop();
  return !!name && name !== "action" && text.includes(name.toLowerCase());
}

/** Normalize a held permission without turning its arguments into a question. */
export function permissionPrompt(tool: string, input: unknown, terminalText = ""): {
  title?: string; details: string; choice?: TerminalChoice; terminalOnly: boolean;
} {
  const title = permissionTitle(tool, input);
  const dialog = visibleTerminalChoice(terminalText);
  const matched = dialog && samePermission(dialog, title, tool, input) ? dialog : undefined;
  const sentence = matched?.title?.split("\n").find(line => /\?\s*$/.test(line) && !/^[{[]/.test(line.trim()));
  const choice = matched ? { ...matched, title: sentence ?? title } : terminalChoice(input);
  return { title: choice?.title ?? title, details: JSON.stringify(input ?? {}, null, 2).slice(0, 32_768),
    ...(choice ? { choice } : {}), terminalOnly: !choice };
}

/** Claude Code's AskUserQuestion input, normalized to the shape the phone
 * already decodes for a held permission request: one question per entry with
 * its header, multi-select flag and options. Undefined when nothing parses. */
export interface TerminalQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; preview?: string }[];
}
export function terminalQuestions(input: unknown): TerminalQuestion[] | undefined {
  const questions = objects(object(input).questions).flatMap(raw => {
    const question = typeof raw.question === "string" ? raw.question.trim() : "";
    if (!question || question.length > 4_000) return [];
    const options = objects(raw.options).flatMap(option => {
      const label = typeof option.label === "string" ? option.label.trim() : "";
      if (!label || label.length > 2_000) return [];
      return [{ label, ...(typeof option.description === "string" && option.description ? { description: option.description.slice(0, 4_000) } : {}),
        ...(typeof option.preview === "string" && option.preview ? { preview: option.preview.slice(0, 4_000) } : {}) }];
    });
    if (!options.length || options.length > 12) return [];
    return [{ question, ...(typeof raw.header === "string" && raw.header ? { header: raw.header.slice(0, 200) } : {}),
      ...(raw.multiSelect === true ? { multiSelect: true } : {}), options }];
  });
  return questions.length >= 1 && questions.length <= 8 ? questions : undefined;
}
/** The current question of a released AskUserQuestion as a terminal choice:
 * its labels keyed "1".."n", and a "Done" Enter for a multi-select question
 * whose answers are confirmed by leaving it. */
export function questionChoice(questions: TerminalQuestion[], index: number): TerminalChoice | undefined {
  const question = questions[index];
  if (!question) return undefined;
  const options = question.options.map((option, position) => ({ label: option.label, key: String(position + 1) }));
  if (question.multiSelect) options.push({ label: "Done", key: "Enter" });
  return { title: question.question, options: options.slice(0, 12) };
}

/** Claude Code's AskUserQuestion is answered by allowing the call with its own
 * input plus `answers` keyed by question text (a label, or labels when the
 * question is multiSelect; any other string is a typed "Other"). The phone may
 * add answers and a free-text `response`; it may not rewrite the questions. */
const questionAnswers = z.looseObject({
  answers: z.record(z.string().min(1).max(4000), z.union([z.string().max(4000), z.array(z.string().max(4000)).min(1).max(24)])).refine(a => Object.keys(a).length > 0),
  response: z.string().max(4000).optional(),
});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value as Json).sort().map(k => JSON.stringify(k) + ":" + canonical((value as Json)[k])).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
export function answeredQuestionInput(tool: string, input: unknown, updatedInput: unknown): Json {
  if (tool !== "AskUserQuestion") throw new BridgeError(400, "Only a question can be answered with input.");
  if (updatedInput === null || typeof updatedInput !== "object" || Array.isArray(updatedInput)) throw new BridgeError(400, "The answer is not an object.");
  const raw = JSON.stringify(updatedInput);
  if (Buffer.byteLength(raw) > 32_768) throw new BridgeError(400, "The answer is too large.");
  const parsed = questionAnswers.safeParse(updatedInput);
  if (!parsed.success) throw new BridgeError(400, "The answer must add an answers object.");
  const { answers, response, ...rest } = parsed.data;
  if (canonical(rest) !== canonical(object(input))) throw new BridgeError(400, "The answer must keep the original questions.");
  const asked = new Set(objects(object(input).questions).map(q => q.question).filter(q => typeof q === "string"));
  if (Object.keys(answers).some(q => !asked.has(q))) throw new BridgeError(400, "The answer names a question that was not asked.");
  return { ...object(input), answers, ...(response === undefined ? {} : { response }) };
}
