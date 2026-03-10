import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { handleTaskPromptLifecycle } from "../task-lifecycle.js";
import { readBacklog } from "../data-access.js";

describe("task lifecycle backlog proactivity gating", () => {
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
    writeFile(path.join(tmp.path, project, "backlog.md"), `# ${project} tasks\n\n## Active\n\n## Queue\n\n## Done\n`);
    writeFile(path.join(tmp.path, project, "CLAUDE.md"), "Repo: https://github.com/alaarab/cortex\n");
    delete process.env.CORTEX_PROACTIVITY;
    delete process.env.CORTEX_PROACTIVITY_BACKLOG;
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    delete process.env.CORTEX_PROACTIVITY;
    delete process.env.CORTEX_PROACTIVITY_BACKLOG;
    tmp.cleanup();
  });

  it("keeps automatic backlog capture at high", () => {
    process.env.CORTEX_PROACTIVITY_BACKLOG = "high";

    const result = handleTaskPromptLifecycle({
      cortexPath: tmp.path,
      prompt: "Implement automatic task management for hooks",
      project,
      sessionId: "session-high",
      intent: "build",
      backlogLevel: "high",
    });

    expect(result.mode).toBe("auto");
    expect(result.noticeLines.join("\n")).toContain("Active task");

    const backlog = readBacklog(tmp.path, project);
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;
    expect(backlog.data.items.Active).toHaveLength(1);
    expect(backlog.data.items.Active[0].line).toBe("Implement automatic task management for hooks");
  });

  it('requires an explicit "add to backlog" signal at medium', () => {
    process.env.CORTEX_PROACTIVITY_BACKLOG = "medium";

    const blocked = handleTaskPromptLifecycle({
      cortexPath: tmp.path,
      prompt: "Implement automatic task management for hooks",
      project,
      sessionId: "session-medium-blocked",
      intent: "build",
      backlogLevel: "medium",
    });

    expect(blocked.mode).toBe("auto");
    expect(blocked.noticeLines).toEqual([]);

    let backlog = readBacklog(tmp.path, project);
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;
    expect(backlog.data.items.Active).toHaveLength(0);

    const allowed = handleTaskPromptLifecycle({
      cortexPath: tmp.path,
      prompt: "Please add this to backlog: wire proactivity level checks",
      project,
      sessionId: "session-medium-allowed",
      intent: "build",
      backlogLevel: "medium",
    });

    expect(allowed.mode).toBe("auto");
    expect(allowed.noticeLines.join("\n")).toContain("Active task");

    backlog = readBacklog(tmp.path, project);
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;
    expect(backlog.data.items.Active).toHaveLength(1);
    expect(backlog.data.items.Active[0].line).toBe("Wire proactivity level checks");
  });

  it("disables automatic backlog capture at low", () => {
    process.env.CORTEX_PROACTIVITY_BACKLOG = "low";

    const result = handleTaskPromptLifecycle({
      cortexPath: tmp.path,
      prompt: "Add task: wire proactivity level checks",
      project,
      sessionId: "session-low",
      intent: "build",
      backlogLevel: "low",
    });

    expect(result.mode).toBe("auto");
    expect(result.noticeLines).toEqual([]);

    const backlog = readBacklog(tmp.path, project);
    expect(backlog.ok).toBe(true);
    if (!backlog.ok) return;
    expect(backlog.data.items.Active).toHaveLength(0);
    expect(backlog.data.items.Queue).toHaveLength(0);
  });
});
