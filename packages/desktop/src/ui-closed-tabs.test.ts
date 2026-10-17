import { describe, expect, it } from "vitest";
import { CLOSED_LIMIT, closedEntry, closedKey, createClosedStack } from "../ui/shell/closed-tabs.js";

const chat = (id: string, extra: object = {}) => ({ computer: "box", id, ...extra });

describe("closedEntry", () => {
  it("keeps the computer, id, tile and position, and drops anything else", () => {
    expect(closedEntry({ ...chat("a", { tile: "t2", index: 3, mode: "console", extra: 1 }) }))
      .toEqual({ key: "box/a", computer: "box", id: "a", tile: "t2", index: 3, mode: "console" });
    expect(closedEntry(chat("a", { tile: 4, index: -1, mode: "chat" }))).toEqual({ key: "box/a", computer: "box", id: "a" });
  });
  it("refuses rows without a computer or id", () => {
    expect(closedEntry(null)).toBeNull();
    expect(closedEntry({ computer: "box" })).toBeNull();
    expect(closedEntry({ id: "a" })).toBeNull();
    expect(closedKey("box", "a")).toBe("box/a");
  });
});

describe("createClosedStack", () => {
  const ok = () => "ok" as const;
  it("reopens the newest first, and again goes further back", () => {
    const stack = createClosedStack();
    stack.push(chat("a")); stack.push(chat("b")); stack.push(chat("c"));
    expect(stack.reopen(ok).entry?.id).toBe("c");
    expect(stack.reopen(ok).entry?.id).toBe("b");
    expect(stack.reopen(ok).entry?.id).toBe("a");
    expect(stack.reopen(ok).entry).toBeNull();
  });
  it("discards gone and already open entries and reports gone", () => {
    const stack = createClosedStack();
    stack.push(chat("a")); stack.push(chat("gone")); stack.push(chat("open"));
    const result = stack.reopen((e) => (e.id === "gone" ? "gone" : e.id === "open" ? "open" : "ok"));
    expect(result).toMatchObject({ entry: { id: "a" }, gone: true, unknown: 0 });
    expect(stack.size()).toBe(0);
  });
  it("an already open entry alone is neither gone nor unknown", () => {
    const stack = createClosedStack();
    stack.push(chat("a"));
    expect(stack.reopen(() => "open")).toEqual({ entry: null, unknown: 0, gone: false });
    expect(stack.size()).toBe(0);
  });
  it("keeps entries whose computer is not reporting, in order, and counts them", () => {
    const stack = createClosedStack();
    stack.push(chat("a", { computer: "away" })); stack.push(chat("b", { computer: "away" })); stack.push(chat("c"));
    const away = (e: { computer: string }) => (e.computer === "away" ? "unknown" : "gone");
    expect(stack.reopen(away)).toEqual({ entry: null, unknown: 2, gone: true });
    expect(stack.entries().map((e) => e.id)).toEqual(["a", "b"]);
    // Back online: the newest of them comes first again.
    expect(stack.reopen(ok).entry?.id).toBe("b");
    expect(stack.entries().map((e) => e.id)).toEqual(["a"]);
  });
  it("holds the last ten, dropping the oldest", () => {
    const stack = createClosedStack();
    for (let i = 0; i < CLOSED_LIMIT + 3; i++) stack.push(chat(`s${i}`));
    expect(stack.size()).toBe(CLOSED_LIMIT);
    expect(stack.entries()[0].id).toBe("s3");
  });
  it("moves a chat closed twice to the top without duplicating it, and records its latest place", () => {
    const stack = createClosedStack();
    stack.push(chat("a", { tile: "t1", index: 0 })); stack.push(chat("b"));
    stack.push(chat("a", { tile: "t2", index: 2 }));
    expect(stack.entries().map((e) => e.id)).toEqual(["b", "a"]);
    expect(stack.reopen(ok).entry).toMatchObject({ id: "a", tile: "t2", index: 2 });
  });
  it("ignores malformed pushes and forgets a dropped key", () => {
    const stack = createClosedStack();
    expect(stack.push({})).toBe(false);
    stack.push(chat("a"));
    stack.drop("box/a");
    expect(stack.size()).toBe(0);
  });
});
