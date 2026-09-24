import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readTasks,
  addTask,
  completeTask,
  readFindings,
  addFinding,
  removeFinding,
  readReviewQueue,
  listMachines,
  listProfiles,
  loadShellState,
  saveShellState,
} from "../data/access.js";
import { PhrenError } from "../shared.js";
import { grantAdmin, makeTempDir, writeFile as write, resultMsg } from "../test-helpers.js";
import { readCustomHooks, runCustomHooks } from "../hooks.js";
import * as path from "path";
import * as fs from "fs";

const PROJECT = "chaos";

let tmpDir: string;
let projectDir: string;
let tmpCleanup: () => void;

beforeEach(() => {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("phren-chaos-"));
  projectDir = path.join(tmpDir, PROJECT);
  fs.mkdirSync(projectDir, { recursive: true });
  grantAdmin(tmpDir);
});

afterEach(() => {
  delete process.env.PHREN_FILE_LOCK_MAX_WAIT_MS;
  delete process.env.PHREN_FILE_LOCK_POLL_MS;
  delete process.env.PHREN_ACTOR;
  tmpCleanup();
});

describe("corrupted file recovery", () => {
  it.each([
    ["empty", "", 0],
    ["no sections", "# chaos task\n\nJust some text\n", 0],
    ["only a Done section", "# chaos task\n\n## Done\n\n- [x] Only done item\n", 1],
  ])("handles tasks.md that is %s", (_label, content, done) => {
    fs.writeFileSync(path.join(projectDir, "tasks.md"), content);
    const result = readTasks(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items.Active).toHaveLength(0);
    expect(result.data.items.Queue).toHaveLength(0);
    expect(result.data.items.Done).toHaveLength(done);
  });

  it("handles FINDINGS.md with no date headers", () => {
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), "# chaos FINDINGS\n\n- Finding without date\n- Another finding\n");
    const result = readFindings(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    expect(result.data[0].date).toBe("unknown");

    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), "");
    const empty = readFindings(tmpDir, PROJECT);
    expect(empty.ok && empty.data).toEqual([]);
  });

  it("handles review.md with no section headers", () => {
    fs.writeFileSync(path.join(projectDir, "review.md"), "# chaos Queue\n\n- [2026-03-05] orphan item\n");
    const result = readReviewQueue(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Item lands in default "Review" section
    expect(result.data).toHaveLength(1);
    expect(result.data[0].section).toBe("Review");

    fs.writeFileSync(path.join(projectDir, "review.md"), "");
    const empty = readReviewQueue(tmpDir, PROJECT);
    expect(empty.ok && empty.data).toEqual([]);
  });

  it.each([
    ["missing", null],
    ["corrupted JSON", "{ corrupted json }}}"],
    ["an unknown view with missing fields", '{"view":"Unknown"}'],
  ])("falls back to default shell state when the file is %s", (_label, content) => {
    if (content !== null) {
      const govDir = path.join(tmpDir, ".runtime");
      fs.mkdirSync(govDir, { recursive: true });
      fs.writeFileSync(path.join(govDir, "shell-state.json"), content);
    }
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
    expect(result.data).toEqual({ "machine-c": "valid" });
  });
});

describe("boundary and edge case inputs", () => {
  it("rejects project names with special characters", () => {
    const badNames = ["../escape", "with spaces", "with/slash", "with@symbol", ".hidden"];
    for (const name of badNames) {
      const result = readTasks(tmpDir, name);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect([PhrenError.INVALID_PROJECT_NAME, PhrenError.PROJECT_NOT_FOUND]).toContain(result.code);
      }
    }
  });
});

describe("filesystem fault injection", () => {
  it("handles profiles directory with no yaml files", () => {
    fs.mkdirSync(path.join(tmpDir, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "profiles", "README.md"), "not a yaml file");
    const result = listProfiles(tmpDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(0);
  });

  it.each([["an array", "[1, 2, 3]\n"], ["empty", ""]])("rejects machines.yaml that is %s", (_label, content) => {
    fs.writeFileSync(path.join(tmpDir, "machines.yaml"), content);
    const result = listMachines(tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PhrenError.MALFORMED_YAML);
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
    const helperScript = path.join(tmpDir, "stderr-helper.sh");
    fs.writeFileSync(helperScript, "#!/bin/sh\necho 'warning' >&2\n");
    fs.chmodSync(helperScript, 0o755);
    fs.writeFileSync(
      path.join(runtimeDir, "install-preferences.json"),
      JSON.stringify({
        customHooks: [
          { event: "post-finding", command: helperScript },
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

describe("concurrent environment variable isolation", () => {
  const origLockWait = process.env.PHREN_FILE_LOCK_MAX_WAIT_MS;
  const origLockPoll = process.env.PHREN_FILE_LOCK_POLL_MS;
  const origLockStale = process.env.PHREN_FILE_LOCK_STALE_MS;

  afterEach(() => {
    if (origLockWait === undefined) delete process.env.PHREN_FILE_LOCK_MAX_WAIT_MS;
    else process.env.PHREN_FILE_LOCK_MAX_WAIT_MS = origLockWait;
    if (origLockPoll === undefined) delete process.env.PHREN_FILE_LOCK_POLL_MS;
    else process.env.PHREN_FILE_LOCK_POLL_MS = origLockPoll;
    if (origLockStale === undefined) delete process.env.PHREN_FILE_LOCK_STALE_MS;
    else process.env.PHREN_FILE_LOCK_STALE_MS = origLockStale;
  });

  it("respects PHREN_FILE_LOCK_STALE_MS override", () => {
    fs.writeFileSync(path.join(projectDir, "tasks.md"), "# chaos task\n\n## Queue\n\n## Done\n");
    const lockPath = path.join(projectDir, "tasks.md.lock");
    fs.writeFileSync(lockPath, `99999\n${Date.now() - 2000}`);
    const past = new Date(Date.now() - 2000);
    fs.utimesSync(lockPath, past, past);

    // Set stale threshold to 1 second so the 2-second-old lock is stale
    process.env.PHREN_FILE_LOCK_STALE_MS = "1000";

    const msg = addTask(tmpDir, PROJECT, "After custom stale threshold");
    expect(msg.ok).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
