import { readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { objects, type Json } from "./protocol.js";

const sessions: Record<string, string> = {
  "w13:p2": "00000001-1111-4111-8111-111111111111", "w1P:p1": "00000002-1111-4111-8111-111111111111",
  "w1P:p2": "00000003-1111-4111-8111-111111111111", "w1S:p1": "00000004-1111-4111-8111-111111111111",
};
vi.mock("./herdr.js", async importOriginal => ({ ...await importOriginal<object>(), paneChatState: async (_server: string, pane: Json) => ({ sessionId: sessions[String(pane.pane_id)] }) }));
vi.mock("./steps.js", () => ({ currentModel: async () => undefined, currentStep: async () => ({ text: "stale step" }) }));
// Two Codex subagents run under the Codex pane, one Claude sub-agent under
// w1P:p1 (plus one finished), nothing under the others.
vi.mock("./transcripts.js", async importOriginal => ({ ...await importOriginal<object>(),
  childAgentTree: async (source: string, session: string) => source === "codex" ? [{ state: "running", provider: "codex", children: [] }, { state: "running", provider: "codex", children: [] }]
    : session === sessions["w1P:p1"] ? [{ state: "running", provider: "claude", children: [] }, { state: "completed", provider: "claude", children: [] }] : [] }));
// What each Claude transcript's tail says its ended turn still awaits.
const awaited: Record<string, number | undefined> = {};
vi.mock("./schedule-watch.js", async importOriginal => ({ ...await importOriginal<object>(),
  readFinalTurn: async (_source: string, session: string) => ({ completed: true, ...(awaited[session] ? { awaited: awaited[session] } : {}) }) }));

const { workspacesReader, OVERVIEW_ENRICH_BUDGET_MS } = await import("./server-routes.js");
const { noteTurn } = await import("./turn-records.js");
const { markSessionSeen } = await import("./session-seen.js");
const { writeLaunchBrief } = await import("./launch-brief.js");
const transcripts = await import("./transcripts.js");
const { TranscriptReader } = transcripts;
const recorded = JSON.parse(readFileSync(new URL("./fixtures/herdr/0.9.1/snapshot.json", import.meta.url), "utf8")).result.snapshot as Json;

let root: string;
beforeEach(async () => {
  const scratch = path.join(process.cwd(), ".scratch");
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(path.join(scratch, "phren-session-status-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude"));
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

const dispatchId = "40000000-0000-4000-8000-000000000001";
const read = (snapshot: Json) => workspacesReader({
  modules: { has: () => false } as never, info: {} as never,
  agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set<string>() } as never,
  journal: { record: async () => {} } as never, tabActivity: { observe: async () => new Map() } as never,
  contextUsage: { read: async () => new Map() } as never,
})("default", snapshot, false);
const tabOf = (answer: Json, pane: string, snapshot: Json) => {
  const tab = objects(snapshot.panes).find(p => p.pane_id === pane)!.tab_id;
  return objects(answer.groups).flatMap(group => objects(group.children)).find(child => child.id === tab)!;
};
const turn = (pane: string, terminal: string, events: Array<[string, Partial<Parameters<typeof noteTurn>[2]>?]>) =>
  events.reduce((previous, [event, extra]) => previous.then(() => noteTurn("default", pane, { event, terminal, source: "claude", session: sessions[pane], ...extra }).then(() => undefined)), Promise.resolve());

describe("session rows on a computer with background work and dispatched workers", () => {
  it("shows an idle tab whose Stop left background tasks as working, and names a dispatched worker by its label", async () => {
    const snapshot = structuredClone(recorded);
    const panes = objects(snapshot.panes);
    const byId = (id: string) => panes.find(p => p.pane_id === id)!;
    byId("w1P:p2").title = "Read and follow the brief in /home/a/bridge/briefs/x/brief.md";
    byId("w1S:p1").title = "Brief d35c6189";
    await turn("w1P:p1", String(byId("w1P:p1").terminal_id), [["UserPromptSubmit"], ["Stop", { background: 7 }]]);
    await turn("w1P:p2", String(byId("w1P:p2").terminal_id), [["UserPromptSubmit", { dispatch: dispatchId }], ["Stop", { background: 0 }]]);
    await turn("w13:p2", String(byId("w13:p2").terminal_id), [["UserPromptSubmit"], ["Stop", { background: 3 }], ["UserPromptSubmit"]]);
    await writeLaunchBrief({ id: dispatchId, text: "Do it" }, Date.now(), "parser checks");
    awaited[sessions["w1P:p1"]] = 3;

    const answer = await read(snapshot);
    const idleWithBackground = tabOf(answer, "w1P:p1", snapshot);
    // Of the Stop's 7, three shells are awaited; the running sub-agent adds one.
    expect(idleWithBackground).toMatchObject({ agentStatus: "working", backgroundTasks: 4, runningChildren: 1 });
    expect(idleWithBackground).not.toHaveProperty("currentStep");
    // A finished dispatched worker with nothing pending stays done, under its label.
    const worker = tabOf(answer, "w1P:p2", snapshot);
    expect(worker).toMatchObject({ agentStatus: "done", title: "parser checks" });
    expect(worker).not.toHaveProperty("backgroundTasks");
    // A new prompt after the Stop: the turn is live, its old count does not apply.
    expect(tabOf(answer, "w13:p2", snapshot)).not.toHaveProperty("backgroundTasks");
    // Codex subagents keep an idle Codex session working; the brief-id title falls back to the workspace label.
    const codex = tabOf(answer, "w1S:p1", snapshot);
    expect(codex).toMatchObject({ agentStatus: "working", backgroundTasks: 2, title: "worker" });
    expect(codex).not.toHaveProperty("currentStep");
  });

  it("does not keep a session working for shells left over from earlier exchanges", async () => {
    // plugin-builder on the Mini, 2026-09-29: 6 shells running, the turn done, nobody waiting.
    const snapshot = structuredClone(recorded);
    const pane = objects(snapshot.panes).find(p => p.pane_id === "w13:p2")!;
    pane.agent_status = "idle";
    objects(snapshot.tabs).find(tab => tab.tab_id === pane.tab_id)!.agent_status = "idle";
    await turn("w13:p2", String(pane.terminal_id), [["UserPromptSubmit"], ["Stop", { background: 6 }]]);
    awaited[sessions["w13:p2"]] = undefined;
    const tab = tabOf(await read(snapshot), "w13:p2", snapshot);
    expect(tab.agentStatus).not.toBe("working");
    expect(tab).not.toHaveProperty("backgroundTasks");
    // One build started since the owner's last prompt is still counted.
    awaited[sessions["w13:p2"]] = 1;
    expect(tabOf(await read(snapshot), "w13:p2", snapshot)).toMatchObject({ agentStatus: "working", backgroundTasks: 1 });
  });

  it("carries what a finished turn said last, and nothing while a turn runs", async () => {
    const snapshot = structuredClone(recorded);
    const pane = objects(snapshot.panes).find(p => p.pane_id === "w1P:p2")!;
    await turn("w1P:p2", String(pane.terminal_id), [["UserPromptSubmit"], ["Stop", { reply: "Tests pass. **Merge** it?" }]]);
    expect(tabOf(await read(snapshot), "w1P:p2", snapshot).lastReply).toBe("Tests pass. Merge it?");
    await turn("w1P:p2", String(pane.terminal_id), [["UserPromptSubmit"]]);
    expect(tabOf(await read(snapshot), "w1P:p2", snapshot)).not.toHaveProperty("lastReply");
  });

  it("carries each finished turn's final assistant entry in stream order, and none while a turn runs", async () => {
    const snapshot = structuredClone(recorded);
    const pane = objects(snapshot.panes).find(p => p.pane_id === "w1P:p2")!;
    const terminal = String(pane.terminal_id), at = Date.parse("2026-10-31T10:00:00Z");
    const folder = path.join(root, "claude", "projects", "project");
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, `${sessions["w1P:p2"]}.jsonl`);
    const row = (offset: number, type: string, text: string) => JSON.stringify({ type,
      timestamp: new Date(at + offset).toISOString(), message: { role: type, content: text,
        ...(type === "assistant" ? { stop_reason: "end_turn" } : {}) } }) + "\n";
    await writeFile(file, row(100, "user", "First prompt") + row(800, "assistant", "First answer")
      + JSON.stringify({ type: "progress" }) + "\n");
    await turn("w1P:p2", terminal, [["UserPromptSubmit", { at }]]);
    expect(tabOf(await read(snapshot), "w1P:p2", snapshot)).not.toHaveProperty("completion");
    await turn("w1P:p2", terminal, [["Stop", { at: at + 1_000, reply: "First answer" }]]);
    expect(tabOf(await read(snapshot), "w1P:p2", snapshot).completion).toEqual({ id: `${sessions["w1P:p2"]}:2`, at: new Date(at + 1_000).toISOString(), entry: "1" });
    expect((await new TranscriptReader(file, "claude").read()).entries).toContainEqual({ line: 1,
      raw: { type: "assistant", timestamp: new Date(at + 800).toISOString(), message: { role: "assistant", content: "First answer", stop_reason: "end_turn" } } });
    // A later row must not be attributed to the old Stop during a hook race.
    await appendFile(file, row(2_100, "user", "Second prompt") + row(2_800, "assistant", "Second answer"));
    expect(tabOf(await read(snapshot), "w1P:p2", snapshot).completion).toMatchObject({ entry: "1" });
    // A new prompt is unanswered, then the next Stop names a different completion.
    await turn("w1P:p2", terminal, [["UserPromptSubmit", { at: at + 2_000 }]]);
    expect(tabOf(await read(snapshot), "w1P:p2", snapshot)).not.toHaveProperty("completion");
    await turn("w1P:p2", terminal, [["Stop", { at: at + 3_000, reply: "Second answer" }]]);
    expect(tabOf(await read(snapshot), "w1P:p2", snapshot).completion).toEqual({ id: `${sessions["w1P:p2"]}:4`, at: new Date(at + 3_000).toISOString(), entry: "4" });
    // Another conversation in the same pane has its own id.
    const original = sessions["w1P:p2"], next = "00000005-1111-4111-8111-111111111111";
    try {
      sessions["w1P:p2"] = next;
      await turn("w1P:p2", terminal, [["UserPromptSubmit", { at: at + 4_000 }], ["Stop", { at: at + 5_000 }]]);
      expect(tabOf(await read(snapshot), "w1P:p2", snapshot).completion).toEqual({ id: `${next}:2`, at: new Date(at + 5_000).toISOString() });
    } finally { sessions["w1P:p2"] = original; }
  });

  it.each(["missing transcript", "no assistant row", "undated row", "undated final row", "earlier turn", "sidechain"])("keeps a completion manual for an unresolved entry: %s", async reason => {
    const snapshot = structuredClone(recorded);
    const pane = objects(snapshot.panes).find(p => p.pane_id === "w1P:p2")!;
    const at = Date.parse("2026-10-31T10:00:00Z");
    if (reason !== "missing transcript") {
      const folder = path.join(root, "claude", "projects", "project");
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, `${sessions["w1P:p2"]}.jsonl`), JSON.stringify({
        type: reason === "no assistant row" ? "user" : "assistant",
        ...(reason.startsWith("undated") ? {} : { timestamp: new Date(at + (reason === "earlier turn" ? -500 : 500)).toISOString() }),
        ...(reason === "sidechain" ? { isSidechain: true } : {}),
        message: { role: reason === "no assistant row" ? "user" : "assistant", content: "Visible text", stop_reason: "end_turn" },
      }) + "\n");
      if (reason === "undated final row") {
        const file = path.join(folder, `${sessions["w1P:p2"]}.jsonl`);
        await writeFile(file, JSON.stringify({ type: "assistant", timestamp: new Date(at + 500).toISOString(),
          message: { role: "assistant", content: "Earlier progress", stop_reason: "end_turn" } }) + "\n"
          + JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Final reply without a timestamp", stop_reason: "end_turn" } }) + "\n");
      }
    }
    await turn("w1P:p2", String(pane.terminal_id), [["UserPromptSubmit", { at }], ["Stop", { at: at + 1_000 }]]);
    expect(tabOf(await read(snapshot), "w1P:p2", snapshot).completion).toEqual({
      id: `${sessions["w1P:p2"]}:2`, at: new Date(at + 1_000).toISOString(),
    });
  });

  it.each([
    { authority: "Stop reply", reply: "Finished" },
    { authority: "terminal row marker", reply: undefined },
  ])("requires terminal evidence with $authority when progress and the delayed final reply have identical text", async ({ reply }) => {
    const snapshot = structuredClone(recorded);
    const pane = objects(snapshot.panes).find(p => p.pane_id === "w1P:p2")!;
    const at = Date.parse("2026-10-31T10:00:00Z");
    const folder = path.join(root, "claude", "projects", "project");
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, `${sessions["w1P:p2"]}.jsonl`);
    const row = (offset: number, text: string, final = false) => JSON.stringify({ type: "assistant",
      timestamp: new Date(at + offset).toISOString(), message: { role: "assistant", content: text, ...(final ? { stop_reason: "end_turn" } : {}) } }) + "\n";
    await writeFile(file, row(500, "Finished"));
    await turn("w1P:p2", String(pane.terminal_id), [["UserPromptSubmit", { at }], ["Stop", { at: at + 1_000, reply }]]);
    expect(tabOf(await read(snapshot), "w1P:p2", snapshot).completion).toEqual({
      id: `${sessions["w1P:p2"]}:2`, at: new Date(at + 1_000).toISOString(),
    });
    await appendFile(file, row(900, "Finished", true));
    expect(tabOf(await read(snapshot), "w1P:p2", snapshot).completion).toMatchObject({ entry: "1" });
  });

  it("preserves completion, seen state and existing metadata while transcript lookup stalls", async () => {
    const snapshot = structuredClone(recorded);
    const pane = objects(snapshot.panes).find(p => p.pane_id === "w1P:p2")!;
    pane.label = "My session";
    await turn("w1P:p2", String(pane.terminal_id), [["UserPromptSubmit"], ["Stop", { reply: "Finished" }]]);
    const id = `${sessions["w1P:p2"]}:2`;
    await markSessionSeen({ server: "default", pane: "w1P:p2", completion: id }, { snapshot: async () => snapshot });
    let started!: () => void, finish!: (file: string) => void;
    const lookupStarted = new Promise<void>(resolve => { started = resolve; });
    const lookup = new Promise<string>(resolve => { finish = resolve; });
    vi.spyOn(transcripts, "targetTranscriptPath").mockImplementationOnce(() => { started(); return lookup; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = read(snapshot);
    await lookupStarted;
    await vi.advanceTimersByTimeAsync(OVERVIEW_ENRICH_BUDGET_MS);
    const tab = tabOf(await pending, "w1P:p2", snapshot);
    expect(tab).toMatchObject({ completion: { id }, seenCompletion: id, title: "My session", lastReply: "Finished" });
    expect(tab.completion).not.toHaveProperty("entry");
    // Release the stalled lookup; its missing file is handled as unresolved.
    finish(path.join(root, "missing.jsonl"));
  });

  it("does not carry a completion for a Stop with no prompt before it", async () => {
    const snapshot = structuredClone(recorded);
    const pane = objects(snapshot.panes).find(p => p.pane_id === "w13:p2")!;
    await turn("w13:p2", String(pane.terminal_id), [["Stop"]]);
    expect(tabOf(await read(snapshot), "w13:p2", snapshot)).not.toHaveProperty("completion");
  });

  it("carries the completion a client marked seen", async () => {
    const snapshot = structuredClone(recorded);
    const pane = objects(snapshot.panes).find(p => p.pane_id === "w1P:p2")!;
    await turn("w1P:p2", String(pane.terminal_id), [["UserPromptSubmit"], ["Stop"]]);
    const completion = tabOf(await read(snapshot), "w1P:p2", snapshot).completion as { id: string; at: string };
    expect(completion.id).toBe(`${sessions["w1P:p2"]}:2`);
    expect(tabOf(await read(snapshot), "w1P:p2", snapshot)).not.toHaveProperty("seenCompletion");
    await markSessionSeen({ server: "default", pane: "w1P:p2", completion: completion.id }, { snapshot: async () => snapshot });
    expect(tabOf(await read(snapshot), "w1P:p2", snapshot).seenCompletion).toBe(completion.id);
  });

  it("shows a renamed session under its pane label, ahead of a dispatch label and the harness title", async () => {
    const snapshot = structuredClone(recorded);
    const pane = objects(snapshot.panes).find(p => p.pane_id === "w1P:p2")!;
    await turn("w1P:p2", String(pane.terminal_id), [["UserPromptSubmit", { dispatch: dispatchId }], ["Stop"]]);
    await writeLaunchBrief({ id: dispatchId, text: "Do it" }, Date.now(), "parser checks");
    expect(tabOf(await read(snapshot), "w1P:p2", snapshot).title).toBe("parser checks");
    pane.label = "Tide charts";
    const renamed = tabOf(await read(snapshot), "w1P:p2", snapshot);
    expect(renamed).toMatchObject({ title: "Tide charts", paneLabel: "Tide charts" });
    // Herdr's bare numbering is not a rename.
    pane.label = "2";
    expect(tabOf(await read(snapshot), "w1P:p2", snapshot).title).toBe("parser checks");
  });

  it("uses the tab or workspace label for a dispatch that has no stored label, and ignores another terminal's record", async () => {
    const snapshot = structuredClone(recorded);
    const pane = objects(snapshot.panes).find(p => p.pane_id === "w1P:p2")!;
    pane.title = "Read and follow the brief in /home/a/bridge/briefs/x/brief.md";
    await turn("w1P:p2", String(pane.terminal_id), [["UserPromptSubmit", { dispatch: dispatchId }], ["Stop"]]);
    expect(tabOf(await read(snapshot), "w1P:p2", snapshot).title).toBe("app");
    // The same pane after its terminal was replaced: the old record names nobody.
    const other = structuredClone(snapshot);
    objects(other.panes).find(p => p.pane_id === "w1P:p2")!.terminal_id = "term_other";
    await writeLaunchBrief({ id: dispatchId, text: "Do it" }, Date.now(), "parser checks");
    expect(tabOf(await read(other), "w1P:p2", other).title).toBe("app");
  });
});
