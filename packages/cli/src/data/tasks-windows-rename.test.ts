import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";

// Windows refuses to rename over a file another process has open for reading
// (another MCP server reading tasks.md) with EPERM. Stand in for that reader
// holding tasks.md for the next `held` renames.
const reader = vi.hoisted(() => ({ held: 0 }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (reader.held > 0 && String(to).endsWith("tasks.md")) {
      reader.held--;
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: "EPERM" });
    }
    return actual.renameSync(from, to);
  }) as typeof actual.renameSync;
  return { ...actual, default: { ...actual, renameSync }, renameSync };
});

const { addTask } = await import("./tasks.js");

const platform = process.platform;
let tmp: ReturnType<typeof makeTempDir>;
beforeEach(() => {
  tmp = makeTempDir("tasks-windows-rename-");
  initTestPhrenRoot(tmp.path);
  fs.mkdirSync(path.join(tmp.path, "demo"));
});
afterEach(() => {
  reader.held = 0;
  Object.defineProperty(process, "platform", { value: platform });
  tmp.cleanup();
});

it("saves a task on Windows while another process briefly holds tasks.md open", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  reader.held = 3;
  const added = addTask(tmp.path, "demo", "Written past a reader");
  expect(added.ok, JSON.stringify(added)).toBe(true);
  expect(reader.held).toBe(0);
  expect(fs.readFileSync(path.join(tmp.path, "demo", "tasks.md"), "utf8")).toContain("Written past a reader");
});

it("does not retry the same refusal off Windows, where a rename never waits on readers", () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  reader.held = 1;
  expect(() => addTask(tmp.path, "demo", "Refused once")).toThrow(/EPERM/);
});
