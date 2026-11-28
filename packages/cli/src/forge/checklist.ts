import type { ChecklistItem } from "./issues.js";

const OPEN = "<!-- phren:checklist -->";
const CLOSE = "<!-- /phren:checklist -->";
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

const CHECKBOX = /^([\t ]*(?:[-+*]|\d{1,9}[.)])[\t ]+\[)([ xX])\](?:[\t ]+([^\r\n]*))?$/;

export class ChecklistIndexError extends Error {
  constructor(index: number, count: number) {
    super(`--check-done ${index} is past the ${count} checklist item(s) on this issue.`);
    this.name = "ChecklistIndexError";
  }
}

function scanChecklist(body: string) {
  let fence: string | undefined;
  let open: { start: number; newline: string } | undefined;
  let last: { start: number; end: number; close: number; newline: string } | undefined;
  const items: { item: ChecklistItem; mark: number }[] = [];
  for (const { 1: line, 2: newline, index } of body.matchAll(/([^\r\n]*)(\r\n|[\r\n]|$)/g)) {
    const delimiter = FENCE.exec(line);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && /^[\t ]*$/.test(delimiter[2])) {
        fence = undefined;
      }
      continue;
    }
    if (delimiter && (delimiter[1][0] === "~" || !delimiter[2].includes("`"))) {
      fence = delimiter[1];
      open = undefined;
      continue;
    }
    const checkbox = CHECKBOX.exec(line);
    if (checkbox) {
      const [, prefix, mark, text] = checkbox;
      items.push({ item: { text: text?.trim() ?? "", done: mark !== " " }, mark: index + prefix.length });
    }
    const marker = line.trimEnd();
    if (marker === OPEN) open = { start: index, newline };
    if (marker === CLOSE && open) {
      last = { ...open, end: index + line.length, close: index };
      open = undefined;
    }
  }
  return { items, last, fenced: fence !== undefined };
}

export function parseChecklist(body: string): ChecklistItem[] {
  return scanChecklist(body).items.map(({ item }) => item);
}

export function editChecklist(body: string, done: number[], added: string[]): string {
  const { items, last } = scanChecklist(body);
  const positions = new Set<number>();
  for (const index of done) {
    const checkbox = items[index - 1];
    if (!checkbox) throw new ChecklistIndexError(index, items.length);
    if (!checkbox.item.done) positions.add(checkbox.mark);
  }
  const chunks: string[] = [];
  let start = 0;
  for (const { mark } of items) {
    if (!positions.has(mark)) continue;
    chunks.push(body.slice(start, mark), "x");
    start = mark + 1;
  }
  const result = chunks.length ? chunks.join("") + body.slice(start) : body;

  if (!added.length) return result;
  const newItems = added.map(text => ({ text, done: false }));
  if (!last) return rewriteChecklist(result, newItems);
  const insertion = newItems.map(renderCheckbox).join(last.newline) + last.newline;
  return result.slice(0, last.close) + insertion + result.slice(last.close);
}

function renderCheckbox({ text, done }: ChecklistItem): string {
  return `- [${done ? "x" : " "}] ${text.replace(/\r\n|[\r\n]/g, " ")}`;
}

export function rewriteChecklist(body: string, items: ChecklistItem[]): string {
  const { last, fenced } = scanChecklist(body);
  const newline = last?.newline ?? body.match(/\r\n|[\r\n]/)?.[0] ?? "\n";
  const block = [OPEN, ...items.map(renderCheckbox), CLOSE].join(newline);
  if (last) return body.slice(0, last.start) + block + body.slice(last.end);
  if (!body) return block;
  // Keep the new block outside an unclosed fence and leave the original text intact.
  if (fenced) return block + newline + newline + body;
  const separator = body.endsWith(newline + newline) ? "" : body.endsWith(newline) ? newline : newline + newline;
  return body + separator + block;
}
