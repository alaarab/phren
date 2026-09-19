import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { browseFiles } from "./files.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-browse-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("lists folders before files, hides git metadata, and reads exact bytes", async () => {
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "a.md"), "hello 世界");
  const listing = await browseFiles(root, "");
  expect(listing.entries?.map(entry => entry.name)).toEqual(["src", "a.md"]);
  const file = await browseFiles(root, "a.md");
  expect(Buffer.from(file.data!, "base64").toString()).toBe("hello 世界");
});
it("rejects traversal, absolute paths, symlink files and symlink directories", async () => {
  await symlink(tmpdir(), path.join(root, "outside"));
  await writeFile(path.join(root, "original"), "text");
  await symlink(path.join(root, "original"), path.join(root, "link"));
  for (const relative of ["../private", "/etc/passwd", "a/../../private", ".git/config", "outside", "link"]) {
    await expect(browseFiles(root, relative)).rejects.toThrow();
  }
});
it("bounds file bytes and directory entries", async () => {
  await writeFile(path.join(root, "large"), Buffer.alloc(2_097_153));
  await expect(browseFiles(root, "large")).rejects.toThrow("2 MB");
  await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(path.join(root, `${index}`), "")));
  const listing = await browseFiles(root, "");
  expect(listing.entries).toHaveLength(500);
  expect(listing.truncated).toBe(true);
});
