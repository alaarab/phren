import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantAdmin, makeTempDir } from "../test-helpers.js";
import { readTasks } from "../data/tasks.js";
import { initializeTaskFormat } from "../data/task-format.js";
import { registeredStoreIdentity } from "../store-registry.js";
import type { ForgeItem, TaskWork } from "../task/work.js";
import type { GitHostProvider, RecentPull } from "./git-hosts.js";

// The forge is the boundary: gh and gitboy's API answer through the providers.
vi.mock("./git-hosts.js", async importOriginal => ({ ...await importOriginal<typeof import("./git-hosts.js")>(), detectHost: vi.fn(), providerFor: vi.fn() }));
vi.mock("./dispatch.js", async importOriginal => ({ ...await importOriginal<typeof import("./dispatch.js")>(), dispatchProjectDirectory: vi.fn(), dispatchReceipt: vi.fn() }));
const hosts = await import("./git-hosts.js");
const dispatch = await import("./dispatch.js");
const { linkReportedWork, recordDispatchWorker, resolveBriefTask } = await import("./task-work.js");
const { TaskWorkSweeper } = await import("./task-work-live.js");
const { getTaskDetailRoute, getTaskListRoute } = await import("./task-routes.js");

let root = "", cleanup = () => {};
let pulls: RecentPull[] = [];
const items = new Map<string, ForgeItem>();
const provider = { kind: "github", name: "GitHub", supported: true, terms: { short: "PR", long: "pull request", ref: "#" },
  list: vi.fn(), open: vi.fn(), merge: vi.fn(), recent: async () => pulls,
  item: async (_root: string, kind: string, number: number) => { const found = items.get(`${kind}:${number}`); if (!found) throw new Error("gh: not found"); return found; } } as GitHostProvider;

beforeEach(() => {
  const temp = makeTempDir("task-work-hook-");
  root = temp.path; cleanup = temp.cleanup;
  grantAdmin(root);
  initializeTaskFormat(root);
  vi.stubEnv("PHREN_PATH", root);
  vi.stubEnv("PHREN_TASK_WORK", "on");
  pulls = [];
  vi.mocked(hosts.providerFor).mockReturnValue(provider);
  vi.mocked(hosts.detectHost).mockResolvedValue(hosts.hostInfo("github", { domain: "github.com", webUrl: "https://github.com/me/app", remote: "origin", source: "url" }));
  vi.mocked(dispatch.dispatchProjectDirectory).mockResolvedValue(root);
  vi.mocked(dispatch.dispatchReceipt).mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); cleanup(); });

function project(name: string, body: string): string {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  const file = path.join(root, name, "tasks.md");
  fs.writeFileSync(file, `# ${name} tasks\n\n${body}`);
  return file;
}
const task = (stableId: string, project = "app") => ({ storeId: registeredStoreIdentity(root)!, project, stableId });
function item(stableId: string, name = "app") {
  const doc = readTasks(root, name);
  if (!doc.ok) throw new Error(doc.error);
  return [...doc.data.items.Active, ...doc.data.items.Queue, ...doc.data.items.Done].find(entry => entry.stableId === stableId)!;
}
const pr = (number: number) => ({ forge: "github" as const, number, url: `https://github.com/me/app/pull/${number}` });
const work = (value: Omit<TaskWork, "version">) => `  Work: ${JSON.stringify({ version: 1, ...value })}`;

describe("dispatch binding", () => {
  it("binds a brief to the one open task it names by bid, stable id or quoted title", () => {
    project("app", "## Active\n\n- [ ] Fix the sync race: two pulls collide <!-- bid:aaaaaaaa -->\n- [ ] Write docs <!-- bid:bbbbbbbb -->\n\n## Done\n\n- [x] Old work <!-- bid:dddddddd -->\n");
    project("other", "## Queue\n\n- [ ] Elsewhere <!-- bid:cccccccc -->\n");
    expect(resolveBriefTask(root, "Read bid:aaaaaaaa and fix it.", "app")).toEqual(task("aaaaaaaa"));
    expect(resolveBriefTask(root, "Task bbbbbbbb, please.", "app")).toEqual(task("bbbbbbbb"));
    expect(resolveBriefTask(root, 'Phren task (project app): "Fix the sync race"', "app")).toEqual(task("aaaaaaaa"));
    // The quoted task wins over one mentioned for context; a closing reference wins over both.
    expect(resolveBriefTask(root, '"Fix the sync race". Coordinate with bid:bbbbbbbb.', "app")).toEqual(task("aaaaaaaa"));
    expect(resolveBriefTask(root, '"Fix the sync race", which fixes bid:bbbbbbbb.', "app")).toEqual(task("bbbbbbbb"));
    // A bare id belongs to the dispatch's project; bid: reaches any project.
    expect(resolveBriefTask(root, "Task cccccccc.", "app")).toBeUndefined();
    expect(resolveBriefTask(root, "bid:cccccccc", "app")).toEqual(task("cccccccc", "other"));
    expect(resolveBriefTask(root, "bid:aaaaaaaa then bid:bbbbbbbb", "app")).toBeUndefined();
    expect(resolveBriefTask(root, "Redo bid:dddddddd", "app")).toBeUndefined();
  });

  it("records the worker on its task, follows its dispatch, and never lets an older dispatch take the task back", () => {
    project("app", "## Active\n\n- [ ] Fix the sync race <!-- bid:aaaaaaaa -->\n");
    const first = { id: "11111111-1111-4111-8111-111111111111", createdAt: "2026-11-25T10:00:00.000Z", updatedAt: "2026-11-25T10:00:00.000Z",
      computer: "PJ", label: "Sync race", harness: "claude", task: task("aaaaaaaa"), state: "launching", branch: "agent/sync" };
    recordDispatchWorker(first);
    expect(item("aaaaaaaa").work).toMatchObject({ branch: "agent/sync", worker: { dispatchId: first.id, computer: "PJ", label: "Sync race", state: "launching" } });
    recordDispatchWorker({ ...first, state: "accepted", target: { server: "s", session: "sess-1" }, worker: { state: "working", since: "2026-11-25T10:01:00.000Z" } });
    expect(item("aaaaaaaa").work?.worker).toMatchObject({ session: "sess-1", state: "working" });
    recordDispatchWorker({ ...first, state: "accepted", returned: { state: "needs-you", at: "2026-11-25T10:05:00.000Z" } });
    expect(item("aaaaaaaa").work?.worker?.state).toBe("needs-you");

    const second = { ...first, id: "22222222-2222-4222-8222-222222222222", createdAt: new Date(Date.now() + 60_000).toISOString(), computer: "Mini", state: "accepted" };
    recordDispatchWorker(second);
    expect(item("aaaaaaaa").work?.worker).toMatchObject({ dispatchId: second.id, computer: "Mini", state: "working" });
    recordDispatchWorker({ ...first, state: "accepted", returned: { state: "done", at: "2026-11-25T10:09:00.000Z" } });
    expect(item("aaaaaaaa").work?.worker?.dispatchId).toBe(second.id);
  });

  it("links a worker's reported pull request on gitboy through its dispatch", async () => {
    project("app", `## Active\n\n- [ ] Fix the sync race <!-- bid:aaaaaaaa -->\n${work({ worker: { dispatchId: "d-1", computer: "PJ", state: "working", at: "2026-11-25T10:00:00.000Z" } })}\n`);
    expect(await linkReportedWork([{ url: "https://gitboy.example.com/me/app/pulls/12", branch: "feat/sync" }], undefined, "d-1")).toEqual({ linked: true });
    expect(item("aaaaaaaa").work).toMatchObject({ branch: "feat/sync", pr: { forge: "gitboy", number: 12, url: "https://gitboy.example.com/me/app/pulls/12" } });
    expect(await linkReportedWork([{ url: "https://gitboy.example.com/me/app/pulls/13", branch: "x" }], undefined, "d-unknown")).toEqual({ linked: false });
  });
});

describe("task work sweep", () => {
  it("links pull requests that name a task, closes tasks whose PR merged or issue closed once, and leaves the rest", async () => {
    const file = project("app", [
      "## Active", "",
      "- [ ] Merge me <!-- bid:a1a1a1a1 -->",
      "- [ ] Named by branch <!-- bid:b2b2b2b2 -->",
      "- [ ] Named only by a PR closed unmerged <!-- bid:a7a7a7a7 -->",
      "- [ ] Only mentioned by a merged PR <!-- bid:9a9a9a9a -->",
      "- [ ] Closed unmerged <!-- bid:c3c3c3c3 -->", work({ pr: pr(103) }),
      "- [ ] Issue fixed <!-- bid:d4d4d4d4 -->", "  GitHub: #104 https://github.com/me/app/issues/104",
      "- [ ] Reopened by the owner <!-- bid:e5e5e5e5 -->", work({ pr: pr(105), autoClosed: { at: "2026-11-24T10:00:00.000Z", reason: "PR #105 merged", url: pr(105).url } }),
      "- [ ] Reopened, then its PR merged <!-- bid:8b8b8b8b -->", work({ pr: pr(111), issue: { forge: "github", number: 112, url: "https://github.com/me/app/issues/112" },
        autoClosed: { at: "2026-11-24T10:00:00.000Z", reason: "issue #112 closed", url: "https://github.com/me/app/issues/112" } }),
      "- [ ] Branch on main <!-- bid:c0c0c0c0 -->", work({ branch: "main" }),
      "", "## Done", "", "- [x] Already done <!-- bid:f6f6f6f6 -->", work({ pr: pr(106) }), "",
    ].join("\n"));
    pulls = [
      { number: 101, url: pr(101).url, state: "merged", head: "fix/merge", body: "Closes bid:a1a1a1a1." },
      { number: 102, url: pr(102).url, state: "open", head: "feat/b2b2b2b2-branch", body: "" },
      { number: 107, url: pr(107).url, state: "open", head: "misc", body: "Mentions bid:99999999 and f6f6f6f6." },
      { number: 108, url: pr(108).url, state: "closed", head: "try/a7a7a7a7", body: "Fixes bid:a7a7a7a7" },
      { number: 109, url: pr(109).url, state: "merged", head: "fix/half", body: "Hook half of Phren task bid:9a9a9a9a." },
      { number: 110, url: pr(110).url, state: "open", head: "main", body: "From a fork's main." },
    ];
    items.set("pull:101", { state: "merged", mergedAt: "2026-11-25T10:00:00Z" });
    items.set("pull:102", { state: "open", checks: "failing", mergeable: "clean" });
    items.set("pull:103", { state: "closed" });
    items.set("issue:104", { state: "closed" });
    items.set("pull:105", { state: "merged" });
    items.set("pull:106", { state: "merged" });
    items.set("pull:111", { state: "merged" });
    items.set("issue:112", { state: "closed" });

    expect(await new TaskWorkSweeper(root).tick()).toEqual({ linked: 2, closed: 3, errors: 0 });
    expect(item("a1a1a1a1")).toMatchObject({ section: "Done", work: { pr: pr(101), branch: "fix/merge", autoClosed: { reason: `PR #101 merged (${pr(101).url})` } } });
    expect(item("a1a1a1a1").history?.at(-1)?.change).toBe(`completed: PR #101 merged (${pr(101).url})`);
    expect(item("b2b2b2b2")).toMatchObject({ section: "Active", work: { pr: pr(102), branch: "feat/b2b2b2b2-branch" } });
    expect(item("a7a7a7a7").work).toBeUndefined();
    expect(item("9a9a9a9a")).toMatchObject({ section: "Active", work: undefined });
    expect(item("c3c3c3c3").section).toBe("Active");
    expect(item("d4d4d4d4")).toMatchObject({ section: "Done", githubIssue: 104 });
    expect(item("d4d4d4d4").history?.at(-1)?.change).toBe("completed: issue #104 closed (https://github.com/me/app/issues/104)");
    expect(item("e5e5e5e5").section).toBe("Active");
    expect(item("8b8b8b8b")).toMatchObject({ section: "Done", work: { autoClosed: { url: pr(111).url } } });
    expect(item("c0c0c0c0").work).toEqual({ version: 1, branch: "main" });
    expect(item("f6f6f6f6").section).toBe("Done");

    const after = fs.readFileSync(file, "utf8");
    expect(await new TaskWorkSweeper(root).tick()).toEqual({ linked: 0, closed: 0, errors: 0 });
    expect(fs.readFileSync(file, "utf8")).toBe(after);
  });
});

describe("task API", () => {
  it("serves work links with live worker, CI and mergeability state and the row's status line", async () => {
    project("app", `## Active\n\n- [ ] Fix the sync race <!-- bid:aaaaaaaa -->\n${work({ worker: { dispatchId: "33333333-3333-4333-8333-333333333333", computer: "PJ", state: "working", at: "2026-11-25T10:00:00.000Z" }, branch: "feat/sync", pr: pr(201) })}\n- [ ] Plain <!-- bid:bbbbbbbb -->\n`);
    items.set("pull:201", { state: "open", title: "Fix the sync race", draft: false, checks: "passing", mergeable: "clean", head: "feat/sync" });
    vi.mocked(dispatch.dispatchReceipt).mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333", createdAt: "2026-11-25T10:00:00.000Z", updatedAt: "2026-11-25T10:20:00.000Z",
      computer: "PJ", label: "Sync race", state: "accepted", returned: { state: "done", at: "2026-11-25T10:20:00.000Z", read: false } } as never);
    const storeId = registeredStoreIdentity(root)!;
    const detail = await getTaskDetailRoute(root, new URL(`http://phren.local/v1/tasks/detail?storeId=${storeId}&project=app&stableId=aaaaaaaa`));
    expect(detail.item).toMatchObject({ stableId: "aaaaaaaa", work: { branch: "feat/sync", pr: pr(201) }, live: {
      worker: { phase: "done", state: "done", source: "dispatch" },
      pr: { state: "open", checks: "passing", mergeable: "clean", title: "Fix the sync race" },
      status: "PR #201 · checks passing · ready to merge" } });
    const list = await getTaskListRoute(root, new URL(`http://phren.local/v1/tasks?storeId=${storeId}&project=app`));
    expect((list.items.Active as { stableId?: string; live?: { status?: string } }[]).map(row => [row.stableId, row.live?.status])).toEqual([["aaaaaaaa", "PR #201 · checks passing · ready to merge"], ["bbbbbbbb", undefined]]);
  });
});
