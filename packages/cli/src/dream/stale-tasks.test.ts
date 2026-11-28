import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantAdmin, makeTempDir } from "../test-helpers.js";
import { readTasks } from "../data/tasks.js";
import { initializeTaskFormat } from "../data/task-format.js";
import { requeueStaleTasks } from "./stale-tasks.js";
import { dream, type DreamRunner } from "./run.js";

const NOW = new Date("2026-11-27T03:00:00.000Z");
// 41 h and 1 h before NOW: one side of STALE_MS each.
const OLD = "2026-11-25T10:00:00.000Z";
const FRESH = "2026-11-27T02:00:00.000Z";

let root = "", cleanup = () => {};

beforeEach(() => {
  const temp = makeTempDir("phren-stale-dream-");
  root = temp.path; cleanup = temp.cleanup;
  grantAdmin(root);
  initializeTaskFormat(root);
  vi.stubEnv("PHREN_PATH", root);
  vi.stubEnv("PHREN_TASK_STALE", "on");
});
afterEach(() => { vi.unstubAllEnvs(); cleanup(); });

function project(name: string, body: string): void {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, "tasks.md"), `# ${name} tasks\n\n${body}`);
}

function task(stableId: string) {
  const doc = readTasks(root, "app");
  if (!doc.ok) throw new Error(doc.error);
  return [...doc.data.items.Active, ...doc.data.items.Queue, ...doc.data.items.Done].find(entry => entry.stableId === stableId)!;
}

describe("requeueStaleTasks (retired)", () => {
  it("never moves a stale Active task while tasks are retired", () => {
    project("app", [
      "## Active", "",
      `- [ ] Stale work <!-- bid:aaaaaaaa lastActivity:${OLD} -->`,
      "  Context: Original note",
      "  Claimed: mini 2026-11-25T10:00:00.000Z",
      `- [ ] Fresh work <!-- bid:bbbbbbbb lastActivity:${FRESH} -->`,
      "", "## Queue", "",
      `- [ ] Waiting long <!-- bid:cccccccc lastActivity:${OLD} -->`,
      "",
    ].join("\n"));
    const before = fs.readFileSync(path.join(root, "app", "tasks.md"), "utf8");
    expect(requeueStaleTasks(root, "app", NOW)).toEqual({ requeued: [], errors: 0 });
    expect(fs.readFileSync(path.join(root, "app", "tasks.md"), "utf8")).toBe(before);
    expect(task("aaaaaaaa").section).toBe("Active");
    expect(task("aaaaaaaa").claim).toBeDefined();
    expect(task("aaaaaaaa").context).toBe("Original note");
  });

  it("does nothing with PHREN_TASK_STALE=off", () => {
    project("app", `## Active\n\n- [ ] Stale work <!-- bid:aaaaaaaa lastActivity:${OLD} -->\n`);
    vi.stubEnv("PHREN_TASK_STALE", "off");
    expect(requeueStaleTasks(root, "app", NOW)).toEqual({ requeued: [], errors: 0 });
    expect(task("aaaaaaaa").section).toBe("Active");
  });

  it("does nothing when update_task is denied", () => {
    fs.mkdirSync(path.join(root, ".config"), { recursive: true });
    fs.writeFileSync(path.join(root, ".config", "access-control.json"), JSON.stringify({ admins: ["owner"] }));
    vi.stubEnv("PHREN_ACTOR", "stranger");
    project("app", `## Active\n\n- [ ] Stale work <!-- bid:aaaaaaaa lastActivity:${OLD} -->\n`);
    expect(requeueStaleTasks(root, "app", NOW)).toEqual({ requeued: [], errors: 0 });
    expect(task("aaaaaaaa").section).toBe("Active");
  });
});

describe("the nightly dream", () => {
  const runner: DreamRunner = async () => ({ ok: true, output: JSON.stringify({ notes: "", changes: [] }) });
  // Built per test: `root` is reassigned by beforeEach.
  const opts = () => ({ phrenPath: root, now: NOW, runner, collect: { roots: [], projectDirs: [], gitLog: false as const }, config: { enabled: true } });

  it("does not requeue stale tasks on the scheduled run while tasks are retired", async () => {
    project("app", `## Active\n\n- [ ] Stale work <!-- bid:aaaaaaaa lastActivity:${OLD} -->\n`);
    const result = await dream("app", { ...opts(), trigger: "scheduled" });
    expect(result.status).toBe("empty");
    expect(result.requeued).toBeUndefined();
    expect(result.message).not.toContain("stale task");
    expect(task("aaaaaaaa").section).toBe("Active");
  });

  it("never moves tasks on a manual dream or a dry run", async () => {
    project("app", `## Active\n\n- [ ] Stale work <!-- bid:aaaaaaaa lastActivity:${OLD} -->\n`);
    const manual = await dream("app", opts());
    expect(manual.status).toBe("empty");
    expect(manual.requeued).toBeUndefined();
    expect(manual.message).not.toContain("stale task");
    const dry = await dream("app", { ...opts(), trigger: "scheduled", dryRun: true });
    expect(dry.requeued).toBeUndefined();
    expect(task("aaaaaaaa").section).toBe("Active");
  });
});
