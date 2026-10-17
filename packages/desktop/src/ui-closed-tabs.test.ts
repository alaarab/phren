import { describe, expect, it } from "vitest";
import { CLOSED_LIMIT, closedEntry, closedKey, createClosedStack, reopenPosition } from "../ui/shell/closed-tabs.js";

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

describe("reopenPosition", () => {
  it("goes right after the tab that was on its left", () => {
    expect(reopenPosition(["a", "file"], { index: 5, after: "file" })).toBe(2);
    expect(reopenPosition(["a", "file", "b"], { index: 0, after: "a" })).toBe(1);
  });
  it("falls back to the old index, clamped, when that tab is gone; last when nothing is known", () => {
    expect(reopenPosition(["a", "b"], { index: 1, after: "gone" })).toBe(1);
    expect(reopenPosition(["a"], { index: 4 })).toBe(1);
    expect(reopenPosition(["a"], {})).toBeUndefined();
    expect(reopenPosition(["a"])).toBeUndefined();
  });
  it("keeps a mixed tile [A, file, B, C] in order when Close others closes C, B, A and they come back newest first", () => {
    // Closed right to left: C (left neighbour B), B (file), A (none).
    const stack = createClosedStack();
    stack.push(chat("c", { tile: "t1", index: 3, after: "chat:box/b" }));
    stack.push(chat("b", { tile: "t1", index: 2, after: "file" }));
    stack.push(chat("a", { tile: "t1", index: 0 }));
    let order = ["file"];
    for (const expected of ["a", "b", "c"]) {
      const { entry } = stack.reopen(() => "ok");
      expect(entry!.id).toBe(expected);
      order.splice(reopenPosition(order, entry!) ?? order.length, 0, `chat:box/${entry!.id}`);
    }
    expect(order).toEqual(["chat:box/a", "file", "chat:box/b", "chat:box/c"]);
  });
  it("closedEntry keeps `after` and drops a non-string one", () => {
    expect(closedEntry(chat("a", { after: "x" }))).toMatchObject({ after: "x" });
    expect(closedEntry(chat("a", { after: 3 }))).not.toHaveProperty("after");
  });
});
