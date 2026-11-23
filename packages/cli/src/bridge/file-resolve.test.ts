import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_FILE_RANGE } from "./file-range.js";
import { resolveFilePath } from "./file-resolve.js";
import { readHomeMedia } from "./home-media.js";

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
afterEach(async () => { vi.unstubAllEnvs(); await rm(scratch, { recursive: true, force: true }); });

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
  // Another spelling of the metadata folder, present on this volume: refused, not resolved.
  await mkdir(path.join(cwd, ".GIT"), { recursive: true });
  await writeFile(path.join(cwd, ".GIT", "config"), "[remote]");
  await expect(resolveFilePath(root, cwd, ".GIT/config")).rejects.toMatchObject({ status: 400 });
  await expect(resolveFilePath(root, scratch, "Main.swift")).rejects.toMatchObject({ status: 403 });
  await expect(resolveFilePath(root, cwd, "missing.ts")).rejects.toMatchObject({ status: 404 });
  await expect(resolveFilePath(root, cwd, "apps")).rejects.toMatchObject({ status: 400 });
});

it("opens media anywhere under home, outside the repository or with none, read-only and in ranges", async () => {
  const home = path.join(scratch, "home"), videos = path.join(home, "videos", "out");
  vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
  await mkdir(videos, { recursive: true }); await mkdir(path.join(home, ".config"));
  await writeFile(path.join(videos, "promo.mp4"), "0123456789");
  await writeFile(path.join(home, "notes.txt"), "private");
  await writeFile(path.join(home, ".config", "clip.mp4"), "hidden");
  await writeFile(path.join(scratch, "outside.mp4"), "outside");
  await symlink(path.join(videos, "promo.mp4"), path.join(home, "linked.mp4"));
  await symlink(path.join(home, "videos"), path.join(home, "shows"), "dir");
  const promo = { path: "~/videos/out/promo.mp4", size: 10, contentType: "video/mp4" };

  // Outside the pane's repository, by absolute path; and with no repository, also relative to the pane's folder.
  expect(await resolveFilePath(root, cwd, path.join(videos, "promo.mp4"))).toMatchObject(promo);
  expect(await resolveFilePath(undefined, home, path.join(videos, "promo.mp4"))).toMatchObject(promo);
  expect(await resolveFilePath(undefined, home, "videos/out/promo.mp4")).toMatchObject(promo);
  expect(await resolveFilePath(undefined, path.join(home, "videos"), "out/promo.mp4")).toMatchObject(promo);
  const { version } = await resolveFilePath(undefined, home, "videos/out/promo.mp4");
  expect(await readHomeMedia(promo.path, 4, 3, version)).toMatchObject({ path: promo.path, length: 3, total: 10, data: Buffer.from("456").toString("base64") });
  await expect(readHomeMedia(promo.path, 0, MAX_FILE_RANGE + 1)).rejects.toMatchObject({ status: 400 });

  // Not media, a hidden folder, a symlinked file or folder, a climb out, outside home: refused with the old errors.
  for (const requested of [path.join(home, "notes.txt"), path.join(home, ".config", "clip.mp4"), path.join(scratch, "outside.mp4")]) {
    await expect(resolveFilePath(root, cwd, requested)).rejects.toMatchObject({ status: 403 });
    await expect(resolveFilePath(undefined, home, requested)).rejects.toMatchObject({ status: 409 });
  }
  for (const requested of ["linked.mp4", "shows/out/promo.mp4"]) {
    await expect(resolveFilePath(undefined, home, requested)).rejects.toMatchObject({ status: 403 });
    await expect(readHomeMedia("~/" + requested, 0, 10)).rejects.toMatchObject({ status: 403 });
  }
  await expect(resolveFilePath(undefined, path.join(home, "videos"), "../notes.txt")).rejects.toMatchObject({ status: 409 });
  await expect(resolveFilePath(undefined, scratch, "home/videos/out/promo.mp4")).rejects.toMatchObject({ status: 409 });
  for (const requested of ["~/notes.txt", "~/.config/clip.mp4", "~/videos/../.config/clip.mp4", "~/\u200c.config/clip.mp4", "~/CONFIG~1/clip.mp4"]) {
    await expect(readHomeMedia(requested, 0, 10)).rejects.toMatchObject({ status: 403 });
  }
  await expect(resolveFilePath(undefined, home, "videos/missing.mp4")).rejects.toMatchObject({ status: 404 });
});
