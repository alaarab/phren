import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { objects, type Json } from "./protocol.js";
import { paneAccountKey, recordPaneAccount } from "./pane-accounts.js";

// Git never answers: a starved machine where a branch read outlasts the phone's patience.
const reads = vi.hoisted(() => ({
  prefix: "session-",
  model: vi.fn(async (): Promise<string> => "opus"),
  children: vi.fn(async (): Promise<unknown[]> => [{ state: "running", provider: "claude", children: [] }]),
}));
vi.mock("./projects.js", async importOriginal => ({ ...await importOriginal<object>(), repositoryBranch: () => new Promise<never>(() => {}) }));
vi.mock("./herdr.js", async importOriginal => ({ ...await importOriginal<object>(), paneChatState: async (_server: string, pane: Json) => ({ sessionId: `${reads.prefix}${pane.pane_id}` }) }));
vi.mock("./steps.js", () => ({ currentModel: reads.model, currentStep: async () => undefined }));
vi.mock("./transcripts.js", async importOriginal => ({ ...await importOriginal<object>(), childAgentTree: reads.children }));

const { workspacesReader, OVERVIEW_ENRICH_BUDGET_MS } = await import("./server-routes.js");
const snapshot = JSON.parse(readFileSync(new URL("./fixtures/herdr/0.9.1/snapshot.json", import.meta.url), "utf8")).result.snapshot as Json;

describe("the overview on a loaded computer", () => {
  afterEach(() => vi.useRealTimers());

  it("answers within its budget with every chat's conversation, leaving slow decoration for a later read", async () => {
    vi.useFakeTimers();
    const read = workspacesReader({
      modules: { has: (name: string) => name === "git" } as never, info: {} as never,
      agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set<string>() } as never,
      journal: { record: async () => {} } as never, tabActivity: { observe: async () => new Map() } as never,
      contextUsage: { read: async () => new Map() } as never,
    });
    let answer: Json | undefined;
    void read("default", snapshot, false).then(value => { answer = value; });
    await vi.advanceTimersByTimeAsync(OVERVIEW_ENRICH_BUDGET_MS);
    expect(answer, "the overview never answered while git was stuck").toBeDefined();
    const tabs = objects(answer!.groups).flatMap(group => objects(group.children));
    const working = tabs.find(tab => objects(snapshot.panes).some(p => p.pane_id === "w13:p2" && p.tab_id === tab.id))!;
    // The chat still opens on the exact conversation; the branch simply isn't there yet.
    expect(working.target).toMatchObject({ pane: "w13:p2", source: "claude", session: "session-w13:p2" });
    expect(working).not.toHaveProperty("branch");
    expect(working).toMatchObject({ runningChildren: 1, childProviders: ["claude"] });
  });

  it("returns child activity while model reads are stuck and reuses trees that outlast the first overview", async () => {
    vi.useFakeTimers();
    reads.prefix = "slow-tree-";
    reads.model.mockImplementation(() => new Promise(() => {}));
    let finish!: (value: unknown[]) => void;
    const tree = new Promise<unknown[]>(resolve => { finish = resolve; });
    reads.children.mockClear().mockImplementation(() => tree);
    const read = workspacesReader({
      modules: { has: () => false } as never, info: {} as never,
      agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set<string>() } as never,
      journal: { record: async () => {} } as never, tabActivity: { observe: async () => new Map() } as never,
      contextUsage: { read: async () => new Map() } as never,
    });
    try {
      const first = read("default", snapshot, false);
      await vi.advanceTimersByTimeAsync(OVERVIEW_ENRICH_BUDGET_MS);
      const old = await first;
      const calls = reads.children.mock.calls.length;
      expect(calls).toBeGreaterThan(0);
      // A second overview joins the pending reads even though their start
      // time is now past the ordinary cache TTL.
      const second = read("default", snapshot, false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reads.children).toHaveBeenCalledTimes(calls);
      finish([{ state: "running", provider: "claude", children: [] }]);
      await vi.advanceTimersByTimeAsync(OVERVIEW_ENRICH_BUDGET_MS);
      const answer = await second;
      const row = objects(answer.groups).flatMap(group => objects(group.children)).find(tab => (tab.target as Json)?.pane === "w13:p2")!;
      expect(row).toMatchObject({ runningChildren: 1, childProviders: ["claude"] });
      expect(row).not.toHaveProperty("model");
      // Late answers never mutate a response already handed to the caller.
      expect(objects(old.groups).flatMap(group => objects(group.children)).every(tab => tab.runningChildren === undefined)).toBe(true);
    } finally {
      reads.prefix = "session-";
      reads.model.mockResolvedValue("opus");
      reads.children.mockResolvedValue([]);
    }
  });

  it("puts the Claude account on a row whose pane has one recorded", async () => {
    const pane = objects(snapshot.panes).find(p => p.pane_id === "w13:p2")!;
    recordPaneAccount(paneAccountKey("default", pane.pane_id), "default", String(pane.terminal_id ?? ""));
    const read = workspacesReader({
      modules: { has: () => false } as never, info: {} as never,
      agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set<string>() } as never,
      journal: { record: async () => {} } as never, tabActivity: { observe: async () => new Map() } as never,
      contextUsage: { read: async () => new Map() } as never,
    });
    const answer = await read("default", snapshot, false);
    const tabs = objects(answer.groups).flatMap(group => objects(group.children));
    const row = tabs.find(tab => objects(snapshot.panes).some(p => p.pane_id === "w13:p2" && p.tab_id === tab.id))!;
    expect(row.account).toMatchObject({ id: "default" });
    expect(row.account).toHaveProperty("key");
  });
});
