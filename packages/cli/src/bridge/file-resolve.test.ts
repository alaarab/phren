import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_FILE_RANGE } from "./file-range.js";
import { resolveFilePath } from "./file-resolve.js";
import { readMedia } from "./home-media.js";

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
  expect(await readMedia(promo.path, 4, 3, version)).toMatchObject({ path: promo.path, length: 3, total: 10, data: Buffer.from("456").toString("base64") });
  await expect(readMedia(promo.path, 0, MAX_FILE_RANGE + 1)).rejects.toMatchObject({ status: 400 });

  // Not media, a hidden folder, a symlinked file or folder, a climb out, outside home: refused with the old errors.
  for (const requested of [path.join(home, "notes.txt"), path.join(home, ".config", "clip.mp4"), path.join(scratch, "outside.mp4")]) {
    await expect(resolveFilePath(root, cwd, requested)).rejects.toMatchObject({ status: 403 });
    await expect(resolveFilePath(undefined, home, requested)).rejects.toMatchObject({ status: 409 });
  }
  for (const requested of ["linked.mp4", "shows/out/promo.mp4"]) {
    await expect(resolveFilePath(undefined, home, requested)).rejects.toMatchObject({ status: 403 });
    await expect(readMedia("~/" + requested, 0, 10)).rejects.toMatchObject({ status: 403 });
  }
  await expect(resolveFilePath(undefined, path.join(home, "videos"), "../notes.txt")).rejects.toMatchObject({ status: 409 });
  await expect(resolveFilePath(undefined, scratch, "home/videos/out/promo.mp4")).rejects.toMatchObject({ status: 409 });
  for (const requested of ["~/notes.txt", "~/.config/clip.mp4", "~/videos/../.config/clip.mp4", "~/\u200c.config/clip.mp4", "~/CONFIG~1/clip.mp4"]) {
    await expect(readMedia(requested, 0, 10)).rejects.toMatchObject({ status: 403 });
  }
  await expect(resolveFilePath(undefined, home, "videos/missing.mp4")).rejects.toMatchObject({ status: 404 });

  // A literal `~/` names home, wherever the pane is.
  expect(await resolveFilePath(root, cwd, "~/videos/out/promo.mp4")).toMatchObject(promo);
  expect(await resolveFilePath(undefined, scratch, "~/videos/out/promo.mp4")).toMatchObject(promo);
  await expect(resolveFilePath(root, cwd, "~/notes.txt")).rejects.toMatchObject({ status: 403 });
  await expect(resolveFilePath(root, cwd, "~/.config/clip.mp4")).rejects.toMatchObject({ status: 403 });

  // A bare name from a pane in home: the newest file of that name beneath the
  // pane's folder, never inside a hidden or symlinked folder; media only.
  await mkdir(path.join(home, "old"));
  await writeFile(path.join(home, "old", "promo.mp4"), "older");
  await utimes(path.join(home, "old", "promo.mp4"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  expect(await resolveFilePath(undefined, home, "promo.mp4")).toMatchObject(promo);
  expect(await resolveFilePath(undefined, path.join(home, "old"), "promo.mp4")).toMatchObject({ path: "~/old/promo.mp4", size: 5 });
  await expect(resolveFilePath(undefined, home, "clip.mp4")).rejects.toMatchObject({ status: 404 });
  await mkdir(path.join(scratch, "far")); await writeFile(path.join(scratch, "far", "far.mp4"), "far");
  await symlink(path.join(scratch, "far"), path.join(home, "far"), "dir");
  await expect(resolveFilePath(undefined, home, "far.mp4")).rejects.toMatchObject({ status: 404 });
  await expect(resolveFilePath(undefined, home, "notes.md")).rejects.toMatchObject({ status: 409 });
});

it("opens media in a configured media folder such as a WSL drive, by the same rules", async () => {
  const home = path.join(scratch, "home"), bridge = path.join(scratch, "bridge"), drive = path.join(scratch, "mnt", "d");
  vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home); vi.stubEnv("PHREN_BRIDGE_HOME", bridge);
  const project = path.join(drive, "Projects", "andz"), showcase = path.join(project, "builds", "ad", "showcase");
  await mkdir(showcase, { recursive: true }); await mkdir(home); await mkdir(bridge);
  await mkdir(path.join(drive, ".trash")); await mkdir(path.join(scratch, "mnt", "e"));
  const file = path.join(showcase, "andz-combos-r1.mp4");
  await writeFile(file, "0123456789");
  await writeFile(path.join(project, "notes.txt"), "private");
  await writeFile(path.join(drive, ".trash", "old.mp4"), "hidden");
  await writeFile(path.join(scratch, "mnt", "e", "other.mp4"), "unlisted");
  await symlink(file, path.join(project, "linked.mp4"));
  await writeFile(path.join(bridge, "media-roots"), `# Render drives\n${drive}\n\nrelative/ignored\n`);
  // The root's own absolute path without its leading `/` (a Windows drive as `D/`).
  const named = (folder: string) => "~root/" + folder.split(path.sep).join("/").replace(/^([A-Za-z]):/, "$1").replace(/^\//, "");
  const clip = { path: `${named(await realpath(drive))}/Projects/andz/builds/ad/showcase/andz-combos-r1.mp4`, size: 10, contentType: "video/mp4" };

  // From a pane in home with no repository (the WSL case), from another repository, relative and by bare name.
  expect(await resolveFilePath(undefined, home, file)).toMatchObject(clip);
  expect(await resolveFilePath(root, cwd, file)).toMatchObject(clip);
  expect(await resolveFilePath(undefined, project, "builds/ad/showcase/andz-combos-r1.mp4")).toMatchObject(clip);
  expect(await resolveFilePath(undefined, path.join(drive, "Projects"), "andz-combos-r1.mp4")).toMatchObject(clip);
  const { version } = await resolveFilePath(undefined, home, file);
  expect(await readMedia(clip.path, 2, 3, version)).toMatchObject({ path: clip.path, length: 3, total: 10, data: Buffer.from("234").toString("base64") });

  // Not media, hidden, a symlink, a folder that is not listed, a climb out.
  for (const requested of [path.join(project, "notes.txt"), path.join(drive, ".trash", "old.mp4"), path.join(scratch, "mnt", "e", "other.mp4")]) {
    await expect(resolveFilePath(undefined, home, requested)).rejects.toMatchObject({ status: 409 });
  }
  await expect(resolveFilePath(undefined, home, path.join(project, "linked.mp4"))).rejects.toMatchObject({ status: 403 });
  await expect(resolveFilePath(undefined, project, "../andz/notes.txt")).rejects.toMatchObject({ status: 409 });
  for (const requested of [clip.path.replace("andz-combos-r1.mp4", "notes.txt"), `${named(await realpath(drive))}/.trash/old.mp4`,
    `${named(await realpath(drive))}/Projects/andz/linked.mp4`, clip.path.replace("builds/ad", "builds/../../andz/builds/ad"),
    `${named(await realpath(path.join(scratch, "mnt", "e")))}/other.mp4`]) {
    await expect(readMedia(requested, 0, 10)).rejects.toMatchObject({ status: 403 });
  }
  // A folder taken off the list is closed again.
  await writeFile(path.join(bridge, "media-roots"), "");
  await expect(readMedia(clip.path, 0, 10)).rejects.toMatchObject({ status: 403 });
});

it.runIf(process.platform === "win32")("matches a lower-case Windows drive letter against the repository and home", async () => {
  const home = path.join(scratch, "home");
  vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
  await mkdir(home); await writeFile(path.join(home, "clip.mp4"), "0123");
  const lower = (file: string) => file.replace(/^[A-Z]:/, drive => drive.toLowerCase());
  expect(await resolveFilePath(root, cwd, lower(path.join(cwd, "Main.swift")))).toHaveProperty("path", "apps/ios/Main.swift");
  expect(await resolveFilePath(root, cwd, lower(path.join(home, "clip.mp4")))).toHaveProperty("path", "~/clip.mp4");
});
