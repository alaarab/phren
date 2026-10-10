import { describe, expect, it } from "vitest";
import { pausePrompt, pauseSessions, pauseSummary, sessionLabel, workingSessions } from "../ui/shell/pause-all.js";

interface Row { key: string; computer: string; group: unknown; child: Record<string, unknown> }
const row = (computer: string, child: Record<string, unknown>): Row => ({ key: `${computer}/${child.id}`, computer, group: {}, child });

describe("pause all: working sessions", () => {
  it("keeps only rows that are working and carry a target", () => {
    const sessions = [
      row("Desk", { id: "a", agentStatus: "working", target: { server: "default" } }),
      row("Desk", { id: "b", agentStatus: "idle", target: { server: "default" } }),
      row("Linuxbox", { id: "c", agentStatus: "working" }),
      row("Linuxbox", { id: "d", agentStatus: "working", target: { server: "default" } }),
    ];
    expect(workingSessions(sessions).map((s) => s.child.id)).toEqual(["a", "d"]);
  });

  it("names a row by its title, project folder, then a fallback", () => {
    expect(sessionLabel(row("Desk", { id: "a", title: "Fix login" }))).toBe("Fix login on Desk");
    expect(sessionLabel(row("Desk", { id: "a", cwd: "/Users/you/phren" }))).toBe("phren on Desk");
    expect(sessionLabel(row("Desk", { id: "a" }))).toBe("session on Desk");
  });
});

describe("pause all: wording", () => {
  it("counts agents and computers in the confirm", () => {
    const sessions = [row("Desk", { id: "a" }), row("Desk", { id: "b" }), row("Linuxbox", { id: "c" })];
    expect(pausePrompt(sessions)).toBe("Pause 3 agents on 2 computers?");
    expect(pausePrompt([row("Desk", { id: "a" })])).toBe("Pause 1 agent on 1 computer?");
    expect(pausePrompt([])).toBe("No agents are working.");
  });

  it("summarizes the outcome, including misses", () => {
    expect(pauseSummary({ paused: 0, failed: [], results: [] })).toBe("No agent was working.");
    expect(pauseSummary({ paused: 1, failed: [], results: [] })).toBe("Paused 1 agent.");
    expect(pauseSummary({ paused: 3, failed: [], results: [] })).toBe("Paused 3 agents.");
    expect(pauseSummary({ paused: 1, failed: ["Two on Desk"], results: [] })).toBe("Paused 1 agent; 1 couldn't be reached: Two on Desk.");
    expect(pauseSummary({ paused: 0, failed: ["X", "Y"], results: [] })).toBe("Paused 0 agents; 2 couldn't be reached: X, Y.");
  });
});

describe("pause all: delivery", () => {
  it("stops each session and records per-session success or failure", async () => {
    const sessions = [row("Desk", { id: "a", title: "One", target: {} }), row("Desk", { id: "b", title: "Two", target: {} })];
    const stopped: string[] = [];
    const stop = async (r: Row) => { if (r.child.id === "b") throw new Error("session gone"); stopped.push(String(r.child.id)); };
    const outcome = await pauseSessions(sessions, stop);
    expect(stopped).toEqual(["a"]);
    expect(outcome.paused).toBe(1);
    expect(outcome.failed).toEqual(["Two on Desk"]);
    expect(outcome.results).toEqual([
      { label: "One on Desk", ok: true },
      { label: "Two on Desk", ok: false, error: "session gone" },
    ]);
  });
});
