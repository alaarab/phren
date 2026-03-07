import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readBacklog,
  addBacklogItem,
  completeBacklogItem,
  updateBacklogItem,
  workNextBacklogItem,
  pinBacklogItem,
  unpinBacklogItem,
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
import { CortexError } from "./shared.js";
import { grantAdmin, makeTempDir, resultMsg } from "./test-helpers.js";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn } from "child_process";

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

let tmpCleanup: () => void;

beforeEach(() => {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("cortex-da-test-"));
  projectDir = path.join(tmpDir, PROJECT);
  fs.mkdirSync(projectDir, { recursive: true });
  grantAdmin(tmpDir);
});

afterEach(() => {
  tmpCleanup();
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.project).toBe(PROJECT);
    expect(result.data.items.Active).toHaveLength(2);
    expect(result.data.items.Queue).toHaveLength(2);
    expect(result.data.items.Done).toHaveLength(1);

    expect(result.data.items.Active[0].line).toBe("Implement auth middleware [high]");
    expect(result.data.items.Active[0].priority).toBe("high");
    expect(result.data.items.Active[0].checked).toBe(false);

    expect(result.data.items.Queue[1].line).toBe("Refactor database layer [medium]");
    expect(result.data.items.Queue[1].priority).toBe("medium");

    expect(result.data.items.Done[0].checked).toBe(true);
  });

  it("returns an empty backlog when the file does not exist", () => {
    const result = readBacklog(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.items.Active).toHaveLength(0);
    expect(result.data.items.Queue).toHaveLength(0);
    expect(result.data.items.Done).toHaveLength(0);
  });

  it("returns an error for an invalid project name", () => {
    const result = readBacklog(tmpDir, "../escape");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(CortexError.INVALID_PROJECT_NAME);
  });

  it("returns an error for a missing project directory", () => {
    const result = readBacklog(tmpDir, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(CortexError.PROJECT_NOT_FOUND);
  });

  it("handles a backlog with no items", () => {
    const empty = `# testproject backlog\n\n## Active\n\n## Queue\n\n## Done\n`;
    fs.writeFileSync(path.join(projectDir, "backlog.md"), empty);
    const result = readBacklog(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.items.Active).toHaveLength(0);
    expect(result.data.items.Queue).toHaveLength(0);
    expect(result.data.items.Done).toHaveLength(0);
  });

  it("uses per-section counters so IDs start at 1 within each section (#112)", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const result = readBacklog(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.items.Active[0].id).toBe("A1");
    expect(result.data.items.Active[1].id).toBe("A2");
    expect(result.data.items.Queue[0].id).toBe("Q1");
    expect(result.data.items.Queue[1].id).toBe("Q2");
    expect(result.data.items.Done[0].id).toBe("D1");
  });

  it("recognizes custom section headers like 'In Progress' and 'Todo' (#113)", () => {
    const custom = [
      "# testproject backlog",
      "",
      "## In Progress",
      "",
      "- [ ] task in progress",
      "",
      "## Todo",
      "",
      "- [ ] task in todo",
      "",
      "## Completed",
      "",
      "- [x] task completed",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(projectDir, "backlog.md"), custom);
    const result = readBacklog(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.items.Active).toHaveLength(1);
    expect(result.data.items.Active[0].line).toBe("task in progress");
    expect(result.data.items.Queue).toHaveLength(1);
    expect(result.data.items.Queue[0].line).toBe("task in todo");
    expect(result.data.items.Done).toHaveLength(1);
    expect(result.data.items.Done[0].line).toBe("task completed");
  });
});

describe("addBacklogItem", () => {
  it("adds an item to the Queue section", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const msg = addBacklogItem(tmpDir, PROJECT, "Add WebSocket support");
    expect(resultMsg(msg)).toContain("Added");
    expect(resultMsg(msg)).toContain("Add WebSocket support");

    const after = readBacklog(tmpDir, PROJECT);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.items.Queue).toHaveLength(3);
    expect(after.data.items.Queue[2].line).toBe("Add WebSocket support");
  });

  it("strips leading bullet prefix from input", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    addBacklogItem(tmpDir, PROJECT, "- Already has dash");

    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Queue[2].line).toBe("Already has dash");
  });

  it("creates a backlog file when none exists", () => {
    const msg = addBacklogItem(tmpDir, PROJECT, "First item");
    expect(resultMsg(msg)).toContain("Added");

    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Queue).toHaveLength(1);
  });

  it("parses priority from the added item", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    addBacklogItem(tmpDir, PROJECT, "Urgent fix [high]");

    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    const added = after.data.items.Queue.find((i) => i.line.includes("Urgent fix"));
    expect(added?.priority).toBe("high");
  });
});

describe("completeBacklogItem", () => {
  it("moves a matched item to Done", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const msg = completeBacklogItem(tmpDir, PROJECT, "rate limiting");
    expect(resultMsg(msg)).toContain("Marked done");

    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Queue).toHaveLength(1);
    expect(after.data.items.Done).toHaveLength(2);
    expect(after.data.items.Done[0].line).toContain("rate limiting");
    expect(after.data.items.Done[0].checked).toBe(true);
  });

  it("matches by item ID", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const msg = completeBacklogItem(tmpDir, PROJECT, "A1");
    expect(resultMsg(msg)).toContain("Marked done");

    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Active).toHaveLength(1);
    expect(after.data.items.Done[0].line).toContain("auth middleware");
  });

  it("returns an error when no item matches", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const msg = completeBacklogItem(tmpDir, PROJECT, "nonexistent item xyz");
    expect(resultMsg(msg)).toContain("No backlog item matching");
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
    expect(resultMsg(msg)).toContain("Updated item");

    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Queue.some((i) => i.line.includes("Add rate limiting"))).toBe(false);
    const moved = after.data.items.Active.find((i) => i.line.includes("Add rate limiting"));
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
    expect(resultMsg(msg)).toContain("archived 2");

    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Done).toHaveLength(1);

    const archive = path.join(tmpDir, ".governance", "backlog-archive", `${PROJECT}.md`);
    expect(fs.existsSync(archive)).toBe(true);
    const archiveContent = fs.readFileSync(archive, "utf8");
    expect(archiveContent).toContain("done B");
    expect(archiveContent).toContain("done C");
  });
});

describe("pin/unpin backlog items", () => {
  it("pins an item and persists the [pinned] tag", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const msg = pinBacklogItem(tmpDir, PROJECT, "rate limiting");
    expect(resultMsg(msg)).toContain("Pinned");

    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    const item = after.data.items.Queue.find((i) => i.line.includes("rate limiting"));
    expect(item?.pinned).toBe(true);

    const raw = fs.readFileSync(path.join(projectDir, "backlog.md"), "utf8");
    expect(raw).toContain("[pinned]");
  });

  it("unpins a pinned item", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    pinBacklogItem(tmpDir, PROJECT, "rate limiting");
    const msg = unpinBacklogItem(tmpDir, PROJECT, "rate limiting");
    expect(resultMsg(msg)).toContain("Unpinned");

    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    const item = after.data.items.Queue.find((i) => i.line.includes("rate limiting"));
    expect(item?.pinned).toBeUndefined();

    const raw = fs.readFileSync(path.join(projectDir, "backlog.md"), "utf8");
    expect(raw).not.toContain("[pinned]");
  });

  it("returns already-pinned message for double pin", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    pinBacklogItem(tmpDir, PROJECT, "rate limiting");
    const msg = pinBacklogItem(tmpDir, PROJECT, "rate limiting");
    expect(resultMsg(msg)).toContain("Already pinned");
  });

  it("returns not-pinned message for unpin on unpinned item", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const msg = unpinBacklogItem(tmpDir, PROJECT, "rate limiting");
    expect(resultMsg(msg)).toContain("Not pinned");
  });

  it("parses existing [pinned] tags from backlog file", () => {
    const content = `# testproject backlog

## Active

- [ ] Implement auth middleware [high] [pinned]

## Queue

- [ ] Add rate limiting

## Done

- [x] Set up CI pipeline
`;
    fs.writeFileSync(path.join(projectDir, "backlog.md"), content);
    const result = readBacklog(tmpDir, PROJECT);
    if (!result.ok) return;
    expect(result.data.items.Active[0].pinned).toBe(true);
    expect(result.data.items.Active[0].priority).toBe("high");
    expect(result.data.items.Queue[0].pinned).toBeUndefined();
  });

  it("pin works with item ID", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const msg = pinBacklogItem(tmpDir, PROJECT, "Q1");
    expect(resultMsg(msg)).toContain("Pinned");
  });
});

describe("readLearnings", () => {
  it("parses dated entries with citations", () => {
    fs.writeFileSync(path.join(projectDir, "LEARNINGS.md"), SAMPLE_LEARNINGS);
    const result = readLearnings(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toHaveLength(3);

    expect(result.data[0].date).toBe("2026-03-01");
    expect(result.data[0].text).toContain("auth middleware");
    expect(result.data[0].citation).toContain("cortex:cite");

    expect(result.data[1].date).toBe("2026-03-01");
    expect(result.data[1].text).toContain("WAL mode");
    expect(result.data[1].citation).toBeUndefined();

    expect(result.data[2].date).toBe("2026-02-15");
    expect(result.data[2].text).toContain("vitest");
  });

  it("returns an empty array when no LEARNINGS.md exists", () => {
    const result = readLearnings(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(0);
  });

  it("returns an error for a missing project", () => {
    const result = readLearnings(tmpDir, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(CortexError.PROJECT_NOT_FOUND);
  });

  it("assigns sequential IDs", () => {
    fs.writeFileSync(path.join(projectDir, "LEARNINGS.md"), SAMPLE_LEARNINGS);
    const result = readLearnings(tmpDir, PROJECT);
    if (!result.ok) return;
    expect(result.data[0].id).toBe("L1");
    expect(result.data[1].id).toBe("L2");
    expect(result.data[2].id).toBe("L3");
  });
});

describe("addLearning", () => {
  it("creates LEARNINGS.md and appends under today's date", () => {
    const msg = addLearning(tmpDir, PROJECT, "New insight about caching");
    expect(resultMsg(msg)).toContain("Created LEARNINGS.md");

    const result = readLearnings(tmpDir, PROJECT);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0].text).toContain("caching");

    const today = new Date().toISOString().slice(0, 10);
    expect(result.data[0].date).toBe(today);
  });

  it("appends to an existing LEARNINGS.md", () => {
    fs.writeFileSync(path.join(projectDir, "LEARNINGS.md"), SAMPLE_LEARNINGS);
    const msg = addLearning(tmpDir, PROJECT, "Another insight");
    expect(resultMsg(msg).toLowerCase()).toContain("added");

    const result = readLearnings(tmpDir, PROJECT);
    if (!result.ok) return;
    expect(result.data.length).toBeGreaterThan(3);
    // New learnings are inserted under today's date at the top of the file
    const found = result.data.find((l) => l.text.includes("Another insight"));
    expect(found).toBeDefined();
    expect(found!.date).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe("removeLearning", () => {
  it("removes a matching learning entry", () => {
    fs.writeFileSync(path.join(projectDir, "LEARNINGS.md"), SAMPLE_LEARNINGS);
    const msg = removeLearning(tmpDir, PROJECT, "WAL mode");
    expect(resultMsg(msg)).toContain("Removed");

    const result = readLearnings(tmpDir, PROJECT);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    expect(result.data.every((l) => !l.text.includes("WAL mode"))).toBe(true);
  });

  it("removes a learning along with its citation comment", () => {
    fs.writeFileSync(path.join(projectDir, "LEARNINGS.md"), SAMPLE_LEARNINGS);
    const msg = removeLearning(tmpDir, PROJECT, "auth middleware");
    expect(resultMsg(msg)).toContain("Removed");

    const content = fs.readFileSync(path.join(projectDir, "LEARNINGS.md"), "utf8");
    expect(content).not.toContain("auth middleware");
    expect(content).not.toContain("cortex:cite");
  });

  it("returns an error when no learning matches", () => {
    fs.writeFileSync(path.join(projectDir, "LEARNINGS.md"), SAMPLE_LEARNINGS);
    const msg = removeLearning(tmpDir, PROJECT, "nonexistent xyz");
    expect(resultMsg(msg)).toContain("No learning matching");
  });

  it("returns an error when LEARNINGS.md does not exist", () => {
    const msg = removeLearning(tmpDir, PROJECT, "anything");
    expect(msg.ok).toBe(false);
    if (!msg.ok) expect(msg.code).toBe(CortexError.FILE_NOT_FOUND);
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
    const result = readMemoryQueue(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(3);
    expect(result.data[0].section).toBe("Review");
    expect(result.data[0].confidence).toBe(0.4);
  });

  it("approveMemoryQueueItem adds learning and removes queue item", () => {
    const msg = approveMemoryQueueItem(tmpDir, PROJECT, "cleanup flaky");
    expect(resultMsg(msg)).toContain("Approved memory");

    const queueAfter = readMemoryQueue(tmpDir, PROJECT);
    if (queueAfter.ok) {
      expect(queueAfter.data.some((i) => i.text.includes("cleanup flaky"))).toBe(false);
    }

    const learnings = readLearnings(tmpDir, PROJECT);
    if (learnings.ok) {
      expect(learnings.data.some((i) => i.text.includes("cleanup flaky"))).toBe(true);
    }
  });

  it("rejectMemoryQueueItem removes the matched queue item", () => {
    const msg = rejectMemoryQueueItem(tmpDir, PROJECT, "conflicting guidance");
    expect(resultMsg(msg)).toContain("Rejected memory");
    const queueAfter = readMemoryQueue(tmpDir, PROJECT);
    if (!queueAfter.ok) return;
    expect(queueAfter.data.some((i) => i.text.includes("conflicting guidance"))).toBe(false);
  });

  it("editMemoryQueueItem rewrites the item text", () => {
    const msg = editMemoryQueueItem(tmpDir, PROJECT, "old stale memory", "updated stale memory");
    expect(resultMsg(msg)).toContain("Edited memory");
    const queueAfter = readMemoryQueue(tmpDir, PROJECT);
    if (!queueAfter.ok) return;
    expect(queueAfter.data.some((i) => i.text.includes("updated stale memory"))).toBe(true);
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
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data["machine-a"]).toBe("personal");

    const msg = setMachineProfile(tmpDir, "machine-b", "personal");
    expect(resultMsg(msg)).toContain("Mapped machine machine-b");
    const after = listMachines(tmpDir);
    if (!after.ok) return;
    expect(after.data["machine-b"]).toBe("personal");
  });

  it("returns FILE_NOT_FOUND when machines.yaml is missing", () => {
    fs.unlinkSync(path.join(tmpDir, "machines.yaml"));
    const listed = listMachines(tmpDir);
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.code).toBe(CortexError.FILE_NOT_FOUND);
  });

  it("returns MALFORMED_YAML for invalid machines.yaml", () => {
    fs.writeFileSync(path.join(tmpDir, "machines.yaml"), "machine-a: [\n");
    const listed = listMachines(tmpDir);
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.code).toBe(CortexError.MALFORMED_YAML);
  });

  it("lists profiles and mutates profile projects", () => {
    const listed = listProfiles(tmpDir);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data[0].name).toBe("personal");

    const addMsg = addProjectToProfile(tmpDir, "personal", "another-proj");
    expect(resultMsg(addMsg)).toContain("Added another-proj");
    const removeMsg = removeProjectFromProfile(tmpDir, "personal", "another-proj");
    expect(resultMsg(removeMsg)).toContain("Removed another-proj");
  });

  it("returns FILE_NOT_FOUND when profiles directory is missing", () => {
    fs.rmSync(path.join(tmpDir, "profiles"), { recursive: true, force: true });
    const listed = listProfiles(tmpDir);
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.code).toBe(CortexError.FILE_NOT_FOUND);
  });

  it("returns MALFORMED_YAML for invalid profile yaml", () => {
    fs.writeFileSync(path.join(tmpDir, "profiles", "personal.yaml"), "name: personal\nprojects: [\n");
    const listed = listProfiles(tmpDir);
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.code).toBe(CortexError.MALFORMED_YAML);
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
    expect(resultMsg(msg)).toContain("reset");
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
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const lines = after.data.items.Queue.map((i) => i.line);
    expect(lines).toContain("First concurrent item");
    expect(lines).toContain("Second concurrent item");
  });

  it("two sequential addLearning calls produce valid LEARNINGS.md", () => {
    addLearning(tmpDir, PROJECT, "First learning");
    addLearning(tmpDir, PROJECT, "Second learning");

    const result = readLearnings(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const texts = result.data.map((l) => l.text);
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
    expect(resultMsg(msg)).toContain("Added");

    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    const lines = after.data.items.Queue.map((i) => i.line);
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

    expect(msg.ok).toBe(false);
    if (!msg.ok) expect(msg.code).toBe(CortexError.LOCK_TIMEOUT);
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

    expect(msg.ok).toBe(false);
    if (!msg.ok) expect(msg.code).toBe(CortexError.LOCK_TIMEOUT);

    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Active.some((i) => i.line.includes("Add rate limiting"))).toBe(false);
    expect(after.data.items.Queue.some((i) => i.line.includes("Add rate limiting"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("allows concurrent backlog writes from two processes without data loss", async () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);

    // Use forward slashes in import paths for Windows compatibility
    const dataAccessPath = path.join(REPO_ROOT, "mcp/src/data-access.ts").replace(/\\/g, "/");
    const mkCode = (item: string) =>
      `import { addBacklogItem } from ${JSON.stringify(dataAccessPath)};` +
      `process.env.CORTEX_ACTOR='vitest-admin';` +
      `const out=addBacklogItem(${JSON.stringify(tmpDir)},${JSON.stringify(PROJECT)},${JSON.stringify(item)});` +
      `console.log(out.ok ? out.data : out.error); if(!out.ok && out.error.includes('LOCK_TIMEOUT')) process.exit(2);`;

    const [a, b] = await Promise.all([
      runDataAccessWorker(mkCode("Concurrent item A")),
      runDataAccessWorker(mkCode("Concurrent item B")),
    ]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);

    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    const lines = after.data.items.Queue.map((i) => i.line);
    expect(lines).toContain("Concurrent item A");
    expect(lines).toContain("Concurrent item B");
  });

  it.skipIf(process.platform === "win32")("allows concurrent learning writes from two processes without data loss", async () => {
    // Use forward slashes in import paths for Windows compatibility
    const dataAccessPath = path.join(REPO_ROOT, "mcp/src/data-access.ts").replace(/\\/g, "/");
    const mkCode = (text: string) =>
      `import { addLearning } from ${JSON.stringify(dataAccessPath)};` +
      `process.env.CORTEX_ACTOR='vitest-admin';` +
      `const out=addLearning(${JSON.stringify(tmpDir)},${JSON.stringify(PROJECT)},${JSON.stringify(text)});` +
      `console.log(out.ok ? out.data : out.error); if(!out.ok && out.error.includes('LOCK_TIMEOUT')) process.exit(2);`;

    const [a, b] = await Promise.all([
      runDataAccessWorker(mkCode("Use writeFileSync with wx flag to atomically create lock files")),
      runDataAccessWorker(mkCode("Debounce disk flushes to avoid hammering storage on every event")),
    ]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);

    const result = readLearnings(tmpDir, PROJECT);
    if (!result.ok) return;
    const texts = result.data.map((l) => l.text);
    expect(texts.some((t) => t.includes("writeFileSync with wx flag"))).toBe(true);
    expect(texts.some((t) => t.includes("Debounce disk flushes"))).toBe(true);
  });
});

// --- Structured error codes ---

describe("structured error codes in data-access", () => {
  it("readBacklog returns INVALID_PROJECT_NAME for path traversal", () => {
    const result = readBacklog(tmpDir, "../escape");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(CortexError.INVALID_PROJECT_NAME);
  });

  it("readBacklog returns PROJECT_NOT_FOUND for missing project", () => {
    const result = readBacklog(tmpDir, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(CortexError.PROJECT_NOT_FOUND);
  });

  it("completeBacklogItem returns NOT_FOUND for unmatched item", () => {
    const msg = completeBacklogItem(tmpDir, PROJECT, "does-not-exist");
    expect(msg.ok).toBe(false);
    if (!msg.ok) expect(msg.code).toBe(CortexError.NOT_FOUND);
  });

  it("removeLearning returns NOT_FOUND for unmatched learning", () => {
    // Ensure LEARNINGS.md exists so the search runs
    fs.writeFileSync(path.join(projectDir, "LEARNINGS.md"), "# LEARNINGS\n\n## 2025-01-01\n\n- Existing learning\n");
    const msg = removeLearning(tmpDir, PROJECT, "nonexistent-learning-xyz");
    expect(msg.ok).toBe(false);
    if (!msg.ok) expect(msg.code).toBe(CortexError.NOT_FOUND);
  });

  it("editMemoryQueueItem returns EMPTY_INPUT for blank text", () => {
    const msg = editMemoryQueueItem(tmpDir, PROJECT, "anything", "");
    expect(msg.ok).toBe(false);
    if (!msg.ok) expect(msg.code).toBe(CortexError.EMPTY_INPUT);
  });

  it("listMachines returns FILE_NOT_FOUND when machines.yaml missing", () => {
    const tmp = makeTempDir("cortex-err-");
    try {
      const result = listMachines(tmp.path);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(CortexError.FILE_NOT_FOUND);
    } finally {
      tmp.cleanup();
    }
  });
});
