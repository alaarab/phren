import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChoiceReaders } from "./account-choice.js";
import { setAccountSettings, setComputerAllowedPools } from "./account-pools.js";
import { clearAccountCaches } from "./claude-accounts.js";
import type { HarnessInventory } from "./harnesses.js";
import { createScheduleLauncher } from "./schedule-launch.js";
import { parseSchedule, type ScheduleLaunchContext, type ScheduleLauncher } from "./schedule-format.js";
import type { AccountUsage } from "./usage.js";

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(), servers: vi.fn(async () => []),
}));

// Exercise the real headless launcher, observing the home received by its child.
const FAKE_CLAUDE = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ configDir: process.env.CLAUDE_CONFIG_DIR })));
`;
const runId = "50000000-0000-4000-8000-000000000001";

describe.skipIf(process.platform === "win32")("scheduled Claude account choice", () => {
  let home: string, store: string, cwd: string, launcher: ScheduleLauncher, context: ScheduleLaunchContext;
  const listing = (): HarnessInventory => ({ harnesses: [{ source: "claude", installed: true, usable: true,
    accounts: ["default", "work", "spare", "disabled", "console"].map(id => ({ id, label: id, key: id, signedIn: true, usable: true,
      ...(id === "console" ? { console: true } : {}) })) }] });
  const usage = (id: string, usedPercent: number): AccountUsage => ({ source: "claude", account: { id, label: id, key: id },
    windows: [{ id: "five_hour", name: "5-hour", usedPercent, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] });
  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), "phren-schedule-accounts-")); store = path.join(home, "store"); cwd = path.join(home, "work");
    const bin = path.join(home, "bin");
    for (const dir of [bin, cwd, path.join(store, "demo"), path.join(home, ".claude"), path.join(home, ".claude-work"), path.join(home, ".claude-spare")]) mkdirSync(dir, { recursive: true });
    for (const id of ["work", "spare"]) writeFileSync(path.join(home, `.claude-${id}`, ".claude.json"), "{}");
    writeFileSync(path.join(bin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
    vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    // The launcher's store, rather than the Hook's default store, owns the schedule's rules.
    vi.stubEnv("PHREN_PATH", path.join(home, "other-store"));
    clearAccountCaches();
    writeFileSync(path.join(store, "demo", "phren.project.yaml"), "allowedPools: [client-a]\n");
    await setAccountSettings("default", { pool: "personal" });
    await setAccountSettings("work", { pool: "client-a", role: "helpers" });
    await setAccountSettings("spare", { pool: "client-a", role: "last-resort" });
    await setAccountSettings("disabled", { pool: "client-a", role: "off" });
    await setAccountSettings("console", { pool: "client-a" });
    await setComputerAllowedPools(["personal", "client-a"]);
    launcher = createScheduleLauncher(async () => { throw new Error("Expected a headless run"); }, store);
    const schedule = parseSchedule({ id: "7f3a2c1d", name: "Sweep", enabled: true, computer: "Desk", harness: "claude", every: "daily", at: "07:30",
      prompt: "Summarize", createdAt: "2026-03-07T16:00:00.000Z", updatedAt: "2026-03-07T16:00:00.000Z" });
    context = { schedule, project: "demo", projectDir: path.join(store, "demo"), cwd, runId };
  });
  afterEach(() => { launcher?.close?.(); setChoiceReaders({}); clearAccountCaches(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  it.each(["available", "absent", "failed"] as const)("enforces project pools and roles when usage is %s", async state => {
    setChoiceReaders({ inventory: async () => listing(), ...(state === "absent" ? {} : {
      usage: async () => { if (state === "failed") throw new Error("usage unavailable"); return [usage("default", 0), usage("work", 90), usage("spare", 0), usage("disabled", 0), usage("console", 0)]; },
    }) });
    const result = await launcher(context);
    expect(await result.completion).toEqual({ status: "finished" });
    expect(result.launch.mode).toBe("headless");
    expect(JSON.parse(readFileSync(path.join(result.launch.jobDir!, "events.jsonl"), "utf8"))).toEqual({ configDir: path.join(home, ".claude-work") });
  });

  it("uses last-resort only after the ordinary tier is exhausted", async () => {
    setChoiceReaders({ inventory: async () => listing(), usage: async () => [usage("work", 100), usage("spare", 30)] });
    const result = await launcher(context);
    expect(await result.completion).toEqual({ status: "finished" });
    expect(JSON.parse(readFileSync(path.join(result.launch.jobDir!, "events.jsonl"), "utf8"))).toEqual({ configDir: path.join(home, ".claude-spare") });
  });

  it("refuses before creating a job when the computer's pools exclude every project account", async () => {
    await setComputerAllowedPools(["personal"]);
    setChoiceReaders({ inventory: async () => listing() });
    await expect(launcher(context)).rejects.toMatchObject({ status: 409, details: { code: "account_pool" } });
    expect(existsSync(path.join(store, ".runtime", "agent-fanouts", runId))).toBe(false);
  });
});
