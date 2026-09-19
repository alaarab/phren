/** Recognize raw F1 sequences; Ink omits function keys from useInput. */
export function isHelpKey(input: string, value: string): boolean {
  return input === "\u001bOP" || input === "\u001b[11~" || input === "\u001b[[A" || input === "\u001b[P"
    || input === "\u001b[57364u"
    || (input === "?" && value === "");
}
