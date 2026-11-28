import type { ChecklistItem } from "./issues.js";

const OPEN = "<!-- phren:checklist -->";
const CLOSE = "<!-- /phren:checklist -->";
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function managedBlock(body: string) {
  let fence: string | undefined;
  let open: { start: number; newline: string } | undefined;
  let last: { start: number; end: number; newline: string } | undefined;
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
    const marker = line.trimEnd();
    if (marker === OPEN) open = { start: index, newline };
    if (marker === CLOSE && open) {
      last = { ...open, end: index + line.length };
      open = undefined;
    }
  }
  return { last, fenced: fence !== undefined };
}

export function parseChecklist(body: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const [, mark, text] of body.matchAll(/^[\t ]*-[\t ]+\[([ xX])\](?:[\t ]+([^\r\n]*))?(?=\r?$)/gm)) {
    items.push({ text: text?.trim() ?? "", done: mark !== " " });
  }
  return items;
}

export function rewriteChecklist(body: string, items: ChecklistItem[]): string {
  const { last, fenced } = managedBlock(body);
  const newline = last?.newline ?? body.match(/\r\n|[\r\n]/)?.[0] ?? "\n";
  const block = [OPEN, ...items.map(({ text, done }) => `- [${done ? "x" : " "}] ${text.replace(/\r\n|[\r\n]/g, " ")}`), CLOSE].join(newline);
  if (last) return body.slice(0, last.start) + block + body.slice(last.end);
  if (!body) return block;
  // Keep the new block outside an unclosed fence and leave the original text intact.
  if (fenced) return block + newline + newline + body;
  const separator = body.endsWith(newline + newline) ? "" : body.endsWith(newline) ? newline : newline + newline;
  return body + separator + block;
}
