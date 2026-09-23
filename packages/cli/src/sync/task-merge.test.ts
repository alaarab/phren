import { describe, expect, it } from "vitest";
import { mergeTasksByBid } from "./task-merge.js";

const task = (bid: string, text: string, done = false, extra = "") =>
  `- [${done ? "x" : " "}] ${text} <!-- bid:${bid} rank:${parseInt(bid.slice(0, 2), 16)} created:2026-09-20T10:00:00.000Z scope:shared -->${extra ? `\n  Context: ${extra}` : ""}`;

function doc(sections: Record<string, string[]>): string {
  const out = ["# demo tasks", ""];
  for (const [name, items] of Object.entries(sections)) out.push(`## ${name}`, "", ...items, "");
  return out.join("\n");
}

const A = task("a1a1a1a1", "Ship the release notes");
const B = task("b2b2b2b2", "Fix the flaky sync test");
const C = task("c3c3c3c3", "Rename the settings screen");

const base = doc({ Active: [], Queue: [A, B, C], Done: [] });

describe("mergeTasksByBid", () => {
  it("keeps the side that changed each task", () => {
    const ours = doc({ Active: [], Queue: [task("a1a1a1a1", "Ship the release notes", false, "draft is in docs/"), B, C], Done: [] });
    const theirs = doc({ Active: [], Queue: [A, task("b2b2b2b2", "Fix the flaky sync test on Linux"), C], Done: [] });
    const merged = mergeTasksByBid(base, ours, theirs);
    expect(merged).toBe(doc({
      Active: [],
      Queue: [task("a1a1a1a1", "Ship the release notes", false, "draft is in docs/"), task("b2b2b2b2", "Fix the flaky sync test on Linux"), C],
      Done: [],
    }));
  });

  it("takes the incoming side when both edited the same task, and a completion over an edit", () => {
    const ours = doc({ Active: [], Queue: [task("a1a1a1a1", "Ship the release notes (local)"), B], Done: [task("c3c3c3c3", "Rename the settings screen", true)] });
    const theirs = doc({ Active: [], Queue: [task("a1a1a1a1", "Ship the release notes (remote)"), B, task("c3c3c3c3", "Rename the settings screen to Preferences")], Done: [] });
    const merged = mergeTasksByBid(base, ours, theirs);
    expect(merged).toContain("Ship the release notes (remote)");
    expect(merged).not.toContain("(local)");
    expect(merged).toBe(doc({
      Active: [],
      Queue: [task("a1a1a1a1", "Ship the release notes (remote)"), B],
      Done: [task("c3c3c3c3", "Rename the settings screen", true)],
    }));
  });

  it("keeps a completion made on one side while the other side left the task alone", () => {
    const theirs = doc({ Active: [], Queue: [A, C], Done: [task("b2b2b2b2", "Fix the flaky sync test", true)] });
    const merged = mergeTasksByBid(base, base, theirs);
    expect(merged).toBe(theirs);
    const mergedLocal = mergeTasksByBid(base, theirs, base);
    expect(mergedLocal).toBe(doc({ Active: [], Queue: [A, C], Done: [task("b2b2b2b2", "Fix the flaky sync test", true)] }));
  });

  it("keeps tasks added on both sides in their sections", () => {
    const D = task("d4d4d4d4", "Add the sync doctor check");
    const E = task("e5e5e5e5", "Document apns.json");
    const F = task("f6f6f6f6", "Trim the hook log");
    const ours = doc({ Active: [F], Queue: [A, D, B, C], Done: [] });
    const theirs = doc({ Active: [], Queue: [A, B, C, E], Done: [] });
    expect(mergeTasksByBid(base, ours, theirs)).toBe(doc({ Active: [F], Queue: [A, D, B, C, E], Done: [] }));
  });

  it("removes a task removed on one side and unchanged on the other, but keeps one edited there", () => {
    const ours = doc({ Active: [], Queue: [A, C], Done: [] });
    const theirs = doc({ Active: [], Queue: [A, B, task("c3c3c3c3", "Rename the settings screen", false, "owner wants Preferences")], Done: [] });
    const merged = mergeTasksByBid(base, ours, theirs);
    expect(merged).not.toContain("b2b2b2b2");
    expect(merged).toBe(doc({ Active: [], Queue: [A, task("c3c3c3c3", "Rename the settings screen", false, "owner wants Preferences")], Done: [] }));
    const removedRemotely = doc({ Active: [], Queue: [A, B], Done: [] });
    expect(mergeTasksByBid(base, base, removedRemotely)).toBe(removedRemotely);
  });

  it("merges an add/add file with no base and keeps sections only the local side has", () => {
    const ours = doc({ Queue: [A], Blocked: [B] });
    const theirs = doc({ Queue: [C] });
    const merged = mergeTasksByBid("", ours, theirs);
    expect(merged).toContain(A);
    expect(merged).toContain(C);
    expect(merged).toMatch(/## Blocked\n\n- \[ \] Fix the flaky sync test/);
    expect(merged.match(/c3c3c3c3/g)).toHaveLength(1);
  });
});
