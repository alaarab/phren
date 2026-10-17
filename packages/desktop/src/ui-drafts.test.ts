import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM UI module
import { createDrafts, draftRowKeys, isDraftText } from "../ui/shell/drafts.js";
// @ts-expect-error plain ESM UI module
import { draftKey } from "../ui/chat/composer.js";

const target = (pane: string) => ({ source: "claude", server: "default", pane, session: "s-" + pane });
const row = (computer: string, id: string, pane: string) => ({ computer, child: { id, target: target(pane) } });
const memory = (seed: Record<string, string> = {}) => {
  const data = new Map(Object.entries(seed));
  return { data, storage: { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null, getItem: (k: string) => data.get(k) ?? null } };
};

describe("draftRowKeys", () => {
  it("maps scoped draft keys to the rows that own them, unopened chats included", () => {
    const keys = new Set([draftKey(target("1"), "Desk"), draftKey(target("3"), "Desk")]);
    const rows = [row("Desk", "a", "1"), row("Desk", "b", "2"), row("Laptop", "c", "3"), row("Desk", "d", "3")];
    expect([...draftRowKeys(keys, rows)]).toEqual(["Desk/a", "Desk/d"]);
  });

  it("never matches the unscoped legacy key or a row without a target", () => {
    const keys = new Set([draftKey(target("1"))]);
    expect(draftRowKeys(keys, [row("Desk", "a", "1"), { computer: "Desk", child: { id: "x" } }]).size).toBe(0);
  });
});

describe("createDrafts", () => {
  const key = draftKey(target("1"), "Desk");

  it("caches only keys holding text, ignoring blank drafts and other keys", () => {
    const { storage } = memory({ [key]: "hello", [draftKey(target("2"), "Desk")]: "  \n", "phren.desktop.muted": "[]" });
    expect([...createDrafts({ storage }).keys()]).toEqual([key]);
  });

  it("note adds and removes a key and notifies only when membership changes", () => {
    const drafts = createDrafts({ storage: memory().storage });
    let calls = 0;
    drafts.subscribe(() => { calls++; });
    drafts.note(key, "h"); drafts.note(key, "hi");
    expect(drafts.keys().has(key)).toBe(true);
    expect(calls).toBe(1);
    drafts.note(key, ""); // sent or cleared
    expect(drafts.keys().has(key)).toBe(false);
    drafts.note("unrelated", "x");
    expect(calls).toBe(2);
  });

  it("reload rescans after another window wrote", () => {
    const { storage, data } = memory();
    const drafts = createDrafts({ storage });
    let calls = 0;
    drafts.subscribe(() => { calls++; });
    data.set(key, "typed elsewhere");
    drafts.reload();
    expect(drafts.keys().has(key)).toBe(true);
    drafts.reload();
    expect(calls).toBe(1);
  });

  it("isDraftText ignores whitespace", () => {
    expect(isDraftText(" x ")).toBe(true);
    expect(isDraftText(" \n")).toBe(false);
    expect(isDraftText(null)).toBe(false);
  });
});
