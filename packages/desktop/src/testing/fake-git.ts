import type { FakeHookHandler } from "./fake-hook.js";

/** A small stateful repository behind the fake Hook's `/v1/git/*` routes, for
 * the desktop's git e2e: one modified file that can be staged by hunk or
 * whole, an untracked file, three commits, a feature branch with a pull
 * request and checks, a remote that moves on fetch, and one agent session's
 * recorded edits. Enough to drive every Changes flow without Git. */

const APP = "src/app.ts";
const README = "README.md";
const HEAD_APP = "export const app = \"old\";\n\nexport function start() {\n  return app;\n}\n";
const WORK_APP = "export const app = \"new\";\nexport const ready = true;\n\nexport function start() {\n  return app.toUpperCase();\n}\n";
// The same edit, as two hunks of `git diff` between HEAD and the working file.
const HUNK_ONE = "@@ -1,2 +1,3 @@\n-export const app = \"old\";\n+export const app = \"new\";\n+export const ready = true;\n \n";
const HUNK_TWO = "@@ -3,3 +4,3 @@\n export function start() {\n-  return app;\n+  return app.toUpperCase();\n }\n";
const HEADER = `diff --git a/${APP} b/${APP}\nindex 1111111..2222222 100644\n--- a/${APP}\n+++ b/${APP}\n`;
const INDEX_ONE = "export const app = \"new\";\nexport const ready = true;\n\nexport function start() {\n  return app;\n}\n";

const SHA = ["a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432", "0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5"];

export interface FakeGit {
  routes: Record<string, FakeHookHandler>;
  /** Which hunks of src/app.ts are staged (0, 1 or 2 of them, in order). */
  staged(): number;
  branch(): string;
  calls: { route: string; body: Record<string, unknown> }[];
}

export function createFakeGit(): FakeGit {
  let stagedHunks = 0;
  let readmeStaged = false;
  let branch = "main";
  const branches = new Map<string, { upstream?: string; ahead: number; behind: number }>([
    ["main", { upstream: "origin/main", ahead: 1, behind: 0 }],
    ["feat/login", { upstream: "origin/feat/login", ahead: 0, behind: 0 }],
  ]);
  let fetched = false;
  const calls: FakeGit["calls"] = [];
  const now = Date.now();
  const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

  const indexApp = () => stagedHunks === 0 ? HEAD_APP : stagedHunks === 1 ? INDEX_ONE : WORK_APP;
  const tracking = () => branches.get(branch) ?? { ahead: 0, behind: 0 };

  function status() {
    const files: Record<string, unknown>[] = [];
    if (stagedHunks > 0) files.push({ path: APP, status: "M", staged: true, additions: stagedHunks === 2 ? 3 : 2, deletions: stagedHunks === 2 ? 2 : 1, countsComplete: true });
    if (stagedHunks < 2) files.push({ path: APP, status: "M", staged: false, additions: stagedHunks === 0 ? 3 : 1, deletions: 1, countsComplete: true });
    files.push(readmeStaged ? { path: README, status: "A", staged: true, additions: 2, deletions: 0, countsComplete: true }
      : { path: README, status: "?", staged: false, additions: 2, deletions: 0, countsComplete: true });
    const t = tracking();
    return {
      repository: "/Users/you/phren", observedAt: new Date().toISOString(), truncated: false, countsComplete: true,
      totalFiles: 2, branch, upstream: t.upstream ?? null, ahead: t.ahead, behind: t.behind,
      staged: files.filter((f) => f.staged).length, unstaged: files.filter((f) => !f.staged && f.status !== "?").length,
      untracked: readmeStaged ? 0 : 1, additions: 5, deletions: 2, defaultBranch: "main", files,
    };
  }

  function diff() {
    const sections: Record<string, unknown>[] = [];
    if (stagedHunks > 0) sections.push({ id: `staged:${APP}`, kind: "staged", loadState: "loaded", patch: HEADER + (stagedHunks === 2 ? HUNK_ONE + HUNK_TWO : HUNK_ONE) });
    if (stagedHunks < 2) sections.push({ id: `unstaged:${APP}`, kind: "unstaged", loadState: "loaded", patch: HEADER + (stagedHunks === 1 ? HUNK_TWO : HUNK_ONE + HUNK_TWO) });
    return {
      branch, root: "/Users/you/phren", repository: "/Users/you/phren", observedAt: new Date().toISOString(), launchPath: "/Users/you/phren",
      truncated: false, totalFiles: 2,
      files: [{ path: APP, status: "M", sections }, { path: README, status: readmeStaged ? "A" : "?", sections: [] }],
    };
  }

  const commits = [
    { sha: SHA[0], short: SHA[0].slice(0, 7), subject: "Wire the login form to the session store", author: "sam", date: ago(2),
      refs: [{ name: "HEAD", kind: "head" }, { name: "main", kind: "local" }], parents: [SHA[1]] },
    { sha: SHA[1], short: SHA[1].slice(0, 7), subject: "Scope idempotency keys per merchant", author: "codex", date: ago(26),
      refs: [{ name: "origin/main", kind: "remote" }], parents: [SHA[2]] },
    { sha: SHA[2], short: SHA[2].slice(0, 7), subject: "Start", author: "sam", date: ago(74), refs: [], parents: [] },
  ];
  const commitFiles: Record<string, { before: Record<string, string>; after: Record<string, string>; files: Record<string, unknown>[] }> = {
    [SHA[0]]: {
      before: { "src/login.ts": "export function login() {\n  return false;\n}\n" },
      after: { "src/login.ts": "import { session } from \"./session\";\n\nexport function login(user: string) {\n  session.set(user);\n  return true;\n}\n", "src/session.ts": "export const session = new Map<string, string>();\n" },
      files: [
        { path: "src/login.ts", status: "M", additions: 4, deletions: 2, binary: false, countsComplete: true,
          sections: [{ id: "commit:src/login.ts", kind: "commit", loadState: "loaded", patch: "@@ -1,3 +1,6 @@\n-export function login() {\n-  return false;\n+import { session } from \"./session\";\n+\n+export function login(user: string) {\n+  session.set(user);\n+  return true;\n }\n" }] },
        { path: "src/session.ts", status: "A", additions: 1, deletions: 0, binary: false, countsComplete: true,
          sections: [{ id: "commit:src/session.ts", kind: "commit", loadState: "loaded", patch: "@@ -0,0 +1 @@\n+export const session = new Map<string, string>();\n" }] },
        { path: "assets/logo.png", status: "A", additions: 0, deletions: 0, binary: true, countsComplete: true,
          sections: [{ id: "commit:assets/logo.png", kind: "commit", binary: true, loadState: "loaded", patch: "" }] },
      ],
    },
  };

  const record = (route: string, body: unknown) => calls.push({ route, body: (body ?? {}) as Record<string, unknown> });
  const ok = (json: unknown) => ({ status: 200, json });

  const routes: Record<string, FakeHookHandler> = {
    "GET /v1/git/status": () => ok(status()),
    "POST /v1/git/status": () => ok(status()),
    "POST /v1/diff": () => ok(diff()),
    "POST /v1/git/file": (_req, body) => {
      record("file", body);
      const { ref, path } = (body ?? {}) as { ref?: string; path?: string };
      let text: string | undefined;
      if (path === APP) text = ref === "INDEX" ? indexApp() : ref === "HEAD" ? HEAD_APP : undefined;
      else if (path === README && ref === "INDEX" && readmeStaged) text = "# phren\n\nNotes.\n";
      else {
        const sha = Object.keys(commitFiles).find((key) => key === ref);
        if (sha) text = commitFiles[sha].after[path ?? ""];
        else if (ref === SHA[1]) text = commitFiles[SHA[0]].before[path ?? ""];
      }
      return ok(text === undefined ? { path, ref, missing: true, text: "" } : { path, ref, size: text.length, text });
    },
    "POST /v1/git/apply": (_req, body) => {
      record("apply", body);
      const { patch, reverse } = (body ?? {}) as { patch?: string; reverse?: boolean };
      if (typeof patch !== "string" || !patch.includes("@@")) return { status: 400, json: { error: "Choose a hunk to stage." } };
      if (reverse) stagedHunks = Math.max(0, stagedHunks - 1);
      else stagedHunks = Math.min(2, stagedHunks + 1);
      return ok({ ok: true, path: APP, staged: !reverse });
    },
    "POST /v1/git/stage": (_req, body) => {
      record("stage", body);
      const paths = ((body ?? {}) as { paths?: string[] }).paths ?? [];
      if (paths.includes(APP)) stagedHunks = 2;
      if (paths.includes(README)) readmeStaged = true;
      return ok({ ok: true });
    },
    "POST /v1/git/unstage": (_req, body) => {
      record("unstage", body);
      const paths = ((body ?? {}) as { paths?: string[] }).paths ?? [];
      if (paths.includes(APP)) stagedHunks = 0;
      if (paths.includes(README)) readmeStaged = false;
      return ok({ ok: true });
    },
    "POST /v1/git/commit": (_req, body) => {
      record("commit", body);
      const message = String(((body ?? {}) as { message?: string }).message ?? "");
      stagedHunks = 0; readmeStaged = false;
      const t = branches.get(branch); if (t) t.ahead++;
      return ok({ ok: true, sha: "f".repeat(40), short: "fffffff", subject: message.split("\n")[0], branch });
    },
    "POST /v1/git/push": (_req, body) => {
      record("push", body);
      if (branch === "main" && !((body ?? {}) as { confirmDefault?: boolean }).confirmDefault) {
        return { status: 409, json: { error: "main is the default branch. Confirm to push it.", defaultBranch: "main" } };
      }
      const t = branches.get(branch); if (t) { t.ahead = 0; t.upstream ??= `origin/${branch}`; }
      return ok({ ok: true, branch, remote: "origin", upstream: `origin/${branch}`, setUpstream: false, output: "" });
    },
    "POST /v1/git/log": () => ok({ commits: branch === "main" ? commits : commits.slice(1), uncommitted: { files: 2, additions: 5, deletions: 2 } }),
    "POST /v1/git/show": (_req, body) => {
      record("show", body);
      const sha = String(((body ?? {}) as { sha?: string }).sha ?? "");
      const commit = commits.find((c) => c.sha.startsWith(sha));
      if (!commit) return { status: 404, json: { error: "This repository has no such commit.", code: "git-unknown-commit" } };
      const files = commitFiles[commit.sha]?.files ?? [];
      return ok({ ...commit, body: commit.sha === SHA[0] ? "The form now keeps the signed-in user.\n\nCo-Authored-By: Codex <codex@example.com>" : "",
        authorEmail: `${commit.author}@example.com`, committer: commit.author, committed: commit.date, files, totalFiles: files.length,
        additions: files.reduce((n, f) => n + Number(f.additions), 0), deletions: files.reduce((n, f) => n + Number(f.deletions), 0), truncated: false });
    },
    "POST /v1/git/branches": () => ok({
      current: branch,
      local: [...branches.entries()].map(([name, t]) => ({ name, ...(t.upstream ? { upstream: t.upstream } : {}), ahead: t.ahead, behind: t.behind, date: ago(name === "main" ? 2 : 30) })),
      remote: [{ name: "origin/main", date: ago(2) }, { name: "origin/feat/login", date: ago(30) }, { name: "origin/agent/parser", date: ago(5) }],
    }),
    "POST /v1/git/checkout": (_req, body) => {
      record("checkout", body);
      const data = (body ?? {}) as { branch?: string; create?: boolean; startPoint?: string; carryChanges?: boolean };
      const name = String(data.branch ?? "");
      if (data.create && branches.has(name)) return { status: 409, json: { error: `A branch named ${name} already exists.`, code: "git-branch-exists" } };
      if (!data.create && !branches.has(name)) return { status: 404, json: { error: `There is no local branch named ${name}.`, code: "git-unknown-ref" } };
      const dirty = stagedHunks < 2 ? 1 : 0;
      if (dirty && !data.carryChanges && !(data.create && !data.startPoint)) {
        return { status: 409, json: { error: `1 file has uncommitted changes that would move to ${name}. Confirm to carry them.`, code: "git-dirty", changes: 1 } };
      }
      const previous = branch;
      if (data.create) branches.set(name, data.startPoint?.startsWith("origin/") ? { upstream: data.startPoint, ahead: 0, behind: 0 } : { ahead: 0, behind: 0 });
      branch = name;
      return ok({ ok: true, branch: name, previous, changed: true, created: !!data.create, ...(branches.get(name)?.upstream ? { upstream: branches.get(name)?.upstream } : {}), carried: dirty });
    },
    "POST /v1/git/fetch": (_req, body) => {
      record("fetch", body);
      if (!fetched) { fetched = true; const t = branches.get("main"); if (t) t.behind = 2; }
      return ok({ ok: true, remote: "origin" });
    },
    "POST /v1/git/pull": (_req, body) => {
      record("pull", body);
      const t = branches.get(branch);
      const commitsIn = t?.behind ?? 0;
      if (t) t.behind = 0;
      return ok({ ok: true, branch, upstream: t?.upstream, commits: commitsIn });
    },
    "POST /v1/git/pulls": () => ok({
      available: true, branch,
      pulls: [
        { number: 42, title: "Login: keep the signed-in user", head: "feat/login", base: "main", author: "sam", url: "https://github.com/sam/phren/pull/42", draft: false, state: "OPEN", updated: ago(1) },
        { number: 37, title: "Draft: parser rewrite", head: "agent/parser", base: "main", author: "codex", url: "https://github.com/sam/phren/pull/37", draft: true, state: "OPEN", updated: ago(5) },
      ],
      current: branch === "feat/login" ? {
        number: 42, title: "Login: keep the signed-in user", url: "https://github.com/sam/phren/pull/42", head: "feat/login", base: "main",
        draft: false, state: "OPEN", checks: "failing", reviewDecision: "CHANGES_REQUESTED", mergeState: "BLOCKED",
        checkRuns: [
          { name: "unit (ubuntu)", workflow: "CI", state: "failing", url: "https://github.com/sam/phren/actions/runs/1" },
          { name: "e2e", workflow: "CI", state: "pending", url: "https://github.com/sam/phren/actions/runs/2" },
          { name: "lint", workflow: "CI", state: "passing", url: "https://github.com/sam/phren/actions/runs/3" },
          { name: "docs", workflow: "Pages", state: "skipped" },
        ],
      } : null,
    }),
    "POST /v1/git/worktrees": () => ok({ worktrees: [] }),
    "POST /v1/git/session-changes": () => ok({
      root: "/Users/you/phren", calls: 3, totalFiles: 2, others: 0, additions: 6, deletions: 2,
      files: [
        { path: APP, status: "M", added: 3, removed: 2, redacted: false, binary: false, edits: [
          { toolUseId: "toolu_1", status: "M", added: 2, removed: 1, patch: HEADER + HUNK_ONE },
          { toolUseId: "toolu_3", status: "M", added: 1, removed: 1, patch: HEADER + HUNK_TWO },
        ] },
        { path: README, status: "A", added: 3, removed: 0, redacted: false, binary: false, edits: [
          { toolUseId: "toolu_2", status: "A", added: 3, removed: 0, patch: `diff --git a/${README} b/${README}\nnew file mode 100644\n--- /dev/null\n+++ b/${README}\n@@ -0,0 +1,3 @@\n+# phren\n+\n+Notes.\n` },
        ] },
      ],
    }),
  };
  return { routes, staged: () => stagedHunks, branch: () => branch, calls };
}

export const FAKE_GIT_WORKING_APP = WORK_APP;
