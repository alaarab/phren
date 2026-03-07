import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readBacklog,
  addBacklogItem,
  addBacklogItems,
  completeBacklogItem,
  completeBacklogItems,
  updateBacklogItem,
  addFinding,
  removeFinding,
  readFindings,
  readReviewQueue,
  approveQueueItem,
  rejectQueueItem,
  editQueueItem,
  setMachineProfile,
  listMachines,
} from "../data-access.js";
import { CortexError } from "../shared.js";
import { grantAdmin, makeTempDir, resultMsg } from "../test-helpers.js";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";

const PROJECT = "conctest";
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

let tmpDir: string;
let projectDir: string;
let tmpCleanup: () => void;

function runWorker(code: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

const SAMPLE_BACKLOG = `# conctest backlog

## Active

- [ ] Active task one

## Queue

- [ ] Queue task one
- [ ] Queue task two
- [ ] Queue task three

## Done

- [x] Done task one
`;

beforeEach(() => {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("cortex-conc-"));
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

describe("concurrent write safety - in-process", () => {
  it("rapid sequential backlog adds do not lose items", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const count = 10;
    for (let i = 0; i < count; i++) {
      const msg = addBacklogItem(tmpDir, PROJECT, `Rapid item ${i}`);
      expect(msg.ok).toBe(true);
    }
    const after = readBacklog(tmpDir, PROJECT);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // Original 3 + 10 new items
    expect(after.data.items.Queue).toHaveLength(3 + count);
  });

  it("rapid sequential finding adds do not corrupt FINDINGS.md", () => {
    // Each finding must be semantically distinct to avoid dedup filtering
    const topics = [
      "SQLite WAL mode improves concurrent read performance by 3x",
      "Node.js streams backpressure must be handled via pause/resume",
      "TypeScript strict mode catches null reference bugs at compile time",
      "Vitest parallel test isolation requires separate temp directories",
      "Git rebase --autostash prevents losing uncommitted changes during rebase",
    ];
    for (const topic of topics) {
      addFinding(tmpDir, PROJECT, topic);
    }
    const result = readFindings(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.length).toBeGreaterThanOrEqual(5);
  });

  it("interleaved add and complete operations preserve integrity", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    addBacklogItem(tmpDir, PROJECT, "Interleave A");
    completeBacklogItem(tmpDir, PROJECT, "Queue task one");
    addBacklogItem(tmpDir, PROJECT, "Interleave B");
    completeBacklogItem(tmpDir, PROJECT, "Queue task two");
    addBacklogItem(tmpDir, PROJECT, "Interleave C");

    const after = readBacklog(tmpDir, PROJECT);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // Queue: original 3 - 2 completed + 3 added = 4
    expect(after.data.items.Queue).toHaveLength(4);
    // Done: original 1 + 2 completed = 3
    expect(after.data.items.Done).toHaveLength(3);
    const queueLines = after.data.items.Queue.map((i) => i.line);
    expect(queueLines).toContain("Interleave A");
    expect(queueLines).toContain("Interleave B");
    expect(queueLines).toContain("Interleave C");
  });

  it("lock timeout returns proper error code and does not mutate file", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const lockPath = path.join(projectDir, "backlog.md.lock");
    fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`);

    process.env.CORTEX_FILE_LOCK_MAX_WAIT_MS = "100";
    process.env.CORTEX_FILE_LOCK_POLL_MS = "20";

    const before = fs.readFileSync(path.join(projectDir, "backlog.md"), "utf8");
    const msg = addBacklogItem(tmpDir, PROJECT, "Should not be added");
    const after = fs.readFileSync(path.join(projectDir, "backlog.md"), "utf8");

    fs.unlinkSync(lockPath);

    expect(msg.ok).toBe(false);
    if (!msg.ok) {
      expect(msg.code).toBe(CortexError.LOCK_TIMEOUT);
      expect(msg.error).toContain("lock");
    }
    expect(after).toBe(before);
  });

  it("stale lock recovery allows write to proceed", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const lockPath = path.join(projectDir, "backlog.md.lock");
    fs.writeFileSync(lockPath, `99999\n${Date.now() - 60000}`);
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(lockPath, past, past);

    const msg = addBacklogItem(tmpDir, PROJECT, "After stale recovery");
    expect(msg.ok).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("lock is always cleaned up even when operation returns an error", () => {
    const findingsPath = path.join(projectDir, "FINDINGS.md");
    const lockPath = findingsPath + ".lock";

    // removeFinding on a project with no FINDINGS.md file
    removeFinding(tmpDir, PROJECT, "nonexistent");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("bulk add operations are atomic under a single lock", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const items = Array.from({ length: 5 }, (_, i) => `Bulk item ${i}`);
    const msg = addBacklogItems(tmpDir, PROJECT, items);
    expect(msg.ok).toBe(true);
    if (!msg.ok) return;
    expect(msg.data.added).toHaveLength(5);

    const after = readBacklog(tmpDir, PROJECT);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.items.Queue).toHaveLength(3 + 5);
  });

  it("bulk complete operations are atomic under a single lock", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const msg = completeBacklogItems(tmpDir, PROJECT, ["Queue task one", "Queue task two"]);
    expect(msg.ok).toBe(true);
    if (!msg.ok) return;
    expect(msg.data.completed).toHaveLength(2);

    const after = readBacklog(tmpDir, PROJECT);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.items.Queue).toHaveLength(1);
    expect(after.data.items.Done).toHaveLength(3);
  });

  it("concurrent lock on different files does not interfere", () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    // These operate on different files (backlog.md vs FINDINGS.md) so should not block each other
    const backlogMsg = addBacklogItem(tmpDir, PROJECT, "Backlog addition");
    const findingMsg = addFinding(tmpDir, PROJECT, "Finding alongside backlog write");
    expect(backlogMsg.ok).toBe(true);
    expect(findingMsg.ok).toBe(true);
  });
});

describe("concurrent write safety - queue operations", () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(projectDir, "MEMORY_QUEUE.md"),
      [
        "# conctest Memory Queue",
        "",
        "## Review",
        "",
        "- [2026-03-05] Review item one [confidence 0.90]",
        "- [2026-03-06] Review item two [confidence 0.85]",
        "",
        "## Stale",
        "",
        "- [2026-03-04] Stale item [confidence 0.55]",
        "",
        "## Conflicts",
        "",
        "",
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(projectDir, "FINDINGS.md"),
      "# conctest FINDINGS\n\n## 2026-03-01\n\n- Existing finding\n"
    );
  });

  it("approve then reject on different items leaves correct queue state", () => {
    const approveMsg = approveQueueItem(tmpDir, PROJECT, "Review item one");
    expect(approveMsg.ok).toBe(true);

    const rejectMsg = rejectQueueItem(tmpDir, PROJECT, "Stale item");
    expect(rejectMsg.ok).toBe(true);

    const queue = readReviewQueue(tmpDir, PROJECT);
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    expect(queue.data).toHaveLength(1);
    expect(queue.data[0].text).toContain("Review item two");
  });

  it("edit then approve produces correct findings entry", () => {
    const editMsg = editQueueItem(tmpDir, PROJECT, "Review item one", "Edited review item");
    expect(editMsg.ok).toBe(true);

    const queue = readReviewQueue(tmpDir, PROJECT);
    if (!queue.ok) return;
    const editedItem = queue.data.find((i) => i.text.includes("Edited review item"));
    expect(editedItem).toBeDefined();

    const approveMsg = approveQueueItem(tmpDir, PROJECT, "Edited review item");
    expect(approveMsg.ok).toBe(true);

    const findings = readFindings(tmpDir, PROJECT);
    if (!findings.ok) return;
    expect(findings.data.some((f) => f.text.includes("Edited review item"))).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("concurrent write safety - cross-process", () => {
  it("three concurrent backlog adds from separate processes all succeed", async () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const dataAccessPath = path.join(REPO_ROOT, "mcp/src/data-access.ts").replace(/\\/g, "/");

    const mkCode = (item: string) =>
      `import { addBacklogItem } from ${JSON.stringify(dataAccessPath)};` +
      `process.env.CORTEX_ACTOR='vitest-admin';` +
      `const out=addBacklogItem(${JSON.stringify(tmpDir)},${JSON.stringify(PROJECT)},${JSON.stringify(item)});` +
      `console.log(out.ok ? out.data : out.error); if(!out.ok && out.error.includes('LOCK_TIMEOUT')) process.exit(2);`;

    const results = await Promise.all([
      runWorker(mkCode("Process item A")),
      runWorker(mkCode("Process item B")),
      runWorker(mkCode("Process item C")),
    ]);

    for (const r of results) {
      expect(r.exitCode).toBe(0);
    }

    const after = readBacklog(tmpDir, PROJECT);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const lines = after.data.items.Queue.map((i) => i.line);
    expect(lines).toContain("Process item A");
    expect(lines).toContain("Process item B");
    expect(lines).toContain("Process item C");
  });

  it("concurrent finding and backlog writes from separate processes both succeed", async () => {
    fs.writeFileSync(path.join(projectDir, "backlog.md"), SAMPLE_BACKLOG);
    const dataAccessPath = path.join(REPO_ROOT, "mcp/src/data-access.ts").replace(/\\/g, "/");

    const backlogCode =
      `import { addBacklogItem } from ${JSON.stringify(dataAccessPath)};` +
      `process.env.CORTEX_ACTOR='vitest-admin';` +
      `const out=addBacklogItem(${JSON.stringify(tmpDir)},${JSON.stringify(PROJECT)},"Cross-process backlog item");` +
      `console.log(out.ok ? out.data : out.error);`;

    const findingCode =
      `import { addFinding } from ${JSON.stringify(dataAccessPath)};` +
      `process.env.CORTEX_ACTOR='vitest-admin';` +
      `const out=addFinding(${JSON.stringify(tmpDir)},${JSON.stringify(PROJECT)},"Cross-process finding with unique content");` +
      `console.log(out.ok ? out.data : out.error);`;

    const [backlogResult, findingResult] = await Promise.all([
      runWorker(backlogCode),
      runWorker(findingCode),
    ]);

    expect(backlogResult.exitCode).toBe(0);
    expect(findingResult.exitCode).toBe(0);

    const backlog = readBacklog(tmpDir, PROJECT);
    expect(backlog.ok).toBe(true);
    if (backlog.ok) {
      expect(backlog.data.items.Queue.map((i) => i.line)).toContain("Cross-process backlog item");
    }

    const findings = readFindings(tmpDir, PROJECT);
    expect(findings.ok).toBe(true);
    if (findings.ok) {
      expect(findings.data.some((f) => f.text.includes("Cross-process finding"))).toBe(true);
    }
  });
});

describe("concurrent write safety - machines.yaml", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "machines.yaml"), "orig-machine: personal\n");
    fs.writeFileSync(
      path.join(tmpDir, "profiles", "personal.yaml"),
      "name: personal\nprojects:\n  - conctest\n"
    );
  });

  it("sequential machine profile updates all persist", () => {
    setMachineProfile(tmpDir, "machine-a", "personal");
    setMachineProfile(tmpDir, "machine-b", "personal");
    setMachineProfile(tmpDir, "machine-c", "personal");

    const listed = listMachines(tmpDir);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data["machine-a"]).toBe("personal");
    expect(listed.data["machine-b"]).toBe("personal");
    expect(listed.data["machine-c"]).toBe("personal");
    expect(listed.data["orig-machine"]).toBe("personal");
  });

  it("machine lock timeout returns proper error", () => {
    const lockPath = path.join(tmpDir, "machines.yaml.lock");
    fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`);

    process.env.CORTEX_FILE_LOCK_MAX_WAIT_MS = "100";
    process.env.CORTEX_FILE_LOCK_POLL_MS = "20";

    const msg = setMachineProfile(tmpDir, "blocked-machine", "personal");
    fs.unlinkSync(lockPath);

    expect(msg.ok).toBe(false);
    if (!msg.ok) expect(msg.code).toBe(CortexError.LOCK_TIMEOUT);
  });
});
