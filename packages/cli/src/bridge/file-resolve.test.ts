import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolveFilePath } from "./file-resolve.js";

let scratch: string, root: string, cwd: string;
beforeEach(async () => {
  await mkdir(path.resolve(".scratch"), { recursive: true });
  scratch = await mkdtemp(path.resolve(".scratch/file-resolve-"));
  root = path.join(scratch, "repo"); cwd = path.join(root, "apps", "ios");
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/main.ts"), "export const rootFile = 1;\n");
  await writeFile(path.join(cwd, "Main.swift"), "struct Screen {}\n");
  await writeFile(path.join(root, "Main.swift"), "struct OtherScreen {}\n");
});
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

it("prefers the live pane's cwd, then falls back to the repository root", async () => {
  expect(await resolveFilePath(root, cwd, "Main.swift")).toMatchObject({ path: "apps/ios/Main.swift", size: 17, contentType: "text/plain" });
  expect(await resolveFilePath(root, cwd, "./Main.swift")).toHaveProperty("path", "apps/ios/Main.swift");
  expect(await resolveFilePath(root, cwd, "src/main.ts")).toHaveProperty("path", "src/main.ts");
  expect(await resolveFilePath(root, cwd, "../../src/main.ts")).toHaveProperty("path", "src/main.ts");
});

it("returns the same relative path and version for an in-repo absolute name and a trusted root alias", async () => {
  const expected = await resolveFilePath(root, cwd, "Main.swift");
  expect(await resolveFilePath(root, cwd, path.join(cwd, "Main.swift"))).toEqual(expected);
  const alias = path.join(scratch, "repo-alias");
  await symlink(root, alias, "dir");
  expect(await resolveFilePath(await realpath(root), path.join(alias, "apps/ios"), path.join(alias, "src/main.ts")))
    .toHaveProperty("path", "src/main.ts");
  expect(expected).not.toHaveProperty("data");
  expect(expected.version).toEqual(expect.any(String));
});

it("refuses outside paths, control characters, metadata and symlinks before falling back", async () => {
  await writeFile(path.join(scratch, "Main.swift"), "private");
  await symlink(path.join(scratch, "Main.swift"), path.join(cwd, "outside"));
  await symlink(path.join(root, "src"), path.join(cwd, "linked"), "dir");
  // Even a valid root fallback cannot disguise an unsafe cwd candidate.
  await symlink(path.join(scratch, "Main.swift"), path.join(cwd, "src"), "file");
  for (const requested of [path.join(scratch, "Main.swift"), "../../../Main.swift", "outside", "linked/main.ts", "linked/../Main.swift", "src/main.ts",
    ".git/config", "../.git/../Main.swift", "bad\u0000name", "bad\nname", "C:\\repo\\Main.swift"]) {
    await expect(resolveFilePath(root, cwd, requested)).rejects.toThrow();
  }
  await expect(resolveFilePath(root, scratch, "Main.swift")).rejects.toMatchObject({ status: 403 });
  await expect(resolveFilePath(root, cwd, "missing.ts")).rejects.toMatchObject({ status: 404 });
  await expect(resolveFilePath(root, cwd, "apps")).rejects.toMatchObject({ status: 400 });
});
