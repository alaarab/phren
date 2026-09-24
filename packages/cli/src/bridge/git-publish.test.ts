import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkRollup, gitPulls, gitStatus } from "./git.js";
import { gitCommit, gitPullRequest, gitPush } from "./git-publish.js";
import { BridgeError } from "./protocol.js";

const execFileAsync = promisify(execFile);

/** A stub `gh` whose answers come from files next to it, so a test can say
 * signed in or not, and what `pr create` and `pr view` print. Every call is
 * appended to `calls.log`. */
const GH_STUB = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/calls.log"
case "$1" in
  --version) echo "gh version 2.0.0"; exit 0 ;;
  auth) if [ -f "$dir/signed-in" ]; then echo "Logged in to github.com account sam"; exit 0; fi
        echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1 ;;
  pr)
    case "$2" in
      create) cat "$dir/create.out"; exit $(cat "$dir/create.code") ;;
      list) echo '[]'; exit 0 ;;
      view) if [ -f "$dir/view.json" ]; then cat "$dir/view.json"; exit 0; fi
            echo "no pull requests found for branch" >&2; exit 1 ;;
    esac ;;
esac
exit 2
`;

describe("git publish routes", () => {
  const saved = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  let scratch: string;
  let stub: string;
  let bareBin: string;

  beforeAll(async () => {
    scratch = await realpath(await mkdtemp(path.join(tmpdir(), "phren-publish-")));
    stub = path.join(scratch, "gh-stub");
    await mkdir(stub);
    await writeFile(path.join(stub, "gh"), GH_STUB);
    await chmod(path.join(stub, "gh"), 0o755);
    // A PATH with Git and nothing else, for "gh is not installed".
    bareBin = path.join(scratch, "bare-bin");
    await mkdir(bareBin);
    const gitBinary = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
    await symlink(gitBinary, path.join(bareBin, "git"));
    // The machine's own global config (hooksPath, signing) must not leak in.
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.PATH = `${stub}${path.delimiter}${saved.PATH}`;
  });
  afterAll(async () => {
    process.env.PATH = saved.PATH;
    if (saved.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.GIT_CONFIG_GLOBAL;
    await rm(scratch, { recursive: true, force: true });
  });

  let created: string[] = [];
  afterEach(async () => {
    process.env.PATH = `${stub}${path.delimiter}${saved.PATH}`;
    for (const file of ["signed-in", "create.out", "create.code", "view.json", "calls.log"]) await rm(path.join(stub, file), { force: true });
    for (const dir of created) await rm(dir, { recursive: true, force: true });
    created = [];
  });

  /** A clone of a bare remote whose `main` has one commit, with origin/HEAD recorded. */
  async function clone() {
    const base = await mkdtemp(path.join(scratch, "repo-"));
    created.push(base);
    const remote = path.join(base, "remote.git"), root = path.join(base, "work");
    const run = async (cwd: string, ...args: string[]) => (await execFileAsync("git", ["-C", cwd, ...args])).stdout;
    await execFileAsync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    await execFileAsync("git", ["init", "-q", "-b", "main", root]);
    await run(root, "config", "user.name", "sam");
    await run(root, "config", "user.email", "sam@example.com");
    await writeFile(path.join(root, "README.md"), "one\n");
    await run(root, "add", ".");
    await run(root, "commit", "-qm", "start");
    await run(root, "remote", "add", "origin", remote);
    await run(root, "push", "-q", "-u", "origin", "main");
    await run(root, "remote", "set-head", "origin", "main");
    const git = (...args: string[]) => run(root, ...args);
    const remoteGit = (...args: string[]) => run(remote, ...args);
    return { root, remote, git, remoteGit };
  }

  async function rejects(promise: Promise<unknown>, status: number, text: RegExp) {
    const error = await promise.then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).status).toBe(status);
    expect((error as BridgeError).message).toMatch(text);
  }

  it("commits only what is staged and needs a message and a staged change", async () => {
    const { root, git } = await clone();
    await rejects(gitCommit(root, "Nothing yet"), 409, /Nothing is staged/);
    await writeFile(path.join(root, "README.md"), "one\ntwo\n");
    await writeFile(path.join(root, "staged.txt"), "staged\n");
    await git("add", "staged.txt");
    await rejects(gitCommit(root, "   "), 400, /commit message/);
    await rejects(gitCommit(root, 42), 400, /commit message/);
    const result = await gitCommit(root, "Add the staged file\n\nWith a body.");
    expect(result).toMatchObject({ ok: true, subject: "Add the staged file", branch: "main" });
    expect(String(result.sha)).toMatch(/^[0-9a-f]{40}$/);
    expect(await git("show", "--name-only", "--format=%B", "HEAD")).toContain("With a body.");
    expect((await git("show", "--name-only", "--format=", "HEAD")).trim()).toBe("staged.txt");
    // The unstaged edit stays in the working tree, uncommitted.
    expect((await gitStatus(root)).files).toEqual([expect.objectContaining({ path: "README.md", staged: false })]);
  });

  it("runs the pre-commit hook and reports its refusal verbatim", async () => {
    const { root, git } = await clone();
    const hook = path.join(root, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\necho 'lint: 2 problems'\necho '  src/a.ts:1  missing semicolon' >&2\nexit 1\n");
    await chmod(hook, 0o755);
    await writeFile(path.join(root, "a.ts"), "x\n");
    await git("add", "a.ts");
    const refused = await gitCommit(root, "Should not land");
    expect(refused).toEqual({ ok: false, output: "lint: 2 problems\n  src/a.ts:1  missing semicolon" });
    expect((await git("log", "--format=%s")).trim()).toBe("start");
    // Still staged, so the person can fix and try again.
    expect((await git("diff", "--cached", "--name-only")).trim()).toBe("a.ts");
    await writeFile(hook, "#!/bin/sh\nexit 0\n");
    expect(await gitCommit(root, "Lands")).toMatchObject({ ok: true, subject: "Lands" });
  });

  it("pushes a new branch to origin and sets its upstream, then pushes to that upstream", async () => {
    const { root, git, remoteGit } = await clone();
    await git("checkout", "-q", "-b", "feature/finish");
    await writeFile(path.join(root, "b.txt"), "b\n");
    await git("add", "b.txt");
    await gitCommit(root, "Feature work");
    const first = await gitPush(root, undefined);
    expect(first).toMatchObject({ ok: true, branch: "feature/finish", remote: "origin", upstream: "origin/feature/finish", setUpstream: true });
    expect((await git("rev-parse", "--abbrev-ref", "feature/finish@{upstream}")).trim()).toBe("origin/feature/finish");
    expect((await remoteGit("rev-parse", "feature/finish")).trim()).toBe((await git("rev-parse", "HEAD")).trim());
    expect((await gitStatus(root)).ahead).toBe(0);
    await writeFile(path.join(root, "b.txt"), "b\nc\n");
    await git("add", "b.txt");
    await gitCommit(root, "More work");
    expect(await gitPush(root, undefined)).toMatchObject({ ok: true, setUpstream: false, upstream: "origin/feature/finish" });
    expect((await remoteGit("rev-parse", "feature/finish")).trim()).toBe((await git("rev-parse", "HEAD")).trim());
  });

  it("refuses the default branch unless confirmed, and never forces a rejected push", async () => {
    const { root, git, remote } = await clone();
    expect((await gitStatus(root)).defaultBranch).toBe("main");
    await writeFile(path.join(root, "c.txt"), "c\n");
    await git("add", "c.txt");
    await gitCommit(root, "On main");
    await rejects(gitPush(root, undefined), 409, /main is the default branch/);
    await rejects(gitPush(root, "yes"), 409, /default branch/);
    expect(await gitPush(root, true)).toMatchObject({ ok: true, branch: "main", upstream: "origin/main" });

    // Someone else moves the remote; our diverged commit is rejected, not forced.
    const other = path.join(path.dirname(root), "other");
    await execFileAsync("git", ["clone", "-q", remote, other]);
    await writeFile(path.join(other, "d.txt"), "d\n");
    await execFileAsync("git", ["-C", other, "add", "d.txt"]);
    await execFileAsync("git", ["-C", other, "-c", "user.name=sam", "-c", "user.email=sam@example.com", "commit", "-qm", "theirs"]);
    await execFileAsync("git", ["-C", other, "push", "-q", "origin", "main"]);
    const theirs = (await execFileAsync("git", ["-C", other, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(root, "e.txt"), "e\n");
    await git("add", "e.txt");
    await gitCommit(root, "Ours");
    const rejected = await gitPush(root, true);
    expect(rejected.ok).toBe(false);
    expect(String(rejected.output)).toMatch(/rejected/);
    expect((await execFileAsync("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim()).toBe(theirs);
  });

  it("refuses a detached HEAD and a branch with no upstream and no origin", async () => {
    const { root, git } = await clone();
    await git("checkout", "-q", "--detach");
    await rejects(gitPush(root, true), 409, /detached/);
    await git("checkout", "-q", "-b", "topic");
    await git("remote", "remove", "origin");
    await rejects(gitPush(root, undefined), 409, /no origin remote/);
  });

  it("reports a missing or signed-out gh, and opens or finds the branch's pull request", async () => {
    const { root, git } = await clone();
    await git("checkout", "-q", "-b", "feature/pr");
    process.env.PATH = bareBin;
    expect(await gitPullRequest(root, false)).toMatchObject({ ok: false, reason: "missing" });
    process.env.PATH = `${stub}${path.delimiter}${saved.PATH}`;
    expect(await gitPullRequest(root, false)).toMatchObject({ ok: false, reason: "auth", message: expect.stringMatching(/gh auth login/) });

    await writeFile(path.join(stub, "signed-in"), "");
    await writeFile(path.join(stub, "create.out"), "Creating pull request for feature/pr into main in sam/phren\n\nhttps://github.com/sam/phren/pull/51\n");
    await writeFile(path.join(stub, "create.code"), "0");
    expect(await gitPullRequest(root, true)).toEqual({ ok: true, url: "https://github.com/sam/phren/pull/51", branch: "feature/pr", draft: true });
    expect(await readFile(path.join(stub, "calls.log"), "utf8")).toContain("pr create --fill --head feature/pr --draft");

    await writeFile(path.join(stub, "create.out"), "a pull request for branch \"feature/pr\" into branch \"main\" already exists:\nhttps://github.com/sam/phren/pull/51\n");
    await writeFile(path.join(stub, "create.code"), "1");
    expect(await gitPullRequest(root, false)).toMatchObject({ ok: true, existing: true, url: "https://github.com/sam/phren/pull/51" });

    await writeFile(path.join(stub, "create.out"), "aborted: you must first push the current branch to a remote, or use the --head flag");
    expect(await gitPullRequest(root, false)).toEqual({ ok: false, reason: "failed", output: "aborted: you must first push the current branch to a remote, or use the --head flag" });
  });

  it("carries the current branch's pull request and its checks in the pulls data", async () => {
    const { root, git } = await clone();
    await git("checkout", "-q", "-b", "feature/pr");
    expect(await gitPulls(root)).toEqual({ available: true, pulls: [], branch: "feature/pr", current: null });
    await writeFile(path.join(stub, "view.json"), JSON.stringify({
      number: 51, title: "Finish", url: "https://github.com/sam/phren/pull/51", state: "OPEN", isDraft: true,
      headRefName: "feature/pr", baseRefName: "main",
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "StatusContext", state: "SUCCESS" }],
    }));
    expect((await gitPulls(root)).current).toEqual({ number: 51, title: "Finish", url: "https://github.com/sam/phren/pull/51",
      head: "feature/pr", base: "main", draft: true, state: "OPEN", checks: "passing" });
    // A pull request for another head (gh's fallback) is not this branch's.
    await git("checkout", "-q", "-b", "elsewhere");
    expect((await gitPulls(root)).current).toBeNull();
  });

  it("rolls checks up to one word", () => {
    expect(checkRollup([])).toBeNull();
    expect(checkRollup(undefined)).toBeNull();
    expect(checkRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }])).toBe("passing");
    expect(checkRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS", conclusion: "" }])).toBe("pending");
    expect(checkRollup([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }])).toBe("failing");
    expect(checkRollup([{ __typename: "StatusContext", state: "PENDING" }])).toBe("pending");
    expect(checkRollup([{ __typename: "StatusContext", state: "ERROR" }])).toBe("failing");
  });
});
