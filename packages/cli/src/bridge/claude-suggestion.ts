// Claude Code's predicted next prompt: after a turn it draws a short guess at
// what the owner will type next as dim text in its empty input box. The screen
// is the only place a live pane shows it. Claude generates it in a side request
// that skips the transcript, keeps it in memory only (no config or state file),
// and no hook event carries it; `claude -p --prompt-suggestions` streams it as
// a `prompt_suggestion` message, but only in print mode, never in a pane.
import { stripTerminal } from "../terminal-text.js";

const MAX_SUGGESTION = 500;

// The input box sits between two rules; the upper one can carry the session
// title ("───── Docs refresh ─").
const rule = (line: string) => /^[─━═]{3,}/.test(line.trim());

// Dim text Claude also draws in the empty input that is not a prediction: the
// first-turn example, the queued-message hints and a teammate's name.
const PLACEHOLDERS = [/^Try ".*"$/, /^Press (?:up|Enter) to /, /^Message @.*…$/];

/**
 * The suggestion on a Claude screen read with its styles, or undefined when
 * there is none. Only an input line whose every character after the prompt is
 * dim counts: once the owner types, their text is drawn plain. A narrow pane
 * cuts a long suggestion with "…" instead of wrapping it; a cut one is not
 * offered, since sending half a sentence would be worse than nothing.
 */
export function claudeSuggestion(screen: string): string | undefined {
  const lines = screen.split("\n").map(line => line.replace(/\r$/, ""));
  for (let index = lines.length - 2; index > 0; index--) {
    const plain = stripTerminal(lines[index]);
    if (!/^\s*❯/.test(plain)) continue;
    // Only the live input box: a sent prompt in the history has no rules around it.
    if (!rule(stripTerminal(lines[index - 1])) || !rule(stripTerminal(lines[index + 1]))) return undefined;
    const text = dimText(lines[index]);
    if (!text || text.endsWith("…") || text.length > MAX_SUGGESTION || PLACEHOLDERS.some(pattern => pattern.test(text))) return undefined;
    return text;
  }
  return undefined;
}

/** The text after the prompt glyph when all of it is dim (SGR 2), else "". */
function dimText(line: string): string {
  let dim = false, prompt = false, text = "";
  for (const token of line.match(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[^\x1b]/gu) ?? []) {
    if (token.startsWith("\x1b")) {
      if (!token.startsWith("\x1b[") || !token.endsWith("m")) continue;
      const codes = (token.slice(2, -1) || "0").split(/[;:]/).map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        // Extended colors carry their own numbers: 38;5;2 is not dim.
        if (code === 38 || code === 48 || code === 58) { i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0; continue; }
        if (code === 0 || code === 22) dim = false;
        else if (code === 2) dim = true;
      }
    } else if (!prompt) { if (token === "❯") prompt = true; }
    else if (!token.trim()) text += " ";
    else if (!dim) return "";
    else text += token;
  }
  return text.replace(/\s+/g, " ").trim();
}
