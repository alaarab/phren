import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";

// Windows refuses to rename over a file another process has open for reading
// (an MCP server or hook reading retention-policy.json) with EPERM. Stand in
// for that reader holding the file for the next `held` renames.
const reader = vi.hoisted(() => ({ held: 0 }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (reader.held > 0 && String(to).endsWith("retention-policy.json")) {
      reader.held--;
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: "EPERM" });
    }
    return actual.renameSync(from, to);
  }) as typeof actual.renameSync;
  return { ...actual, default: { ...actual, renameSync }, renameSync };
});

const { updateRetentionPolicy } = await import("./policy.js");

const platform = process.platform;
let tmp: ReturnType<typeof makeTempDir>;
beforeEach(() => {
  tmp = makeTempDir("policy-windows-rename-");
  initTestPhrenRoot(tmp.path);
});
afterEach(() => {
  reader.held = 0;
  Object.defineProperty(process, "platform", { value: platform });
  tmp.cleanup();
});

it("saves a policy on Windows while another process briefly holds the file open", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  reader.held = 3;
  const updated = updateRetentionPolicy(tmp.path, { ttlDays: 7 });
  expect(updated.ok, JSON.stringify(updated)).toBe(true);
  expect(reader.held).toBe(0);
  expect(fs.readFileSync(path.join(tmp.path, ".config", "retention-policy.json"), "utf8")).toContain('"ttlDays": 7');
});

it("does not retry the same refusal off Windows, where a rename never waits on readers", () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  reader.held = 1;
  expect(() => updateRetentionPolicy(tmp.path, { ttlDays: 7 })).toThrow(/EPERM/);
  // The refused write leaves no temp file in the config directory.
  expect(fs.readdirSync(path.join(tmp.path, ".config")).filter(name => name.includes(".tmp"))).toEqual([]);
});
