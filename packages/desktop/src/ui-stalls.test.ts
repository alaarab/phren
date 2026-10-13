import { describe, expect, it } from "vitest";
import { newlyStalled, stallLabel, stalledMinutes } from "../ui/shell/stalls.js";
import { stalledNotice } from "../ui/shell/needs-notify.js";

const now = Date.parse("2026-10-13T12:00:00Z");
const child = (extra: Record<string, unknown>) => ({ id: "7", title: "Fix login", label: "claude", cwd: "/home/you/phren", agentStatus: "working", ...extra });

describe("stalled sessions", () => {
  it("counts minutes since the Hook saw the last change, only on working rows", () => {
    expect(stalledMinutes(child({ stalled: true, stalledSince: "2026-10-13T11:53:00Z" }), now)).toBe(7);
    expect(stalledMinutes(child({ stalled: true, stallFor: 30 }), now)).toBe(1);
    expect(stalledMinutes(child({ stalled: true, stalledSince: "2026-10-13T11:53:00Z", agentStatus: "idle" }), now)).toBeNull();
    expect(stalledMinutes(child({}), now)).toBeNull();
  });

  it("labels minutes and hours", () => {
    expect(stallLabel(7)).toBe("stalled 7m");
    expect(stallLabel(130)).toBe("stalled 2h");
  });

  it("reports a row once, when it first stalls", () => {
    const rows = [{ key: "mini/7", computer: "mini", child: child({ stalled: true, stalledSince: "2026-10-13T11:53:00Z" }) }, { key: "mini/8", computer: "mini", child: child({ id: "8" }) }];
    expect(newlyStalled(rows, new Set()).map((r) => r.key)).toEqual(["mini/7"]);
    expect(newlyStalled(rows, new Set(["mini/7"]))).toEqual([]);
    expect(stalledNotice(rows[0]).title).toBe("phren stalled");
  });
});

describe("background work", () => {
  it("names the work a finished turn left running, only on working rows", async () => {
    const { backgroundLabel } = await import("../ui/shell/stalls.js");
    expect(backgroundLabel({ agentStatus: "working", backgroundTasks: 3 })).toBe("3 background tasks");
    expect(backgroundLabel({ agentStatus: "working", backgroundTasks: 1 })).toBe("1 background task");
    expect(backgroundLabel({ agentStatus: "working" })).toBe("");
    expect(backgroundLabel({ agentStatus: "idle", backgroundTasks: 2 })).toBe("");
  });
});
