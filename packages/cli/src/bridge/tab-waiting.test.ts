import { describe, expect, it } from "vitest";
import { tabWaiting } from "./tab-waiting.js";
import type { TurnRecord } from "./turn-records.js";

const at = "2026-11-26T22:00:00.000Z";
const ended = (reply?: string): TurnRecord => ({
  terminal: "term-1", source: "claude", session: "00000003-1111-4111-8111-111111111111", seq: 2, at,
  prompt: { seq: 1, at }, stop: { seq: 2, at, ...(reply ? { reply } : {}) },
});

describe("tabWaiting", () => {
  it("names what an ended turn waits on, CI or a queue before its background work", () => {
    expect(tabWaiting(ended("Opened #940. Waiting on CI for #940."), { agentStatus: "working", backgroundTasks: 1 })).toBe("ci");
    expect(tabWaiting(ended("I'll push once the checks pass."), { agentStatus: "idle" })).toBe("ci");
    expect(tabWaiting(ended("Waiting for a slot on the Mac mini."), { agentStatus: "idle" })).toBe("queue");
    expect(tabWaiting(ended("Built the feature."), { agentStatus: "working", backgroundTasks: 2 })).toBe("background");
    expect(tabWaiting(ended("Now waiting on the MacBook rerun."), { agentStatus: "idle" })).toBe("other");
  });

  it("is absent while a turn runs, while the owner is needed, and when nothing is waited on", () => {
    const running: TurnRecord = { ...ended(), prompt: { seq: 3, at } };
    expect(tabWaiting(running, { agentStatus: "working", backgroundTasks: 1 })).toBeUndefined();
    expect(tabWaiting(ended("Waiting on CI."), { agentStatus: "blocked", backgroundTasks: 1 })).toBeUndefined();
    expect(tabWaiting(ended("Waiting on CI."), { agentStatus: "waiting" })).toBeUndefined();
    expect(tabWaiting(ended("Done. Merge it?"), { agentStatus: "idle" })).toBeUndefined();
    expect(tabWaiting(ended("I'll wait for your review."), { agentStatus: "idle" })).toBeUndefined();
    expect(tabWaiting(undefined, { agentStatus: "idle", backgroundTasks: 1 })).toBeUndefined();
  });

});
