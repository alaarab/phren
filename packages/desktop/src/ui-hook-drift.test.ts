import { describe, expect, it } from "vitest";
import { compareVersions, hookDrift, updateCommand } from "../ui/shell/hook-drift.js";

const computer = (name: string, version: string | undefined, state = "online") => ({ computer: name, state, overview: { groups: [], phren: version ? { version } : undefined } });

describe("hookDrift", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("0.3.45", "0.3.9")).toBe(1);
    expect(compareVersions("0.3.44", "0.3.45")).toBe(-1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(0);
  });

  it("flags online computers behind the newest Hook seen", () => {
    const drift = hookDrift([computer("mini", "0.3.45"), computer("nas", "0.3.44"), computer("pj", "0.3.39", "offline"), computer("jets", undefined)]);
    expect(drift.newest).toBe("0.3.45");
    expect([...drift.behind]).toEqual([["nas", "0.3.44"]]);
  });

  it("names the update command for the newest version", () => {
    expect(updateCommand("0.3.45")).toBe("npx --yes @phren/cli@0.3.45 bridge update");
  });
});
