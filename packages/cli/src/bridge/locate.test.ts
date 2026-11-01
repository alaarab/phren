import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locateProject } from "./locate.js";

describe("locating a project on this computer", () => {
  let root = "", home = "";
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "phren-locate-"));
    home = path.join(root, "home");
    mkdirSync(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PHREN_HERDR_HOME", path.join(root, "herdr"));
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PHREN_PATH: path.join(root, "store"), ...extra });

  it("offers a symlinked project once, at its real path", async () => {
    const real = path.join(home, "work/located");
    mkdirSync(path.join(real, "src"), { recursive: true });
    mkdirSync(path.join(home, "Projects"), { recursive: true });
    symlinkSync(real, path.join(home, "Projects/located"));

    const found = await locateProject("located",
      [{ at: "2026-10-01T00:00:00Z", directory: path.join(home, "Projects/located/src") }], env());

    expect(found.map(f => [f.source, f.directory])).toEqual([["activity", realpathSync.native(real)]]);
  });

  it("skips a plain file and a dangling symlink named like the project", async () => {
    mkdirSync(path.join(home, "Projects"), { recursive: true });
    mkdirSync(path.join(home, "Code"), { recursive: true });
    writeFileSync(path.join(home, "Projects/broken"), "");
    symlinkSync(path.join(home, "Projects/missing"), path.join(home, "Code/broken"));

    expect(await locateProject("broken", [], env())).toEqual([]);
  });

  it("keeps the newest activity timestamp when the same folder repeats", async () => {
    const dir = path.join(home, "Projects/repeat");
    mkdirSync(path.join(dir, "nested"), { recursive: true });

    const found = await locateProject("repeat", [
      { at: "2026-10-01T00:00:00Z", directory: dir },
      { at: "2026-10-02T00:00:00Z", directory: path.join(dir, "nested") },
    ], env());

    expect(found).toEqual([{ directory: realpathSync.native(dir), source: "activity", lastSeen: "2026-10-02T00:00:00Z" }]);
  });

  it("does not mistake a folder that only starts with the project name for the project", async () => {
    mkdirSync(path.join(home, "Projects/sample-old/src"), { recursive: true });

    const found = await locateProject("sample",
      [{ at: "2026-10-01T00:00:00Z", directory: path.join(home, "Projects/sample-old/src") }], env());

    expect(found).toEqual([]);
  });

  it("offers at most eight folders, newest activity first", async () => {
    const directories: string[] = [];
    const activity: Array<{ at: string; directory: string }> = [];
    for (let i = 1; i <= 10; i += 1) {
      const directory = path.join(home, `w${i}/many`);
      mkdirSync(directory, { recursive: true });
      directories.push(directory);
      activity.push({ at: `2026-10-${String(i).padStart(2, "0")}T00:00:00Z`, directory });
    }

    const found = await locateProject("many", activity, env());

    expect(found.map(f => f.directory)).toEqual(directories.slice(2).reverse().map(d => realpathSync.native(d)));
    expect(found.every(f => f.source === "activity")).toBe(true);
  });

  it("searches PROJECTS_DIR before the usual home roots", async () => {
    const custom = path.join(home, "custom/proj");
    const usual = path.join(home, "Projects/proj");
    mkdirSync(custom, { recursive: true });
    mkdirSync(usual, { recursive: true });

    const found = await locateProject("proj", [], env({ PROJECTS_DIR: path.join(home, "custom") }));

    expect(found.map(f => [f.source, f.directory])).toEqual([
      ["search", realpathSync.native(custom)],
      ["search", realpathSync.native(usual)],
    ]);
  });

  it("reads a quoted sourcePath from a registration on this machine", async () => {
    const dir = path.join(home, "Projects/quoted");
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(root, "store/quoted"), { recursive: true });
    writeFileSync(path.join(root, "store/quoted/phren.project.yaml"), `sourcePath: "${dir}"\n`);

    const found = await locateProject("quoted", [], env());

    expect(found.map(f => [f.source, f.directory])).toEqual([["phren", realpathSync.native(dir)]]);
  });

  it("ignores a registration whose folder is not on this computer", async () => {
    mkdirSync(path.join(root, "store/elsewhere"), { recursive: true });
    writeFileSync(path.join(root, "store/elsewhere/phren.project.yaml"), `sourcePath: ${path.join(root, "gone/elsewhere")}\n`);

    expect(await locateProject("elsewhere", [], env())).toEqual([]);
  });
});
