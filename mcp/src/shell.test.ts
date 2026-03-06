import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CortexShell } from "./shell.js";
import { readBacklog, readLearnings, readMemoryQueue, loadShellState } from "./data-access.js";
import { writeFile as write, makeTempDir } from "./test-helpers.js";

interface TempContext {
  root: string;
  project: string;
}

function seedCortex(root: string): TempContext {
  const project = "demo";
  write(
    path.join(root, project, "summary.md"),
    "# demo\n\nSmall demo project for tests.\n"
  );
  write(
    path.join(root, project, "backlog.md"),
    [
      "# demo backlog",
      "",
      "## Active",
      "",
      "- [ ] active item [high]",
      "  Context: active context",
      "",
      "## Queue",
      "",
      "- [ ] queued item",
      "",
      "## Done",
      "",
      "- [x] done item",
      "",
    ].join("\n")
  );
  write(
    path.join(root, project, "LEARNINGS.md"),
    [
      "# demo LEARNINGS",
      "",
      "## 2026-03-01",
      "",
      "- Existing learning",
      "  <!-- cortex:cite {\"created_at\":\"2026-03-01T00:00:00.000Z\"} -->",
      "",
    ].join("\n")
  );
  write(
    path.join(root, project, "MEMORY_QUEUE.md"),
    [
      "# demo Memory Queue",
      "",
      "## Review",
      "",
      "- [2026-03-05] Keep this memory [confidence 0.90]",
      "",
      "## Stale",
      "",
      "- [2026-03-04] Remove stale memory [confidence 0.55]",
      "",
      "## Conflicts",
      "",
      "",
    ].join("\n")
  );

  write(path.join(root, ".governance", "runtime-health.json"), JSON.stringify({
    lastPromptAt: "2026-03-05T10:00:00.000Z",
    lastAutoSave: { at: "2026-03-05T10:01:00.000Z", status: "saved-pushed" },
    lastGovernance: { at: "2026-03-05T10:02:00.000Z", status: "ok", detail: "ok" },
  }, null, 2) + "\n");

  write(path.join(root, "machines.yaml"), "machine-a: personal\n");
  write(path.join(root, "profiles", "personal.yaml"), "name: personal\nprojects:\n  - demo\n");

  return { root, project };
}

function createShell(cortexPath: string) {
  return new CortexShell(cortexPath, "", {
    runDoctor: async (_cortexPath: string, fix?: boolean) => ({
      ok: !fix,
      machine: "machine-a",
      profile: "personal",
      checks: [
        { name: "machine-registered", ok: true, detail: "ok" },
        { name: "runtime-auto-save", ok: true, detail: "saved-pushed" },
      ],
    } as any),
    runRelink: async () => "Relink ok",
    runHooks: async () => "Hooks rerun",
    runUpdate: async () => "Updated cortex",
  });
}

describe("CortexShell", () => {
  let dir: string;
  let dirCleanup: () => void;
  const priorActor = process.env.CORTEX_ACTOR;

  beforeEach(() => {
    ({ path: dir, cleanup: dirCleanup } = makeTempDir("cortex-shell-test-"));
    seedCortex(dir);
    process.env.CORTEX_ACTOR = "shell-test-admin";
    write(
      path.join(dir, ".governance", "access-control.json"),
      JSON.stringify({
        admins: ["shell-test-admin"],
        maintainers: [],
        contributors: [],
        viewers: [],
      }, null, 2) + "\n"
    );
  });

  afterEach(() => {
    if (priorActor === undefined) delete process.env.CORTEX_ACTOR;
    else process.env.CORTEX_ACTOR = priorActor;
    dirCleanup();
  });

  it("navigates between views and preserves selected project context", async () => {
    const shell = createShell(dir);
    await shell.handleInput(":open demo");
    await shell.handleInput("b");
    let output = await shell.render();
    expect(output).toContain("[Backlog]");
    expect(output).toContain("Project: demo");

    await shell.handleInput("l");
    output = await shell.render();
    expect(output).toContain("[Learnings]");
    expect(output).toContain("Project: demo");

    shell.close();
    const state = loadShellState(dir);
    expect(state.project).toBe("demo");
  });

  it("supports backlog mutations including work next and tidy", async () => {
    const shell = createShell(dir);
    await shell.handleInput(":open demo");
    await shell.handleInput(":add write shell tests [medium]");
    await shell.handleInput(":work next");
    await shell.handleInput(":complete write shell tests");
    await shell.handleInput("y");

    const parsedInitial = readBacklog(dir, "demo");
    expect(parsedInitial.ok).toBe(true);
    if (!parsedInitial.ok) throw new Error(parsedInitial.error);
    expect(parsedInitial.data.items.Done.some((item) => item.line.includes("write shell tests"))).toBe(true);

    // Force multiple done entries and archive old ones.
    await shell.handleInput(":add prune this task");
    await shell.handleInput(":complete prune this task");
    await shell.handleInput("y");
    await shell.handleInput(":tidy 1");

    const parsedAfterTidy = readBacklog(dir, "demo");
    expect(parsedAfterTidy.ok).toBe(true);
    if (!parsedAfterTidy.ok) throw new Error(parsedAfterTidy.error);
    expect(parsedAfterTidy.data.items.Done.length).toBe(1);
    const archiveFile = path.join(dir, ".governance", "backlog-archive", "demo.md");
    expect(fs.existsSync(archiveFile)).toBe(true);
  });

  it("adds and removes learnings from shell commands", async () => {
    const shell = createShell(dir);
    await shell.handleInput(":open demo");
    await shell.handleInput(":learn add Shell can write learnings");

    let learnings = readLearnings(dir, "demo");
    expect(learnings.ok).toBe(true);
    if (learnings.ok) expect(learnings.data.some((entry) => entry.text.includes("Shell can write learnings"))).toBe(true);

    await shell.handleInput(":learn remove Shell can write learnings");
    await shell.handleInput("y");
    learnings = readLearnings(dir, "demo");
    if (learnings.ok) expect(learnings.data.some((entry) => entry.text.includes("Shell can write learnings"))).toBe(false);
  });

  it("triages memory queue entries with approve/reject/edit", async () => {
    const shell = createShell(dir);
    await shell.handleInput(":open demo");
    await shell.handleInput(":mq edit M1 keep this memory updated");
    await shell.handleInput(":mq approve M1");
    await shell.handleInput(":mq reject stale memory");
    await shell.handleInput("y");

    const queue = readMemoryQueue(dir, "demo");
    expect(queue.ok).toBe(true);
    if (queue.ok) expect(queue.data.length).toBe(0);

    const learnings = readLearnings(dir, "demo");
    if (learnings.ok) expect(learnings.data.some((entry) => entry.text.includes("keep this memory updated"))).toBe(true);
  });

  it("renders health dashboard and supports remediation commands", async () => {
    const shell = createShell(dir);
    await shell.handleInput("h");
    let output = await shell.render();
    expect(output).toContain("[Health]");
    expect(output).toContain("runtime-auto-save");
    expect(output).toContain("last auto-save");

    await shell.handleInput(":run fix");
    output = await shell.render();
    expect(output).toContain("doctor --fix completed");

    await shell.handleInput(":update");
    output = await shell.render();
    expect(output).toContain("Updated cortex");
  });

  it("migrates old shell-state format without crashing (stale-state regression)", async () => {
    const statePath = path.join(dir, ".governance", "shell-state.json");
    write(statePath, JSON.stringify({ lastView: "Backlog", project: "demo", page: 2 }, null, 2));

    const shell = createShell(dir);
    const output = await shell.render();
    expect(output).toContain("View: Backlog");
    expect(output).toContain("Project: demo");
  });

  it(":help renders help text as main content and clears on next input", async () => {
    const shell = createShell(dir);
    await shell.handleInput(":help");
    let output = await shell.render();
    expect(output).toContain("Palette Commands");
    expect(output).toContain("Navigation");
    expect(output).toContain("Press any key to dismiss.");

    await shell.handleInput("");
    output = await shell.render();
    expect(output).not.toContain("Palette Commands");
  });

  it("preserves per-view page numbers when switching views", async () => {
    const shell = createShell(dir);
    await shell.handleInput(":open demo");

    await shell.handleInput("b");
    await shell.handleInput(":page 3");
    const stateAfterBacklog = loadShellState(dir);
    expect(stateAfterBacklog.page).toBe(3);

    await shell.handleInput("l");
    const stateAfterLearnings = loadShellState(dir);
    expect(stateAfterLearnings.page).toBe(1);

    await shell.handleInput("b");
    const stateBackAgain = loadShellState(dir);
    expect(stateBackAgain.page).toBe(3);
  });

  it(":govern and :consolidate require a selected project", async () => {
    const tmp = makeTempDir("cortex-shell-empty-");
    try {
      const shell = new CortexShell(tmp.path, "", {
        runDoctor: async () => ({ ok: true, checks: [] }) as any,
        runRelink: async () => "ok",
        runHooks: async () => "ok",
        runUpdate: async () => "ok",
      });

      await shell.handleInput(":govern");
      let output = await shell.render();
      expect(output).toContain("Select a project first");

      await shell.handleInput(":consolidate");
      output = await shell.render();
      expect(output).toContain("Select a project first");
    } finally {
      tmp.cleanup();
    }
  });

  it("shows loading indicators during async operations", async () => {
    let relinkResolve: (() => void) | undefined;
    const relinkPromise = new Promise<string>((resolve) => {
      relinkResolve = () => resolve("Relink done");
    });

    const shell = new CortexShell(dir, "", {
      runDoctor: async () => ({ ok: true, checks: [] }) as any,
      runRelink: async () => relinkPromise,
      runHooks: async () => "ok",
      runUpdate: async () => "ok",
    });
    await shell.handleInput(":open demo");

    const inputPromise = shell.handleInput(":relink");
    relinkResolve!();
    await inputPromise;

    const output = await shell.render();
    expect(output).toContain("Relink done");
  });

  it("groups memory queue items by section with headers", async () => {
    const shell = createShell(dir);
    await shell.handleInput(":open demo");
    await shell.handleInput("m");
    const output = await shell.render();
    expect(output).toContain("[Memory Queue]");
    expect(output).toContain("Review");
    expect(output).toContain("Stale");
    expect(output).toMatch(/─{10,}/);
  });

  it(":undo restores file after destructive :complete action", async () => {
    const shell = createShell(dir);
    await shell.handleInput(":open demo");

    const backlogBefore = fs.readFileSync(path.join(dir, "demo", "backlog.md"), "utf8");
    await shell.handleInput(":complete active item");
    await shell.handleInput("y");

    const parsedAfter = readBacklog(dir, "demo");
    expect(parsedAfter.ok).toBe(true);
    if (parsedAfter.ok) {
      expect(parsedAfter.data.items.Done.some((i) => i.line.includes("active item"))).toBe(true);
    }

    await shell.handleInput(":undo");
    const backlogAfterUndo = fs.readFileSync(path.join(dir, "demo", "backlog.md"), "utf8");
    expect(backlogAfterUndo).toBe(backlogBefore);
  });

  it(":undo reports nothing when stack is empty", async () => {
    const shell = createShell(dir);
    await shell.handleInput(":undo");
    const output = await shell.render();
    expect(output).toContain("Nothing to undo");
  });

  it("bulk :complete with comma-separated text matches completes multiple items", async () => {
    const shell = createShell(dir);
    await shell.handleInput(":open demo");
    await shell.handleInput(":add first bulk task");
    await shell.handleInput(":add second bulk task");

    await shell.handleInput(":complete first bulk task,second bulk task");
    await shell.handleInput("y");

    const parsed = readBacklog(dir, "demo");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const doneLines = parsed.data.items.Done.map((i) => i.line);
      expect(doneLines.some((l) => l.includes("first bulk task"))).toBe(true);
      expect(doneLines.some((l) => l.includes("second bulk task"))).toBe(true);
    }
  });

  it("long-running commands include timing in status message", async () => {
    const shell = createShell(dir);
    await shell.handleInput(":open demo");
    await shell.handleInput(":relink");
    const output = await shell.render();
    expect(output).toMatch(/Relink ok.*\(\d+\.\d+s\)/);
  });

  it("per-section backlog IDs start at 1 for each section (#112)", async () => {
    const shell = createShell(dir);
    await shell.handleInput(":open demo");
    await shell.handleInput("b");
    const output = await shell.render();
    expect(output).toContain("A1");
    expect(output).toContain("Q1");
    expect(output).toContain("D1");
  });
});
