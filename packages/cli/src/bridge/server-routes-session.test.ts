import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

const { workspacesReader } = await import("./server-routes.js");
const { noteTurn } = await import("./turn-records.js");
const { writeLaunchBrief } = await import("./launch-brief.js");
const recorded = JSON.parse(readFileSync(new URL("./fixtures/herdr/0.9.1/snapshot.json", import.meta.url), "utf8")).result.snapshot as Json;

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-session-status-")); vi.stubEnv("PHREN_BRIDGE_HOME", root); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

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
    // m4l-builder on the Mini, 2026-09-29: 6 shells running, the turn done, nobody waiting.
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
