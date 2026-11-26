import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantAdmin, makeTempDir } from "../test-helpers.js";
import { currentSessionId, isStale, recordSessionTask, resolutionPrompt, sessionActiveCount, sessionLedgerPath, sessionTaskStates,
  STALE_MS, titleAdvice, unresolvedTasks, wipWarning } from "./session-tasks.js";

let root = "", cleanup = () => {};
beforeEach(() => { const temp = makeTempDir("session-tasks-"); root = temp.path; cleanup = temp.cleanup; grantAdmin(root); });
afterEach(() => cleanup());

function project(name: string, body: string): void {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, "tasks.md"), `# ${name} tasks\n\n${body}`);
}

describe("session task ledger", () => {
  it("judges each task the session took on", () => {
    project("app", [
      "## Active", "",
      "- [ ] Still open [high] <!-- bid:aaaaaaaa -->",
      "- [ ] Parked <!-- bid:bbbbbbbb -->", "  Context: Blocker: owner's merge; Next: rebase on main",
      "- [ ] Half parked <!-- bid:cccccccc -->", "  Context: Blocker: owner's merge",
      "", "## Queue", "", "- [ ] Returned <!-- bid:dddddddd -->",
      "", "## Done", "", "- [x] Finished <!-- bid:eeeeeeee -->", "",
    ].join("\n"));
    for (const stableId of ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee", "ffffffff"]) recordSessionTask(root, "sess-1", { store: root, project: "app", stableId });
    recordSessionTask(root, "sess-1", { store: root, project: "app", stableId: "aaaaaaaa" });
    const states = sessionTaskStates(root, "sess-1");
    expect(states.map(state => [state.stableId, state.resolution])).toEqual([
      ["bbbbbbbb", "parked"], ["cccccccc", "open"], ["dddddddd", "queue"], ["eeeeeeee", "done"], ["ffffffff", "missing"], ["aaaaaaaa", "open"],
    ]);
    expect(states.find(state => state.stableId === "aaaaaaaa")?.title).toBe("Still open");
    const open = unresolvedTasks(states);
    expect(open.map(state => state.stableId)).toEqual(["cccccccc", "aaaaaaaa"]);
    expect(resolutionPrompt(open)).toContain("app bid:aaaaaaaa: Still open");
    expect(sessionActiveCount(root, "sess-1")).toBe(3);
    expect(sessionTaskStates(root, "other")).toEqual([]);
  });

  it("ignores bad session ids, bad refs and a corrupt ledger", () => {
    expect(sessionLedgerPath(root, "../escape")).toBeUndefined();
    recordSessionTask(root, "../escape", { store: root, project: "app", stableId: "aaaaaaaa" });
    recordSessionTask(root, "s", { store: "relative", project: "app", stableId: "aaaaaaaa" });
    recordSessionTask(root, "s", { store: root, project: "app", stableId: "NOTHEX!!" });
    expect(fs.existsSync(path.join(root, ".runtime", "session-tasks"))).toBe(false);
    fs.mkdirSync(path.join(root, ".runtime", "session-tasks"), { recursive: true });
    fs.writeFileSync(sessionLedgerPath(root, "s")!, "{not json");
    expect(sessionTaskStates(root, "s")).toEqual([]);
  });

  it("reads the session id from Claude Code, then Codex", () => {
    expect(currentSessionId({ CLAUDE_CODE_SESSION_ID: "c-1", CODEX_THREAD_ID: "x-1" })).toBe("c-1");
    expect(currentSessionId({ CODEX_THREAD_ID: "x-1" })).toBe("x-1");
    expect(currentSessionId({ CLAUDE_CODE_SESSION_ID: "bad id" })).toBeUndefined();
    expect(currentSessionId({})).toBeUndefined();
  });
});

describe("limits", () => {
  it("warns past three Active tasks", () => {
    expect(wipWarning(3)).toBeUndefined();
    expect(wipWarning(4)).toContain("4 Active tasks (limit 3)");
  });

  it("splits a long title at its first clause break", () => {
    expect(titleAdvice("Fix the sync race")).toBeUndefined();
    const advice = titleAdvice("Make agents close or work off their tasks (owner 2026-11-26: 'how would you make sure you're trying to close them') [high] <!-- bid:57987805 -->")!;
    expect(advice.title).toBe("Make agents close or work off their tasks");
    expect(advice.context).toBe("(owner 2026-11-26: 'how would you make sure you're trying to close them')");
    const words = titleAdvice(`${"word ".repeat(30)}end`)!;
    expect(words.title.length).toBeLessThanOrEqual(80);
    expect(`${words.title} ${words.context}`).toBe(`${"word ".repeat(30)}end`);
  });

  it("calls an Active task stale after a day without a touch", () => {
    const now = Date.parse("2026-11-26T12:00:00Z");
    const old = new Date(now - STALE_MS - 1000).toISOString(), fresh = new Date(now - 1000).toISOString();
    expect(isStale({ section: "Active", lastActivity: old }, now)).toBe(true);
    expect(isStale({ section: "Active", lastActivity: old, claim: { computer: "m", at: fresh } }, now)).toBe(false);
    expect(isStale({ section: "Active", createdAt: old }, now)).toBe(true);
    expect(isStale({ section: "Queue", lastActivity: old }, now)).toBe(false);
    expect(isStale({ section: "Active" }, now)).toBe(false);
  });
});
