import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { grantAdmin, makeTempDir, initTestPhrenRoot } from "../test-helpers.js";
import { addStoreToRegistry, registerStoreIdentity, registeredStoreIdentity } from "../store-registry.js";
import { taskFormatStatus } from "../data/task-format.js";
import { TASKS_RETIRED_MESSAGE } from "../task/retired.js";
import { handleTaskNamespace } from "./namespaces-tasks.js";

describe("phren task format", () => {
  let root: string, primary: string, team: string, cleanup: () => void;
  const origPhrenPath = process.env.PHREN_PATH;

  beforeAll(() => {
    ({ path: root, cleanup } = makeTempDir("task-format-cli-"));
    primary = path.join(root, ".phren");
    team = path.join(root, ".phren-stores", "crew");
    grantAdmin(primary);
    grantAdmin(team);
    registerStoreIdentity(primary);
    // A legacy team store: attached here, but with no portable identity yet.
    addStoreToRegistry(primary, { id: "22222222", name: "crew", path: team, role: "team", sync: "managed-git" });
    fs.mkdirSync(path.join(team, "global"), { recursive: true });
    process.env.PHREN_PATH = primary;
  });
  afterAll(() => {
    if (origPhrenPath === undefined) delete process.env.PHREN_PATH;
    else process.env.PHREN_PATH = origPhrenPath;
    vi.restoreAllMocks();
    cleanup();
  });

  async function run(cwd: string, ...args: string[]) {
    const lines: string[] = [];
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const log = vi.spyOn(console, "log").mockImplementation((...a) => { lines.push(a.join(" ")); });
    const err = vi.spyOn(console, "error").mockImplementation((...a) => { lines.push(a.join(" ")); });
    try { await handleTaskNamespace(["format", ...args]); } finally { log.mockRestore(); err.mockRestore(); }
    return lines.join("\n");
  }

  it("enables the store whose folder it runs in and names it", async () => {
    expect(await run(path.join(team, "global"))).toMatch(/Store: crew[\s\S]*Task metadata: off/);

    const out = await run(path.join(team, "global"), "enable", "--all-writers-compatible");

    expect(out).toContain("crew");
    expect(process.exitCode ?? 0).toBe(0);
    expect(registeredStoreIdentity(team)).toMatch(/^[a-f0-9]{8}$/);
    expect(taskFormatStatus(team).enabled).toBe(true);
    expect(taskFormatStatus(primary).enabled).toBe(false);
    expect(JSON.parse(await run(root, "--json"))).toMatchObject({ enabled: false, path: primary });
  });
});

describe("phren task write subcommands are retired", () => {
  let root: string, cleanup: () => void;
  const origPhrenPath = process.env.PHREN_PATH;

  beforeAll(() => {
    ({ path: root, cleanup } = makeTempDir("task-retired-cli-"));
    initTestPhrenRoot(root);
    process.env.PHREN_PATH = root;
  });
  afterAll(() => {
    if (origPhrenPath === undefined) delete process.env.PHREN_PATH;
    else process.env.PHREN_PATH = origPhrenPath;
    process.exitCode = 0;
    cleanup();
  });
  afterEach(() => { process.exitCode = 0; });

  const WRITES = [
    ["add", "demo", "Write a task"],
    ["complete", "demo", "Write a task"],
    ["remove", "demo", "Write a task"],
    ["update", "demo", "Write a task", "--priority=high"],
    ["pin", "demo", "Write a task"],
    ["reorder", "demo", "Write a task", "--rank=1"],
    ["next", "demo"],
    ["promote", "demo", "Write a task"],
    ["tidy", "demo"],
    ["link", "demo", "Write a task", "--issue", "1"],
    ["create-issue", "demo", "Write a task"],
    ["reconcile", "demo", "--apply"],
  ];

  it.each(WRITES)("%s is refused with tasks-retired", async (...args) => {
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
    try { await handleTaskNamespace(args as string[]); } finally { errSpy.mockRestore(); }
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toBe(TASKS_RETIRED_MESSAGE);
  });
});
