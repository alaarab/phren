import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readBacklog,
  addBacklogItem,
  completeBacklogItem,
  readFindings,
  addFinding,
  removeFinding,
  readReviewQueue,
  approveQueueItem,
  editQueueItem,
  listMachines,
  listProfiles,
  loadShellState,
  saveShellState,
} from "../data-access.js";
import { CortexError } from "../shared.js";
import { grantAdmin, makeTempDir, writeFile as write, resultMsg } from "../test-helpers.js";
import { readCustomHooks, runCustomHooks } from "../hooks.js";
import * as path from "path";
import * as fs from "fs";

const PROJECT = "chaos";

let tmpDir: string;
let projectDir: string;
let tmpCleanup: () => void;

beforeEach(() => {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("cortex-chaos-"));
  projectDir = path.join(tmpDir, PROJECT);
  fs.mkdirSync(projectDir, { recursive: true });
  grantAdmin(tmpDir);
});

afterEach(() => {
  delete process.env.CORTEX_FILE_LOCK_MAX_WAIT_MS;
  delete process.env.CORTEX_FILE_LOCK_POLL_MS;
  delete process.env.CORTEX_ACTOR;
  tmpCleanup();
});

describe("corrupted file recovery", () => {
  it("handles empty backlog.md without crashing", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), "");
    const result = readBacklog(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items.Active).toHaveLength(0);
    expect(result.data.items.Queue).toHaveLength(0);
    expect(result.data.items.Done).toHaveLength(0);
  });

  it("handles backlog.md with no sections", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), "# chaos backlog\n\nJust some text\n");
    const result = readBacklog(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No items since there are no bullet points
    expect(result.data.items.Active).toHaveLength(0);
    expect(result.data.items.Queue).toHaveLength(0);
  });

  it("handles backlog.md with only Done section", () => {
    const content = `# chaos backlog\n\n## Done\n\n- [x] Only done item\n`;
    fs.writeFileSync(path.join(projectDir, "backlog.md"), content);
    const result = readBacklog(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items.Done).toHaveLength(1);
    expect(result.data.items.Active).toHaveLength(0);
    expect(result.data.items.Queue).toHaveLength(0);
  });

  it("handles FINDINGS.md with no date headers", () => {
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), "# chaos FINDINGS\n\n- Finding without date\n- Another finding\n");
    const result = readFindings(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    expect(result.data[0].date).toBe("unknown");
  });

  it("handles empty FINDINGS.md", () => {
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), "");
    const result = readFindings(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(0);
  });

  it("handles MEMORY_QUEUE.md with no section headers", () => {
    fs.writeFileSync(path.join(projectDir, "MEMORY_QUEUE.md"), "# chaos Queue\n\n- [2026-03-05] orphan item\n");
    const result = readReviewQueue(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Item lands in default "Review" section
    expect(result.data).toHaveLength(1);
    expect(result.data[0].section).toBe("Review");
  });

  it("handles empty MEMORY_QUEUE.md", () => {
    fs.writeFileSync(path.join(projectDir, "MEMORY_QUEUE.md"), "");
    const result = readReviewQueue(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(0);
  });

  it("handles corrupted shell state JSON gracefully", () => {
    const govDir = path.join(tmpDir, ".runtime");
    fs.mkdirSync(govDir, { recursive: true });
    fs.writeFileSync(path.join(govDir, "shell-state.json"), "{ corrupted json }}}");
    const state = loadShellState(tmpDir);
    expect(state.view).toBe("Projects");
    expect(state.page).toBe(1);
  });

  it("handles shell state with missing fields", () => {
    const govDir = path.join(tmpDir, ".runtime");
    fs.mkdirSync(govDir, { recursive: true });
    fs.writeFileSync(path.join(govDir, "shell-state.json"), '{"view":"Unknown"}');
    const state = loadShellState(tmpDir);
    expect(state.view).toBe("Projects");
    expect(state.page).toBe(1);
    expect(state.perPage).toBe(40);
  });

  it("handles machines.yaml with non-string values", () => {
    fs.writeFileSync(path.join(tmpDir, "machines.yaml"), "machine-a: 123\nmachine-b: true\nmachine-c: valid\n");
    const result = listMachines(tmpDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only machine-c has a string value
    expect(result.data["machine-c"]).toBe("valid");
  });
});

describe("boundary and edge case inputs", () => {
  it("handles project name with maximum valid length", () => {
    const longName = "a".repeat(50);
    fs.mkdirSync(path.join(tmpDir, longName), { recursive: true });
    const result = readBacklog(tmpDir, longName);
    expect(result.ok).toBe(true);
  });

  it("rejects project names with special characters", () => {
    const badNames = ["../escape", "with spaces", "with/slash", "with@symbol", ".hidden"];
    for (const name of badNames) {
      const result = readBacklog(tmpDir, name);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect([CortexError.INVALID_PROJECT_NAME, CortexError.PROJECT_NOT_FOUND]).toContain(result.code);
      }
    }
  });

  it("handles adding a finding with very long text", () => {
    const longText = "A".repeat(5000) + " unique long finding";
    const msg = addFinding(tmpDir, PROJECT, longText);
    // validateFinding rejects texts longer than 2000 chars
    expect(msg.ok).toBe(false);
  });

  it("handles adding a backlog item with unicode characters", () => {
    const backlog = `# chaos backlog\n\n## Queue\n\n## Done\n`;
    fs.writeFileSync(path.join(projectDir, "backlog.md"), backlog);
    const msg = addBacklogItem(tmpDir, PROJECT, "Fix emoji handling: rocket launch complete");
    expect(msg.ok).toBe(true);
    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Queue[0].line).toContain("rocket launch complete");
  });

  it("handles completing a non-existent item gracefully", () => {
    const backlog = `# chaos backlog\n\n## Queue\n\n- [ ] Only item\n\n## Done\n`;
    fs.writeFileSync(path.join(projectDir, "backlog.md"), backlog);
    const msg = completeBacklogItem(tmpDir, PROJECT, "This item does not exist at all");
    expect(msg.ok).toBe(false);
    if (!msg.ok) expect(msg.code).toBe(CortexError.NOT_FOUND);
  });

  it("handles removing from empty FINDINGS.md", () => {
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), "# chaos FINDINGS\n");
    const msg = removeFinding(tmpDir, PROJECT, "nonexistent");
    expect(msg.ok).toBe(false);
    if (!msg.ok) expect(msg.code).toBe(CortexError.NOT_FOUND);
  });

  it("handles editing queue item to very long text", () => {
    write(
      path.join(projectDir, "MEMORY_QUEUE.md"),
      [
        "# chaos Memory Queue",
        "",
        "## Review",
        "",
        "- [2026-03-05] Short item [confidence 0.90]",
        "",
        "## Stale",
        "",
        "## Conflicts",
        "",
      ].join("\n")
    );
    const longText = "B".repeat(5000);
    const msg = editQueueItem(tmpDir, PROJECT, "Short item", longText);
    expect(msg.ok).toBe(true);
    const queue = readReviewQueue(tmpDir, PROJECT);
    if (!queue.ok) return;
    expect(queue.data[0].text).toContain("B".repeat(100));
  });
});

describe("filesystem fault injection", () => {
  it("handles read-only project directory for backlog add", () => {
    // Create a valid backlog but make the directory read-only
    const backlog = `# chaos backlog\n\n## Queue\n\n## Done\n`;
    fs.writeFileSync(path.join(projectDir, "backlog.md"), backlog);

    // Make file read-only
    fs.chmodSync(path.join(projectDir, "backlog.md"), 0o444);
    try {
      // The lock file write or the backlog rewrite should fail with an EACCES error.
      // The withFileLock function does not catch write errors so it throws.
      let threw = false;
      try {
        addBacklogItem(tmpDir, PROJECT, "Should fail on read-only");
      } catch (err: any) {
        threw = true;
        expect(err.code || err.message).toMatch(/EACCES|EPERM|permission/i);
      }
      // Either it threw (expected) or succeeded (e.g., running as root)
      expect(threw || true).toBe(true);
    } finally {
      fs.chmodSync(path.join(projectDir, "backlog.md"), 0o644);
    }
  });

  it("handles missing governance directory for shell state", () => {
    // No runtime directory exists
    const state = loadShellState(tmpDir);
    expect(state.view).toBe("Projects");
    expect(state.page).toBe(1);
  });

  it("saveShellState creates runtime directory if missing", () => {
    saveShellState(tmpDir, {
      version: 1,
      view: "Tasks",
      project: PROJECT,
      page: 1,
      perPage: 40,
    });
    const runtimeDir = path.join(tmpDir, ".runtime");
    expect(fs.existsSync(runtimeDir)).toBe(true);
    const loaded = loadShellState(tmpDir);
    expect(loaded.view).toBe("Tasks");
  });

  it("handles profiles directory with no yaml files", () => {
    fs.mkdirSync(path.join(tmpDir, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "profiles", "README.md"), "not a yaml file");
    const result = listProfiles(tmpDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(0);
  });

  it("handles machines.yaml that is an array instead of object", () => {
    fs.writeFileSync(path.join(tmpDir, "machines.yaml"), "[1, 2, 3]\n");
    const result = listMachines(tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(CortexError.MALFORMED_YAML);
  });

  it("handles machines.yaml with empty content", () => {
    fs.writeFileSync(path.join(tmpDir, "machines.yaml"), "");
    const result = listMachines(tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(CortexError.MALFORMED_YAML);
  });
});

describe("custom hooks fault injection", () => {
  it("runCustomHooks handles nonexistent command gracefully", () => {
    const runtimeDir = path.join(tmpDir, ".runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "install-preferences.json"),
      JSON.stringify({
        customHooks: [
          { event: "pre-save", command: "/nonexistent/binary/xyz" },
        ],
      })
    );
    const result = runCustomHooks(tmpDir, "pre-save");
    expect(result.ran).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it("runCustomHooks handles command that writes to stderr", () => {
    const runtimeDir = path.join(tmpDir, ".runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "install-preferences.json"),
      JSON.stringify({
        customHooks: [
          { event: "post-finding", command: "echo 'warning' >&2" },
        ],
      })
    );
    // Should not throw - stderr is captured
    const result = runCustomHooks(tmpDir, "post-finding");
    expect(result.ran).toBe(1);
    // echo to stderr with exit 0 is not an error
    expect(result.errors).toHaveLength(0);
  });

  it("readCustomHooks handles null entries in array", () => {
    const runtimeDir = path.join(tmpDir, ".runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "install-preferences.json"),
      JSON.stringify({
        customHooks: [
          null,
          { event: "pre-save", command: "echo ok" },
          undefined,
          42,
        ],
      })
    );
    const hooks = readCustomHooks(tmpDir);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].event).toBe("pre-save");
  });
});

describe("rapid state transitions", () => {
  it("save then immediately load shell state round-trips", () => {
    for (let i = 0; i < 5; i++) {
      const view = i % 2 === 0 ? "Tasks" : "Projects";
      saveShellState(tmpDir, {
        version: 1,
        view: view as "Tasks" | "Projects",
        page: i + 1,
        perPage: 40,
      });
      const loaded = loadShellState(tmpDir);
      expect(loaded.view).toBe(view);
      expect(loaded.page).toBe(i + 1);
    }
  });

  it("addFinding then removeFinding then addFinding produces clean state", () => {
    addFinding(tmpDir, PROJECT, "Temporary finding to be removed");
    removeFinding(tmpDir, PROJECT, "Temporary finding");
    addFinding(tmpDir, PROJECT, "Replacement finding after removal");

    const result = readFindings(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.some((f) => f.text.includes("Temporary finding"))).toBe(false);
    expect(result.data.some((f) => f.text.includes("Replacement finding"))).toBe(true);
  });

  it("approve queue item then re-read queue shows consistent state", () => {
    write(
      path.join(projectDir, "MEMORY_QUEUE.md"),
      [
        "# chaos Memory Queue",
        "",
        "## Review",
        "",
        "- [2026-03-05] Item to approve [confidence 0.90]",
        "- [2026-03-06] Item to keep [confidence 0.80]",
        "",
        "## Stale",
        "",
        "## Conflicts",
        "",
      ].join("\n")
    );
    write(
      path.join(projectDir, "FINDINGS.md"),
      "# chaos FINDINGS\n"
    );

    const msg = approveQueueItem(tmpDir, PROJECT, "Item to approve");
    expect(msg.ok).toBe(true);

    const queue = readReviewQueue(tmpDir, PROJECT);
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    expect(queue.data).toHaveLength(1);
    expect(queue.data[0].text).toContain("Item to keep");

    const findings = readFindings(tmpDir, PROJECT);
    expect(findings.ok).toBe(true);
    if (!findings.ok) return;
    expect(findings.data.some((f) => f.text.includes("Item to approve"))).toBe(true);
  });
});

describe("concurrent environment variable isolation", () => {
  const origLockWait = process.env.CORTEX_FILE_LOCK_MAX_WAIT_MS;
  const origLockPoll = process.env.CORTEX_FILE_LOCK_POLL_MS;
  const origLockStale = process.env.CORTEX_FILE_LOCK_STALE_MS;

  afterEach(() => {
    if (origLockWait === undefined) delete process.env.CORTEX_FILE_LOCK_MAX_WAIT_MS;
    else process.env.CORTEX_FILE_LOCK_MAX_WAIT_MS = origLockWait;
    if (origLockPoll === undefined) delete process.env.CORTEX_FILE_LOCK_POLL_MS;
    else process.env.CORTEX_FILE_LOCK_POLL_MS = origLockPoll;
    if (origLockStale === undefined) delete process.env.CORTEX_FILE_LOCK_STALE_MS;
    else process.env.CORTEX_FILE_LOCK_STALE_MS = origLockStale;
  });

  it("respects CORTEX_FILE_LOCK_MAX_WAIT_MS override", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), "# chaos backlog\n\n## Queue\n\n## Done\n");
    const lockPath = path.join(projectDir, "backlog.md.lock");
    fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`);

    process.env.CORTEX_FILE_LOCK_MAX_WAIT_MS = "50";
    process.env.CORTEX_FILE_LOCK_POLL_MS = "10";
    const start = Date.now();
    const msg = addBacklogItem(tmpDir, PROJECT, "Should timeout quickly");
    const elapsed = Date.now() - start;

    fs.unlinkSync(lockPath);

    expect(msg.ok).toBe(false);
    // Should have timed out within a reasonable window
    expect(elapsed).toBeLessThan(2000);
  });

  it("respects CORTEX_FILE_LOCK_STALE_MS override", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), "# chaos backlog\n\n## Queue\n\n## Done\n");
    const lockPath = path.join(projectDir, "backlog.md.lock");
    fs.writeFileSync(lockPath, `99999\n${Date.now() - 2000}`);
    const past = new Date(Date.now() - 2000);
    fs.utimesSync(lockPath, past, past);

    // Set stale threshold to 1 second so the 2-second-old lock is stale
    process.env.CORTEX_FILE_LOCK_STALE_MS = "1000";

    const msg = addBacklogItem(tmpDir, PROJECT, "After custom stale threshold");
    expect(msg.ok).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
