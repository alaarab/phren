import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin, resultMsg } from "../test-helpers.js";
import {
  addTask,
  addTasks,
  completeTask,
  completeTasks,
  removeTask,
  removeTasks,
  readTasks,
  pinTask,
  unpinTask,
  workNextTask,
  tidyDoneTasks,
  promoteTask,
  updateTask,
  TASKS_FILENAME,
} from "../data/access.js";
import { reorderTask, applyGravity, type TaskItem } from "../data/tasks.js";

const PROJECT = "test-tasks";

let tmpDir: string;
let projectDir: string;
let tmpCleanup: () => void;

const SAMPLE_TASKS = `# test-tasks tasks

## Active

- [ ] Implement auth middleware [high]

## Queue

- [ ] Add rate limiting
- [ ] Refactor database layer [medium]
- [ ] Write documentation [low]

## Done

- [x] Set up CI pipeline
- [x] Configure linter
`;

function writeTaskFile(content: string): void {
  fs.writeFileSync(path.join(projectDir, TASKS_FILENAME), content);
}

beforeEach(() => {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("data-tasks-test-"));
  projectDir = path.join(tmpDir, PROJECT);
  fs.mkdirSync(projectDir, { recursive: true });
  grantAdmin(tmpDir);
});

afterEach(() => {
  tmpCleanup();
});

// ── readTasks ──────────────────────────────────────────────────────────────

describe("readTasks", () => {
  it("returns empty doc when no task file exists", () => {
    const result = readTasks(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items.Active).toHaveLength(0);
    expect(result.data.items.Queue).toHaveLength(0);
    expect(result.data.items.Done).toHaveLength(0);
  });

  it("parses sections correctly", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = readTasks(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items.Active).toHaveLength(1);
    expect(result.data.items.Queue).toHaveLength(3);
    expect(result.data.items.Done).toHaveLength(2);
  });

  it("parses priority tags", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = readTasks(tmpDir, PROJECT);
    if (!result.ok) return;
    expect(result.data.items.Active[0].priority).toBe("high");
    expect(result.data.items.Queue[1].priority).toBe("medium");
    expect(result.data.items.Queue[2].priority).toBe("low");
    expect(result.data.items.Queue[0].priority).toBeUndefined();
  });

  it("assigns positional IDs", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = readTasks(tmpDir, PROJECT);
    if (!result.ok) return;
    expect(result.data.items.Active[0].id).toBe("A1");
    expect(result.data.items.Queue[0].id).toBe("Q1");
    expect(result.data.items.Queue[1].id).toBe("Q2");
    expect(result.data.items.Done[0].id).toBe("D1");
  });

  it("returns error for invalid project name", () => {
    const result = readTasks(tmpDir, "../escape");
    expect(result.ok).toBe(false);
  });

  it("returns error for nonexistent project", () => {
    const result = readTasks(tmpDir, "no-such-project");
    expect(result.ok).toBe(false);
  });
});

// ── addTask ────────────────────────────────────────────────────────────────

describe("addTask", () => {
  it("adds to queue of existing task file", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = addTask(tmpDir, PROJECT, "New task item");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.line).toContain("New task item");

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    const queueLines = after.data.items.Queue.map((i) => i.line);
    expect(queueLines).toContain("New task item");
  });

  it("creates task file when none exists", () => {
    const result = addTask(tmpDir, PROJECT, "First task");
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(projectDir, TASKS_FILENAME))).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Queue).toHaveLength(1);
  });

  it("strips leading dash from item text", () => {
    const result = addTask(tmpDir, PROJECT, "- Already dashed");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.line).toBe("Already dashed");
  });

  it("preserves priority tag from item text", () => {
    const result = addTask(tmpDir, PROJECT, "Important task [high]");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.priority).toBe("high");
  });

  it("assigns a stable ID", () => {
    const result = addTask(tmpDir, PROJECT, "Stable ID task");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.stableId).toMatch(/^[a-f0-9]{8}$/);
  });

  it("rejects invalid project name", () => {
    const result = addTask(tmpDir, "../bad", "nope");
    expect(result.ok).toBe(false);
  });

  it("rejects nonexistent project", () => {
    const result = addTask(tmpDir, "missing-project", "nope");
    expect(result.ok).toBe(false);
  });

  it("passes optional metadata through", () => {
    const result = addTask(tmpDir, PROJECT, "With opts", {
      createdAt: "2026-01-01T00:00:00Z",
      sessionId: "sess-123",
      scope: "backend",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(result.data.sessionId).toBe("sess-123");
    expect(result.data.scope).toBe("backend");
  });
});

// ── addTasks (bulk) ────────────────────────────────────────────────────────

describe("addTasks", () => {
  it("adds multiple tasks in one call", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = addTasks(tmpDir, PROJECT, ["Task A", "Task B", "Task C"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.added).toHaveLength(3);
    expect(result.data.errors).toHaveLength(0);
  });

  it("reports empty items as errors", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = addTasks(tmpDir, PROJECT, ["Good task", "", "  "]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.added).toHaveLength(1);
    expect(result.data.errors).toHaveLength(2);
  });

  it("handles empty input array", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = addTasks(tmpDir, PROJECT, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.added).toHaveLength(0);
  });
});

// ── completeTask ───────────────────────────────────────────────────────────

describe("completeTask", () => {
  it("moves task to Done section", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = completeTask(tmpDir, PROJECT, "Add rate limiting");
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    const queueLines = after.data.items.Queue.map((i) => i.line);
    expect(queueLines).not.toContain("Add rate limiting");
    const doneLines = after.data.items.Done.map((i) => i.line);
    expect(doneLines).toContain("Add rate limiting");
  });

  it("marks completed task as checked", () => {
    writeTaskFile(SAMPLE_TASKS);
    completeTask(tmpDir, PROJECT, "Add rate limiting");
    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    const item = after.data.items.Done.find((i) => i.line === "Add rate limiting");
    expect(item?.checked).toBe(true);
  });

  it("returns error for nonexistent task", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = completeTask(tmpDir, PROJECT, "Nonexistent task");
    expect(result.ok).toBe(false);
  });

  it("matches by positional ID", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = completeTask(tmpDir, PROJECT, "Q1");
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Done.some((i) => i.line === "Add rate limiting")).toBe(true);
  });

  it("matches by partial text", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = completeTask(tmpDir, PROJECT, "rate limiting");
    expect(result.ok).toBe(true);
  });

  it("returns error on empty match string", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = completeTask(tmpDir, PROJECT, "");
    expect(result.ok).toBe(false);
  });

  it("can complete an Active task", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = completeTask(tmpDir, PROJECT, "Implement auth middleware");
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Active).toHaveLength(0);
  });
});

// ── completeTasks (bulk) ───────────────────────────────────────────────────

describe("completeTasks", () => {
  it("completes multiple tasks at once", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = completeTasks(tmpDir, PROJECT, ["Add rate limiting", "A1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.completed).toHaveLength(2);
    expect(result.data.errors).toHaveLength(0);
  });

  it("reports non-matching items as errors", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = completeTasks(tmpDir, PROJECT, ["Add rate limiting", "Nonexistent"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.completed).toHaveLength(1);
    expect(result.data.errors).toHaveLength(1);
  });
});

// ── removeTask ─────────────────────────────────────────────────────────────

describe("removeTask", () => {
  it("removes a task from the file", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = removeTask(tmpDir, PROJECT, "Add rate limiting");
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    const allLines = [
      ...after.data.items.Active,
      ...after.data.items.Queue,
      ...after.data.items.Done,
    ].map((i) => i.line);
    expect(allLines).not.toContain("Add rate limiting");
  });

  it("returns error for nonexistent task", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = removeTask(tmpDir, PROJECT, "Nonexistent task");
    expect(result.ok).toBe(false);
  });

  it("can remove from Done section", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = removeTask(tmpDir, PROJECT, "Set up CI pipeline");
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Done).toHaveLength(1);
  });
});

// ── removeTasks (bulk) ─────────────────────────────────────────────────────

describe("removeTasks", () => {
  it("removes multiple tasks at once", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = removeTasks(tmpDir, PROJECT, ["Add rate limiting", "Set up CI pipeline"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.removed).toHaveLength(2);
    expect(result.data.errors).toHaveLength(0);
  });

  it("reports errors for non-matching items", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = removeTasks(tmpDir, PROJECT, ["Add rate limiting", "Ghost task"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.removed).toHaveLength(1);
    expect(result.data.errors).toHaveLength(1);
  });
});

// ── pinTask / unpinTask ────────────────────────────────────────────────────

describe("pinTask", () => {
  it("pins a task and moves it to top of section", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = pinTask(tmpDir, PROJECT, "Refactor database layer");
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    const first = after.data.items.Queue[0];
    expect(first.pinned).toBe(true);
    expect(first.line).toContain("Refactor database layer");
  });

  it("returns success message when already pinned", () => {
    writeTaskFile(SAMPLE_TASKS);
    pinTask(tmpDir, PROJECT, "Add rate limiting");
    const result = pinTask(tmpDir, PROJECT, "Add rate limiting");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("Already pinned");
  });

  it("returns error for nonexistent task", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = pinTask(tmpDir, PROJECT, "Nonexistent");
    expect(result.ok).toBe(false);
  });
});

describe("unpinTask", () => {
  it("unpins a previously pinned task", () => {
    writeTaskFile(SAMPLE_TASKS);
    pinTask(tmpDir, PROJECT, "Add rate limiting");
    const result = unpinTask(tmpDir, PROJECT, "Add rate limiting");
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    const item = after.data.items.Queue.find((i) => i.line.includes("Add rate limiting"));
    expect(item?.pinned).toBeUndefined();
  });

  it("returns message when not pinned", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = unpinTask(tmpDir, PROJECT, "Add rate limiting");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("Not pinned");
  });
});

// ── reorderTask ────────────────────────────────────────────────────────────

describe("reorderTask", () => {
  it("moves a task to a different rank", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = reorderTask(tmpDir, PROJECT, "Write documentation", 1);
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Queue[0].line).toContain("Write documentation");
  });

  it("clamps rank to valid range", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = reorderTask(tmpDir, PROJECT, "Add rate limiting", 999);
    expect(result.ok).toBe(true);
  });

  it("returns error for nonexistent task", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = reorderTask(tmpDir, PROJECT, "Ghost", 1);
    expect(result.ok).toBe(false);
  });
});

// ── promoteTask ────────────────────────────────────────────────────────────

describe("promoteTask", () => {
  it("moves a Queue task to Active when moveToActive=true", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = promoteTask(tmpDir, PROJECT, "Add rate limiting", true);
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Active.some((i) => i.line === "Add rate limiting")).toBe(true);
    expect(after.data.items.Queue.some((i) => i.line === "Add rate limiting")).toBe(false);
  });

  it("clears speculative flag on promote", () => {
    addTask(tmpDir, PROJECT, "Spec task", { speculative: true });
    const result = promoteTask(tmpDir, PROJECT, "Spec task", false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.speculative).toBeUndefined();
  });

  it("does not move when moveToActive=false", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = promoteTask(tmpDir, PROJECT, "Add rate limiting", false);
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Queue.some((i) => i.line === "Add rate limiting")).toBe(true);
  });

  it("returns error for nonexistent task", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = promoteTask(tmpDir, PROJECT, "Ghost", true);
    expect(result.ok).toBe(false);
  });
});

// ── workNextTask ───────────────────────────────────────────────────────────

describe("workNextTask", () => {
  it("moves highest-priority Queue item to Active", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = workNextTask(tmpDir, PROJECT);
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    // medium is highest priority in Queue, then unranked, then low
    const activeLine = after.data.items.Active.find((i) =>
      i.line.includes("Refactor database layer"),
    );
    expect(activeLine).toBeDefined();
  });

  it("returns error when queue is empty", () => {
    writeTaskFile(`# test-tasks tasks

## Active

## Queue

## Done

`);
    const result = workNextTask(tmpDir, PROJECT);
    expect(result.ok).toBe(false);
  });

  it("creates task file if needed then errors on empty queue", () => {
    // No task file at all = empty doc = empty queue
    const result = workNextTask(tmpDir, PROJECT);
    expect(result.ok).toBe(false);
  });
});

// ── tidyDoneTasks ──────────────────────────────────────────────────────────

describe("tidyDoneTasks", () => {
  it("archives done items beyond the keep threshold", () => {
    // Create a task file with many done items
    const doneItems = Array.from({ length: 10 }, (_, i) => `- [x] Done item ${i + 1}`).join("\n");
    writeTaskFile(`# test-tasks tasks

## Active

## Queue

## Done

${doneItems}
`);
    const result = tidyDoneTasks(tmpDir, PROJECT, 3);
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Done).toHaveLength(3);

    // Check archive file was created
    const archivePath = path.join(tmpDir, ".config", "task-archive", `${PROJECT}.md`);
    expect(fs.existsSync(archivePath)).toBe(true);
  });

  it("no-ops when done count is within threshold", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = tidyDoneTasks(tmpDir, PROJECT, 30);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("No tidy needed");
  });

  it("dry-run mode does not modify files", () => {
    const doneItems = Array.from({ length: 5 }, (_, i) => `- [x] Done item ${i + 1}`).join("\n");
    writeTaskFile(`# test-tasks tasks

## Active

## Queue

## Done

${doneItems}
`);
    const result = tidyDoneTasks(tmpDir, PROJECT, 2, true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("dry-run");

    // File should be unchanged
    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Done).toHaveLength(5);
  });

  it("handles keep=0 (archive everything)", () => {
    const doneItems = Array.from({ length: 3 }, (_, i) => `- [x] Done ${i}`).join("\n");
    writeTaskFile(`# test-tasks tasks

## Active

## Queue

## Done

${doneItems}
`);
    const result = tidyDoneTasks(tmpDir, PROJECT, 0);
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Done).toHaveLength(0);
  });
});

// ── updateTask ─────────────────────────────────────────────────────────────

describe("updateTask", () => {
  it("updates task text", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = updateTask(tmpDir, PROJECT, "Add rate limiting", { text: "Add rate limiting v2" });
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Queue.some((i) => i.line.includes("rate limiting v2"))).toBe(true);
  });

  it("updates priority", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = updateTask(tmpDir, PROJECT, "Add rate limiting", { priority: "high" });
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    const item = after.data.items.Queue.find((i) => i.line.includes("rate limiting"));
    expect(item?.priority).toBe("high");
  });

  it("moves task to different section", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = updateTask(tmpDir, PROJECT, "Add rate limiting", { section: "Active" });
    expect(result.ok).toBe(true);

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Active.some((i) => i.line.includes("rate limiting"))).toBe(true);
  });

  it("rejects empty text", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = updateTask(tmpDir, PROJECT, "Add rate limiting", { text: "" });
    expect(result.ok).toBe(false);
  });

  it("appends context by default", () => {
    writeTaskFile(SAMPLE_TASKS);
    updateTask(tmpDir, PROJECT, "Add rate limiting", { context: "first context" });
    updateTask(tmpDir, PROJECT, "Add rate limiting", { context: "second context" });

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    const item = after.data.items.Queue.find((i) => i.line.includes("rate limiting"));
    expect(item?.context).toContain("first context");
    expect(item?.context).toContain("second context");
  });

  it("replaces context when replace_context is true", () => {
    writeTaskFile(SAMPLE_TASKS);
    updateTask(tmpDir, PROJECT, "Add rate limiting", { context: "old" });
    updateTask(tmpDir, PROJECT, "Add rate limiting", { context: "new", replace_context: true });

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    const item = after.data.items.Queue.find((i) => i.line.includes("rate limiting"));
    expect(item?.context).toBe("new");
  });
});

// ── applyGravity ───────────────────────────────────────────────────────────

describe("applyGravity", () => {
  it("does not affect items with recent activity", () => {
    const items: TaskItem[] = [{
      id: "Q1",
      section: "Queue",
      line: "Recent",
      checked: false,
      rank: 1,
      lastActivity: new Date().toISOString(),
    }];
    const result = applyGravity(items);
    expect(result[0].rank).toBe(1);
  });

  it("increases rank for stale items", () => {
    const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const items: TaskItem[] = [{
      id: "Q1",
      section: "Queue",
      line: "Stale",
      checked: false,
      rank: 1,
      lastActivity: staleDate,
    }];
    const result = applyGravity(items);
    expect(result[0].rank).toBeGreaterThan(1);
  });

  it("caps gravity penalty at 10", () => {
    const veryOld = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const items: TaskItem[] = [{
      id: "Q1",
      section: "Queue",
      line: "Ancient",
      checked: false,
      rank: 1,
      lastActivity: veryOld,
    }];
    const result = applyGravity(items);
    expect(result[0].rank).toBeLessThanOrEqual(11);
  });

  it("skips items without lastActivity or rank", () => {
    const items: TaskItem[] = [{
      id: "Q1",
      section: "Queue",
      line: "No metadata",
      checked: false,
    }];
    const result = applyGravity(items);
    expect(result[0].rank).toBeUndefined();
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles ambiguous match (multiple exact matches)", () => {
    writeTaskFile(`# test-tasks tasks

## Active

## Queue

- [ ] Duplicate task
- [ ] Duplicate task

## Done

`);
    const result = completeTask(tmpDir, PROJECT, "Duplicate task");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ambiguous");
  });

  it("task roundtrip preserves content", () => {
    writeTaskFile(SAMPLE_TASKS);
    addTask(tmpDir, PROJECT, "Roundtrip test [high]");
    completeTask(tmpDir, PROJECT, "Add rate limiting");
    pinTask(tmpDir, PROJECT, "Roundtrip test");

    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    const pinned = after.data.items.Queue.find((i) => i.line.includes("Roundtrip test"));
    expect(pinned).toBeDefined();
    expect(pinned?.pinned).toBe(true);
    expect(pinned?.priority).toBe("high");
  });

  it("stable IDs survive add-complete-read cycle", () => {
    const addResult = addTask(tmpDir, PROJECT, "Track me");
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) return;
    const stableId = addResult.data.stableId;

    completeTask(tmpDir, PROJECT, "Track me");
    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    const completed = after.data.items.Done.find((i) => i.stableId === stableId);
    expect(completed).toBeDefined();
  });

  it("matching by stable ID works", () => {
    writeTaskFile(SAMPLE_TASKS);
    // Add a task to get a stable ID
    const addResult = addTask(tmpDir, PROJECT, "ID match test");
    if (!addResult.ok) return;
    const bid = addResult.data.stableId!;

    const result = completeTask(tmpDir, PROJECT, bid);
    expect(result.ok).toBe(true);
  });
});
