import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantAdmin, makeTempDir } from "../test-helpers.js";
import { initializeTaskFormat } from "../data/task-format.js";
import { StaleTaskSources } from "./task-stale.js";

let root = "", cleanup = () => {};
let now = 0;
const OLD = "2026-11-25T10:00:00.000Z";

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

const rows = () => new StaleTaskSources(root, () => now, computer => computer === "this-host").sources();

describe("StaleTaskSources (retired)", () => {
  it("lists no row for a stale Active task while tasks are retired", () => {
    project("app", `## Active\n\n- [ ] Fix the sync race <!-- bid:aaaaaaaa lastActivity:${OLD} -->\n`);
    expect(rows()).toEqual([]);
  });

  it("stays empty whatever PHREN_TASK_STALE says", () => {
    project("app", `## Active\n\n- [ ] Fix the sync race <!-- bid:aaaaaaaa lastActivity:${OLD} -->\n`);
    vi.stubEnv("PHREN_TASK_STALE", "off");
    expect(rows()).toEqual([]);
    vi.stubEnv("PHREN_TASK_STALE", "on");
    expect(rows()).toEqual([]);
  });

  it("never throws when a project's tasks.md cannot be read", () => {
    project("app", `## Active\n\n- [ ] Fix the sync race <!-- bid:aaaaaaaa lastActivity:${OLD} -->\n`);
    fs.rmSync(path.join(root, "app", "tasks.md"));
    fs.mkdirSync(path.join(root, "app", "tasks.md"));
    expect(rows()).toEqual([]);
  });
});
