import { describe, expect, it } from "vitest";
import { checksStrip, ciTransitions, reviewNotice, reviewTransitions, watchedSessions } from "../ui/shell/ci-watch.js";

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

describe("checksStrip", () => {
  it("puts failing requests first, then running, passing and unchecked, newest first within each", () => {
    const pulls = [
      { ...pull("passing"), number: 7 }, { ...pull(null), number: 9 }, { ...pull("failing"), number: 3 },
      { ...pull("pending"), number: 5 }, { ...pull("failing"), number: 8 },
    ];
    expect(checksStrip(pulls).map((p) => `${p.checks}#${p.number}`)).toEqual(["failing#8", "failing#3", "pending#5", "passing#7", "null#9"]);
  });
});

describe("reviewTransitions", () => {
  type Look = Parameters<typeof reviewTransitions>[1] extends Map<string, infer V> ? V : never;
  const look = (decision: string | null, conflicts = false, key = "a"): [string, Look] =>
    [key, { key, project: "phren", computer: "mini", number: 42, title: "Keep the session", ref: "#", decision, conflicts, checks: null } as Look];
  const run = (looks: Array<Array<[string, Look]>>) => {
    const announced = new Set<string>();
    let previous = new Map<string, Look>();
    return looks.map((entries) => {
      const current = new Map(entries);
      const out = reviewTransitions(previous, current, announced).map((t: { state: string }) => t.state);
      previous = current;
      return out;
    });
  };

  it("announces each transition once and nothing on first sight", () => {
    expect(run([
      [look("CHANGES_REQUESTED", true)], // first sight: baseline only
      [look("CHANGES_REQUESTED", true)],
      [look(null)], // both cleared
      [look("CHANGES_REQUESTED")],
      [look("CHANGES_REQUESTED")],
    ])).toEqual([[], [], [], ["changes"], []]);
  });

  it("announces approval only when it was not approved before; approved to approved is silent", () => {
    expect(run([[look("REVIEW_REQUIRED")], [look("APPROVED")], [look("APPROVED")], [look("REVIEW_REQUIRED")], [look("APPROVED")]]))
      .toEqual([[], ["approved"], [], [], ["approved"]]);
  });

  it("announces conflicts again after they were cleared and came back", () => {
    expect(run([[look(null)], [look(null, true)], [look(null, true)], [look(null, false)], [look(null, true)]]))
      .toEqual([[], ["conflicts"], [], [], ["conflicts"]]);
  });

  it("forgets a request that leaves the watch set, so it is a first sight again", () => {
    expect(run([[look(null)], [], [look("APPROVED")], [look("CHANGES_REQUESTED")]])).toEqual([[], [], [], ["changes"]]);
  });

  it("titles each notice", () => {
    const pull = { project: "phren", computer: "mini", number: 42, title: "Keep the session", ref: "#" };
    expect((["changes", "approved", "conflicts"] as const).map((state) => reviewNotice({ pull, state }).title)).toEqual([
      "Changes requested on #42 Keep the session", "Approved: #42 Keep the session", "#42 Keep the session now has conflicts",
    ]);
  });
});

