import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM UI module
import { createMuted, notifiable, pruneMuted, unmutedRows } from "../ui/shell/muted.js";

const row = (key: string) => ({ key, computer: "Desk", child: { id: key.split("/")[1] } });
const memory = (seed?: string) => {
  const data = new Map<string, string>(seed ? [["phren.desktop.muted", seed]] : []);
  return { data, storage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } } };
};

describe("notifiable / unmutedRows", () => {
  it("lets a row notify unless its key is muted", () => {
    const muted = new Set(["Desk/a"]);
    expect(notifiable(row("Desk/a"), muted)).toBe(false);
    expect(notifiable(row("Desk/b"), muted)).toBe(true);
    expect(unmutedRows([row("Desk/a"), row("Desk/b")], muted).map((r: { key: string }) => r.key)).toEqual(["Desk/b"]);
  });

  it("returns the same list when nothing is muted", () => {
    const rows = [row("Desk/a")];
    expect(unmutedRows(rows, new Set())).toBe(rows);
  });
});

describe("pruneMuted", () => {
  it("keeps a chat missing for less than the grace period and forgets it after", () => {
    const keys = new Set(["Desk/a", "Desk/gone"]);
    const first = pruneMuted(keys, new Set(["Desk/a"]), new Map(), 1_000, 60_000);
    expect([...first.keys].sort()).toEqual(["Desk/a", "Desk/gone"]);
    const later = pruneMuted(first.keys, new Set(["Desk/a"]), first.missing, 62_000, 60_000);
    expect([...later.keys]).toEqual(["Desk/a"]);
  });

  it("restarts the clock when a chat comes back", () => {
    const first = pruneMuted(new Set(["Desk/a"]), new Set(), new Map(), 1_000, 60_000);
    const back = pruneMuted(first.keys, new Set(["Desk/a"]), first.missing, 30_000, 60_000);
    expect(back.missing.size).toBe(0);
    const gone = pruneMuted(back.keys, new Set(), back.missing, 80_000, 60_000);
    expect([...gone.keys]).toEqual(["Desk/a"]);
  });
});

describe("createMuted", () => {
  it("persists under phren.desktop.muted and reads it back, ignoring junk", () => {
    const first = memory();
    const a = createMuted({ storage: first.storage });
    expect(a.toggle("Desk/a")).toBe(true);
    a.set("Desk/b", true);
    expect(JSON.parse(first.data.get("phren.desktop.muted")!)).toEqual(["Desk/a", "Desk/b"]);
    expect(createMuted({ storage: first.storage }).has("Desk/b")).toBe(true);
    expect(a.toggle("Desk/a")).toBe(false);
    expect(createMuted({ storage: memory("not json").storage }).keys().size).toBe(0);
    expect([...createMuted({ storage: memory('["Desk/x", 3, ""]').storage }).keys()]).toEqual(["Desk/x"]);
  });

  it("prunes vanished chats after the grace period and tells subscribers", () => {
    const { storage, data } = memory('["Desk/a","Desk/gone"]');
    let now = 1_000;
    const m = createMuted({ storage, now: () => now });
    let calls = 0;
    m.subscribe(() => { calls++; });
    m.prune(new Set(["Desk/a"]));
    expect(m.has("Desk/gone")).toBe(true);
    now += 61_000;
    m.prune(new Set(["Desk/a"]));
    expect([...m.keys()]).toEqual(["Desk/a"]);
    expect(JSON.parse(data.get("phren.desktop.muted")!)).toEqual(["Desk/a"]);
    expect(calls).toBe(1);
  });

  it("works for this session when storage throws", () => {
    const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    const m = createMuted({ storage: broken });
    expect(m.keys().size).toBe(0);
    m.set("Desk/a", true);
    expect(m.has("Desk/a")).toBe(true);
  });
});
