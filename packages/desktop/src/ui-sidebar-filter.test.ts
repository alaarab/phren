import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM UI module
import { filterSessionRows, filterWords, matchesSessionFilter } from "../ui/shell/sidebar-filter.js";

const row = (id: string, computer: string, child: Record<string, unknown>) => ({
  computer, child: { id, title: "", cwd: "/Users/you/phren", label: "phren", agent: "claude", target: { source: "claude" }, ...child },
});
const rows = [
  row("1", "Mac mini", { title: "Fix login redirect", branch: "fix/login", cwd: "/Users/you/phren" }),
  row("2", "MacBook", { title: "Review the docs", cwd: "/Users/you/website", label: "website", agent: "codex", target: { source: "codex" } }),
  row("3", "Mac mini", { title: "Migrate the index", branch: "feat/index-migrate", agent: "opencode", target: { source: "opencode" } }),
];
const ids = (list: Array<{ child: { id: string } }>) => list.map((r) => r.child.id);

describe("sidebar filter", () => {
  it("keeps everything for a blank query, as the same array", () => {
    expect(filterWords("  ")).toEqual([]);
    expect(filterSessionRows(rows, "")).toBe(rows);
    expect(filterSessionRows(rows, "   ")).toBe(rows);
  });

  it("matches title, project, branch, computer and harness without regard to case", () => {
    expect(ids(filterSessionRows(rows, "LOGIN"))).toEqual(["1"]);
    expect(ids(filterSessionRows(rows, "website"))).toEqual(["2"]);
    expect(ids(filterSessionRows(rows, "index-migrate"))).toEqual(["3"]);
    expect(ids(filterSessionRows(rows, "macbook"))).toEqual(["2"]);
    expect(ids(filterSessionRows(rows, "codex"))).toEqual(["2"]);
    expect(ids(filterSessionRows(rows, "opencode"))).toEqual(["3"]);
  });

  it("requires every word, in any order, across fields", () => {
    expect(ids(filterSessionRows(rows, "mini migrate"))).toEqual(["3"]);
    expect(ids(filterSessionRows(rows, "migrate mini"))).toEqual(["3"]);
    expect(ids(filterSessionRows(rows, "mini docs"))).toEqual([]);
    expect(ids(filterSessionRows(rows, "mac  "))).toEqual(["1", "2", "3"]);
  });

  it("copes with rows that lack optional fields", () => {
    expect(matchesSessionFilter({ computer: "mini", child: { id: "x" } }, "mini")).toBe(true);
    expect(matchesSessionFilter({ computer: "mini", child: { id: "x" } }, "nope")).toBe(false);
  });
});
