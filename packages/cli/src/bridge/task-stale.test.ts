import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantAdmin, makeTempDir } from "../test-helpers.js";
import { initializeTaskFormat } from "../data/task-format.js";
import { StaleTaskSources } from "./task-stale.js";

let root = "", cleanup = () => {};
let now = 0;
// 26 h and 1 h before `now`: one side of STALE_MS each.
const OLD = "2026-11-25T10:00:00.000Z";
const FRESH = "2026-11-26T11:00:00.000Z";

beforeEach(() => {
  const temp = makeTempDir("task-stale-");
  root = temp.path; cleanup = temp.cleanup;
  grantAdmin(root);
  initializeTaskFormat(root);
  vi.stubEnv("PHREN_PATH", root);
  vi.stubEnv("PHREN_TASK_STALE", "on");
  now = Date.parse("2026-11-26T12:00:00.000Z");
});
afterEach(() => { vi.unstubAllEnvs(); cleanup(); });

function project(name: string, body: string): void {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, "tasks.md"), `# ${name} tasks\n\n${body}`);
}

/** This computer is "this-host": a claim here stays this Hook's row. */
const rows = () => new StaleTaskSources(root, () => now, computer => computer === "this-host").sources();

describe("StaleTaskSources", () => {
  it("lists no row for a fresh Active task", () => {
    project("app", `## Active\n\n- [ ] Fresh work <!-- bid:aaaaaaaa lastActivity:${FRESH} -->\n`);
    expect(rows()).toEqual([]);
  });

  it("lists a stale Active task as a needs-you row naming its project and date", () => {
    project("app", `## Active\n\n- [ ] Fix the sync race <!-- bid:aaaaaaaa lastActivity:${OLD} -->\n`);
    expect(rows()).toEqual([{
      source: "task-stale:app:aaaaaaaa", kind: "needs-you", project: "app", task: "bid:aaaaaaaa",
      title: "Stale task in app: Fix the sync race (Active, untouched since 2026-11-25)",
    }]);
  });

  it("skips a task claimed by another computer", () => {
    project("app", `## Active\n\n- [ ] Fix the sync race <!-- bid:aaaaaaaa lastActivity:${OLD} -->\n  Claimed: other-host 2026-11-25T10:00:00.000Z\n`);
    expect(rows()).toEqual([]);
  });

  it("keeps a task claimed by this computer", () => {
    project("app", `## Active\n\n- [ ] Fix the sync race <!-- bid:aaaaaaaa lastActivity:${OLD} -->\n  Claimed: this-host 2026-11-25T10:00:00.000Z\n`);
    expect(rows()).toMatchObject([{ computer: "this-host" }]);
  });

  it("ignores an old Queue task and a task without a stable id", () => {
    project("app", `## Queue\n\n- [ ] Waiting long <!-- bid:aaaaaaaa lastActivity:${OLD} -->\n\n## Active\n\n- [ ] No identity, just old\n`);
    expect(rows()).toEqual([]);
  });

  it("keeps at most 20 rows, oldest first", () => {
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) {
      const at = new Date(Date.parse("2026-11-20T00:00:00.000Z") + i * 3_600_000).toISOString();
      lines.push(`- [ ] Task ${i} <!-- bid:${i.toString(16).padStart(8, "0")} lastActivity:${at} -->`);
    }
    project("app", `## Active\n\n${lines.join("\n")}\n`);
    const stale = new StaleTaskSources(root, () => now, computer => computer === "this-host");
    expect(stale.sources().map(row => row.source)).toEqual(
      Array.from({ length: 20 }, (_, i) => `task-stale:app:${i.toString(16).padStart(8, "0")}`));
  });

  it("recomputes only after the cache expires", () => {
    const stale = new StaleTaskSources(root, () => now, computer => computer === "this-host");
    project("app", `## Active\n\n- [ ] Fresh work <!-- bid:aaaaaaaa lastActivity:${FRESH} -->\n`);
    expect(stale.sources()).toEqual([]);
    // Written after the first read: hidden while the cache holds, seen once it expires.
    fs.writeFileSync(path.join(root, "app", "tasks.md"), `# app tasks\n\n## Active\n\n- [ ] Stale work <!-- bid:aaaaaaaa lastActivity:${OLD} -->\n`);
    expect(stale.sources()).toEqual([]);
    now += 5 * 60 * 1000 + 1;
    expect(stale.sources()).toHaveLength(1);
  });

  it("keeps the previous rows when a read fails, and never throws", () => {
    const stale = new StaleTaskSources(root, () => now, computer => computer === "this-host");
    project("app", `## Active\n\n- [ ] Stale work <!-- bid:aaaaaaaa lastActivity:${OLD} -->\n`);
    expect(stale.sources()).toHaveLength(1);
    now += 6 * 60 * 1000;
    // A directory where tasks.md was: reading it throws inside the recompute.
    fs.rmSync(path.join(root, "app", "tasks.md"));
    fs.mkdirSync(path.join(root, "app", "tasks.md"));
    expect(stale.sources()).toHaveLength(1);
  });

  it("lists nothing with PHREN_TASK_STALE=off", () => {
    project("app", `## Active\n\n- [ ] Stale work <!-- bid:aaaaaaaa lastActivity:${OLD} -->\n`);
    vi.stubEnv("PHREN_TASK_STALE", "off");
    expect(rows()).toEqual([]);
  });
});
