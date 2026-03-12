import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "./test-helpers.js";
import { handleTaskPromptLifecycle, finalizeTaskSession } from "./task-lifecycle.js";
import { readTasks } from "./data-access.js";

describe("task lifecycle", () => {
  let tmp: { path: string; cleanup: () => void };
  const project = "demo";

  beforeEach(() => {
    tmp = makeTempDir("task-lifecycle-");
    grantAdmin(tmp.path);
    writeFile(path.join(tmp.path, ".governance", "workflow-policy.json"), JSON.stringify({
      schemaVersion: 1,
      requireMaintainerApproval: true,
      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale", "Conflicts"],
      taskMode: "manual",
    }, null, 2) + "\n");
    writeFile(path.join(tmp.path, project, "tasks.md"), `# ${project} tasks\n\n## Active\n\n## Queue\n\n## Done\n`);
    writeFile(path.join(tmp.path, project, "CLAUDE.md"), "Repo: https://github.com/alaarab/cortex\n");
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    tmp.cleanup();
  });

  it("suggest mode proposes a task without mutating tasks.md", () => {
    writeFile(path.join(tmp.path, ".governance", "workflow-policy.json"), JSON.stringify({
      schemaVersion: 1,
      requireMaintainerApproval: true,
      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale", "Conflicts"],
      taskMode: "suggest",
    }, null, 2) + "\n");

    const before = fs.readFileSync(path.join(tmp.path, project, "tasks.md"), "utf8");
    const result = handleTaskPromptLifecycle({
      cortexPath: tmp.path,
      prompt: "Implement automatic task management for hooks",
      project,
      sessionId: "session-suggest",
      intent: "build",
    });

    expect(result.mode).toBe("suggest");
    expect(result.noticeLines.join("\n")).toContain("Task suggestion");
    const after = fs.readFileSync(path.join(tmp.path, project, "tasks.md"), "utf8");
    expect(after).toBe(before);
  });

  it("auto mode creates an active task and links an explicit GitHub issue URL", () => {
    writeFile(path.join(tmp.path, ".governance", "workflow-policy.json"), JSON.stringify({
      schemaVersion: 1,
      requireMaintainerApproval: true,
      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale", "Conflicts"],
      taskMode: "auto",
    }, null, 2) + "\n");

    const result = handleTaskPromptLifecycle({
      cortexPath: tmp.path,
      prompt: "Implement automatic task management for hooks https://github.com/alaarab/cortex/issues/14",
      project,
      sessionId: "session-auto",
      intent: "build",
    });

    expect(result.mode).toBe("auto");
    expect(result.noticeLines.join("\n")).toContain("Active task");

    const task = readTasks(tmp.path, project);
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    expect(task.data.items.Active).toHaveLength(1);
    expect(task.data.items.Active[0].context).toContain("Implement automatic task management for hooks");
    expect(task.data.items.Active[0].githubIssue).toBe(14);
    expect(task.data.items.Active[0].githubUrl).toBe("https://github.com/alaarab/cortex/issues/14");
  });

  it("auto mode suggests instead of writing when discovery intent detected", () => {
    writeFile(path.join(tmp.path, ".governance", "workflow-policy.json"), JSON.stringify({
      schemaVersion: 1,
      requireMaintainerApproval: true,
      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale", "Conflicts"],
      taskMode: "auto",
    }, null, 2) + "\n");

    const before = fs.readFileSync(path.join(tmp.path, project, "tasks.md"), "utf8");
    const result = handleTaskPromptLifecycle({
      cortexPath: tmp.path,
      prompt: "Explore different caching strategies and evaluate the pros and cons",
      project,
      sessionId: "session-discovery",
      intent: "build",
    });

    expect(result.mode).toBe("auto");
    expect(result.noticeLines.join("\n")).toContain("Task suggestion");
    const after = fs.readFileSync(path.join(tmp.path, project, "tasks.md"), "utf8");
    expect(after).toBe(before);
  });

  it("auto mode writes task when execution intent detected", () => {
    writeFile(path.join(tmp.path, ".governance", "workflow-policy.json"), JSON.stringify({
      schemaVersion: 1,
      requireMaintainerApproval: true,
      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale", "Conflicts"],
      taskMode: "auto",
    }, null, 2) + "\n");

    const result = handleTaskPromptLifecycle({
      cortexPath: tmp.path,
      prompt: "Yes do it, implement the new caching layer",
      project,
      sessionId: "session-execution",
      intent: "build",
    });

    expect(result.mode).toBe("auto");
    expect(result.noticeLines.join("\n")).toContain("Active task");

    const task = readTasks(tmp.path, project);
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    expect(task.data.items.Active).toHaveLength(1);
  });

  it("auto mode writes task when both execution and discovery signals present", () => {
    writeFile(path.join(tmp.path, ".governance", "workflow-policy.json"), JSON.stringify({
      schemaVersion: 1,
      requireMaintainerApproval: true,
      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale", "Conflicts"],
      taskMode: "auto",
    }, null, 2) + "\n");

    const result = handleTaskPromptLifecycle({
      cortexPath: tmp.path,
      prompt: "Go ahead and explore the caching alternatives then ship it",
      project,
      sessionId: "session-both",
      intent: "build",
    });

    expect(result.mode).toBe("auto");
    expect(result.noticeLines.join("\n")).toContain("Active task");
  });

  it("auto mode writes task when no discovery signal present (default behavior)", () => {
    writeFile(path.join(tmp.path, ".governance", "workflow-policy.json"), JSON.stringify({
      schemaVersion: 1,
      requireMaintainerApproval: true,
      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale", "Conflicts"],
      taskMode: "auto",
    }, null, 2) + "\n");

    const result = handleTaskPromptLifecycle({
      cortexPath: tmp.path,
      prompt: "Fix the authentication middleware",
      project,
      sessionId: "session-default",
      intent: "debug",
    });

    expect(result.mode).toBe("auto");
    expect(result.noticeLines.join("\n")).toContain("Active task");
  });

  it("auto mode completes the tracked task after a successful stop", () => {
    writeFile(path.join(tmp.path, ".governance", "workflow-policy.json"), JSON.stringify({
      schemaVersion: 1,
      requireMaintainerApproval: true,
      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale", "Conflicts"],
      taskMode: "auto",
    }, null, 2) + "\n");

    handleTaskPromptLifecycle({
      cortexPath: tmp.path,
      prompt: "Fix narrow terminal task rendering",
      project,
      sessionId: "session-complete",
      intent: "debug",
    });

    finalizeTaskSession({
      cortexPath: tmp.path,
      sessionId: "session-complete",
      status: "saved-local",
      detail: "commit saved; background sync scheduled",
    });

    const task = readTasks(tmp.path, project);
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    expect(task.data.items.Active).toHaveLength(0);
    expect(task.data.items.Done[0].line).toContain("Fix narrow terminal task rendering");
  });
});
