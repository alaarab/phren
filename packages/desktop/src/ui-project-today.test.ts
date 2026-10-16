import { afterEach, expect, it } from "vitest";
// @ts-expect-error plain ESM
import { todayGroups } from "../ui/shell/project-today.js";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });

const now = new Date(2026, 9, 16, 15, 0, 0).getTime();
const at = (day: number, h: number) => new Date(2026, 9, day, h).toISOString();
const chat = (id: string, lastChangedAt: string) => ({ computer: "This computer", child: { id, lastChangedAt } });

it("keeps chats changed today, newest first, and pulls updated today without repeating the current one", () => {
  const out = todayGroups({
    sessions: [chat("old", at(15, 23)), chat("a", at(16, 9)), chat("b", at(16, 14)), chat("none", "")],
    current: { number: 42, state: "OPEN", checks: "failing" },
    pulls: [
      { number: 42, checks: "failing", updated: at(16, 13) },
      { number: 41, updated: at(15, 13) },
      { number: 40, state: "merged", updated: at(16, 10) },
    ],
  }, now);
  expect(out.chats.map((c: { row: { child: { id: string } } }) => c.row.child.id)).toEqual(["b", "a"]);
  expect(out.prs.map((p: { pull: { number: number }; merged: boolean; failing: boolean }) => [p.pull.number, p.merged, p.failing])).toEqual([[42, false, true], [40, true, false]]);
  expect(out.memory).toEqual([]);
  expect(out.total).toBe(4);
});

it("counts findings through the UTC-date rule, once each, and is empty with no activity", () => {
  process.env.TZ = "UTC";
  const out = todayGroups({
    findings: [
      { id: "f1", text: "  saved\n today ", created: "2026-10-16" },
      { id: "f1", text: "same", created: "2026-10-16" },
      { id: "f2", text: "yesterday", created: "2026-10-14" },
    ],
    project: "phren", computer: "This computer",
  }, new Date(2026, 9, 16, 15).getTime());
  expect(out.memory.map((m: { id: string; text: string; project: string }) => [m.id, m.text, m.project])).toEqual([["f1", "saved today", "phren"]]);
  expect(todayGroups({ sessions: [chat("x", at(14, 9))], pulls: [{ number: 1, updated: at(14, 9) }], findings: [{ id: "f", created: "2026-10-14" }] }, now).total).toBe(0);
});
