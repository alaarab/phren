import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { handleTaskPromptLifecycle } from "../task/lifecycle.js";
import { readTasks } from "../data/access.js";
import { hasSuppressTaskIntent, hasCodeChangeContext } from "../proactivity.js";

describe("hasSuppressTaskIntent", () => {
  it.each([
    ["don't create a task for this", true],
    ["don\u2019t add that to task", true],
    ["no task needed here", true],
    ["implement the feature", false],
  ])("%s -> %s", (prompt, expected) => {
    expect(hasSuppressTaskIntent(prompt)).toBe(expected);
  });
});

describe("hasCodeChangeContext", () => {
  it.each([
    ["git diff shows the changes", true],
    ["run npm run build to compile", true],
    ["edit the file to fix the bug", true],
    ["let's brainstorm ideas for the feature", false],
  ])("%s -> %s", (prompt, expected) => {
    expect(hasCodeChangeContext(prompt)).toBe(expected);
  });
});

describe("task lifecycle suppression", () => {
  let tmp: { path: string; cleanup: () => void };
  const project = "demo";

  beforeEach(() => {
    tmp = makeTempDir("task-lifecycle-suppression-");
    grantAdmin(tmp.path);
    writeFile(path.join(tmp.path, ".config", "workflow-policy.json"), JSON.stringify({
      schemaVersion: 1,

      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale", "Conflicts"],
      taskMode: "auto",
    }, null, 2) + "\n");
    writeFile(path.join(tmp.path, project, "tasks.md"), `# ${project} tasks\n\n## Active\n\n## Queue\n\n## Done\n`);
    writeFile(path.join(tmp.path, project, "AGENTS.md"), "Repo: https://github.com/alaarab/phren\n");
    delete process.env.PHREN_PROACTIVITY;
    delete process.env.PHREN_PROACTIVITY_TASKS;
  });

  afterEach(() => {
    delete process.env.PHREN_ACTOR;
    delete process.env.PHREN_PROACTIVITY;
    delete process.env.PHREN_PROACTIVITY_TASKS;
    tmp.cleanup();
  });

  it.each([
    "implement the feature but don't create a task for this",
    "no task, just fix the lint warning in utils.ts",
  ])("suppresses task when prompt says %s", (prompt) => {
    process.env.PHREN_PROACTIVITY_TASKS = "high";

    const result = handleTaskPromptLifecycle({
      phrenPath: tmp.path,
      prompt,
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
});

describe("task lifecycle task proactivity gating", () => {
  let tmp: { path: string; cleanup: () => void };
  const project = "demo";

  beforeEach(() => {
    tmp = makeTempDir("task-lifecycle-proactivity-");
    grantAdmin(tmp.path);
    writeFile(path.join(tmp.path, ".config", "workflow-policy.json"), JSON.stringify({
      schemaVersion: 1,

      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale", "Conflicts"],
      taskMode: "auto",
    }, null, 2) + "\n");
    writeFile(path.join(tmp.path, project, "tasks.md"), `# ${project} tasks\n\n## Active\n\n## Queue\n\n## Done\n`);
    writeFile(path.join(tmp.path, project, "AGENTS.md"), "Repo: https://github.com/alaarab/phren\n");
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
    // Picked up on its own: it waits in Queue, not Active.
    expect(result.noticeLines.join("\n")).toContain("Queued task");

    const task = readTasks(tmp.path, project);
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    expect(task.data.items.Active).toHaveLength(0);
    expect(task.data.items.Queue).toHaveLength(1);
    expect(task.data.items.Queue[0].line).toBe("Implement automatic task management for hooks");
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

  // ── Substance gate (regression for the conversational-fragment task spam) ────
  // At proactivityTasks=high the task lifecycle used to capture every prompt that
  // wasn't an exact match against CONVERSATIONAL_NOISE_RE. That left fragments like
  // "I just clicked on to this page", "Here's the thing", "Need this fixed", "<"
  // in tasks.md. The substance gate (min words + min chars + signal verb / path /
  // ticket / file extension / URL) rejects them all without losing real tasks.

  const observedJunkPrompts = [
    "Bro",
    "Here's the thing",
    "I just clicked on to this page",
    "Need this fixed",
    "OK",
    "<",
    "IDK man",
    "Yeah do that",
    "Wait why are those hiding by preference",
  ];

  for (const junk of observedJunkPrompts) {
    it(`substance gate at high rejects: "${junk}"`, () => {
      process.env.PHREN_PROACTIVITY_TASKS = "high";
      const result = handleTaskPromptLifecycle({
        phrenPath: tmp.path,
        prompt: junk,
        project,
        sessionId: `session-junk-${junk.slice(0, 4)}`,
        intent: "general",
        taskLevel: "high",
      });
      expect(result.noticeLines).toEqual([]);
      const tasks = readTasks(tmp.path, project);
      expect(tasks.ok).toBe(true);
      if (!tasks.ok) return;
      expect(tasks.data.items.Active).toHaveLength(0);
    });
  }

  it.each([
    "Investigate ticket 43062 — Power Portal reports tile not loading",
    "Update the regex in src/utils.ts to handle empty input",
  ])("substance gate accepts a real prompt: %s", (prompt) => {
    process.env.PHREN_PROACTIVITY_TASKS = "high";
    const result = handleTaskPromptLifecycle({
      phrenPath: tmp.path,
      prompt,
      project,
      sessionId: "session-real-ticket",
      intent: "general",
      taskLevel: "high",
    });
    const tasks = readTasks(tmp.path, project);
    expect(tasks.ok).toBe(true);
    if (!tasks.ok) return;
    expect(tasks.data.items.Queue).toHaveLength(1);
    expect(result.noticeLines.join("\n")).toContain("Queued task");
  });
});
