/** Fold the harness's footer, including an unindented soft wrap, without
 * swallowing newer output below it. */
export function joinDialogFooters(lines: string[]): string[] {
  const result: string[] = [];
  let footer = -1;
  for (const line of lines) {
    if (footer >= 0 && /^\s*(?:[↑↓←→/·]+\s*|Esc\b|Tab\b|Enter\b|to\b|cancel\b|select\b|navigate\b|confirm\b|amend\b)/i.test(line)) {
      result[footer] += " " + line.trim();
      continue;
    }
    footer = /^\s*(?:Enter to\b|Press enter\b|Esc to\b|↑\/↓ to\b)/i.test(line) ? result.length : -1;
    result.push(line);
  }
  return result;
}

const OPTION = /^(\s*[>❯›▸▶»•*]?\s*\d+[.)]\s+)(.+)$/;
const PROMPT = /^\s*(?:Do you want to |Would you like to |Allow |Trust |Teach auto mode about your environment|Ready to code)/i;

/** Physical rows in a narrow pane are not option boundaries. A continuation
 * starts in the label's column; prompt continuations end at the question mark.
 * Keep blank rows, chrome, new composers and hints as block boundaries. */
export function logicalDialogLines(text: string): string[] {
  const result: string[] = [];
  let option = -1, column = 0, prompt = -1;
  for (const line of text.split(/\r?\n/).map(line => line.trimEnd())) {
    const row = OPTION.exec(line);
    if (row) { option = result.length; column = row[1].length; prompt = -1; result.push(line); continue; }
    const boundary = !line.trim() || /^\s*(?:[❯›>│`─]|Esc\b|Enter\b|Press enter\b|Tab\b|[↑↓←→])/i.test(line);
    if (!boundary && option >= 0 && /^\s*/.exec(line)![0].length >= column) {
      result[option] += " " + line.trim();
      continue;
    }
    option = -1;
    if (!boundary && prompt >= 0) {
      result[prompt] += " " + line.trim();
      if (/\?\s*$/.test(line)) prompt = -1;
      continue;
    }
    prompt = PROMPT.test(line) && !/\?\s*$/.test(line) ? result.length : -1;
    result.push(line);
  }
  return joinDialogFooters(result);
}
