import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { AgentHooks } from "./agent-hooks.js";
import type { CodexQuestions } from "./questions.js";
import type { HookInfo } from "./server-routes.js";
import { transcriptStreams, type StreamContext } from "./server-stream.js";
import type { SideQuestions } from "./side-questions.js";
import { setTerminalProvider } from "./terminal.js";
import type { Json } from "./protocol.js";
import { PromptDeliveries } from "./prompt-deliveries.js";

class FakeClient extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  closed?: { code?: number; reason?: string };
  send(data: string) { this.sent.push(data); }
  frames(): Json[] { return this.sent.map(data => JSON.parse(data) as Json); }
  close(code?: number, reason?: string) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.closed = { code, reason }; this.readyState = WebSocket.CLOSED; this.emit("close");
  }
}

let root = "", restoreProvider: (() => void) | undefined, openClient: FakeClient | undefined;
const fixture = JSON.parse(readFileSync(new URL("../../fixtures/conformance/checkpoint-prompt-identity.json", import.meta.url), "utf8")) as {
  source: "claude"; session: string; rows: Json[]; entries: { line: number; type: string; promptEntryId?: string | null }[];
};
const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: fixture.source, session: fixture.session };
const pane = { pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab, agent: target.source, agent_status: "idle",
  terminal_id: "term-prompt-identity", cwd: root, foreground_cwd: root, agent_session: { kind: "id", agent: target.source, value: target.session } };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-prompt-stream-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", root);
  vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "bridge"));
  pane.cwd = pane.foreground_cwd = root;
  const project = path.join(root, "projects", "test");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, `${fixture.session}.jsonl`), fixture.rows.slice(0, 2).map(row => JSON.stringify(row)).join("\n") + "\n");
  restoreProvider = setTerminalProvider({
    kind: "fake", ping: async () => {}, snapshot: async () => ({ panes: [pane] }), listPanes: async () => [],
    processes: async () => ({ foregroundPids: [process.pid] }), readScreen: async () => "", sendKeys: async () => {},
    prompt: async () => {}, create: async () => undefined, startAgent: async () => {}, focusPane: async () => {},
    closePane: async () => {}, renamePane: async () => {}, groupAction: async () => {},
  });
});
afterEach(async () => {
  openClient?.close(1000); openClient = undefined;
  vi.unstubAllEnvs();
  restoreProvider?.(); restoreProvider = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

function streamContext(deliveries = new PromptDeliveries()): StreamContext {
  const hooks = {
    approval: () => undefined, passwordPrompt: () => false, compacting: () => false,
    watch: () => () => {}, syncTerminalDialog: async () => {}, servedQuestion: () => undefined, terminalPrompt: () => undefined,
    deliveries, changes: { view: () => undefined },
  };
  return {
    modules: { store: "", profile: "", modules: [], generation: "test", has: (name: string) => name === "hook" } as never,
    agentHooks: hooks as unknown as AgentHooks,
    codexQuestions: { pending: async () => [], availableFor: () => false } as unknown as CodexQuestions,
    sideQuestions: { list: () => [] } as unknown as SideQuestions,
    info: { modules: {}, store: "store", profile: "profile", generation: "test" } as unknown as HookInfo,
    activeCapabilities: {},
  };
}

it("carries prompt identities through backlog, a live append and an older page", async () => {
  const ctx = streamContext();
  const streams = transcriptStreams(ctx);
  const client = new FakeClient(); openClient = client;
  const query = new URLSearchParams({ server: target.server, workspace: target.workspace, tab: target.tab, pane: target.pane,
    source: target.source, session: target.session });
  await streams.stream(client, new URL(`http://phren.local/v1/transcripts?${query}`));
  const expected = (line: number) => fixture.entries.find(entry => entry.line === line)?.promptEntryId ?? null;
  const project = (entries: { line: number; promptEntryId?: string }[]) =>
    entries.map(entry => ({ line: entry.line, promptEntryId: entry.promptEntryId ?? null }));

  expect(project(client.frames()[0].entries as { line: number; promptEntryId?: string }[]))
    .toEqual([{ line: 0, promptEntryId: expected(0) }, { line: 1, promptEntryId: expected(1) }]);

  const transcript = path.join(root, "projects", "test", `${fixture.session}.jsonl`);
  await appendFile(transcript, fixture.rows.slice(2).map(row => JSON.stringify(row)).join("\n") + "\n");
  await vi.waitFor(() => expect(client.frames().some(frame => frame.type === "append")).toBe(true), { timeout: 3_000 });
  const append = client.frames().find(frame => frame.type === "append")!;
  expect(project(append.entries as { line: number; promptEntryId?: string }[]))
    .toEqual([{ line: 2, promptEntryId: expected(2) }, { line: 3, promptEntryId: expected(3) }, { line: 4, promptEntryId: expected(4) }]);
  expect((append.entries as { line: number }[]).find(entry => entry.line === 2)).not.toHaveProperty("promptEntryId");

  client.emit("message", Buffer.from(JSON.stringify({ type: "older", beforeLine: 2 })));
  await vi.waitFor(() => expect(client.frames().some(frame => frame.type === "older")).toBe(true), { timeout: 3_000 });
  const older = client.frames().find(frame => frame.type === "older")!;
  expect(project(older.entries as { line: number; promptEntryId?: string }[]))
    .toEqual([{ line: 0, promptEntryId: expected(0) }, { line: 1, promptEntryId: expected(1) }]);
  client.close(1000);
});

it.each([false, true])("resets a delivered prompt identity when a later append makes it ambiguous (disconnected: %s)", async disconnected => {
  const ctx = streamContext();
  const streams = transcriptStreams(ctx), client = new FakeClient(); openClient = client;
  const query = new URLSearchParams({ server: target.server, workspace: target.workspace, tab: target.tab, pane: target.pane,
    source: target.source, session: target.session });
  await streams.stream(client, new URL(`http://phren.local/v1/transcripts?${query}`));
  const shared = fixture.entries.find(entry => entry.line === 0)?.promptEntryId;
  expect(shared).toBeTruthy();
  expect((client.frames()[0].entries as { line: number; promptEntryId?: string }[]).find(entry => entry.line === 0)?.promptEntryId).toBe(shared);
  if (disconnected) client.close(1000);

  // The second prompt reuses the first prompt's native id.
  const rows = fixture.rows.map(row => ({ ...row })) as { promptId?: unknown; [key: string]: unknown }[];
  rows[3].promptId = rows[0].promptId; rows[3].uuid = "uuid-user-beta-duplicate";
  const transcript = path.join(root, "projects", "test", `${fixture.session}.jsonl`);
  await appendFile(transcript, rows.slice(2).map(row => JSON.stringify(row)).join("\n") + "\n");
  let receiving = client;
  if (disconnected) {
    receiving = new FakeClient(); openClient = receiving;
    query.set("afterLine", String(Number(client.frames()[0].totalLines) - 1));
    await streams.stream(receiving, new URL(`http://phren.local/v1/transcripts?${query}`));
  }
  const frames = () => disconnected ? [...client.frames(), ...receiving.frames()] : client.frames();
  await vi.waitFor(() => expect(frames().some((frame, index) => index > 0 && frame.type === "backlog" && frame.reset === true)).toBe(true), { timeout: 3_000 });

  const replacement = frames().find((frame, index) => index > 0 && frame.type === "backlog" && frame.reset === true)!;
  const replacementEntries = replacement.entries as { line: number; promptEntryId?: string }[];
  expect(replacementEntries.find(entry => entry.line === 0)).not.toHaveProperty("promptEntryId");
  expect(replacementEntries.find(entry => entry.line === 3)).not.toHaveProperty("promptEntryId");

  // Apply the frames as the client does: reset clears earlier associations.
  const state = new Map<number, string | undefined>();
  for (const frame of frames()) {
    if (frame.reset) state.clear();
    for (const entry of (frame.entries ?? []) as { line: number; promptEntryId?: string }[]) state.set(entry.line, entry.promptEntryId);
  }
  expect([...state.values()]).not.toContain(shared);
  receiving.close(1000);
});

it.each([false, true])("preserves queue bindings and independent prompt identities through an ambiguity reset (disconnected: %s)", async disconnected => {
  const deliveries = new PromptDeliveries(undefined, () => Date.parse("2026-01-02T03:04:09.000Z"));
  await deliveries.expect(target, "Queued request", 1, undefined, "phone-prompt-identity-01");
  deliveries.queue("phone-prompt-identity-01", target);
  await deliveries.bindClaudeQueueRows(target, []);
  const transcript = path.join(root, "projects", "test", `${fixture.session}.jsonl`);
  // A queue placeholder's promptId is not an eligible prompt identity and must
  // neither export one nor make the ordinary prompt with that id ambiguous.
  await appendFile(transcript, JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "Queued request",
    timestamp: "2026-01-02T03:04:09.000Z", sessionId: target.session, promptId: fixture.rows[0].promptId }) + "\n");
  const streams = transcriptStreams(streamContext(deliveries)), client = new FakeClient(); openClient = client;
  const query = new URLSearchParams(target);
  const url = () => new URL(`http://phren.local/v1/transcripts?${query}`);
  await streams.stream(client, url());
  expect(client.closed).toBeUndefined();
  const initial = client.frames()[0].entries as { line: number; promptEntryId?: string; raw: Json }[];
  expect(initial.find(entry => entry.line === 0)?.promptEntryId).toBe("claude:prompt:fixture-prompt-alpha");
  expect(initial.find(entry => entry.line === 2)).not.toHaveProperty("promptEntryId");
  expect(initial.find(entry => entry.line === 2)?.raw.phrenDeliveryId).toBe("phone-prompt-identity-01");
  if (disconnected) client.close(1000);
  const rows = fixture.rows.slice(2).map(row => ({ ...row }));
  rows[1].promptId = fixture.rows[0].promptId;
  await appendFile(transcript, [...rows,
    { type: "queue-operation", operation: "dequeue", sessionId: target.session },
    { type: "user", promptId: "fixture-queue-submitted", timestamp: "2026-01-02T03:04:10.000Z", sessionId: target.session,
      message: { role: "user", content: "Queued request" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  let receiving = client;
  if (disconnected) {
    receiving = new FakeClient(); openClient = receiving;
    query.set("afterLine", "2");
    await streams.stream(receiving, url());
  }
  const frames = () => receiving.frames().filter(frame => frame.type === "backlog" && frame.reset === true && frame.totalLines === 8);
  await vi.waitFor(() => expect(frames()).toHaveLength(1), { timeout: 3_000 });
  const entries = frames()[0].entries as { line: number; promptEntryId?: string; raw: Json }[];
  for (const line of [0, 4]) expect(entries.find(entry => entry.line === line)).not.toHaveProperty("promptEntryId");
  for (const line of [2, 6, 7]) expect(entries.find(entry => entry.line === line)?.raw.phrenDeliveryId).toBe("phone-prompt-identity-01");
  expect(entries.find(entry => entry.line === 7)?.promptEntryId).toBe("claude:prompt:fixture-queue-submitted");
  expect(entries.find(entry => entry.line === 5)?.promptEntryId).toBe("claude:prompt:fixture-prompt-gamma");
  receiving.emit("message", Buffer.from(JSON.stringify({ type: "older", beforeLine: 3 })));
  await vi.waitFor(() => expect(receiving.frames().some(frame => frame.type === "older")).toBe(true), { timeout: 3_000 });
  const older = receiving.frames().find(frame => frame.type === "older")!.entries as { line: number; promptEntryId?: string; raw: Json }[];
  expect(older.find(entry => entry.line === 0)).not.toHaveProperty("promptEntryId");
  expect(older.find(entry => entry.line === 2)?.raw.phrenDeliveryId).toBe("phone-prompt-identity-01");
  receiving.close(1000);
  await deliveries.flush();
});
