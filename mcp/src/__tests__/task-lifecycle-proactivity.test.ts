import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { handleTaskPromptLifecycle } from "../task-lifecycle.js";
import { readTasks } from "../data-access.js";

describe("task lifecycle task proactivity gating", () => {
  let tmp: { path: string; cleanup: () => void };
  const project = "demo";

  beforeEach(() => {
    tmp = makeTempDir("task-lifecycle-proactivity-");
    grantAdmin(tmp.path);
    writeFile(path.join(tmp.path, ".governance", "workflow-policy.json"), JSON.stringify({
      schemaVersion: 1,
      requireMaintainerApproval: true,
      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale", "Conflicts"],
      taskMode: "auto",
    }, null, 2) + "\n");
    writeFile(path.join(tmp.path, project, "tasks.md"), `# ${project} tasks\n\n## Active\n\n## Queue\n\n## Done\n`);
    writeFile(path.join(tmp.path, project, "CLAUDE.md"), "Repo: https://github.com/alaarab/cortex\n");
    delete process.env.CORTEX_PROACTIVITY;
    delete process.env.CORTEX_PROACTIVITY_TASKS;
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    delete process.env.CORTEX_PROACTIVITY;
    delete process.env.CORTEX_PROACTIVITY_TASKS;
    tmp.cleanup();
  });

  it("keeps automatic task capture at high", () => {
    process.env.CORTEX_PROACTIVITY_TASKS = "high";

    const result = handleTaskPromptLifecycle({
      cortexPath: tmp.path,
      prompt: "Implement automatic task management for hooks",
      project,
      sessionId: "session-high",
      intent: "build",
      taskLevel: "high",
    });

    expect(result.mode).toBe("auto");
    expect(result.noticeLines.join("\n")).toContain("Active task");

    const task = readTasks(tmp.path, project);
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    expect(task.data.items.Active).toHaveLength(1);
    expect(task.data.items.Active[0].line).toBe("Implement automatic task management for hooks");
  });

  it('requires an explicit "add to task" signal at medium', () => {
    process.env.CORTEX_PROACTIVITY_TASKS = "medium";

    const blocked = handleTaskPromptLifecycle({
      cortexPath: tmp.path,
      prompt: "Implement automatic task management for hooks",
      project,
      sessionId: "session-medium-blocked",
      intent: "build",
      taskLevel: "medium",
    });

    expect(blocked.mode).toBe("auto");
    expect(blocked.noticeLines).toEqual([]);

    let task = readTasks(tmp.path, project);
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    expect(task.data.items.Active).toHaveLength(0);

    const allowed = handleTaskPromptLifecycle({
      cortexPath: tmp.path,
      prompt: "Please add this to task: wire proactivity level checks",
      project,
      sessionId: "session-medium-allowed",
      intent: "build",
      taskLevel: "medium",
    });

    expect(allowed.mode).toBe("auto");
    expect(allowed.noticeLines.join("\n")).toContain("Active task");

    task = readTasks(tmp.path, project);
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    expect(task.data.items.Active).toHaveLength(1);
    expect(task.data.items.Active[0].line).toBe("Wire proactivity level checks");
  });

  it("disables automatic task capture at low", () => {
    process.env.CORTEX_PROACTIVITY_TASKS = "low";

    const result = handleTaskPromptLifecycle({
      cortexPath: tmp.path,
      prompt: "Add task: wire proactivity level checks",
      project,
      sessionId: "session-low",
      intent: "build",
      taskLevel: "low",
    });

    expect(result.mode).toBe("auto");
    expect(result.noticeLines).toEqual([]);

    const task = readTasks(tmp.path, project);
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    expect(task.data.items.Active).toHaveLength(0);
    expect(task.data.items.Queue).toHaveLength(0);
  });
});
