import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantAdmin, makeTempDir } from "../test-helpers.js";
import { initializeTaskFormat } from "../data/task-format.js";
import { registeredStoreIdentity } from "../store-registry.js";
import type { ForgeItem, TaskWork } from "../task/work.js";
import type { GitHostProvider } from "./git-hosts.js";

// The forge is the boundary: gh and gitboy's API answer through the providers.
vi.mock("./git-hosts.js", async importOriginal => ({ ...await importOriginal<typeof import("./git-hosts.js")>(), providerFor: vi.fn() }));
vi.mock("./dispatch.js", async importOriginal => ({ ...await importOriginal<typeof import("./dispatch.js")>(), dispatchReceipt: vi.fn() }));
const hosts = await import("./git-hosts.js");
const dispatch = await import("./dispatch.js");
const { getTaskDetailRoute, getTaskListRoute } = await import("./task-routes.js");

let root = "", cleanup = () => {};
const items = new Map<string, ForgeItem>();
const provider = { kind: "github", name: "GitHub", supported: true, terms: { short: "PR", long: "pull request", ref: "#" },
  list: vi.fn(), open: vi.fn(), merge: vi.fn(),
  item: async (_root: string, kind: string, number: number) => { const found = items.get(`${kind}:${number}`); if (!found) throw new Error("gh: not found"); return found; } } as GitHostProvider;

beforeEach(() => {
  const temp = makeTempDir("task-work-hook-");
  root = temp.path; cleanup = temp.cleanup;
  grantAdmin(root);
  initializeTaskFormat(root);
  vi.stubEnv("PHREN_PATH", root);
  vi.mocked(hosts.providerFor).mockReturnValue(provider);
  vi.mocked(dispatch.dispatchReceipt).mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); cleanup(); });

function project(name: string, body: string): string {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  const file = path.join(root, name, "tasks.md");
  fs.writeFileSync(file, `# ${name} tasks\n\n${body}`);
  return file;
}
const pr = (number: number) => ({ forge: "github" as const, number, url: `https://github.com/me/app/pull/${number}` });
const work = (value: Omit<TaskWork, "version">) => `  Work: ${JSON.stringify({ version: 1, ...value })}`;

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
