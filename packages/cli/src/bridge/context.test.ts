import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContextUsageReader, WorkspaceContextUsage } from "./context.js";
import { paneIdentity, workspaceSnapshot } from "./herdr.js";
import { transcriptPath } from "./transcripts.js";
import { object, objects, type Json } from "./protocol.js";

vi.mock("./herdr.js", async importOriginal => ({ ...await importOriginal<typeof import("./herdr.js")>(), paneIdentity: vi.fn() }));
vi.mock("./transcripts.js", () => ({ transcriptPath: vi.fn() }));

const usage = (used: unknown, limit: unknown = 100_000) => JSON.stringify({ type: "event_msg", payload: {
  type: "token_count", info: { last_token_usage: { total_tokens: used }, model_context_window: limit,
    total_token_usage: { total_tokens: 900_000_000 } },
} }) + "\n";

describe("workspace context usage", () => {
  let root: string, file: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(path.join(tmpdir(), "phren-context-")); file = path.join(root, "rollout.jsonl");
    await writeFile(file, usage(25_000));
    vi.mocked(transcriptPath).mockResolvedValue(file);
    vi.mocked(paneIdentity).mockImplementation(async (_server, pane) => pane.session as string | undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it("uses last-response usage rather than cumulative billing and refreshes changed files", async () => {
    const reader = new ContextUsageReader();
    expect(await reader.read(file, "session")).toBe(25);
    expect(await reader.read(file, "session")).toBe(25);
    await appendFile(file, usage(50_000));
    expect(await reader.read(file, "session")).toBe(50);
    await writeFile(file, usage(0));
    expect(await reader.read(file, "session")).toBe(0);
    await appendFile(file, usage(120_000));
    expect(await reader.read(file, "session")).toBe(100);
  });

  it("keeps missing, reset and malformed latest observations unknown", async () => {
    const reader = new ContextUsageReader();
    for (const row of [usage(-1), usage(true), usage(1.5), usage(10, 0), usage(10, null),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }) + "\n",
      JSON.stringify({ type: "compacted" }) + "\n"]) {
      await writeFile(file, usage(25_000) + row);
      expect(await reader.read(file, "session")).toBeUndefined();
    }
  });

  it("bounds reads to the tail and ignores incomplete rows", async () => {
    const reader = new ContextUsageReader();
    await writeFile(file, usage(25_000) + JSON.stringify({ type: "other", padding: "x".repeat(300_000) }) + "\n");
    expect(await reader.read(file, "session")).toBeUndefined();
    await appendFile(file, usage(50_000) + '{"type":"event_msg"');
    expect(await reader.read(file, "session")).toBe(50);
  });

  it("requires one supported agent with a current exact identity and deduplicates session reads", async () => {
    const panes: Json[] = [
      { workspace_id: "w1", tab_id: "t1", pane_id: "p1", agent: "codex", session: "a" },
      { workspace_id: "w1", tab_id: "t2", pane_id: "p2", agent: "codex", session: "a" },
      { workspace_id: "w1", tab_id: "t3", pane_id: "p3", agent: "codex", session: "b" },
      { workspace_id: "w1", tab_id: "t3", pane_id: "p4", agent: "claude", session: "c" },
      { workspace_id: "w1", tab_id: "t4", pane_id: "p5", agent: "claude", session: "c" },
      { workspace_id: "w1", tab_id: "t5", pane_id: "p6", agent: "codex" },
    ];
    const snapshot = { workspaces: [{ workspace_id: "w1", label: "Project" }], panes,
      tabs: ["t1", "t2", "t3", "t4", "t5"].map(tab_id => ({ workspace_id: "w1", tab_id, label: tab_id })) };
    const reader = new WorkspaceContextUsage();
    const result = await reader.read("default", snapshot);
    expect([...result.values()]).toEqual([25, 25]);
    expect(transcriptPath).toHaveBeenCalledTimes(1);
    expect(transcriptPath).toHaveBeenCalledWith("codex", "a");
    expect(vi.mocked(paneIdentity).mock.calls.map(([, pane]) => pane.pane_id)).toEqual(["p1", "p2", "p6"]);
    const tabs = objects(object(objects(workspaceSnapshot(snapshot, result).groups)[0]).children);
    expect(tabs.map(t => t.contextUsedPercent)).toEqual([25, 25, undefined, undefined, undefined]);

    vi.mocked(paneIdentity).mockResolvedValue(undefined);
    expect((await reader.read("default", snapshot)).size).toBe(0);
  });

  it("caps session work and concurrent identity lookups", async () => {
    let active = 0, maximum = 0;
    vi.mocked(paneIdentity).mockImplementation(async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--; return "a";
    });
    const tabs = Array.from({ length: 40 }, (_, i) => ({ workspace_id: "w1", tab_id: `t${i}` }));
    const panes = tabs.map(t => ({ ...t, pane_id: `p${t.tab_id}`, agent: "codex" }));
    const result = await new WorkspaceContextUsage().read("default", { tabs, panes });
    expect(result.size).toBe(32);
    expect(maximum).toBe(4);
    expect(paneIdentity).toHaveBeenCalledTimes(32);
  });

  it("keeps the same tab ID in different workspaces separate", async () => {
    const first = { workspace_id: "w1", tab_id: "t1", pane_id: "p1", agent: "codex", session: "a" };
    const second = { workspace_id: "w2", tab_id: "t1", pane_id: "p2", agent: "claude", session: "b" };
    const snapshot = { panes: [first, second],
      workspaces: [{ workspace_id: "w1", label: "First" }, { workspace_id: "w2", label: "Second" }],
      tabs: [{ workspace_id: "w1", tab_id: "t1" }, { workspace_id: "w2", tab_id: "t1" }] };
    const context = await new WorkspaceContextUsage().read("default", snapshot);
    expect(context.get(first)).toBe(25);
    expect(context.has(second)).toBe(false);
    expect(paneIdentity).toHaveBeenCalledTimes(1);
    const groups = objects(workspaceSnapshot(snapshot, context).groups);
    expect(objects(groups[0].children)[0].contextUsedPercent).toBe(25);
    expect(objects(groups[1].children)[0].contextUsedPercent).toBeUndefined();
  });

  it("returns partial context at the deadline and suppresses overlapping batches until slow lookups drain", async () => {
    vi.useFakeTimers();
    vi.spyOn(ContextUsageReader.prototype, "read").mockResolvedValue(25);
    const pending: ((session: string) => void)[] = [];
    vi.mocked(paneIdentity).mockImplementation(async (_server, pane) => pane.pane_id === "p0" ? "first"
      : new Promise<string>(resolve => { pending.push(resolve); }));
    const tabs = Array.from({ length: 10 }, (_, i) => ({ workspace_id: "w1", tab_id: `t${i}` }));
    const panes = tabs.map((tab, i) => ({ ...tab, pane_id: `p${i}`, agent: "codex" }));
    const snapshot = { tabs, panes };
    const reader = new WorkspaceContextUsage();
    let settled = false;
    const reading = reader.read("default", snapshot).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(paneIdentity).toHaveBeenCalledTimes(5); // One completed, four in flight.
    expect((await reader.read("default", { ...snapshot })).size).toBe(0);
    expect(paneIdentity).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const partial = await reading;
    expect([...partial.entries()]).toEqual([[panes[0], 25]]);
    expect((await reader.read("another-server", snapshot)).size).toBe(0);
    expect(paneIdentity).toHaveBeenCalledTimes(5);

    for (const resolve of pending) resolve("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(paneIdentity).toHaveBeenCalledTimes(5);
    expect(transcriptPath).toHaveBeenCalledTimes(1);
    expect([...partial.entries()]).toEqual([[panes[0], 25]]);

    vi.mocked(paneIdentity).mockResolvedValue("fresh");
    expect((await reader.read("default", snapshot)).size).toBe(10);
    expect(paneIdentity).toHaveBeenCalledTimes(15);
  });
});
