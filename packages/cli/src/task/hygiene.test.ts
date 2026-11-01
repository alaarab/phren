import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import { inspectTaskHygiene } from "./hygiene.js";

const PROJECT = "hygiene-proj";

let tmp: { path: string; cleanup: () => void };
let repoPath: string;

beforeEach(() => {
  tmp = makeTempDir("phren-task-hygiene-");
  initTestPhrenRoot(tmp.path);
  repoPath = path.join(tmp.path, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
});

afterEach(() => {
  tmp.cleanup();
});

function writeTasks(content: string): void {
  const projectDir = path.join(tmp.path, PROJECT);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "tasks.md"), content);
}

function writeRepoFile(relativePath: string, content = "placeholder\n"): void {
  const filePath = path.join(repoPath, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("inspectTaskHygiene", () => {
  it("reports a missing file anchor with the task id, reason and evidence", () => {
    writeTasks("# hygiene-proj tasks\n\n## Active\n\n- [ ] Refactor `missing-widget.ts` rendering\n\n## Queue\n\n## Done\n");
    writeRepoFile("src/widget.ts");

    const result = inspectTaskHygiene(tmp.path, PROJECT, repoPath);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { id: "A1", line: "Refactor `missing-widget.ts` rendering", reason: "anchors-missing", evidence: ["missing-widget.ts"] },
    ]);
    expect(result.detail).toBe("1 suspect task(s): A1 missing anchors (missing-widget.ts)");
  });

  it("accepts a task whose anchor names a file in the repository", () => {
    writeTasks("# hygiene-proj tasks\n\n## Active\n\n- [ ] Refactor `shell-view.ts` selection rendering\n\n## Queue\n\n## Done\n");
    writeRepoFile("src/shell-view.ts", "export const shellView = true;\n");

    const result = inspectTaskHygiene(tmp.path, PROJECT, repoPath);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.detail).toBe("ok across 2 roots");
  });

  it("matches a task without anchors against distinctive repository prose", () => {
    writeTasks("# hygiene-proj tasks\n\n## Active\n\n- [ ] Improve chart interface with bubble details and device type filters\n\n## Queue\n\n## Done\n");
    writeRepoFile("notes/dashboard.md", "The bubble details panel groups incidents by device.\n");

    const result = inspectTaskHygiene(tmp.path, PROJECT, repoPath);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("does not flag a task with fewer than two distinctive keywords", () => {
    writeTasks("# hygiene-proj tasks\n\n## Active\n\n- [ ] Fix tests\n\n## Queue\n\n## Done\n");

    const result = inspectTaskHygiene(tmp.path, PROJECT, repoPath);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("inspects Active and Queue tasks but never Done tasks", () => {
    writeTasks([
      "# hygiene-proj tasks",
      "",
      "## Active",
      "",
      "- [ ] Remove `active-ghost.ts`",
      "",
      "## Queue",
      "",
      "- [ ] Remove `queued-ghost.ts`",
      "",
      "## Done",
      "",
      "- [x] Remove `done-ghost.ts`",
      "",
    ].join("\n"));
    writeRepoFile("src/present.ts");

    const result = inspectTaskHygiene(tmp.path, PROJECT, repoPath);

    expect(result.issues.map((issue) => [issue.id, issue.reason])).toEqual([
      ["A1", "anchors-missing"],
      ["Q1", "anchors-missing"],
    ]);
  });

  it("does not treat tasks.md itself as grounding evidence", () => {
    writeTasks("# hygiene-proj tasks\n\n## Active\n\n- [ ] Rework `tasks.md` rendering\n\n## Queue\n\n## Done\n");

    const result = inspectTaskHygiene(tmp.path, PROJECT, repoPath);

    expect(result.ok).toBe(false);
    expect(result.issues).toMatchObject([
      { id: "A1", reason: "anchors-missing", evidence: ["tasks.md"] },
    ]);
  });

  it("ignores files under skipped dependency directories", () => {
    writeTasks("# hygiene-proj tasks\n\n## Active\n\n- [ ] Replace `vendor-shim.js` mocking\n\n## Queue\n\n## Done\n");
    writeRepoFile("node_modules/pkg/vendor-shim.js", "module.exports = {};\n");

    const result = inspectTaskHygiene(tmp.path, PROJECT, repoPath);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { id: "A1", line: "Replace `vendor-shim.js` mocking", reason: "anchors-missing", evidence: ["vendor-shim.js"] },
    ]);
  });

  it("skips hygiene when the project's tasks cannot be read", () => {
    const result = inspectTaskHygiene(tmp.path, "ghost-project", repoPath);

    expect(result.ok).toBe(true);
    expect(result.detail).toBe("skipped: tasks unavailable");
    expect(result.issues).toEqual([]);
  });
});
