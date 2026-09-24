import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.useRealTimers();
  tmpCleanup();
});

// ── readTasks ──────────────────────────────────────────────────────────────

describe("readTasks", () => {
  it("parses priority tags", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = readTasks(tmpDir, PROJECT);
    if (!result.ok) return;
    expect(result.data.items.Active[0].priority).toBe("high");
    expect(result.data.items.Queue[1].priority).toBe("medium");
    expect(result.data.items.Queue[2].priority).toBe("low");
    expect(result.data.items.Queue[0].priority).toBeUndefined();
  });
});

// ── addTask ────────────────────────────────────────────────────────────────

describe("addTask", () => {
  it("timestamps new tasks and preserves their date through edits and completion", () => {
    writeTaskFile(SAMPLE_TASKS);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:34:56.789Z"));
    const added = addTask(tmpDir, PROJECT, "Date me");
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.data.createdAt).toBe("2026-09-10T12:34:56.789Z");
    vi.setSystemTime(new Date("2026-10-20T01:02:03Z"));
    expect(updateTask(tmpDir, PROJECT, added.data.stableId!, { text: "Renamed", section: "Active" }).ok).toBe(true);
    expect(completeTask(tmpDir, PROJECT, added.data.stableId!).ok).toBe(true);
    const after = readTasks(tmpDir, PROJECT);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.items.Done.find(t => t.stableId === added.data.stableId)?.createdAt).toBe("2026-09-10T12:34:56.789Z");
    expect(after.data.items.Queue.every(t => t.createdAt === undefined)).toBe(true);
  });

  it("assigns a stable ID", () => {
    const result = addTask(tmpDir, PROJECT, "Stable ID task");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.stableId).toMatch(/^[a-f0-9]{8}$/);
  });

  it("rejects invalid or missing project", () => {
    expect(addTask(tmpDir, "../bad", "nope").ok).toBe(false);
    expect(addTask(tmpDir, "missing-project", "nope").ok).toBe(false);
  });
});

// ── addTasks (bulk) ────────────────────────────────────────────────────────

describe("addTasks", () => {
  it("persists creation timestamps for every bulk-added task", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:34:56.789Z"));
    expect(addTasks(tmpDir, PROJECT, ["First", "Second"]).ok).toBe(true);
    const after = readTasks(tmpDir, PROJECT);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.items.Queue.map(t => t.createdAt)).toEqual([
      "2026-09-10T12:34:56.789Z", "2026-09-10T12:34:56.789Z",
    ]);
  });

  it("reports empty items as errors", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = addTasks(tmpDir, PROJECT, ["Good task", "", "  "]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.added).toHaveLength(1);
    expect(result.data.errors).toHaveLength(2);
  });
});

// ── completeTask ───────────────────────────────────────────────────────────

describe("completeTask", () => {
  it("rejects an invalid project name", () => {
    const result = completeTask(tmpDir, "../escape", "anything");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PROJECT_NAME");
  });

  it("returns error on empty match string", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = completeTask(tmpDir, PROJECT, "");
    expect(result.ok).toBe(false);
  });
});

// ── completeTasks (bulk) ───────────────────────────────────────────────────

describe("completeTasks", () => {
  it("reports non-matching items as errors", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = completeTasks(tmpDir, PROJECT, ["Add rate limiting", "A1", "Nonexistent"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.completed).toHaveLength(2);
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
    expect(removeTask(tmpDir, PROJECT, "Nonexistent task").ok).toBe(false);
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
  it("reports errors for non-matching items", () => {
    writeTaskFile(SAMPLE_TASKS);
    const result = removeTasks(tmpDir, PROJECT, ["Add rate limiting", "Set up CI pipeline", "Ghost task"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.removed).toHaveLength(2);
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
    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Queue.at(-1)?.line).toBe("Add rate limiting");
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
    const after = readTasks(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Queue.some((i) => i.line === "Spec task")).toBe(true);
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
});

// ── tidyDoneTasks ──────────────────────────────────────────────────────────

describe("tidyDoneTasks", () => {
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
  it("idempotent: priority tag does not accumulate across repeated updates", () => {
    // Regression for the 48× [high] bug: stripPriorityTag failed to remove the trailing
    // tag when it was followed by [pinned], so each update appended another [high].
    writeTaskFile(SAMPLE_TASKS);
    for (let i = 0; i < 50; i++) {
      const r = updateTask(tmpDir, PROJECT, "Add rate limiting", { priority: "high" });
      expect(r.ok).toBe(true);
    }
    const raw = fs.readFileSync(path.join(tmpDir, PROJECT, "tasks.md"), "utf-8");
    const matchingLine = raw.split("\n").find((l) => l.includes("rate limiting"));
    expect(matchingLine).toBeDefined();
    const occurrences = matchingLine!.match(/\[high\]/g)?.length ?? 0;
    expect(occurrences).toBe(1);
    expect(matchingLine).not.toContain("[high] [high]");
  });

  it("idempotent: priority tag does not accumulate when [pinned] is also present", () => {
    // Pin then repeatedly bump priority — the [pinned] used to block the trailing-tag
    // strip, so accumulated [high]s sat between the text and [pinned].
    writeTaskFile(SAMPLE_TASKS);
    pinTask(tmpDir, PROJECT, "Add rate limiting");
    for (let i = 0; i < 30; i++) {
      updateTask(tmpDir, PROJECT, "Add rate limiting", { priority: "high" });
    }
    const raw = fs.readFileSync(path.join(tmpDir, PROJECT, "tasks.md"), "utf-8");
    const matchingLine = raw.split("\n").find((l) => l.includes("rate limiting"));
    expect(matchingLine).toBeDefined();
    expect(matchingLine!.match(/\[high\]/g)?.length ?? 0).toBe(1);
    expect(matchingLine!.match(/\[pinned\]/g)?.length ?? 0).toBe(1);
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
});
