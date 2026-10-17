// Prompt history for the composer: ArrowUp in an empty draft recalls the last
// prompt sent in this chat, ArrowUp again goes further back, ArrowDown comes
// forward and ends on the draft that was there before. Pure: the composer owns
// the textarea and storage, this owns the walk.

export const HISTORY_MAX = 50;

/** The localStorage key for one target's sent prompts. */
export function historyKey(draftStorageKey) {
  return draftStorageKey.replace("phren.composer.draft.", "phren.composer.history.");
}

/** Adds a sent prompt (newest last); blanks and an immediate repeat are skipped, the list is capped. */
export function pushPrompt(list, text, max = HISTORY_MAX) {
  const value = String(text ?? "");
  if (!value.trim() || list[list.length - 1] === value) return list;
  return [...list, value].slice(-max);
}

/** True when the caret sits on the first line (ArrowUp would leave the text). */
export const onFirstLine = (value, caret) => !value.slice(0, caret).includes("\n");
/** True when the caret sits on the last line (ArrowDown would leave the text). */
export const onLastLine = (value, caret) => !value.slice(caret).includes("\n");

/**
 * `list` is the sent prompts, oldest first. `older(draft, caret)` / `newer(caret)`
 * return the text to put in the box, or null when the key should act normally
 * (typing is never overwritten: a walk starts only from an empty draft).
 */
export function createPromptHistory(list = []) {
  let prompts = list.slice();
  let at = -1; // index being shown; -1 = not walking
  let shown = "";
  let stash = "";
  const walking = (value) => at >= 0 && value === shown;
  return {
    get list() { return prompts; },
    record(text) { prompts = pushPrompt(prompts, text); at = -1; },
    older(value, caret = 0) {
      if (!walking(value)) {
        if (value !== "" || !prompts.length) return null;
        stash = value;
        at = prompts.length;
      } else if (!onFirstLine(value, caret)) return null;
      if (at === 0) return null;
      at -= 1;
      shown = prompts[at];
      return shown;
    },
    newer(value, caret = value.length) {
      if (!walking(value) || !onLastLine(value, caret)) return null;
      at += 1;
      if (at >= prompts.length) { at = -1; shown = ""; return stash; }
      shown = prompts[at];
      return shown;
    },
    reset() { at = -1; },
  };
}
