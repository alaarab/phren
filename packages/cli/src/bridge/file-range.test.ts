import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fileContentType, MAX_FILE_RANGE, rangeInteger, readFileRange } from "./file-range.js";

let scratch: string, root: string;
beforeEach(async () => {
  await mkdir(path.resolve(".scratch"), { recursive: true });
  scratch = await mkdtemp(path.resolve(".scratch/file-range-"));
  root = path.join(scratch, "project");
  await mkdir(path.join(root, "video"), { recursive: true });
});
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

it("assembles a git-ignored 12 MiB video in bounded ranges and checks metadata without bytes", async () => {
  await writeFile(path.join(root, ".gitignore"), "video/\n");
  const bytes = Buffer.alloc(12 * 1024 * 1024 + 37);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await writeFile(path.join(root, "video/render.mp4"), bytes);
  const meta = await readFileRange(root, "video/render.mp4", 0, 0);
  expect(meta).toMatchObject({ total: bytes.length, length: 0, data: "", contentType: "video/mp4", eof: false });
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += MAX_FILE_RANGE) {
    const result = await readFileRange(root, "video/render.mp4", offset, MAX_FILE_RANGE, meta.version);
    expect(result.length).toBeLessThanOrEqual(MAX_FILE_RANGE);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(6_000_000);
    chunks.push(Buffer.from(result.data, "base64"));
  }
  expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  // Requested paths use the phone's forward slashes, never Windows backslashes.
  const absolute = path.join(root, "video/render.mp4").replaceAll("\\", "/");
  expect(await readFileRange(root, absolute, bytes.length, 100)).toMatchObject({ length: 0, eof: true });
  await expect(readFileRange(root, "video/render.mp4", bytes.length + 1, 100)).rejects.toMatchObject({ status: 416 });
});

it("reads beyond 2 GiB without loading the file, and handles an empty file", async () => {
  const file = await open(path.join(root, "large.bin"), "w");
  try { await file.write(Buffer.from("tail"), 0, 4, 3 * 1024 ** 3); } finally { await file.close(); }
  const result = await readFileRange(root, "large.bin", 3 * 1024 ** 3, MAX_FILE_RANGE);
  expect(result.total).toBe(3 * 1024 ** 3 + 4);
  expect(Buffer.from(result.data, "base64").toString()).toBe("tail");
  await writeFile(path.join(root, "empty.txt"), "");
  expect(await readFileRange(root, "empty.txt", 0, MAX_FILE_RANGE)).toMatchObject({ total: 0, eof: true, data: "" });
});

it("refuses traversal, outside absolute paths, .git, directories and symlink escapes", async () => {
  await writeFile(path.join(scratch, "secret"), "private");
  await symlink(path.join(scratch, "secret"), path.join(root, "link"));
  await symlink(scratch, path.join(root, "outside"));
  for (const file of ["../secret", "video/../../secret", path.join(scratch, "secret"), "link", "outside/secret", ".git/config", "video", "bad\0path", "video\\secret"]) {
    await expect(readFileRange(root, file, 0, 1)).rejects.toThrow();
  }
  await expect(readFileRange(root, "missing", 0, 0)).rejects.toMatchObject({ status: 404 });
});

it("rejects invalid ranges and a changed file on resume", async () => {
  await writeFile(path.join(root, "data.json"), "{}");
  const meta = await readFileRange(root, "data.json", 0, 0);
  await writeFile(path.join(root, "data.json"), '{"changed":true}');
  await expect(readFileRange(root, "data.json", 0, 4, meta.version)).rejects.toMatchObject({ status: 409 });
  for (const [offset, length] of [[-1, 1], [0, MAX_FILE_RANGE + 1], [0.5, 1], [0, -1], [Number.MAX_SAFE_INTEGER + 1, 1]]) {
    await expect(readFileRange(root, "data.json", offset, length)).rejects.toThrow();
  }
  for (const value of ["", "-1", "1.5", "Infinity", "1e3", "9007199254740992"]) expect(() => rangeInteger(value, 0)).toThrow();
  expect(rangeInteger(null, 100)).toBe(100);
  expect(fileContentType("REPORT.PDF")).toBe("application/pdf");
  expect(fileContentType("clip.m4a")).toBe("audio/mp4");
  expect(fileContentType("unknown.bin")).toBe("application/octet-stream");
});
