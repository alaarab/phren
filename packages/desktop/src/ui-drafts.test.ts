import { describe, expect, it, vi } from "vitest";
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

  it("matches when the tab's captured target and the row's live target differ only in a late session", () => {
    const captured = { source: "claude", server: "default", pane: "7" }; // composer key made before a session existed
    const keys = new Set([draftKey(captured, "Desk")]);
    const live = { computer: "Desk", child: { id: "a", target: { ...captured, session: "s-late" } } };
    expect([...draftRowKeys(keys, [live])]).toEqual(["Desk/a"]);
    // a key from an earlier conversation in the same pane does not mark the new one
    const older = new Set([draftKey({ ...captured, session: "s-old" }, "Desk")]);
    expect(draftRowKeys(older, [live]).size).toBe(0);
    // a row whose session has not arrived yet matches its pane's keys
    expect([...draftRowKeys(older, [{ computer: "Desk", child: { id: "a", target: captured } }])]).toEqual(["Desk/a"]);
    // pane 7 must not claim pane 70's draft
    const other = new Set([draftKey({ ...captured, pane: "70" }, "Desk")]);
    expect(draftRowKeys(other, [live]).size).toBe(0);
  });

  it("maps a conductor row like any other (it is an overview row with a target)", () => {
    const conductor = { computer: "Desk", child: { id: "cond", role: "conductor", target: { source: "claude", server: "default", pane: "2", session: "c1" } } };
    expect([...draftRowKeys(new Set([draftKey(conductor.child.target, "Desk")]), [conductor])]).toEqual(["Desk/cond"]);
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

describe("window listeners", () => {
  const key = draftKey(target("1"), "Desk");
  function withWindow(run: (fire: (name: string, event: object) => void, storage: ReturnType<typeof memory>) => void) {
    const handlers = new Map<string, (e: object) => void>();
    vi.stubGlobal("window", { addEventListener: (name: string, fn: (e: object) => void) => handlers.set(name, fn) });
    try { run((name, event) => handlers.get(name)!(event), memory()); } finally { vi.unstubAllGlobals(); }
  }

  it("follows phren:draft from the composer", () => {
    withWindow((fire, mem) => {
      const drafts = createDrafts({ storage: mem.storage });
      fire("phren:draft", { detail: { key, value: "typing" } });
      expect(drafts.keys().has(key)).toBe(true);
      fire("phren:draft", { detail: { key, value: "" } });
      expect(drafts.keys().has(key)).toBe(false);
    });
  });

  it("follows storage events from this storage, rescans on a null key and ignores other areas", () => {
    withWindow((fire, mem) => {
      const drafts = createDrafts({ storage: mem.storage });
      fire("storage", { key, newValue: "from elsewhere", storageArea: mem.storage });
      expect(drafts.keys().has(key)).toBe(true);
      fire("storage", { key, newValue: null, storageArea: mem.storage }); // removed in another window
      expect(drafts.keys().has(key)).toBe(false);
      fire("storage", { key, newValue: "session storage", storageArea: {} });
      expect(drafts.keys().has(key)).toBe(false);
      mem.data.set(key, "cleared storage then rewritten");
      fire("storage", { key: null, newValue: null, storageArea: mem.storage }); // clear() rescans
      expect(drafts.keys().has(key)).toBe(true);
    });
  });
});
