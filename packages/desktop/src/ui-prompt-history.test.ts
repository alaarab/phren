import { describe, expect, it } from "vitest";
// @ts-expect-error plain-ESM UI module
import { createPromptHistory, historyKey, onFirstLine, onLastLine, pushPrompt } from "../ui/chat/prompt-history.js";

describe("pushPrompt", () => {
  it("appends, skips blanks and an immediate repeat, and caps the list", () => {
    expect(pushPrompt(["a"], "b")).toEqual(["a", "b"]);
    expect(pushPrompt(["a"], "  ")).toEqual(["a"]);
    expect(pushPrompt(["a"], "a")).toEqual(["a"]);
    expect(pushPrompt(["a", "b"], "a")).toEqual(["a", "b", "a"]);
    expect(pushPrompt(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
  });
});

describe("caret lines", () => {
  it("knows the first and last line", () => {
    expect(onFirstLine("ab\ncd", 1)).toBe(true);
    expect(onFirstLine("ab\ncd", 4)).toBe(false);
    expect(onLastLine("ab\ncd", 4)).toBe(true);
    expect(onLastLine("ab\ncd", 1)).toBe(false);
  });
});

describe("createPromptHistory", () => {
  it("walks back from an empty draft and forward to it again", () => {
    const h = createPromptHistory(["one", "two", "three"]);
    expect(h.older("")).toBe("three");
    expect(h.older("three", 0)).toBe("two");
    expect(h.older("two", 0)).toBe("one");
    expect(h.older("one", 0)).toBeNull(); // oldest: the key acts normally
    expect(h.newer("one", 3)).toBe("two");
    expect(h.newer("two", 3)).toBe("three");
    expect(h.newer("three", 5)).toBe(""); // back to the empty draft
    expect(h.newer("", 0)).toBeNull();
  });

  it("never overwrites typing", () => {
    const h = createPromptHistory(["one"]);
    expect(h.older("draft")).toBeNull();
    expect(h.older("")).toBe("one");
    expect(h.older("one edited", 0)).toBeNull(); // edited: no longer walking
    expect(h.newer("one edited", 10)).toBeNull();
  });

  it("only moves from the first or last line of a multi-line prompt", () => {
    const h = createPromptHistory(["x", "a\nb"]);
    expect(h.older("")).toBe("a\nb");
    expect(h.older("a\nb", 3)).toBeNull(); // caret on line 2: ArrowUp moves the caret
    expect(h.older("a\nb", 0)).toBe("x");
  });

  it("does nothing with no history and starts over after a record", () => {
    const h = createPromptHistory();
    expect(h.older("")).toBeNull();
    h.record("hello");
    expect(h.older("")).toBe("hello");
    h.record("world");
    expect(h.older("")).toBe("world");
  });
});

describe("historyKey", () => {
  it("derives from the draft key", () => {
    expect(historyKey("phren.composer.draft.c:s")).toBe("phren.composer.history.c:s");
  });
});
