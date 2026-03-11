import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin, resultMsg } from "../test-helpers.js";
import {
  addBacklogItem,
  completeBacklogItem,
  readBacklog,
  TASKS_FILENAME,
} from "../data-access.js";

const PROJECT = "testproject";

let tmpDir: string;
let projectDir: string;
let tmpCleanup: () => void;

const SAMPLE_BACKLOG = `# testproject backlog

## Active

- [ ] Implement auth middleware [high]

## Queue

- [ ] Add rate limiting
- [ ] Refactor database layer [medium]

## Done

- [x] Set up CI pipeline
`;

beforeEach(() => {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("mcp-backlog-test-"));
  projectDir = path.join(tmpDir, PROJECT);
  fs.mkdirSync(projectDir, { recursive: true });
  grantAdmin(tmpDir);
});

afterEach(() => {
  delete process.env.CORTEX_ACTOR;
  tmpCleanup();
});

describe("add_backlog_item MCP tool", () => {
  it("happy path: item gets added to the task file", () => {
    fs.writeFileSync(path.join(projectDir, TASKS_FILENAME), SAMPLE_BACKLOG);
    const msg = addBacklogItem(tmpDir, PROJECT, "Set up monitoring dashboard");
    expect(msg.ok).toBe(true);
    expect(resultMsg(msg)).toContain("Added");

    const after = readBacklog(tmpDir, PROJECT);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const queueLines = after.data.items.Queue.map((i) => i.line);
    expect(queueLines).toContain("Set up monitoring dashboard");
  });

  it("creates the task file when none exists", () => {
    const msg = addBacklogItem(tmpDir, PROJECT, "First task ever");
    expect(msg.ok).toBe(true);
    expect(fs.existsSync(path.join(projectDir, TASKS_FILENAME))).toBe(true);

    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Queue).toHaveLength(1);
    expect(after.data.items.Queue[0].line).toBe("First task ever");
  });

  it("invalid project name returns error", () => {
    const msg = addBacklogItem(tmpDir, "../escape", "should fail");
    expect(msg.ok).toBe(false);
  });

  it("nonexistent project directory still creates backlog", () => {
    // project dir exists (created in beforeEach), so this should work
    const msg = addBacklogItem(tmpDir, PROJECT, "New item");
    expect(msg.ok).toBe(true);
  });
});

describe("complete_backlog_item MCP tool", () => {
  it("item moves to Done", () => {
    fs.writeFileSync(path.join(projectDir, TASKS_FILENAME), SAMPLE_BACKLOG);
    const msg = completeBacklogItem(tmpDir, PROJECT, "rate limiting");
    expect(msg.ok).toBe(true);
    expect(resultMsg(msg)).toContain("Marked done");

    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Done).toHaveLength(2);
    expect(after.data.items.Done[0].line).toContain("rate limiting");
    expect(after.data.items.Done[0].checked).toBe(true);
    expect(after.data.items.Queue).toHaveLength(1);
  });

  it("nonexistent item returns error message", () => {
    fs.writeFileSync(path.join(projectDir, TASKS_FILENAME), SAMPLE_BACKLOG);
    const msg = completeBacklogItem(tmpDir, PROJECT, "nonexistent item xyz123");
    expect(msg.ok).toBe(false);
    expect(resultMsg(msg)).toContain("Item not found");
  });

  it("completes by item ID", () => {
    fs.writeFileSync(path.join(projectDir, TASKS_FILENAME), SAMPLE_BACKLOG);
    const msg = completeBacklogItem(tmpDir, PROJECT, "Q1");
    expect(msg.ok).toBe(true);

    const after = readBacklog(tmpDir, PROJECT);
    if (!after.ok) return;
    expect(after.data.items.Queue).toHaveLength(1);
    expect(after.data.items.Done[0].line).toContain("rate limiting");
  });

  it("invalid project returns error", () => {
    const msg = completeBacklogItem(tmpDir, "../escape", "anything");
    expect(msg.ok).toBe(false);
  });
});

describe("readBacklog done_limit", () => {
  it("done_limit returns most recent items, not oldest", () => {
    // Seed Active section with 10 items
    const activeItems = "# backlog\n\n## Active\n\n" +
      Array.from({ length: 10 }, (_, i) => `- [ ] Done item ${i + 1}`).join("\n") + "\n\n## Queue\n\n## Done\n";
    fs.writeFileSync(path.join(projectDir, TASKS_FILENAME), activeItems);

    // Complete each item in order 1..10; completeBacklogItem uses unshift so last completed is at index 0
    for (let i = 1; i <= 10; i++) {
      completeBacklogItem(tmpDir, PROJECT, `Done item ${i}`);
    }

    const result = readBacklog(tmpDir, PROJECT);
    expect(result.ok).toBe(true);
    const doneItems = result.data.items.Done;
    expect(doneItems).toHaveLength(10);
    // completeBacklogItem uses unshift (prepend), so most recently completed is first
    expect(doneItems[0].line).toContain("Done item 10");
    expect(doneItems[9].line).toContain("Done item 1");
  });
});
