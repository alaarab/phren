import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentBudget } from "./budget-status.js";

const GB = 1024 ** 3;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function root() {
  const dir = mkdtempSync(path.join(tmpdir(), "phren-slots-"));
  dirs.push(dir);
  return dir;
}
function ticket(dir: string, pool: string, t: Record<string, unknown>) {
  mkdirSync(path.join(dir, pool), { recursive: true });
  writeFileSync(path.join(dir, pool, `${t.id}.json`), JSON.stringify({ pid: process.pid, ...t }));
}
const env = { XDG_CONFIG_HOME: "/nonexistent-phren-config" } as NodeJS.ProcessEnv;

describe("agentBudget", () => {
  it("reports each pool's slots, running and waiting jobs, oldest first, for the phone", () => {
    const dir = root(), now = 1_000_000;
    ticket(dir, "workers", { id: "a", priority: 1, createdAt: now - 60_000, startedAt: now - 50_000, label: "fanout worker 1", state: "running" });
    ticket(dir, "workers", { id: "b", priority: 2, createdAt: now - 5_000, label: "release\nbuild", state: "waiting" });
    ticket(dir, "heavy", { id: "c", priority: 0, createdAt: now - 1_000, startedAt: now - 1_000, label: "pnpm test", state: "running" });
    const got = agentBudget({ totalBytes: 31 * GB, availableBytes: 20 * GB, load1: 2, cores: 16 }, now, dir, env);
    expect(got.workers).toEqual({ slots: 4, running: 1, waiting: 1, jobs: [
      { label: "fanout worker 1", state: "running", priority: "normal", sinceSeconds: 50 },
      { label: "release build", state: "waiting", priority: "release", sinceSeconds: 5 },
    ] });
    expect(got.heavy).toMatchObject({ slots: 2, running: 1, waiting: 0 });
    expect(got.overBudget).toBeUndefined();
  });

  it("says why the computer is over budget, and an empty pool reads as free", () => {
    const got = agentBudget({ totalBytes: 31 * GB, availableBytes: 1 * GB, load1: 40, cores: 16 }, Date.now(), root(), env);
    expect(got.workers).toEqual({ slots: 4, running: 0, waiting: 0, jobs: [] });
    expect(got.overBudget).toMatch(/memory available, under the .* floor; load 40.0 on 16 cores/);
  });
});
