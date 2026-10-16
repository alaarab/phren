import { describe, expect, it } from "vitest";
import {
  HALF_LIFE_MS, MAX_BOOST, MAX_ENTRIES, STORE_KEY, blend, boostFactor, bump, clearRecent, decayed, prune,
  readRecent, recentRows, recordPick, weights,
} from "../ui/shell/palette-recent.js";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
function memoryStorage(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[STORE_KEY, initial]]);
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  return { data, store: store as unknown as Storage };
}

describe("frecency score", () => {
  it("halves a pick count every three days", () => {
    expect(decayed(4, NOW, NOW)).toBe(4);
    expect(decayed(4, NOW - HALF_LIFE_MS, NOW)).toBeCloseTo(2);
    expect(decayed(4, NOW - 2 * HALF_LIFE_MS, NOW)).toBeCloseTo(1);
  });

  it("boosts by 1 + 0.25 * log2(1 + count) and never past the cap", () => {
    expect(boostFactor(0)).toBe(1);
    expect(boostFactor(1)).toBeCloseTo(1.25);
    expect(boostFactor(3)).toBeCloseTo(1.5);
    expect(boostFactor(1000)).toBe(1 + MAX_BOOST);
  });

  it("lets a frequent match rise above an equal one but not above a clearly better match", () => {
    const heat = weights([{ id: "a", n: 50, t: NOW }], NOW);
    expect(blend(10, "a", heat)).toBeGreaterThan(blend(10, "b", heat));
    expect(blend(10, "a", heat)).toBeLessThan(blend(16, "b", heat));
    expect(blend(-1, "a", heat)).toBe(-1);
  });

  it("orders ties by recency, then id, in the Recent group", () => {
    const entries = [{ id: "z", n: 1, t: NOW - 10 }, { id: "a", n: 1, t: NOW - 10 }, { id: "m", n: 1, t: NOW }];
    const available = new Map(entries.map((e) => [e.id, { id: e.id }]));
    expect(recentRows(entries, available, NOW).map((r: { id: string }) => r.id)).toEqual(["m", "a", "z"]);
  });
});

describe("recent storage", () => {
  it("records picks as ids and counts only, never text", () => {
    const { data, store } = memoryStorage();
    recordPick("command:keys.search", NOW, store);
    recordPick("command:keys.search", NOW + 1000, store);
    const saved = JSON.parse(data.get(STORE_KEY) as string);
    expect(saved).toHaveLength(1);
    expect(Object.keys(saved[0]).sort()).toEqual(["id", "n", "t"]);
    expect(saved[0].n).toBeCloseTo(2, 1);
  });

  it("prunes faded, malformed, duplicate and unrememberable entries on read", () => {
    const raw = JSON.stringify([
      { id: "session:ok", n: 1, t: NOW },
      { id: "session:old", n: 1, t: NOW - 30 * DAY },
      { id: "session:ok", n: 9, t: NOW },
      { id: "memory:x", n: 5, t: NOW },
      { id: "command:palette.clear-recent", n: 5, t: NOW },
      { id: 7, n: 1, t: NOW },
      { id: "session:nan", n: "x", t: NOW },
      null,
    ]);
    expect(readRecent(NOW, memoryStorage(raw).store).map((e: { id: string }) => e.id)).toEqual(["session:ok"]);
  });

  it("caps at 200 entries, keeping the strongest", () => {
    const many = Array.from({ length: 260 }, (_, i) => ({ id: `file:${i}`, n: 1 + i / 100, t: NOW }));
    const kept = prune(many, NOW);
    expect(kept).toHaveLength(MAX_ENTRIES);
    expect(kept[0].id).toBe("file:259");
    expect(kept.some((e: { id: string }) => e.id === "file:0")).toBe(false);
  });

  it("survives corrupt JSON and a storage that throws", () => {
    expect(readRecent(NOW, memoryStorage("{nope").store)).toEqual([]);
    const blocked = () => { throw new Error("blocked"); };
    const broken = { getItem: blocked, setItem: blocked, removeItem: blocked } as unknown as Storage;
    expect(readRecent(NOW, broken)).toEqual([]);
    expect(() => recordPick("command:x", NOW, broken)).not.toThrow();
    expect(() => clearRecent(broken)).not.toThrow();
  });

  it("clears everything", () => {
    const { store } = memoryStorage();
    recordPick("command:x", NOW, store);
    clearRecent(store);
    expect(readRecent(NOW, store)).toEqual([]);
  });

  it("shows only the six latest picks and skips items that no longer exist", () => {
    let entries: { id: string; n: number; t: number }[] = [];
    for (let i = 0; i < 8; i++) entries = bump(entries, `session:${i}`, NOW + i);
    const available = new Map<string, { id: string }>();
    for (let i = 0; i < 7; i++) available.set(`session:${i}`, { id: `session:${i}` });
    const rows = recentRows(entries, available, NOW + 8).map((r: { id: string }) => r.id);
    expect(rows).toHaveLength(6);
    expect(rows).not.toContain("session:7");
    expect(rows).not.toContain("session:0");
  });
});
