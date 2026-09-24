import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { objects, type Json } from "./protocol.js";

// Git never answers: a starved machine where a branch read outlasts the phone's patience.
vi.mock("./projects.js", async importOriginal => ({ ...await importOriginal<object>(), repositoryBranch: () => new Promise<never>(() => {}) }));
vi.mock("./herdr.js", async importOriginal => ({ ...await importOriginal<object>(), paneChatState: async (_server: string, pane: Json) => ({ sessionId: `session-${pane.pane_id}` }) }));
vi.mock("./steps.js", () => ({ currentModel: async () => "opus", currentStep: async () => undefined }));
vi.mock("./transcripts.js", async importOriginal => ({ ...await importOriginal<object>(), childAgentTree: async () => [] }));

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
  });
});
