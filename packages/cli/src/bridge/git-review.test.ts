import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { gitApply, gitFile, patchFiles, sessionChanges } from "./git-review.js";
import { BridgeError } from "./protocol.js";

const execFileAsync = promisify(execFile);

describe("git review routes", () => {
  let created: string | undefined;
  afterEach(async () => { if (created) await rm(created, { recursive: true, force: true }); created = undefined; });

  async function repository() {
    const root = created = await realpath(await mkdtemp(path.join(tmpdir(), "phren-review-")));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: root,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
    const git = async (...args: string[]) => (await execFileAsync("git", ["-C", root, ...args], { env })).stdout;
    await git("init", "-q", "-b", "main");
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    await writeFile(path.join(root, "a.txt"), lines.join("\n") + "\n");
    await git("add", "."); await git("commit", "-qm", "start");
    return { root, git, lines };
  }

  async function rejects(promise: Promise<unknown>, status: number, text: RegExp) {
    const error = await promise.then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).status).toBe(status);
    expect((error as BridgeError).message).toMatch(text);
  }

  it("reads a file at HEAD, in the index and at a commit, and says when it is missing, binary or invalid", async () => {
    const { root, git } = await repository();
    const first = (await git("rev-parse", "HEAD")).trim();
    await writeFile(path.join(root, "a.txt"), "staged\n"); await git("add", "a.txt");
    await writeFile(path.join(root, "a.txt"), "working\n");
    expect(await gitFile(root, "HEAD", "a.txt")).toMatchObject({ path: "a.txt", ref: "HEAD", text: expect.stringContaining("line 30\n") });
    expect(await gitFile(root, "INDEX", "a.txt")).toMatchObject({ text: "staged\n" });
    expect(await gitFile(root, first.slice(0, 8), "a.txt")).toMatchObject({ text: expect.stringContaining("line 1\n") });
    expect(await gitFile(root, "HEAD", "new.txt")).toMatchObject({ missing: true, text: "" });
    await writeFile(path.join(root, "b.bin"), Buffer.from([1, 0, 2])); await git("add", "b.bin");
    expect(await gitFile(root, "INDEX", "b.bin")).toMatchObject({ binary: true, text: "" });
    await rejects(gitFile(root, "--all", "a.txt"), 400, /HEAD, INDEX or a commit/);
    await rejects(gitFile(root, "HEAD", "../etc/passwd"), 400, /Invalid path/);
    await rejects(gitFile(root, "deadbeef", "a.txt"), 404, /no such commit/);
  });

  it("stages and unstages one hunk without touching the working tree or the other hunk", async () => {
    const { root, git, lines } = await repository();
    const edited = [...lines]; edited[1] = "line 2 changed"; edited[27] = "line 28 changed";
    await writeFile(path.join(root, "a.txt"), edited.join("\n") + "\n");
    const full = await git("diff", "-U3", "a.txt");
    const [header, ...hunks] = full.split(/^(?=@@ )/m);
    expect(hunks).toHaveLength(2);
    expect(await gitApply(root, header + hunks[0], false)).toEqual({ ok: true, path: "a.txt", staged: true });
    expect(await git("diff", "--cached", "a.txt")).toContain("+line 2 changed");
    expect(await git("diff", "--cached", "a.txt")).not.toContain("line 28 changed");
    expect(await git("diff", "a.txt")).toContain("+line 28 changed");
    // Unstaging the same hunk puts the index back; the working file keeps both edits.
    const staged = await git("diff", "--cached", "-U3", "a.txt");
    expect(await gitApply(root, staged, true)).toMatchObject({ ok: true, staged: false });
    expect(await git("diff", "--cached")).toBe("");
    expect(await git("diff", "a.txt")).toContain("+line 2 changed");
    // A hunk that no longer applies is Git's refusal, not an error.
    const refused = await gitApply(root, header + hunks[0].replace("-line 2\n", "-line two\n"), false);
    expect(refused.ok).toBe(false);
    expect(String(refused.output)).toMatch(/patch/i);
  });

  it("refuses patches that are not one file's text hunks", () => {
    const hunk = "@@ -1 +1 @@\n-a\n+b\n";
    expect(patchFiles(`diff --git a/x b/x\n--- a/x\n+++ b/x\n${hunk}`)).toEqual(["x"]);
    expect(patchFiles(`diff --git a/n b/n\nnew file mode 100644\n`.replace("new file mode 100644\n", "") + `--- /dev/null\n+++ b/n\n${hunk}`)).toEqual(["n"]);
    expect(patchFiles(`--- "a/sp ace\\tx"\n+++ "b/sp ace\\tx"\n${hunk}`)).toEqual(["sp ace\tx"]);
    expect(() => patchFiles(`--- a/x\n+++ b/x\n`)).toThrow(/no hunks/);
    expect(() => patchFiles(`--- a/x\n+++ b/x\n${hunk}--- a/y\n+++ b/y\n${hunk}`)).toThrow(/one file/);
    expect(() => patchFiles(`diff --git a/x b/y\nrename from x\nrename to y\n`)).toThrow(/whole file/);
    expect(() => patchFiles(`--- a/x\n+++ b/x\nGIT binary patch\n`)).toThrow(/whole file/);
    expect(() => patchFiles(`--- x\n+++ x\n${hunk}`)).toThrow(/not a Git patch/);
  });

  it("folds a session's recorded edits by file, newest first, within its repository", () => {
    const edit = (root: string, file: string, status: string, added: number, removed: number) =>
      ({ root, path: file, status, patch: `@@ -1 +1 @@\n-${file}\n+${file}!\n`, added, removed });
    const result = sessionChanges("/r", [
      { toolUseId: "t1", files: [edit("/r", "a.ts", "A", 10, 0), edit("/elsewhere", "x", "M", 1, 1)] },
      { toolUseId: "t2", files: [edit("/r", "b.ts", "M", 2, 1)] },
      { toolUseId: "t3", files: [edit("/r", "a.ts", "M", 3, 2)] },
    ]);
    expect(result).toMatchObject({ root: "/r", calls: 3, totalFiles: 2, others: 1, additions: 15, deletions: 3 });
    const files = result.files as { path: string; status: string; added: number; removed: number; edits: { toolUseId: string }[] }[];
    expect(files.map(f => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(files[0]).toMatchObject({ status: "A", added: 13, removed: 2 });
    expect(files[0].edits.map(e => e.toolUseId)).toEqual(["t1", "t3"]);
  });
});
