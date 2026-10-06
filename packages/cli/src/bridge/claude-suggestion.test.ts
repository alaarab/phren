import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claudeSuggestion } from "./claude-suggestion.js";

// Screens recorded from Claude Code 2.1.284 with their styles: Herdr's
// `pane.read --format ansi` (trimmed to the input box) and tmux `capture-pane -e`.
const recorded = (file: string) => readFileSync(new URL(`./fixtures/claude/2.1.284/${file}`, import.meta.url), "utf8");

describe("Claude's suggested next prompt", () => {
  it("reads the dim text in the empty input box after a turn", () => {
    expect(claudeSuggestion(recorded("next-suggestion-herdr.ansi"))).toBe("merged 313 and 314");
    expect(claudeSuggestion(recorded("next-suggestion-tmux.ansi"))).toBe("no, skip it");
  });

  it("finds none in an empty box, while working, or once the owner types", () => {
    expect(claudeSuggestion(recorded("empty-prompt-herdr.ansi"))).toBeUndefined();
    expect(claudeSuggestion(recorded("working-tmux.ansi"))).toBeUndefined();
    // The sent prompt above ("❯ Create a file…", on a background color) is history, not the box.
    expect(claudeSuggestion(recorded("owner-typing-tmux.ansi"))).toBeUndefined();
  });

  it("skips the first-turn example and a suggestion a narrow pane cut short", () => {
    expect(claudeSuggestion(recorded("fresh-placeholder-tmux.ansi"))).toBeUndefined();
    expect(claudeSuggestion(recorded("narrow-truncated-tmux.ansi"))).toBeUndefined();
  });

  it("skips Claude's queued-message hints and teammate placeholder", () => {
    const box = (text: string) => recorded("next-suggestion-herdr.ansi").replace("merged 313 and 314", text);
    expect(claudeSuggestion(box("run the tests again"))).toBe("run the tests again");
    expect(claudeSuggestion(box("Press up to edit queued messages"))).toBeUndefined();
    expect(claudeSuggestion(box("Press Enter to edit the selected message, or up again for history"))).toBeUndefined();
    expect(claudeSuggestion(box("Message @researcher…"))).toBeUndefined();
  });

  it("reads nothing from plain text or a draft that is only partly dim", () => {
    const screen = recorded("next-suggestion-herdr.ansi");
    expect(claudeSuggestion(screen.replace(/\x1b\[[0-9;]*m/g, ""))).toBeUndefined();
    expect(claudeSuggestion(screen.replace("\x1b[2mmerged", "merged\x1b[2m"))).toBeUndefined();
    expect(claudeSuggestion("")).toBeUndefined();
  });
});
