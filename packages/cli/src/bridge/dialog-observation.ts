import { stripTerminal } from "../terminal-text.js";
import { claudeFooterMode } from "./claude-footer-mode.js";
import { intervalFromEnv } from "./limits.js";

/** Discovery is frequent by default; an owner can still cap polling explicitly.
 * Confirmation has its own small, fixed budget, independent of that cap. */
export const DIALOG_READ_MS = intervalFromEnv("PHREN_DIALOG_THROTTLE_MS", 350);
export const DIALOG_CONFIRM_MS = 300;
const CONFIRM_READ_MS = 400;

export async function confirmDialogRead<T>(read: () => Promise<T>, current: () => boolean): Promise<T | undefined> {
  await new Promise<void>(resolve => setTimeout(resolve, DIALOG_CONFIRM_MS));
  if (!current()) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read().catch(() => undefined), new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), CONFIRM_READ_MS);
    })]);
  } finally { clearTimeout(timer); }
}

/** A live composer or working hint after all dialog cues proves closure.
 * Call only after ruling out a currently readable dialog. A failed parse alone
 * says nothing: clipped and half-drawn screens remain unknown. */
export function dialogHasClosed(screen: string): boolean {
  const lines = stripTerminal(screen).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const composer = (line: string) => /^[❯›](?!\s*\d+[.)])(?:\s|$)/.test(line);
  const chrome = (line: string) => /^[─━═]+$/.test(line) || claudeFooterMode(line) !== undefined
    || /^(?:[←→?].*(?:agents|shortcuts)|(?:gpt-|GPT-|claude-|Claude ).*)/i.test(line);
  const liveTail = (index: number) => lines.slice(index + 1).every(line => composer(line) || chrome(line));
  let cue = -1;
  for (let index = 0; index < lines.length; index++) {
    if (/^(?:[>❯›]?\s*\d+[.)]|Do you want|Would you like|Ready to code|Allow\b|Trust\b|Teach auto|△\s*Permission|[☐☒]|.*Esc to cancel)/i.test(lines[index])) cue = index;
  }
  for (let index = lines.length - 1; index > cue; index--) {
    if (/\besc to interrupt\b/i.test(lines[index]) && liveTail(index)) return true;
    if (index >= lines.length - 3 && composer(lines[index]) && liveTail(index)) return true;
  }
  return false;
}
