import { describe, expect, it } from "vitest";
import { RECENT_LIMIT, acceptTab, createMru, initialSelection, lostCtrl, moveSelection, ownsCtrlTab, validKeys } from "../ui/shell/recent-mru.js";

describe("createMru", () => {
  it("puts the newest first and moves a repeat to the front without duplicating", () => {
    const mru = createMru();
    mru.touch("a").touch("b").touch("c").touch("a");
    expect(mru.list()).toEqual(["a", "c", "b"]);
  });

  it("keeps at most eight, dropping the oldest", () => {
    const mru = createMru();
    for (let i = 1; i <= 12; i++) mru.touch(`s${i}`);
    expect(RECENT_LIMIT).toBe(8);
    expect(mru.list()).toEqual(["s12", "s11", "s10", "s9", "s8", "s7", "s6", "s5"]);
  });

  it("drops sessions that no longer exist", () => {
    const mru = createMru().touch("a").touch("b").touch("c");
    mru.prune((k: string) => k !== "b");
    expect(mru.list()).toEqual(["c", "a"]);
  });

  it("restores a saved list in order and ignores empty keys", () => {
    const mru = createMru(8, ["x", "y", "z"]);
    mru.touch("").touch(undefined as never);
    expect(mru.list()).toEqual(["x", "y", "z"]);
  });
});

describe("selection", () => {
  it("starts on the previous session, or the oldest backwards, and needs two sessions", () => {
    expect(initialSelection(3)).toBe(1);
    expect(initialSelection(3, true)).toBe(2);
    expect(initialSelection(1)).toBe(-1);
    expect(initialSelection(0)).toBe(-1);
  });

  it("wraps in both directions", () => {
    expect(moveSelection(2, 3, 1)).toBe(0);
    expect(moveSelection(0, 3, -1)).toBe(2);
    expect(moveSelection(1, 3, 1)).toBe(2);
    expect(moveSelection(0, 0, 1)).toBe(-1);
  });
});

describe("ownsCtrlTab", () => {
  const within = (selector: string) => ({ closest: (q: string) => (q.split(",").map((x) => x.trim()).includes(selector) ? {} : null) });
  it("leaves Ctrl+Tab to terminals, editors and iframes only", () => {
    expect(ownsCtrlTab(within(".xterm"))).toBe(true);
    expect(ownsCtrlTab(within(".monaco-editor"))).toBe(true);
    expect(ownsCtrlTab(within("iframe"))).toBe(true);
    expect(ownsCtrlTab(within("textarea"))).toBe(false);
    expect(ownsCtrlTab(null)).toBe(false);
  });
});

describe("a missed Ctrl keyup", () => {
  it("settles on the next event with Ctrl up: open when showing, cancel when not", () => {
    expect(lostCtrl({ shown: true }, { ctrlKey: false })).toBe("commit");
    expect(lostCtrl({ shown: false }, { ctrlKey: false })).toBe("cancel");
    expect(lostCtrl({ shown: true }, { ctrlKey: true })).toBeNull();
    expect(lostCtrl(null, { ctrlKey: false })).toBeNull();
  });
});

describe("held Tab", () => {
  it("is ignored until the overlay shows, then throttled", () => {
    expect(acceptTab({ repeat: false, shown: false, now: 0, last: 0 })).toBe(true);
    expect(acceptTab({ repeat: true, shown: false, now: 1000, last: 0 })).toBe(false);
    expect(acceptTab({ repeat: true, shown: true, now: 100, last: 0 })).toBe(false);
    expect(acceptTab({ repeat: true, shown: true, now: 200, last: 0 })).toBe(true);
  });
});

describe("validKeys", () => {
  it("keeps only computer/id strings, capped", () => {
    expect(validKeys(["a/b", "nope", 3, "x/".padEnd(400, "y"), "c/d"])).toEqual(["a/b", "c/d"]);
    expect(validKeys("a/b")).toEqual([]);
    expect(validKeys(Array.from({ length: 20 }, (_, i) => `c/${i}`))).toHaveLength(8);
  });
});
