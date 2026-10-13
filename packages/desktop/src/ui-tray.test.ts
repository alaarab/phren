import { describe, expect, it } from "vitest";
import { trayState } from "../ui/shell/tray.js";

const row = (n: number, child: Record<string, unknown> = {}) => ({
  key: `mini/${n}`, computer: "mini", child: { id: String(n), label: "claude", title: `Task ${n}`, cwd: "/home/you/phren", agentStatus: "waiting", ...child },
});

describe("trayState", () => {
  it("names each session by project and title, with its computer and why it needs you", () => {
    expect(trayState([row(1, { approvalPending: true }), row(2, { agentStatus: "blocked", cwd: undefined })], true)).toEqual({
      enabled: true,
      more: 0,
      rows: [
        { key: "mini/1", title: "phren: Task 1", sub: "mini · wants approval" },
        { key: "mini/2", title: "claude: Task 2", sub: "mini · is blocked" },
      ],
    });
  });

  it("keeps the menu short and counts the rest", () => {
    const state = trayState(Array.from({ length: 15 }, (_, i) => row(i)), true);
    expect(state.rows).toHaveLength(12);
    expect(state.more).toBe(3);
  });

  it("sends nothing but off when the icon is turned off", () => {
    expect(trayState([row(1)], false)).toEqual({ enabled: false });
  });

  it("offers Allow / Deny for an approval Home is watching, with what it asks", () => {
    const rows = [row(1, { approvalPending: true }), row(2, { approvalPending: true }), row(3)];
    const state = trayState(rows, true, (key: string) => (key === "mini/1" ? { actionId: "a1", summary: "Run pnpm test" } : undefined));
    expect(state.rows!.map((r: { approval?: string }) => r.approval)).toEqual(["Run pnpm test", undefined, undefined]);
  });
});
