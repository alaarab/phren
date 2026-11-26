import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grantAdmin, makeTempDir } from "../test-helpers.js";
import { linkTaskIssue, readTasks, updateTask, updateTaskWork } from "../data/tasks.js";
import { initializeTaskFormat } from "../data/task-format.js";
import { registerStoreIdentity } from "../store-registry.js";
import { bidReferences, branchTaskIds, parseForgeUrl, textNamesTask, workStatusLine, type TaskWork } from "./work.js";

const temps: { cleanup: () => void }[] = [];
afterEach(() => { for (const temp of temps.splice(0)) temp.cleanup(); });

function store(tasks: string, metadata = true): { root: string; file: string } {
  const temp = makeTempDir("task-work-");
  temps.push(temp);
  grantAdmin(temp.path);
  if (metadata) initializeTaskFormat(temp.path); else registerStoreIdentity(temp.path);
  fs.mkdirSync(path.join(temp.path, "app"));
  const file = path.join(temp.path, "app", "tasks.md");
  fs.writeFileSync(file, tasks);
  return { root: temp.path, file };
}
const first = (root: string) => {
  const doc = readTasks(root, "app");
  if (!doc.ok) throw new Error(doc.error);
  return doc.data;
};
const PR = { forge: "gitboy" as const, number: 12, url: "https://gitboy.example.com/me/app/pulls/12" };

describe("task Work record in tasks.md", () => {
  it("round-trips the record and keeps one a newer phren wrote verbatim, refusing to write over it", () => {
    const work: TaskWork = { version: 1, worker: { dispatchId: "5f0c3b8e-1111-4222-8333-944455556666", computer: "PJ", session: "s-1", label: "Fix sync", harness: "claude", state: "working", at: "2026-11-25T10:00:00.000Z" },
      branch: "feat/sync", worktree: "/home/me/app-sync", pr: PR };
    const newer = `  Work: {"version":2,"worker":{"dispatchId":"x"}}`;
    const { root, file } = store(`# app tasks\n\n## Active\n\n- [ ] Fix sync <!-- bid:aaaaaaaa -->\n  Work: ${JSON.stringify(work)}\n- [ ] Later <!-- bid:bbbbbbbb -->\n${newer}\n`);
    const doc = first(root);
    expect(doc.items.Active[0].work).toEqual(work);
    expect(doc.items.Active[1].work).toBeUndefined();
    expect(updateTask(root, "app", "bid:aaaaaaaa", { context: "touched" }).ok).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain(`  Work: ${JSON.stringify(work)}\n  Context: touched`);
    expect(text).toContain(newer);
    const refused = updateTaskWork(root, "app", "bid:bbbbbbbb", current => ({ work: { version: 1, ...current, branch: "x" } }));
    expect(refused.ok).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(text);
  });

  it("reads a legacy GitHub issue line as the Work issue, migrates it on write, and drops it on unlink", () => {
    const { root, file } = store("# app tasks\n\n## Queue\n\n- [ ] Crash on launch <!-- bid:cccccccc -->\n  GitHub: #41 https://github.com/me/app/issues/41\n- [ ] Bare <!-- bid:dddddddd -->\n  GitHub: #7\n");
    const before = first(root).items.Queue;
    expect(before[0]).toMatchObject({ githubIssue: 41, githubUrl: "https://github.com/me/app/issues/41", work: { issue: { forge: "github", number: 41, url: "https://github.com/me/app/issues/41" } } });
    expect(before[1]).toMatchObject({ githubIssue: 7 });
    expect(before[1].work).toBeUndefined();

    expect(updateTask(root, "app", "bid:cccccccc", { priority: "high" }).ok).toBe(true);
    let text = fs.readFileSync(file, "utf8");
    expect(text).toContain('  Work: {"version":1,"issue":{"forge":"github","number":41,"url":"https://github.com/me/app/issues/41"}}');
    expect(text).not.toContain("GitHub: #41");
    // An issue number without a URL has no repository to migrate to.
    expect(text).toContain("  GitHub: #7");
    expect(first(root).items.Queue[0]).toMatchObject({ githubIssue: 41, githubUrl: "https://github.com/me/app/issues/41" });

    expect(linkTaskIssue(root, "app", "bid:cccccccc", { unlink: true }).ok).toBe(true);
    text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain("issues/41");
    expect(first(root).items.Queue[0].githubIssue).toBeUndefined();
  });

  it("completes with the reason in history, or in context when the store has no task metadata, and never moves a Done task", () => {
    for (const metadata of [true, false]) {
      const { root, file } = store(`# app tasks\n\n## Active\n\n- [ ] Ship it <!-- bid:eeeeeeee -->\n  Work: ${JSON.stringify({ version: 1, pr: PR })}\n  Claimed: PJ 2026-11-25T10:00:00.000Z\n\n## Done\n\n- [x] Old <!-- bid:ffffffff -->\n`, metadata);
      const done = updateTaskWork(root, "app", "bid:eeeeeeee", work => ({ work: { ...work!, autoClosed: { at: "2026-11-25T11:00:00.000Z", reason: "PR #12 merged" } }, complete: "PR #12 merged" }));
      expect(done.ok).toBe(true);
      const item = first(root).items.Done[0];
      expect(item).toMatchObject({ stableId: "eeeeeeee", checked: true, work: { autoClosed: { reason: "PR #12 merged" } } });
      expect(item.claim).toBeUndefined();
      if (metadata) expect(item.history?.at(-1)?.change).toBe("completed: PR #12 merged; released claim by PJ");
      else { expect(item.history).toBeUndefined(); expect(item.context).toBe("completed: PR #12 merged; released claim by PJ"); }

      const untouched = fs.readFileSync(file, "utf8");
      const again = updateTaskWork(root, "app", "bid:ffffffff", work => ({ work, complete: "issue #1 closed" }));
      expect(again.ok && again.data.changed).toBe(false);
      expect(fs.readFileSync(file, "utf8")).toBe(untouched);
    }
  });
});

describe("work references", () => {
  it.each([
    ["https://github.com/me/app/pull/877", { domain: "github.com", repo: "me/app", kind: "pull", number: 877 }],
    ["https://github.com/me/app/issues/5?x=1#top", { domain: "github.com", repo: "me/app", kind: "issue", number: 5, url: "https://github.com/me/app/issues/5" }],
    ["https://gitboy.example.com:8443/me/app/pulls/12", { domain: "gitboy.example.com:8443", repo: "me/app", kind: "pull", number: 12 }],
    ["https://gitlab.com/group/sub/app/-/merge_requests/3", { domain: "gitlab.com", repo: "group/sub/app", kind: "pull", number: 3 }],
  ])("parses %s", (url, want) => expect(parseForgeUrl(url)).toMatchObject(want));

  it.each(["http://github.com/me/app/pull/1", "https://user:pw@github.com/me/app/pull/1", "https://github.com/me/app/pull/0", "https://github.com/me/app/commit/abc", "https://github.com/me/pull/1"])
  ("refuses %s", url => expect(parseForgeUrl(url)).toBeUndefined());

  it("reads bid references as gitboy does, branch ids as whole segments, and brief titles exactly", () => {
    expect(bidReferences("Closes bid:c2cc33d0. See bid:aaaaaaaa, not xbid:bbbbbbbb, bid:cccccccc9, bid:dddddddd-x or /bid:eeeeeeee")).toEqual(["c2cc33d0", "aaaaaaaa"]);
    expect(branchTaskIds("feat/c2cc33d0-work-links")).toEqual(["c2cc33d0"]);
    expect(branchTaskIds("agent/links-c2cc33d0")).toEqual(["c2cc33d0"]);
    expect(branchTaskIds("feat/c2cc33d0ff")).toEqual([]);
    const line = "Task work links, server side (owner 2026-11-25 'Yes do it'): give Phren tasks real fields [high]";
    expect(textNamesTask("Task work links, server side (owner 2026-11-25 'Yes do it')", line)).toBe(true);
    expect(textNamesTask("Task work links", line)).toBe(false);
  });
});

describe("work status line", () => {
  const worker = { dispatchId: "d", computer: "PJ", state: "working" as const, at: "2026-11-25T10:00:00.000Z" };
  const pr = { forge: "github" as const, number: 9, url: "https://github.com/me/app/pull/9" };
  const at = "2026-11-25T10:00:00.000Z";
  it.each([
    ["needs you outranks the PR", { version: 1, worker, pr }, { worker: { phase: "waiting", state: "needs-you", at, source: "dispatch" }, pr: { state: "open", checks: "failing", checkedAt: at } }, "Worker needs you on PJ"],
    ["failing checks", { version: 1, worker, pr }, { worker: { phase: "live", state: "working", at, source: "dispatch" }, pr: { state: "open", checks: "failing", checkedAt: at } }, "PR #9 · checks failing"],
    ["running checks", { version: 1, pr }, { pr: { state: "open", checks: "pending", mergeable: "blocked", checkedAt: at } }, "PR #9 · checks running"],
    ["ready", { version: 1, pr }, { pr: { state: "open", checks: "passing", mergeable: "clean", checkedAt: at } }, "PR #9 · checks passing · ready to merge"],
    ["conflicts", { version: 1, pr }, { pr: { state: "open", checks: "passing", mergeable: "conflicts", checkedAt: at } }, "PR #9 · merge conflicts"],
    ["merged", { version: 1, pr }, { pr: { state: "merged", checkedAt: at } }, "PR #9 merged"],
    ["PR not read yet", { version: 1, worker: { ...worker, state: "done" }, pr }, { worker: { phase: "done", state: "done", at, source: "task" }, pr: null }, "PR #9 open"],
    ["worker only", { version: 1, worker }, { worker: { phase: "live", state: "working", at, source: "task" } }, "Worker working on PJ"],
    ["issue", { version: 1, issue: { forge: "gitboy", number: 4, url: "https://gitboy.example.com/me/app/issues/4" } }, { issue: { state: "closed", checkedAt: at } }, "Issue #4 closed"],
  ] as const)("%s", (_name, work, live, want) => expect(workStatusLine(work as TaskWork, live as never)).toBe(want));
});
