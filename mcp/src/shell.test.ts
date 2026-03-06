import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CortexShell } from "./shell.js";
import { readBacklog, readLearnings, readMemoryQueue, loadShellState } from "./data-access.js";

interface TempContext {
  root: string;
  project: string;
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
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
  const priorActor = process.env.CORTEX_ACTOR;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-shell-test-"));
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
    fs.rmSync(dir, { recursive: true, force: true });
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

    const parsedInitial = readBacklog(dir, "demo");
    expect(typeof parsedInitial).not.toBe("string");
    if (typeof parsedInitial === "string") throw new Error(parsedInitial);
    expect(parsedInitial.items.Done.some((item) => item.line.includes("write shell tests"))).toBe(true);

    // Force multiple done entries and archive old ones.
    await shell.handleInput(":add prune this task");
    await shell.handleInput(":complete prune this task");
    await shell.handleInput(":tidy 1");

    const parsedAfterTidy = readBacklog(dir, "demo");
    expect(typeof parsedAfterTidy).not.toBe("string");
    if (typeof parsedAfterTidy === "string") throw new Error(parsedAfterTidy);
    expect(parsedAfterTidy.items.Done.length).toBe(1);
    const archiveFile = path.join(dir, ".governance", "backlog-archive", "demo.md");
    expect(fs.existsSync(archiveFile)).toBe(true);
  });

  it("adds and removes learnings from shell commands", async () => {
    const shell = createShell(dir);
    await shell.handleInput(":open demo");
    await shell.handleInput(":learn add Shell can write learnings");

    let learnings = readLearnings(dir, "demo");
    expect(typeof learnings).not.toBe("string");
    expect((learnings as any[]).some((entry) => entry.text.includes("Shell can write learnings"))).toBe(true);

    await shell.handleInput(":learn remove Shell can write learnings");
    learnings = readLearnings(dir, "demo");
    expect((learnings as any[]).some((entry) => entry.text.includes("Shell can write learnings"))).toBe(false);
  });

  it("triages memory queue entries with approve/reject/edit", async () => {
    const shell = createShell(dir);
    await shell.handleInput(":open demo");
    await shell.handleInput(":mq edit M1 keep this memory updated");
    await shell.handleInput(":mq approve M1");
    await shell.handleInput(":mq reject stale memory");

    const queue = readMemoryQueue(dir, "demo");
    expect(typeof queue).not.toBe("string");
    expect((queue as any[]).length).toBe(0);

    const learnings = readLearnings(dir, "demo") as any[];
    expect(learnings.some((entry) => entry.text.includes("keep this memory updated"))).toBe(true);
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
});
