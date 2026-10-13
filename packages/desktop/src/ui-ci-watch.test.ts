import { describe, expect, it } from "vitest";
import { ciTransitions, watchedSessions } from "../ui/shell/ci-watch.js";

const pull = (checks: string | null) => ({ project: "phren", computer: "This computer", number: 42, title: "Keep the session", checks });

describe("ciTransitions", () => {
  it("announces checks that settle on failing or passing, never a first sighting or no change", () => {
    const previous = new Map([["a", pull("pending")], ["b", pull("passing")], ["c", pull("failing")]]);
    const current = new Map([["a", pull("failing")], ["b", pull("passing")], ["c", pull("pending")], ["d", pull("failing")]]);
    expect(ciTransitions(previous, current).map((p) => p.checks)).toEqual(["failing"]);
    expect(ciTransitions(new Map([["a", pull("failing")]]), new Map([["a", pull("passing")]]))).toHaveLength(1);
  });
});

describe("watchedSessions", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  const row = (computer: string, cwd: string, agentStatus: string, minutesAgo: number) => ({
    computer, child: { cwd, agentStatus, target: { id: cwd }, lastChangedAt: new Date(now - minutesAgo * 60_000).toISOString() },
  });

  it("keeps one session per computer and project, working or active in the last two hours", () => {
    const picked = watchedSessions([
      row("mini", "/home/you/phren", "idle", 10),
      row("mini", "/home/you/phren", "working", 5),
      row("mini", "/home/you/gitboy", "idle", 300),
      row("mini", "/home/you/old", "working", 600),
      row("laptop", "/home/you/phren", "idle", 30),
    ], now);
    expect(picked.map((w) => `${w.computer}/${w.project}`)).toEqual(["mini/phren", "laptop/phren", "mini/old"]);
    expect(picked[0].target).toEqual({ id: "/home/you/phren" });
  });
});
