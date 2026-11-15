import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../test-helpers.js";
import { defaultBudget, readBudget, type Pressure } from "./budget.js";
import { acquire, PRIORITIES, poolStatus, QueueTimeout } from "./slots.js";
import { elsewhereHint, runHeavy } from "./command.js";
import type { ComputerReport } from "../computers/read.js";

const GB = 1024 ** 3;
const budget = defaultBudget(31 * GB);
const calm: Pressure = { totalBytes: 31 * GB, availableBytes: 20 * GB, load1: 2, cores: 16 };
let temp: ReturnType<typeof makeTempDir> | undefined;
afterEach(() => { temp?.cleanup(); temp = undefined; vi.unstubAllEnvs(); });

function pool(overrides: Partial<Parameters<typeof acquire>[0]> = {}) {
  temp ??= makeTempDir("heavy-slots-");
  const messages: string[] = [];
  const take = (label: string, more: Partial<Parameters<typeof acquire>[0]> = {}) => acquire({ pool: "heavy", slots: 1, priority: PRIORITIES.normal, label, budget,
    pressure: async () => calm, report: m => messages.push(`${label}: ${m}`), pollMs: 5, root: temp!.path, ...overrides, ...more });
  return { take, messages };
}

describe("per-machine budget", () => {
  it("defaults to four workers and two heavy jobs on the 31 GB box, overridden by budget.yaml and then the environment", () => {
    expect(defaultBudget(31.3 * GB)).toMatchObject({ workers: 4, heavySlots: 2, minFreeBytes: 3 * GB });
    expect(defaultBudget(16 * GB)).toMatchObject({ workers: 2, heavySlots: 1 });
    temp = makeTempDir("heavy-budget-");
    const file = path.join(temp.path, "budget.yaml");
    fs.writeFileSync(file, "workers: 6\nheavySlots: 3\nminFreeGB: 5\n");
    expect(readBudget(31 * GB, { PHREN_HEAVY_SLOTS: "1" }, file)).toMatchObject({ workers: 6, heavySlots: 1, minFreeBytes: 5 * GB, maxLoadPerCore: 1.5 });
    expect(readBudget(31 * GB, { PHREN_FANOUT_WORKERS: "zero" }, path.join(temp.path, "missing.yaml")).workers).toBe(4);
  });
});

describe("heavy-job slots", () => {
  it("runs N at once and starts waiting release work before earlier normal work", async () => {
    const { take, messages } = pool();
    const first = await take("first");
    const order: string[] = [];
    const normal = take("normal").then(held => { order.push("normal"); return held; });
    await new Promise(resolve => setTimeout(resolve, 20));
    const release = take("release", { priority: PRIORITIES.release }).then(held => { order.push("release"); return held; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(messages).toContain("normal: queued: all 1 slot busy: first (pid " + process.pid + ", 0s)");
    first.release();
    (await release).release();
    (await normal).release();
    expect(order).toEqual(["release", "normal"]);
  });

  it("frees the slot of a job whose process is gone", async () => {
    const { take } = pool();
    await take("killed", { pid: 999_999 });
    const next = await take("next");
    expect(poolStatus("heavy", temp!.path).map(t => t.label)).toEqual(["next"]);
    next.release();
  });

  it("holds new work while memory is short only when something else in the pool runs", async () => {
    let pressure: Pressure = { ...calm, availableBytes: 1 * GB };
    const { take, messages } = pool({ slots: 3, pressure: async () => pressure });
    const first = await take("first");
    expect(messages[0]).toMatch(/^first: warning: 1\.0 GB of 31\.0 GB memory available, under the 3\.0 GB floor; starting anyway/);
    const second = take("second");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(messages.some(m => m.startsWith("second: queued: 1.0 GB of 31.0 GB memory available"))).toBe(true);
    pressure = calm;
    (await second).release();
    first.release();
  });

  it("gives up after the timeout and leaves no ticket behind", async () => {
    const { take } = pool();
    const held = await take("first");
    await expect(take("late", { timeoutMs: 15 })).rejects.toBeInstanceOf(QueueTimeout);
    expect(poolStatus("heavy", temp!.path).map(t => t.label)).toEqual(["first"]);
    held.release();
  });
});

it("phren heavy runs the command, returns its exit code and frees the slot", async () => {
  temp = makeTempDir("heavy-command-");
  vi.stubEnv("PHREN_SLOTS_DIR", temp.path);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await runHeavy(["--label", "exit three", "--", process.execPath, "-e", "process.exit(3)"])).toBe(3);
  expect(poolStatus("heavy", temp.path)).toEqual([]);
  await expect(runHeavy(["--slots", "0", "--", "true"])).rejects.toThrow("--slots");
});

it("names the least pressed other computer that is not stressed for a job held back here", () => {
  const computer = (name: string, local: boolean, overall: number, level = "ok") => ({ name, local, online: true,
    resources: { level, pressure: { overall }, memory: { availablePercent: 60 }, cpu: { load1: 3, cores: 10 } } }) as unknown as ComputerReport;
  const hint = elsewhereHint([computer("omarchy", true, 0.1), computer("Jets", false, 0.95, "stressed"), computer("MacBook", false, 0.4), computer("Mini", false, 0.5)], "pnpm test");
  expect(hint).toMatch(/^MacBook has room \(60% memory available, load 3 on 10 cores\)\..*phren dispatch MacBook <project> --worktree --prompt "Check out <branch>, run pnpm test, /);
  expect(elsewhereHint([computer("omarchy", true, 0.1), computer("Jets", false, 0.95, "stressed")], "pnpm test")).toBeUndefined();
});
