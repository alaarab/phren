import { describe, expect, it } from "vitest";
import { pullIdentity, syncLabel, syncResultMessage, throttleLeft, watchHead, WATCH_DELAYS } from "../ui/store-sync.js";

describe("syncResultMessage", () => {
  it("never claims a result the Hook did not report", () => {
    expect(syncResultMessage({ state: "requested" })).toBe("Sync requested");
    expect(syncResultMessage({ state: "updated" })).toBe("Memory updated");
    expect(syncResultMessage({ state: "quiet" })).toBe("Sync requested — no new changes so far");
  });
  it("shows the Hook's message, and explains its bare 404", () => {
    expect(syncResultMessage({ error: Object.assign(new Error("Only the owner or a peer Hook can request a pull."), { status: 403 }) }))
      .toBe("Only the owner or a peer Hook can request a pull.");
    expect(syncResultMessage({ error: Object.assign(new Error("Not found."), { status: 404 }) })).toBe("This store has no matching remote branch to pull.");
  });
});

describe("watchHead", () => {
  const run = (heads: Array<string | Error>, before: string | undefined = "a") => {
    const waits: number[] = [];
    let i = 0;
    const readHead = async () => { const next = heads[Math.min(i++, heads.length - 1)]; if (next instanceof Error) throw next; return next; };
    return watchHead({ readHead, before, wait: async (ms) => { waits.push(ms); } }).then((updated) => ({ updated, waits, reads: i }));
  };
  it("waits 2, 4, 8, 16 then 15 seconds and reports no change", async () => {
    const r = await run(["a"]);
    expect(r).toEqual({ updated: false, waits: [2000, 4000, 8000, 16_000, 15_000], reads: 5 });
    expect(WATCH_DELAYS.reduce((a, b) => a + b, 0)).toBe(45_000);
  });
  it("stops at the first changed head", async () => {
    expect(await run(["a", "b", "c"])).toMatchObject({ updated: true, waits: [2000, 4000], reads: 2 });
  });
  it("ignores a failed read and tries again at the next interval", async () => {
    expect(await run([new Error("offline"), "b"])).toMatchObject({ updated: true, waits: [2000, 4000], reads: 2 });
  });
  it("takes the first good read as the baseline when the first head could not be read", async () => {
    expect(await run(["a", "a", "b"], undefined)).toMatchObject({ updated: true, reads: 3 });
  });
  it("stops when cancelled", async () => {
    let n = 0;
    const updated = await watchHead({ readHead: async () => "b", before: "a", wait: async () => {}, cancelled: () => n++ > 0 });
    expect(updated).toBe(true);
    expect(await watchHead({ readHead: async () => "b", before: "a", wait: async () => {}, cancelled: () => true })).toBe(false);
  });
});

describe("throttleLeft", () => {
  it("allows a first sync and blocks repeats for ten seconds", () => {
    expect(throttleLeft(undefined as unknown as number, 1000)).toBe(0);
    expect(throttleLeft(1000, 4000)).toBe(7000);
    expect(throttleLeft(1000, 11_000)).toBe(0);
  });
});

describe("pullIdentity and syncLabel", () => {
  it("names the primary store by id, repository and branch", () => {
    expect(pullIdentity({ stores: [{ id: "x1", primary: false }, { id: "ab12cd34", primary: true, repositoryIdentity: { repository: "me/memory", branch: "main" } }] }))
      .toEqual({ storeId: "ab12cd34", repository: "me/memory", branch: "main" });
    expect(pullIdentity({ stores: [{ id: "ab12cd34", primary: true }] })).toBeNull();
  });
  it("says primary store only when the computer has several", () => {
    expect(syncLabel({ stores: [{ id: "a" }] }).text).toBe("Sync now");
    const many = syncLabel({ stores: [{ id: "a", primary: true }, { id: "b" }] });
    expect(many.text).toBe("Sync primary store");
    expect(many.title).toMatch(/team stores are not included/);
  });
});
