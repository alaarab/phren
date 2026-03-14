import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { handleTaskPromptLifecycle } from "../task-lifecycle.js";
import { readTasks } from "../data-access.js";
import { hasSuppressTaskIntent, hasCodeChangeContext } from "../proactivity.js";

describe("hasSuppressTaskIntent", () => {
  it("detects straight-apostrophe don't create a task", () => {
    expect(hasSuppressTaskIntent("don't create a task for this")).toBe(true);
  });

  it("detects curly-apostrophe don\u2019t add to task", () => {
    expect(hasSuppressTaskIntent("don\u2019t add that to task")).toBe(true);
  });

  it("detects no task signal", () => {
    expect(hasSuppressTaskIntent("no task needed here")).toBe(true);
  });

  it("does not match normal actionable prompts", () => {
    expect(hasSuppressTaskIntent("implement the feature")).toBe(false);
  });
});

describe("hasCodeChangeContext", () => {
  it("detects git diff command", () => {
    expect(hasCodeChangeContext("git diff shows the changes")).toBe(true);
  });

  it("detects npm run command", () => {
    expect(hasCodeChangeContext("run npm run build to compile")).toBe(true);
  });

  it("detects explicit file edit language", () => {
    expect(hasCodeChangeContext("edit the file to fix the bug")).toBe(true);
  });

  it("does not match pure brainstorming", () => {
    expect(hasCodeChangeContext("let's brainstorm ideas for the feature")).toBe(false);
  });
});

describe("task lifecycle suppression", () => {
  let tmp: { path: string; cleanup: () => void };
  const project = "demo";

  beforeEach(() => {
    tmp = makeTempDir("task-lifecycle-suppression-");
    grantAdmin(tmp.path);
    writeFile(path.join(tmp.path, ".governance", "workflow-policy.json"), JSON.stringify({
      schemaVersion: 1,

      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale", "Conflicts"],
      taskMode: "auto",
    }, null, 2) + "\n");
    writeFile(path.join(tmp.path, project, "tasks.md"), `# ${project} tasks\n\n## Active\n\n## Queue\n\n## Done\n`);
    writeFile(path.join(tmp.path, project, "CLAUDE.md"), "Repo: https://github.com/alaarab/phren\n");
    delete process.env.PHREN_PROACTIVITY;
    delete process.env.PHREN_PROACTIVITY_TASKS;
  });

  afterEach(() => {
    delete process.env.PHREN_ACTOR;
    delete process.env.PHREN_PROACTIVITY;
    delete process.env.PHREN_PROACTIVITY_TASKS;
    tmp.cleanup();
  });

  it("suppresses task when prompt contains don't create a task", () => {
    process.env.PHREN_PROACTIVITY_TASKS = "high";

    const result = handleTaskPromptLifecycle({
      phrenPath: tmp.path,
      prompt: "implement the feature but don't create a task for this",
      project,
      sessionId: "session-suppress-1",
      intent: "build",
      taskLevel: "high",
    });

    expect(result.mode).toBe("auto");
    expect(result.noticeLines).toEqual([]);

    const tasks = readTasks(tmp.path, project);
    expect(tasks.ok).toBe(true);
    if (!tasks.ok) return;
    expect(tasks.data.items.Active).toHaveLength(0);
  });

  it("suppresses task when prompt contains no task", () => {
    process.env.PHREN_PROACTIVITY_TASKS = "high";

    const result = handleTaskPromptLifecycle({
      phrenPath: tmp.path,
      prompt: "no task, just fix the lint warning in utils.ts",
      project,
      sessionId: "session-suppress-2",
      intent: "build",
      taskLevel: "high",
    });

    expect(result.mode).toBe("auto");
    expect(result.noticeLines).toEqual([]);

    const tasks = readTasks(tmp.path, project);
    expect(tasks.ok).toBe(true);
    if (!tasks.ok) return;
    expect(tasks.data.items.Active).toHaveLength(0);
  });
});

describe("task lifecycle task proactivity gating", () => {
  let tmp: { path: string; cleanup: () => void };
  const project = "demo";

  beforeEach(() => {
    tmp = makeTempDir("task-lifecycle-proactivity-");
    grantAdmin(tmp.path);
    writeFile(path.join(tmp.path, ".governance", "workflow-policy.json"), JSON.stringify({
      schemaVersion: 1,

      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale", "Conflicts"],
      taskMode: "auto",
    }, null, 2) + "\n");
    writeFile(path.join(tmp.path, project, "tasks.md"), `# ${project} tasks\n\n## Active\n\n## Queue\n\n## Done\n`);
    writeFile(path.join(tmp.path, project, "CLAUDE.md"), "Repo: https://github.com/alaarab/phren\n");
    delete process.env.PHREN_PROACTIVITY;
    delete process.env.PHREN_PROACTIVITY_TASKS;
  });

  afterEach(() => {
    delete process.env.PHREN_ACTOR;
    delete process.env.PHREN_PROACTIVITY;
    delete process.env.PHREN_PROACTIVITY_TASKS;
    tmp.cleanup();
  });

  it("keeps automatic task capture at high", () => {
    process.env.PHREN_PROACTIVITY_TASKS = "high";

    const result = handleTaskPromptLifecycle({
      phrenPath: tmp.path,
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
    process.env.PHREN_PROACTIVITY_TASKS = "medium";

    const blocked = handleTaskPromptLifecycle({
      phrenPath: tmp.path,
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
      phrenPath: tmp.path,
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
    process.env.PHREN_PROACTIVITY_TASKS = "low";

    const result = handleTaskPromptLifecycle({
      phrenPath: tmp.path,
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
