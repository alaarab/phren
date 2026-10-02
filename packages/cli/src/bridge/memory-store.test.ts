import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { blobSha, deleteStoreFile, githubStoreRepository, putStoreFile, storeBlob, storeHead, storeTree } from "./memory-store.js";

let root: string, store: string, index: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-store-routes-"));
  store = path.join(root, "store"); index = path.join(root, "snapshot.index");
  await mkdir(path.join(store, "demo"), { recursive: true });
  execFileSync("git", ["init", "-q", store]);
  await writeFile(path.join(store, ".gitignore"), ".runtime/\n");
  await writeFile(path.join(store, "demo", "FINDINGS.md"), "# demo\n- one\n");
  execFileSync("git", ["-C", store, "add", "-A"]);
  execFileSync("git", ["-C", store, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const paths = async (sha: string) => ((await storeTree(store, sha)).tree as { path: string }[]).map(entry => entry.path).sort();

it("reports a store's GitHub repository and branch without exposing its remote credentials", async () => {
  execFileSync("git", ["-C", store, "remote", "add", "origin", "https://user:private-password@github.com/Owner/Memory.git"]);
  const branch = execFileSync("git", ["-C", store, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const head = await storeHead(store, index);
  expect(head.repositoryIdentity).toEqual({ repository: "owner/memory", branch });
  expect(JSON.stringify(head)).not.toContain("private-password");
  execFileSync("git", ["-C", store, "remote", "remove", "origin"]);
  expect(await storeHead(store, index)).not.toHaveProperty("repositoryIdentity");
});

it("only identifies GitHub remotes, preserving distinct hosts and local stores", () => {
  for (const remote of ["git@github.com:Owner/Memory.git", "ssh://git@github.com/Owner/Memory.git", "https://github.com/Owner/Memory.git/"]) {
    expect(githubStoreRepository(remote)).toBe("owner/memory");
  }
  for (const remote of ["/some/local/repo", "https://github.com.evil.test/owner/memory", "https://gitlab.com/owner/memory", "https://github.com/owner/memory?token=secret", "https://github.com/owner/memory/extra"]) {
    expect(githubStoreRepository(remote)).toBeUndefined();
  }
});

it("serves the working tree, uncommitted edits included, without ignored files", async () => {
  await writeFile(path.join(store, "demo", "tasks.md"), "# tasks\n");
  await mkdir(path.join(store, ".runtime")); await writeFile(path.join(store, ".runtime", "secret.json"), "{}");
  const { sha } = await storeHead(store, index);
  expect(await paths(sha)).toEqual([".gitignore", "demo/FINDINGS.md", "demo/tasks.md"]);
  const entry = ((await storeTree(store, sha)).tree as { path: string; sha: string }[]).find(item => item.path === "demo/tasks.md")!;
  expect(entry.sha).toBe(blobSha(Buffer.from("# tasks\n")));
  expect(Buffer.from((await storeBlob(store, entry.sha)).content as string, "base64").toString()).toBe("# tasks\n");
  await rm(path.join(store, "demo", "tasks.md"));
  expect(await paths((await storeHead(store, index)).sha)).not.toContain("demo/tasks.md");
});

it("writes only over the sha the phone last saw", async () => {
  const file = path.join(store, "demo", "FINDINGS.md");
  const before = blobSha(await readFile(file));
  const next = Buffer.from("# demo\n- one\n- two\n");
  const put = await putStoreFile(store, { path: "demo/FINDINGS.md", content: next.toString("base64"), sha: before });
  expect(put).toMatchObject({ content: { sha: blobSha(next), path: "demo/FINDINGS.md" } });
  expect(await readFile(file, "utf8")).toContain("- two");
  await expect(putStoreFile(store, { path: "demo/FINDINGS.md", content: "", sha: before })).rejects.toMatchObject({ status: 409 });
  await expect(putStoreFile(store, { path: "demo/new.md", content: "eA==", sha: before })).rejects.toMatchObject({ status: 409 });
  await putStoreFile(store, { path: "demo/notes/new.md", content: "eA==", sha: null });
  expect(await readFile(path.join(store, "demo", "notes", "new.md"), "utf8")).toBe("x");
  await expect(deleteStoreFile(store, { path: "demo/notes/new.md", sha: before })).rejects.toMatchObject({ status: 409 });
  await deleteStoreFile(store, { path: "demo/notes/new.md", sha: blobSha(Buffer.from("x")) });
});

it("rejects oversized blobs with an actionable size error before reading their contents", async () => {
  const content = Buffer.alloc(4 * 1024 * 1024 + 1, 120);
  await writeFile(path.join(store, "demo", "tasks.md"), content);
  await storeHead(store, index);
  await expect(storeBlob(store, blobSha(content))).rejects.toMatchObject({
    status: 413, details: { code: "store-file-too-large", size: content.length, limit: 4 * 1024 * 1024 },
  });
  // A large task history cannot stop independent small files being read.
  const small = await readFile(path.join(store, "demo", "FINDINGS.md"));
  expect((await storeBlob(store, blobSha(small))).content).toBe(small.toString("base64"));
});

it("refuses paths outside the store, into .git, or through symlinks", async () => {
  await symlink(root, path.join(store, "escape"));
  for (const bad of ["../x.md", "/etc/passwd", ".git/config", "demo/../../x", "escape/x.md", "demo//x.md", "./demo/x.md"]) {
    await expect(putStoreFile(store, { path: bad, content: "", sha: null })).rejects.toMatchObject({ status: 400 });
  }
  await expect(storeBlob(store, "not-a-sha")).rejects.toMatchObject({ status: 400 });
  await expect(storeTree(store, "0".repeat(40))).rejects.toMatchObject({ status: 404 });
});
