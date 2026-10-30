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
  const text = liveInputDimText(screen);
  if (!text || text.endsWith("…") || text.length > MAX_SUGGESTION || PLACEHOLDERS.some(pattern => pattern.test(text))) return undefined;
  return text;
}

/** The suggestion as drawn, a narrow pane's cut one ("…" at the end) included, for refusing a relay of what
 * a screen read shows; undefined when there is none. */
export function claudeSuggestionShown(screen: string): string | undefined {
  const text = liveInputDimText(screen);
  if (!text || text.length > MAX_SUGGESTION || PLACEHOLDERS.some(pattern => pattern.test(text)) || SUBAGENT_VIEW.test(text)) return undefined;
  return text;
}

/** Claude Code showing a subagent's (or teammate's) view: its empty input box
 * reads "Message @<agent>…". Text typed there goes to that agent, not the
 * conversation, so a phone message typed into it never reaches the turn;
 * Escape returns to the main view. */
// Only the bare placeholder, one agent name and nothing else: a suggestion
// that a narrow pane cut short ("Message @researcher to check…") is not one.
// Claude Code (2.1.303) cuts a name past 20 columns with its own "…" before the
// placeholder's: "Message @researcher-performa……".
export const SUBAGENT_VIEW = /^Message @[\w.-]{1,20}…?…$/;
export function claudeSubagentView(screen: string): boolean {
  const text = liveInputDimText(screen);
  return !!text && SUBAGENT_VIEW.test(text);
}

/** Whether Claude's live input box holds no typed text: nothing after the
 * prompt glyph, or only dim placeholder or suggestion text. False for typed
 * text, a subagent's view, or no single-line live box on screen (typed text
 * that wraps leaves no rule under the prompt line). */
export function claudeInputEmpty(screen: string): boolean {
  const line = liveInputLine(screen);
  if (line === undefined) return false;
  if (!stripTerminal(line).replace(/^\s*❯/, "").trim()) return true;
  const dim = dimText(line);
  return !!dim && !SUBAGENT_VIEW.test(dim);
}

/** The dim text in the live input box (between its two rules), "" when the
 * box holds typed text, undefined when there is no live box on screen. */
function liveInputDimText(screen: string): string | undefined {
  const line = liveInputLine(screen);
  return line === undefined ? undefined : dimText(line);
}

/** The live input box's prompt line, as read with its styles. */
function liveInputLine(screen: string): string | undefined {
  const lines = screen.split("\n").map(line => line.replace(/\r$/, ""));
  for (let index = lines.length - 2; index > 0; index--) {
    const plain = stripTerminal(lines[index]);
    if (!/^\s*❯/.test(plain)) continue;
    // Only the live input box: a sent prompt in the history has no rules around it.
    if (!rule(stripTerminal(lines[index - 1])) || !rule(stripTerminal(lines[index + 1]))) return undefined;
    return lines[index];
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
