import { describe, expect, it, vi } from "vitest";
import { ownerInboxDone } from "./owner-inbox-done.js";
import type { InboxItem } from "./owner-inbox.js";

const at = "2026-11-26T10:00:00.000Z";
const item = (over: Partial<InboxItem> & Pick<InboxItem, "id">): InboxItem =>
  ({ kind: "manual", title: "Merge the release", createdAt: at, updatedAt: at, state: "open", ...over });

describe("owner inbox auto-resolution", () => {
  it("resolves merged and closed pulls, leaves open and unread ones alone", async () => {
    const pull = vi.fn(async (url: string) =>
      url.endsWith("/877") ? { state: "merged" } : url.endsWith("/878") ? { state: "closed" } : url.endsWith("/879") ? { state: "open" } : undefined);
    const items = [
      item({ id: "11111111-1111-4111-8111-111111111111", pr: "https://github.com/o/r/pull/877" }),
      item({ id: "22222222-2222-4222-8222-222222222222", pr: "https://github.com/o/r/pull/878" }),
      item({ id: "33333333-3333-4333-8333-333333333333", pr: "https://github.com/o/r/pull/879" }),
      item({ id: "44444444-4444-4444-8444-444444444444", pr: "https://github.com/o/r/pull/880" }),
    ];
    const done = await ownerInboxDone(items, { pull });
    expect(done.get(items[0].id)).toBe("done: PR merged");
    expect(done.get(items[1].id)).toBe("done: PR closed without merging");
    expect(done.has(items[2].id)).toBe(false);
    expect(done.has(items[3].id)).toBe(false);
    expect(pull).toHaveBeenCalledTimes(4);
  });
  it("resolves a task link only on positive evidence the task is Done", async () => {
    const id = "55555555-5555-4555-8555-555555555555";
    const linked = item({ id, task: "bid:c2cc33d0" });
    expect((await ownerInboxDone([linked], { task: async () => true })).get(id)).toBe("done: task bid:c2cc33d0 is Done");
    expect(await ownerInboxDone([linked], { task: async () => false })).toEqual(new Map());
    expect(await ownerInboxDone([linked], { task: async () => undefined })).toEqual(new Map());
    expect(await ownerInboxDone([linked], { task: async () => { throw new Error("store unreadable"); } })).toEqual(new Map());
  });
  it("reads the pull first when an item links both a pr and a task", async () => {
    const pull = vi.fn(async () => ({ state: "open" })), task = vi.fn(async () => true);
    const both = item({ id: "66666666-6666-4666-8666-666666666666", pr: "https://github.com/o/r/pull/877", task: "bid:c2cc33d0" });
    expect(await ownerInboxDone([both], { pull, task })).toEqual(new Map());
    expect(pull).toHaveBeenCalledWith("https://github.com/o/r/pull/877");
    expect(task).not.toHaveBeenCalled();
  });
  it("never asks about resolved or non-manual items", async () => {
    const pull = vi.fn(async () => ({ state: "merged" })), task = vi.fn(async () => true);
    const items = [
      { ...item({ id: "77777777-7777-4777-8777-777777777777", pr: "https://github.com/o/r/pull/1" }), state: "resolved" as const },
      { ...item({ id: "88888888-8888-4888-8888-888888888888", pr: "https://github.com/o/r/pull/2", task: "bid:c2cc33d0" }), kind: "blocked" as const },
    ];
    expect(await ownerInboxDone(items, { pull, task })).toEqual(new Map());
    expect(pull).not.toHaveBeenCalled();
    expect(task).not.toHaveBeenCalled();
  });
  it("leaves an item open when its pull read fails", async () => {
    const id = "99999999-9999-4999-8999-999999999999";
    const done = await ownerInboxDone([item({ id, pr: "https://github.com/o/r/pull/877" })], { pull: async () => { throw new Error("gh down"); } });
    expect(done.size).toBe(0);
  });
});
