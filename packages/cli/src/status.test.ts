import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OverBudget, StoreHealth, StoreHealthCounts } from "./governance/store-health.js";
import { CLI_PATH, initTestPhrenRoot, setupIsolatedCliEnv, writeFile } from "./test-helpers.js";

const DAY_MS = 86_400_000;
const totals: StoreHealthCounts = {
  activeFindings: 20, archivedBullets: 4, olderBullets: 2, retiredBullets: 4,
  contradictedBullets: 0, bulletsWithoutFid: 0, duplicateTexts: 3, duplicateFids: 1,
  citations: { none: 0, timestampOnly: 0, withFile: 26, withCommit: 0, withSymbol: 0, withRemote: 0 },
  checkableCitations: { any: 15, withFile: 15 }, openTasks: 8, doneTasks: 0, reviewEntries: 6,
};
const store = { name: "example", path: ".", projects: [], totals, citationCoverage: 0.75 };
const overBudget: OverBudget[] = [
  { component: "openTasks", store: "example", project: "project-a", value: 8, budget: 5, effect: "capture paused" },
  { component: "reviewEntries", store: "example", project: "project-b", value: 6, budget: 5, effect: "queue paused" },
  { component: "runtimeBytes", value: 3_145_728, budget: 2_097_152, effect: "reported only" },
  { component: "fanoutArchiveBytes", value: 200, budget: 100, effect: "reported only" },
];

let fixture: ReturnType<typeof setupIsolatedCliEnv>;

beforeEach(() => {
  fixture = setupIsolatedCliEnv("phren-status-");
  initTestPhrenRoot(fixture.phrenDir);
});

afterEach(() => fixture.cleanup());

function snapshot(over: OverBudget[] = [], at = new Date().toISOString()): StoreHealth {
  return {
    at, computer: "example-computer", stores: [store], budgets: { over }, recall: null,
    runtimeBytes: { code: 2_097_152, "log.jsonl": 1_048_576 },
    runtimeClasses: { codeIndexes: 2_097_152, fanoutArchive: 0, fanouts: 0, sessions: 0, packages: 0, logs: 1_048_576, other: 0 },
  };
}

function writeHistory(...entries: StoreHealth[]): void {
  writeFile(path.join(fixture.phrenDir, ".runtime", "store-health.jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
}

function statusHealth(): string {
  // File-backed stdout also works in sandboxes that deny child-process pipes.
  const outputFile = path.join(fixture.rootDir, "status.txt");
  const fd = fs.openSync(outputFile, "w");
  try {
    const result = spawnSync(process.execPath, [CLI_PATH, "status"], {
      cwd: fixture.rootDir,
      env: { ...process.env, ...fixture.env({ PATH: fixture.homeDir, PHREN_FEDERATION_PATHS: "" }) },
      stdio: ["ignore", fd, fd],
      timeout: 10_000,
    });
    if (result.error) throw result.error;
    expect(result.status, fs.readFileSync(outputFile, "utf8")).toBe(0);
  } finally {
    fs.closeSync(fd);
  }
  const output = fs.readFileSync(outputFile, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
  const section = output.split("\n\n").find(block => block.startsWith("  Store health"));
  expect(section, `Store health section missing in:\n${output}`).toBeDefined();
  return section!;
}

describe("phren status store health", () => {
  it("shows each store's numbers and runtime size from the newest daily line", () => {
    const latest = snapshot();
    latest.stores[0] = { ...store, projects: Array.from({ length: 80 }, (_, i) => ({ ...totals, project: `project-${i}` })) };
    latest.stores.push({ ...store, name: "shared", path: "../shared", citationCoverage: 0.125, totals: { ...totals, retiredBullets: 0, duplicateTexts: 0, duplicateFids: 0 } });
    writeHistory(snapshot(overBudget, new Date(Date.now() - DAY_MS).toISOString()), latest);

    const health = statusHealth();
    expect(health).toContain(latest.at.slice(0, 10));
    expect(health).toContain("0 items over budget");
    expect(health).toContain("Citation coverage  example 75% · shared 12.5%");
    expect(health).toContain("Retired bullets  example 4 · shared 0");
    expect(health).toContain("Duplicates  example 3 texts, 1 ID · shared 0 texts, 0 IDs");
    expect(health).toContain(".runtime  3 MB (largest: code indexes, 2 MB)");
    expect(health).not.toContain("stale");
    expect(health.split("\n")).toHaveLength(6);
  });

  it.each([3, 4])("shows the count for %i budget breaches and names them when they fit", count => {
    writeHistory(snapshot(overBudget.slice(0, count)));

    const budget = statusHealth().split("\n").find(line => line.includes("over budget"));
    expect(budget?.trim()).toBe(count === 3
      ? "3 items over budget (example/project-a open tasks, example/project-b review entries, .runtime)"
      : "4 items over budget");
  });

  it("says when the first snapshot will appear if the health log is absent", () => {
    expect(statusHealth()).toBe("  Store health  first snapshot appears after the daily background maintenance");
  });

  it("shows the date and marks a snapshot older than three days as stale", () => {
    const at = new Date(Date.now() - 3 * DAY_MS - 60_000).toISOString();
    writeHistory(snapshot([], at));
    const heading = statusHealth().split("\n")[0];
    expect(heading).toContain(at.slice(0, 10));
    expect(heading).toContain("stale, older than 3 days");
  });
});
