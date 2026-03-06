import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readBacklog,
  addBacklogItem,
  completeBacklogItem,
  updateBacklogItem,
  workNextBacklogItem,
  tidyBacklogDone,
  readMemoryQueue,
  approveMemoryQueueItem,
  rejectMemoryQueueItem,
  editMemoryQueueItem,
  listMachines,
  setMachineProfile,
  listProfiles,
  addProjectToProfile,
  removeProjectFromProfile,
  listProjectCards,
  loadShellState,
  saveShellState,
  resetShellState,
  readLearnings,
  addLearning,
  removeLearning,
} from "./data-access.js";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn } from "child_process";

function grantAdminAccess(cortexDir: string, actor = "vitest-admin"): string {
  const govDir = path.join(cortexDir, ".governance");
  fs.mkdirSync(govDir, { recursive: true });
  fs.writeFileSync(
    path.join(govDir, "access-control.json"),
    JSON.stringify({
      admins: [actor],
      maintainers: [],
      contributors: [],
      viewers: [],
    }, null, 2) + "\n"
  );
  process.env.CORTEX_ACTOR = actor;
  return actor;
}

let tmpDir: string;
let projectDir: string;
const PROJECT = "testproject";
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function runDataAccessWorker(code: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "-e", code], {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (codeNum) => {
      resolve({ exitCode: codeNum ?? 1, stdout, stderr });
    });
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-da-test-"));
  projectDir = path.join(tmpDir, PROJECT);
  fs.mkdirSync(projectDir, { recursive: true });
  grantAdminAccess(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CORTEX_ACTOR;
});

const SAMPLE_BACKLOG = `# testproject backlog

## Active

- [ ] Implement auth middleware [high]
- [ ] Write integration tests

## Queue

- [ ] Add rate limiting
- [ ] Refactor database layer [medium]

## Done

- [x] Set up CI pipeline
`;

const SAMPLE_LEARNINGS = `# testproject LEARNINGS

## 2026-03-01

- The auth middleware runs before rate limiting, order matters
  <!-- cortex:cite {"created_at":"2026-03-01T10:00:00Z"} -->
- SQLite WAL mode is required for concurrent readers

## 2026-02-15

- vitest needs pool: "forks" when testing native addons
`;

describe("readBacklog", () => {
  it("parses a valid backlog with Active/Queue/Done sections", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const result = readBacklog(tmpDir, PROJECT);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(result.project).toBe(PROJECT);
    expect(result.items.Active).toHaveLength(2);
    expect(result.items.Queue).toHaveLength(2);
    expect(result.items.Done).toHaveLength(1);

    expect(result.items.Active[0].line).toBe("Implement auth middleware [high]");
    expect(result.items.Active[0].priority).toBe("high");
    expect(result.items.Active[0].checked).toBe(false);

    expect(result.items.Queue[1].line).toBe("Refactor database layer [medium]");
    expect(result.items.Queue[1].priority).toBe("medium");

    expect(result.items.Done[0].checked).toBe(true);
  });

  it("returns an empty backlog when the file does not exist", () => {
    const result = readBacklog(tmpDir, PROJECT);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(result.items.Active).toHaveLength(0);
    expect(result.items.Queue).toHaveLength(0);
    expect(result.items.Done).toHaveLength(0);
  });

  it("returns an error string for an invalid project name", () => {
    const result = readBacklog(tmpDir, "../escape");
    expect(typeof result).toBe("string");
    expect(result).toContain("INVALID_PROJECT_NAME");
  });

  it("returns an error string for a missing project directory", () => {
    const result = readBacklog(tmpDir, "nonexistent");
    expect(typeof result).toBe("string");
    expect(result).toContain("PROJECT_NOT_FOUND");
  });

  it("handles a backlog with no items", () => {
    const empty = `# testproject backlog\n\n## Active\n\n## Queue\n\n## Done\n`;
    fs.writeFileSync(path.join(projectDir, "backlog.md"), empty);
    const result = readBacklog(tmpDir, PROJECT);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(result.items.Active).toHaveLength(0);
    expect(result.items.Queue).toHaveLength(0);
    expect(result.items.Done).toHaveLength(0);
  });
});

describe("addBacklogItem", () => {
  it("adds an item to the Queue section", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const msg = addBacklogItem(tmpDir, PROJECT, "Add WebSocket support");
    expect(msg).toContain("Added");
    expect(msg).toContain("Add WebSocket support");

    const after = readBacklog(tmpDir, PROJECT);
    expect(typeof after).not.toBe("string");
    if (typeof after === "string") return;
    expect(after.items.Queue).toHaveLength(3);
    expect(after.items.Queue[2].line).toBe("Add WebSocket support");
  });

  it("strips leading bullet prefix from input", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    addBacklogItem(tmpDir, PROJECT, "- Already has dash");

    const after = readBacklog(tmpDir, PROJECT);
    if (typeof after === "string") return;
    expect(after.items.Queue[2].line).toBe("Already has dash");
  });

  it("creates a backlog file when none exists", () => {
    const msg = addBacklogItem(tmpDir, PROJECT, "First item");
    expect(msg).toContain("Added");

    const after = readBacklog(tmpDir, PROJECT);
    if (typeof after === "string") return;
    expect(after.items.Queue).toHaveLength(1);
  });

  it("parses priority from the added item", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    addBacklogItem(tmpDir, PROJECT, "Urgent fix [high]");

    const after = readBacklog(tmpDir, PROJECT);
    if (typeof after === "string") return;
    const added = after.items.Queue.find((i) => i.line.includes("Urgent fix"));
    expect(added?.priority).toBe("high");
  });
});

describe("completeBacklogItem", () => {
  it("moves a matched item to Done", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const msg = completeBacklogItem(tmpDir, PROJECT, "rate limiting");
    expect(msg).toContain("Marked done");

    const after = readBacklog(tmpDir, PROJECT);
    if (typeof after === "string") return;
    expect(after.items.Queue).toHaveLength(1);
    expect(after.items.Done).toHaveLength(2);
    expect(after.items.Done[0].line).toContain("rate limiting");
    expect(after.items.Done[0].checked).toBe(true);
  });

  it("matches by item ID", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const msg = completeBacklogItem(tmpDir, PROJECT, "A1");
    expect(msg).toContain("Marked done");

    const after = readBacklog(tmpDir, PROJECT);
    if (typeof after === "string") return;
    expect(after.items.Active).toHaveLength(1);
    expect(after.items.Done[0].line).toContain("auth middleware");
  });

  it("returns an error when no item matches", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const msg = completeBacklogItem(tmpDir, PROJECT, "nonexistent item xyz");
    expect(msg).toContain("No item matching");
  });
});

describe("backlog mutation helpers", () => {
  it("updateBacklogItem updates priority/context/section in one call", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const msg = updateBacklogItem(tmpDir, PROJECT, "Add rate limiting", {
      priority: "high",
      context: "protect burst traffic",
      section: "active",
    });
    expect(msg).toContain("Updated item");

    const after = readBacklog(tmpDir, PROJECT);
    if (typeof after === "string") return;
    expect(after.items.Queue.some((i) => i.line.includes("Add rate limiting"))).toBe(false);
    const moved = after.items.Active.find((i) => i.line.includes("Add rate limiting"));
    expect(moved).toBeDefined();
    expect(moved?.priority).toBe("high");
    expect(moved?.context).toContain("burst traffic");
  });

  it("tidyBacklogDone writes archive and trims done list", () => {
    const content = `# testproject backlog

## Active

## Queue

## Done

- [x] done A
- [x] done B
- [x] done C
`;
    fs.writeFileSync(path.join(projectDir, "backlog.md"), content);
    const msg = tidyBacklogDone(tmpDir, PROJECT, 1);
    expect(msg).toContain("archived 2");

    const after = readBacklog(tmpDir, PROJECT);
    if (typeof after === "string") return;
    expect(after.items.Done).toHaveLength(1);

    const archive = path.join(tmpDir, ".governance", "backlog-archive", `${PROJECT}.md`);
    expect(fs.existsSync(archive)).toBe(true);
    const archiveContent = fs.readFileSync(archive, "utf8");
    expect(archiveContent).toContain("done B");
    expect(archiveContent).toContain("done C");
  });
});

describe("readLearnings", () => {
  it("parses dated entries with citations", () => {
    fs.writeFileSync(path.join(projectDir, "LEARNINGS.md"), SAMPLE_LEARNINGS);
    const result = readLearnings(tmpDir, PROJECT);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;

    expect(result).toHaveLength(3);

    expect(result[0].date).toBe("2026-03-01");
    expect(result[0].text).toContain("auth middleware");
    expect(result[0].citation).toContain("cortex:cite");

    expect(result[1].date).toBe("2026-03-01");
    expect(result[1].text).toContain("WAL mode");
    expect(result[1].citation).toBeUndefined();

    expect(result[2].date).toBe("2026-02-15");
    expect(result[2].text).toContain("vitest");
  });

  it("returns an empty array when no LEARNINGS.md exists", () => {
    const result = readLearnings(tmpDir, PROJECT);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result).toHaveLength(0);
  });

  it("returns an error string for a missing project", () => {
    const result = readLearnings(tmpDir, "nonexistent");
    expect(typeof result).toBe("string");
    expect(result).toContain("PROJECT_NOT_FOUND");
  });

  it("assigns sequential IDs", () => {
    fs.writeFileSync(path.join(projectDir, "LEARNINGS.md"), SAMPLE_LEARNINGS);
    const result = readLearnings(tmpDir, PROJECT);
    if (!Array.isArray(result)) return;
    expect(result[0].id).toBe("L1");
    expect(result[1].id).toBe("L2");
    expect(result[2].id).toBe("L3");
  });
});

describe("addLearning", () => {
  it("creates LEARNINGS.md and appends under today's date", () => {
    const msg = addLearning(tmpDir, PROJECT, "New insight about caching");
    expect(msg).toContain("Created LEARNINGS.md");

    const result = readLearnings(tmpDir, PROJECT);
    if (!Array.isArray(result)) return;
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain("caching");

    const today = new Date().toISOString().slice(0, 10);
    expect(result[0].date).toBe(today);
  });

  it("appends to an existing LEARNINGS.md", () => {
    fs.writeFileSync(path.join(projectDir, "LEARNINGS.md"), SAMPLE_LEARNINGS);
    const msg = addLearning(tmpDir, PROJECT, "Another insight");
    expect(msg.toLowerCase()).toContain("added");

    const result = readLearnings(tmpDir, PROJECT);
    if (!Array.isArray(result)) return;
    expect(result.length).toBeGreaterThan(3);
    // New learnings are inserted under today's date at the top of the file
    const found = result.find((l) => l.text.includes("Another insight"));
    expect(found).toBeDefined();
    expect(found!.date).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe("removeLearning", () => {
  it("removes a matching learning entry", () => {
    fs.writeFileSync(path.join(projectDir, "LEARNINGS.md"), SAMPLE_LEARNINGS);
    const msg = removeLearning(tmpDir, PROJECT, "WAL mode");
    expect(msg).toContain("Removed");

    const result = readLearnings(tmpDir, PROJECT);
    if (!Array.isArray(result)) return;
    expect(result).toHaveLength(2);
    expect(result.every((l) => !l.text.includes("WAL mode"))).toBe(true);
  });

  it("removes a learning along with its citation comment", () => {
    fs.writeFileSync(path.join(projectDir, "LEARNINGS.md"), SAMPLE_LEARNINGS);
    const msg = removeLearning(tmpDir, PROJECT, "auth middleware");
    expect(msg).toContain("Removed");

    const content = fs.readFileSync(path.join(projectDir, "LEARNINGS.md"), "utf8");
    expect(content).not.toContain("auth middleware");
    expect(content).not.toContain("cortex:cite");
  });

  it("returns an error when no learning matches", () => {
    fs.writeFileSync(path.join(projectDir, "LEARNINGS.md"), SAMPLE_LEARNINGS);
    const msg = removeLearning(tmpDir, PROJECT, "nonexistent xyz");
    expect(msg).toContain("No learning matching");
  });

  it("returns an error when LEARNINGS.md does not exist", () => {
    const msg = removeLearning(tmpDir, PROJECT, "anything");
    expect(msg).toContain("FILE_NOT_FOUND");
  });
});

describe("memory queue helpers", () => {
  beforeEach(() => {
    const queue = `# testproject Memory Queue

## Review

- [2026-03-01] cleanup flaky test [confidence 0.4]

## Stale

- [2025-01-01] old stale memory

## Conflicts

- [2026-03-02] conflicting guidance
`;
    fs.writeFileSync(path.join(projectDir, "MEMORY_QUEUE.md"), queue);
  });

  it("readMemoryQueue parses sections and confidence", () => {
    const items = readMemoryQueue(tmpDir, PROJECT);
    expect(Array.isArray(items)).toBe(true);
    if (!Array.isArray(items)) return;
    expect(items).toHaveLength(3);
    expect(items[0].section).toBe("Review");
    expect(items[0].confidence).toBe(0.4);
  });

  it("approveMemoryQueueItem adds learning and removes queue item", () => {
    const msg = approveMemoryQueueItem(tmpDir, PROJECT, "cleanup flaky");
    expect(msg).toContain("Approved memory");

    const queueAfter = readMemoryQueue(tmpDir, PROJECT);
    if (Array.isArray(queueAfter)) {
      expect(queueAfter.some((i) => i.text.includes("cleanup flaky"))).toBe(false);
    }

    const learnings = readLearnings(tmpDir, PROJECT);
    if (Array.isArray(learnings)) {
      expect(learnings.some((i) => i.text.includes("cleanup flaky"))).toBe(true);
    }
  });

  it("rejectMemoryQueueItem removes the matched queue item", () => {
    const msg = rejectMemoryQueueItem(tmpDir, PROJECT, "conflicting guidance");
    expect(msg).toContain("Rejected memory");
    const queueAfter = readMemoryQueue(tmpDir, PROJECT);
    if (!Array.isArray(queueAfter)) return;
    expect(queueAfter.some((i) => i.text.includes("conflicting guidance"))).toBe(false);
  });

  it("editMemoryQueueItem rewrites the item text", () => {
    const msg = editMemoryQueueItem(tmpDir, PROJECT, "old stale memory", "updated stale memory");
    expect(msg).toContain("Edited memory");
    const queueAfter = readMemoryQueue(tmpDir, PROJECT);
    if (!Array.isArray(queueAfter)) return;
    expect(queueAfter.some((i) => i.text.includes("updated stale memory"))).toBe(true);
  });
});

describe("machines, profiles, and shell state", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "machines.yaml"), "machine-a: personal\n");
    fs.writeFileSync(path.join(tmpDir, "profiles", "personal.yaml"), "name: personal\nprojects:\n  - testproject\n");
  });

  it("lists and updates machines", () => {
    const listed = listMachines(tmpDir);
    expect(typeof listed).not.toBe("string");
    if (typeof listed === "string") return;
    expect(listed["machine-a"]).toBe("personal");

    const msg = setMachineProfile(tmpDir, "machine-b", "personal");
    expect(msg).toContain("Mapped machine machine-b");
    const after = listMachines(tmpDir);
    if (typeof after === "string") return;
    expect(after["machine-b"]).toBe("personal");
  });

  it("returns FILE_NOT_FOUND when machines.yaml is missing", () => {
    fs.unlinkSync(path.join(tmpDir, "machines.yaml"));
    const listed = listMachines(tmpDir);
    expect(typeof listed).toBe("string");
    expect(listed).toContain("FILE_NOT_FOUND");
  });

  it("returns MALFORMED_YAML for invalid machines.yaml", () => {
    fs.writeFileSync(path.join(tmpDir, "machines.yaml"), "machine-a: [\n");
    const listed = listMachines(tmpDir);
    expect(typeof listed).toBe("string");
    expect(listed).toContain("MALFORMED_YAML");
  });

  it("lists profiles and mutates profile projects", () => {
    const listed = listProfiles(tmpDir);
    expect(typeof listed).not.toBe("string");
    if (typeof listed === "string") return;
    expect(listed[0].name).toBe("personal");

    const addMsg = addProjectToProfile(tmpDir, "personal", "another-proj");
    expect(addMsg).toContain("Added another-proj");
    const removeMsg = removeProjectFromProfile(tmpDir, "personal", "another-proj");
    expect(removeMsg).toContain("Removed another-proj");
  });

  it("returns FILE_NOT_FOUND when profiles directory is missing", () => {
    fs.rmSync(path.join(tmpDir, "profiles"), { recursive: true, force: true });
    const listed = listProfiles(tmpDir);
    expect(typeof listed).toBe("string");
    expect(listed).toContain("FILE_NOT_FOUND");
  });

  it("returns MALFORMED_YAML for invalid profile yaml", () => {
    fs.writeFileSync(path.join(tmpDir, "profiles", "personal.yaml"), "name: personal\nprojects: [\n");
    const listed = listProfiles(tmpDir);
    expect(typeof listed).toBe("string");
    expect(listed).toContain("MALFORMED_YAML");
  });

  it("listProjectCards includes summary/docs", () => {
    fs.writeFileSync(path.join(projectDir, "summary.md"), "# testproject\n\nQuick summary line\n");
    fs.writeFileSync(path.join(projectDir, "CLAUDE.md"), "# testproject\n");
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);

    const cards = listProjectCards(tmpDir);
    const card = cards.find((c) => c.name === PROJECT);
    expect(card).toBeDefined();
    expect(card?.summary).toContain("Quick summary");
    expect(card?.docs).toContain("backlog.md");
  });

  it("save/load/reset shell state round trips", () => {
    saveShellState(tmpDir, {
      version: 1,
      view: "Backlog",
      project: PROJECT,
      filter: "auth",
      page: 2,
      perPage: 25,
    });
    const loaded = loadShellState(tmpDir);
    expect(loaded.view).toBe("Backlog");
    expect(loaded.project).toBe(PROJECT);
    expect(loaded.filter).toBe("auth");
    expect(loaded.page).toBe(2);
    expect(loaded.perPage).toBe(25);

    const msg = resetShellState(tmpDir);
    expect(msg).toContain("reset");
    const fallback = loadShellState(tmpDir);
    expect(fallback.view).toBe("Projects");
  });
});

describe("file locking", () => {
  it("two sequential addBacklogItem calls produce both items", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    addBacklogItem(tmpDir, PROJECT, "First concurrent item");
    addBacklogItem(tmpDir, PROJECT, "Second concurrent item");

    const after = readBacklog(tmpDir, PROJECT);
    expect(typeof after).not.toBe("string");
    if (typeof after === "string") return;
    const lines = after.items.Queue.map((i) => i.line);
    expect(lines).toContain("First concurrent item");
    expect(lines).toContain("Second concurrent item");
  });

  it("two sequential addLearning calls produce valid LEARNINGS.md", () => {
    addLearning(tmpDir, PROJECT, "First learning");
    addLearning(tmpDir, PROJECT, "Second learning");

    const result = readLearnings(tmpDir, PROJECT);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    const texts = result.map((l) => l.text);
    expect(texts.some((t) => t.includes("First learning"))).toBe(true);
    expect(texts.some((t) => t.includes("Second learning"))).toBe(true);
  });

  it("lock file is cleaned up after successful backlog write", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const lockPath = path.join(projectDir, "backlog.md.lock");

    addBacklogItem(tmpDir, PROJECT, "Lock cleanup test");

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("lock file is cleaned up after successful learning write", () => {
    const learningsPath = path.join(projectDir, "LEARNINGS.md");
    const lockPath = learningsPath + ".lock";

    addLearning(tmpDir, PROJECT, "Lock cleanup learning");

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("stale lock is recovered: old .lock file does not block writes", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const lockPath = path.join(projectDir, "backlog.md.lock");

    // Create a stale lock file with old timestamp
    fs.writeFileSync(lockPath, `99999\n${Date.now() - 60000}`);
    // Backdate the mtime to exceed the 30s stale threshold
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(lockPath, past, past);

    const msg = addBacklogItem(tmpDir, PROJECT, "After stale lock");
    expect(msg).toContain("Added");

    const after = readBacklog(tmpDir, PROJECT);
    if (typeof after === "string") return;
    const lines = after.items.Queue.map((i) => i.line);
    expect(lines).toContain("After stale lock");

    // Lock should be cleaned up
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("lock file is cleaned up even if the inner operation fails", () => {
    const learningsPath = path.join(projectDir, "LEARNINGS.md");
    const lockPath = learningsPath + ".lock";

    // removeLearning on nonexistent file: the operation returns an error string
    // but should still clean up the lock
    removeLearning(tmpDir, PROJECT, "anything");

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("returns lock timeout and does not write backlog changes under lock contention", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const lockPath = path.join(projectDir, "backlog.md.lock");
    fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`);

    process.env.CORTEX_FILE_LOCK_MAX_WAIT_MS = "150";
    process.env.CORTEX_FILE_LOCK_POLL_MS = "25";
    const before = fs.readFileSync(path.join(projectDir, "backlog.md"), "utf8");
    const msg = addBacklogItem(tmpDir, PROJECT, "Blocked by lock");
    const after = fs.readFileSync(path.join(projectDir, "backlog.md"), "utf8");
    delete process.env.CORTEX_FILE_LOCK_MAX_WAIT_MS;
    delete process.env.CORTEX_FILE_LOCK_POLL_MS;
    fs.unlinkSync(lockPath);

    expect(msg).toContain("LOCK_TIMEOUT");
    expect(after).toBe(before);
    expect(after).not.toContain("Blocked by lock");
  });

  it("prevents workNextBacklogItem mutation when backlog lock times out", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const lockPath = path.join(projectDir, "backlog.md.lock");
    fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`);

    process.env.CORTEX_FILE_LOCK_MAX_WAIT_MS = "150";
    process.env.CORTEX_FILE_LOCK_POLL_MS = "25";
    const msg = workNextBacklogItem(tmpDir, PROJECT);
    delete process.env.CORTEX_FILE_LOCK_MAX_WAIT_MS;
    delete process.env.CORTEX_FILE_LOCK_POLL_MS;
    fs.unlinkSync(lockPath);

    expect(msg).toContain("LOCK_TIMEOUT");

    const after = readBacklog(tmpDir, PROJECT);
    if (typeof after === "string") return;
    expect(after.items.Active.some((i) => i.line.includes("Add rate limiting"))).toBe(false);
    expect(after.items.Queue.some((i) => i.line.includes("Add rate limiting"))).toBe(true);
  });

  it("allows concurrent backlog writes from two processes without data loss", async () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);

    const mkCode = (item: string) =>
      `import { addBacklogItem } from ${JSON.stringify(path.join(REPO_ROOT, "mcp/src/data-access.ts"))};` +
      `process.env.CORTEX_ACTOR='vitest-admin';` +
      `const out=addBacklogItem(${JSON.stringify(tmpDir)},${JSON.stringify(PROJECT)},${JSON.stringify(item)});` +
      `console.log(out); if(out.includes('LOCK_TIMEOUT')) process.exit(2);`;

    const [a, b] = await Promise.all([
      runDataAccessWorker(mkCode("Concurrent item A")),
      runDataAccessWorker(mkCode("Concurrent item B")),
    ]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);

    const after = readBacklog(tmpDir, PROJECT);
    if (typeof after === "string") return;
    const lines = after.items.Queue.map((i) => i.line);
    expect(lines).toContain("Concurrent item A");
    expect(lines).toContain("Concurrent item B");
  });

  it("allows concurrent learning writes from two processes without data loss", async () => {
    const mkCode = (text: string) =>
      `import { addLearning } from ${JSON.stringify(path.join(REPO_ROOT, "mcp/src/data-access.ts"))};` +
      `process.env.CORTEX_ACTOR='vitest-admin';` +
      `const out=addLearning(${JSON.stringify(tmpDir)},${JSON.stringify(PROJECT)},${JSON.stringify(text)});` +
      `console.log(out); if(out.includes('LOCK_TIMEOUT')) process.exit(2);`;

    const [a, b] = await Promise.all([
      runDataAccessWorker(mkCode("Concurrent learning A")),
      runDataAccessWorker(mkCode("Concurrent learning B")),
    ]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);

    const result = readLearnings(tmpDir, PROJECT);
    if (!Array.isArray(result)) return;
    const texts = result.map((l) => l.text);
    expect(texts.some((t) => t.includes("Concurrent learning A"))).toBe(true);
    expect(texts.some((t) => t.includes("Concurrent learning B"))).toBe(true);
  });
});
