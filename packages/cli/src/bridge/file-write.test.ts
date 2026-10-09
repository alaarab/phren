import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileVersion } from "./file-range.js";
import { writeRepoFile } from "./file-write.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "file-write-")); await mkdir(path.join(root, "src")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const versionOf = async (file: string) => fileVersion(await lstat(path.join(root, file)));
const code = (promise: Promise<unknown>) => promise.then(() => "ok", error => `${error.status}:${error.details?.code ?? ""}`);

describe("writeRepoFile", () => {
  it("saves over the version the editor read, keeps the mode, and returns the new version", async () => {
    await writeFile(path.join(root, "src/a.ts"), "old\n");
    await chmod(path.join(root, "src/a.ts"), 0o755);
    const saved = await writeRepoFile(root, "src/a.ts", "new\n", await versionOf("src/a.ts"));
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toBe("new\n");
    expect((await stat(path.join(root, "src/a.ts"))).mode & 0o777).toBe(0o755);
    expect(saved).toMatchObject({ path: "src/a.ts", size: 4, created: false, version: await versionOf("src/a.ts") });
  });

  it("refuses a stale version and leaves the file alone", async () => {
    await writeFile(path.join(root, "src/a.ts"), "old\n");
    const read = await versionOf("src/a.ts");
    await new Promise(resolve => setTimeout(resolve, 10));
    await writeFile(path.join(root, "src/a.ts"), "agent edit\n");
    expect(await code(writeRepoFile(root, "src/a.ts", "mine\n", read))).toBe("409:file-changed");
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toBe("agent edit\n");
  });

  it("creates a new file only when none exists", async () => {
    expect(await writeRepoFile(root, "src/new.ts", "x")).toMatchObject({ created: true, size: 1 });
    expect(await code(writeRepoFile(root, "src/new.ts", "y"))).toBe("409:file-exists");
    expect(await readFile(path.join(root, "src/new.ts"), "utf8")).toBe("x");
  });

  it("refuses paths that leave the repository, touch .git, or go through a link", async () => {
    await mkdir(path.join(root, ".git"));
    await symlink(tmpdir(), path.join(root, "link"));
    await writeFile(path.join(tmpdir(), `outside-${process.pid}.txt`), "keep");
    await symlink(path.join(tmpdir(), `outside-${process.pid}.txt`), path.join(root, "src/file-link"));
    for (const bad of ["../x", "/etc/passwd", ".git/config", "src/../../x", "link/x", "src//a", "a\\b", "a\nb"]) {
      expect(await code(writeRepoFile(root, bad, "x")), bad).toMatch(/^40[03]:/);
    }
    expect(await code(writeRepoFile(root, "src/file-link", "x", "v"))).toBe("403:");
    expect(await readFile(path.join(tmpdir(), `outside-${process.pid}.txt`), "utf8")).toBe("keep");
    await rm(path.join(tmpdir(), `outside-${process.pid}.txt`));
  });

  it("refuses a missing folder and oversized text", async () => {
    expect(await code(writeRepoFile(root, "nope/a.ts", "x"))).toBe("404:");
    expect(await code(writeRepoFile(root, "src/big.txt", "x".repeat(4 * 1024 * 1024 + 1)))).toBe("413:");
  });
});
