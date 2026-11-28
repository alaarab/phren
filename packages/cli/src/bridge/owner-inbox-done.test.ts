import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgeItem } from "../forge/links.js";
import { grantAdmin, makeTempDir, writeFile } from "../test-helpers.js";
import { PROVIDERS, providerFor } from "./git-hosts.js";
import { ownerInboxDone } from "./owner-inbox-done.js";
import type { InboxItem } from "./owner-inbox.js";

vi.mock("./git-hosts.js", async original => ({ ...await original<typeof import("./git-hosts.js")>(), providerFor: vi.fn() }));

const at = "2026-11-26T10:00:00.000Z";
const item = (over: Partial<InboxItem> & Pick<InboxItem, "id">): InboxItem =>
  ({ kind: "manual", title: "Merge the release", createdAt: at, updatedAt: at, state: "open", ...over });

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

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


  it("waits for a post-reopen forge read before using a cached unmerged closure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(at) + 1000);
    let finish!: (result: ForgeItem) => void;
    const refreshing = new Promise<ForgeItem>(resolve => { finish = resolve; });
    const read = vi.fn().mockResolvedValueOnce({ state: "closed" }).mockReturnValueOnce(refreshing);
    vi.mocked(providerFor).mockReturnValue({ ...PROVIDERS.github, item: read });
    const linked = item({ id: "11111111-1111-4111-8111-111111111111", pr: "https://github.com/o/r/pull/881" });
    await ownerInboxDone([linked]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await ownerInboxDone([linked])).get(linked.id)).toBe("done: PR closed without merging");
    const updated = { ...linked, title: "Merge after reopen", updatedAt: new Date(Date.parse(at) + 2000).toISOString() };
    vi.setSystemTime(Date.parse(at) + 3000);
    expect(await ownerInboxDone([updated])).toEqual(new Map());
    expect(read).toHaveBeenCalledTimes(2);
    finish({ state: "open" });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(await ownerInboxDone([updated])).toEqual(new Map());
  });

  it("never asks about resolved or non-manual items", async () => {
    const pull = vi.fn(async () => ({ state: "merged" }));
    const items = [
      { ...item({ id: "77777777-7777-4777-8777-777777777777", pr: "https://github.com/o/r/pull/1" }), state: "resolved" as const },
      { ...item({ id: "88888888-8888-4888-8888-888888888888", pr: "https://github.com/o/r/pull/2" }), kind: "blocked" as const },
    ];
    expect(await ownerInboxDone(items, { pull })).toEqual(new Map());
    expect(pull).not.toHaveBeenCalled();
  });
  it("leaves an item open when its pull read fails", async () => {
    const id = "99999999-9999-4999-8999-999999999999";
    const done = await ownerInboxDone([item({ id, pr: "https://github.com/o/r/pull/877" })], { pull: async () => { throw new Error("gh down"); } });
    expect(done.size).toBe(0);
  });
});
