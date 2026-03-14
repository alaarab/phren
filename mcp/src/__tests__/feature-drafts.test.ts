/**
 * Feature 4: Stack-ranked priorities
 *
 * Tests for applyGravity() (unit) and the `phren task reorder` CLI command.
 *
 * Features 1–3 and 5 have dedicated test files:
 *   1. Capability registry      — capabilities.test.ts
 *   2. Task negation            — task-lifecycle-proactivity.test.ts, task-lifecycle.test.ts
 *   3. Progressive task model   — task-lifecycle.test.ts (appendChildFinding)
 *   5. Finding supersession     — __tests__/finding-supersession.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile, runCliExec } from "../test-helpers.js";
import { applyGravity } from "../data-tasks.js";
import type { TaskItem } from "../data-tasks.js";

const runCli = runCliExec;

// ── Shared fixture helpers ────────────────────────────────────────────────────

function makePhren() {
  const tmp = makeTempDir("feature-drafts-");
  grantAdmin(tmp.path);
  return tmp;
}

function makeProject(phrenPath: string, project: string) {
  const dir = path.join(phrenPath, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.md"), `# ${project}\n`);
}

function writeTasks(phrenPath: string, project: string, content: string) {
  writeFile(path.join(phrenPath, project, "tasks.md"), content);
}

function readTasks(phrenPath: string, project: string): string {
  return fs.readFileSync(path.join(phrenPath, project, "tasks.md"), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature 4: Stack-ranked priorities
// applyGravity() — display-only drift; does NOT mutate the file
// phren task reorder <project> "<text>" --rank=<n>
// ─────────────────────────────────────────────────────────────────────────────

describe("Feature 4: stack-ranked priorities", () => {
  let tmp: { path: string; cleanup: () => void };
  const project = "demo";

  const RANKED_TASKS = [
    `# ${project} tasks`,
    "",
    "## Active",
    "",
    "- [ ] Implement caching [high] <!-- bid:aaa rank:1 lastActivity:2025-01-01T00:00:00.000Z -->",
    "- [ ] Add rate limiting [medium] <!-- bid:bbb rank:2 lastActivity:2025-01-01T00:00:00.000Z -->",
    "- [ ] Refactor DB layer [low] <!-- bid:ccc rank:3 lastActivity:2026-03-01T00:00:00.000Z -->",
    "",
    "## Queue",
    "",
    "- [ ] Write docs <!-- bid:ddd rank:4 -->",
    "",
    "## Done",
    "",
  ].join("\n");

  beforeEach(() => {
    tmp = makePhren();
    makeProject(tmp.path, project);
    writeTasks(tmp.path, project, RANKED_TASKS);
  });
  afterEach(() => tmp.cleanup());

  it("applyGravity drifts tasks with stale lastActivity (>2 weeks) toward higher rank", () => {
    const items: TaskItem[] = [
      { id: "A1", stableId: "aaa", section: "Active", line: "Implement caching", checked: false, rank: 1, lastActivity: "2025-01-01T00:00:00.000Z" },
      { id: "A2", stableId: "bbb", section: "Active", line: "Add rate limiting", checked: false, rank: 2, lastActivity: "2025-01-01T00:00:00.000Z" },
      { id: "A3", stableId: "ccc", section: "Active", line: "Refactor DB layer", checked: false, rank: 3, lastActivity: new Date().toISOString() },
    ];

    const gravitated = applyGravity(items);

    const aaa = gravitated.find((i) => i.stableId === "aaa")!;
    const bbb = gravitated.find((i) => i.stableId === "bbb")!;
    const ccc = gravitated.find((i) => i.stableId === "ccc")!;

    // Stale items drift — rank number increases
    expect(aaa.rank).toBeGreaterThan(1);
    expect(bbb.rank).toBeGreaterThan(2);
    // Recent item — no drift
    expect(ccc.rank).toBe(3);
  });

  it("applyGravity caps drift at 10 positions maximum", () => {
    const items: TaskItem[] = [
      { id: "A1", stableId: "old", section: "Active", line: "Ancient task", checked: false, rank: 1, lastActivity: "2020-01-01T00:00:00.000Z" },
    ];

    const gravitated = applyGravity(items);
    const old = gravitated.find((i) => i.stableId === "old")!;
    expect(old.rank).toBeLessThanOrEqual(11); // 1 + max 10
  });

  it("applyGravity does not modify tasks with no lastActivity", () => {
    const items: TaskItem[] = [
      { id: "Q1", stableId: "ddd", section: "Queue", line: "Write docs", checked: false, rank: 4 },
    ];

    const gravitated = applyGravity(items);
    expect(gravitated[0].rank).toBe(4); // unchanged
  });

  it("applyGravity does not mutate the original items array", () => {
    const items: TaskItem[] = [
      { id: "A1", stableId: "aaa", section: "Active", line: "Stale task", checked: false, rank: 1, lastActivity: "2020-01-01T00:00:00.000Z" },
    ];

    applyGravity(items);
    // Original item should be unchanged
    expect(items[0].rank).toBe(1);
  });

  it("applyGravity ignores items without a rank field", () => {
    const items: TaskItem[] = [
      { id: "A1", stableId: "norank", section: "Active", line: "No rank task", checked: false, lastActivity: "2020-01-01T00:00:00.000Z" },
    ];

    const gravitated = applyGravity(items);
    // Should return as-is without crashing
    expect(gravitated[0].rank).toBeUndefined();
  });

  it("phren task reorder moves a task to a new rank", () => {
    const { exitCode, stdout, stderr } = runCli(
      ["task", "reorder", project, "Add rate limiting", "--rank=1"],
      { PHREN_PATH: tmp.path, PHREN_ACTOR: "test" },
    );
    expect(exitCode).toBe(0);
    void stdout; void stderr;

    // After reorder, rank:1 should now belong to "Add rate limiting"
    const content = readTasks(tmp.path, project);
    expect(content).toContain("Add rate limiting");
    // rank:1 should now appear near "Add rate limiting"
    const lines = content.split("\n");
    const rateLimitLine = lines.find((l) => l.includes("Add rate limiting")) ?? "";
    expect(rateLimitLine).toContain("rank:1");
  });

  it("phren task reorder exits non-zero when project is missing", () => {
    const { exitCode } = runCli(
      ["task", "reorder"],
      { PHREN_PATH: tmp.path, PHREN_ACTOR: "test" },
    );
    expect(exitCode).not.toBe(0);
  });

  it("phren task reorder exits non-zero when --rank is missing", () => {
    const { exitCode } = runCli(
      ["task", "reorder", project, "Implement caching"],
      { PHREN_PATH: tmp.path, PHREN_ACTOR: "test" },
    );
    expect(exitCode).not.toBe(0);
  });

  it("phren task reorder exits non-zero when task text does not match any item", () => {
    const { exitCode } = runCli(
      ["task", "reorder", project, "Nonexistent task text xyz", "--rank=1"],
      { PHREN_PATH: tmp.path, PHREN_ACTOR: "test" },
    );
    expect(exitCode).not.toBe(0);
  });
});
