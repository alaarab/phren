import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import path from "node:path";
import { WebSocket } from "ws";
import { AgentHooks, agentHook } from "./agent-hooks.js";
import { FAST_HOOK_SOURCE } from "./hook-fast.js";
import { rpc, snapshot, validateTarget } from "./herdr.js";
import { paneStatus, resetPaneStatus } from "./pane-status.js";
import { objects, type Json, type Target } from "./protocol.js";
import { readTurn, turnPhase } from "./turn-records.js";
import * as transcripts from "./transcripts.js";
import { transcriptStreams } from "./server-stream.js";
import { workspacesReader } from "./server-routes.js";
import { activateModules } from "../modules/runtime.js";
import { checkpointRoute } from "./checkpoints.js";

// Only the terminal transport is faked. Both callback forwarders, the local
// endpoint, persisted records, transcript discovery/normalization and streams
// run their production code. Reconstructed Claude rows are complete JSONL.
vi.mock("./herdr.js", async original => ({ ...await original<typeof import("./herdr.js")>(),
  rpc: vi.fn(), snapshot: vi.fn(), validateTarget: vi.fn(), paneChatState: async () => ({ sessionId: session }),
}));
vi.mock("../modules/runtime.js", async original => ({ ...await original<typeof import("../modules/runtime.js")>(), activateModules: vi.fn() }));
let session = "01a0deac-2df6-7202-aef7-264f5484fbdd";
const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude", session };
const at = "2026-11-01T15:00:00.000Z", prompt = "Review the login link";
const owner = { type: "user", uuid: "u1", timestamp: at, message: { role: "user", content: prompt } };
const notice = { type: "user", uuid: "n1", timestamp: "2026-11-01T15:00:02.000Z", origin: { kind: "task-notification" }, message: { role: "user", content: "ordinary origin-only notification" } };
const monitor = '<task-notification>\n<task-id>bru2vhgmb</task-id>\n<summary>Monitor event: "Worker exits (fixes, reviews, spike)"</summary>\n<event>review-bug-loginlink exited: 0</event>\n</task-notification>';
const assistant = (text: string, final = false) => ({ type: "assistant", uuid: `a-${text}`, timestamp: "2026-11-01T15:00:03.000Z",
  message: { role: "assistant", content: [{ type: "text", text }], ...(final ? { stop_reason: "end_turn" } : {}) } });
class Client extends EventEmitter {
  constructor(readonly channel: string) { super(); }
  readyState = WebSocket.OPEN; bufferedAmount = 0; frames: Json[] = [];
  send(data: string) { const frame = JSON.parse(data); this.frames.push(frame); trace.push({ channel: this.channel, ...frame }); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
}
const exec = promisify(execFile);
const trace: Json[] = [];
describe.skipIf(process.platform === "win32")("Claude notification production replay", () => {
  let root: string, file: string, hooks: AgentHooks, pane: Json, screen: string, snapshotValue: Json;
  const clients: Client[] = [];
  let modules: ReturnType<typeof activateModules>;
  beforeEach(async () => {
    trace.length = 0;
    session = randomUUID(); target.session = session;
    root = await mkdtemp("/tmp/phren-notification-");
    vi.stubEnv("PHREN_BRIDGE_HOME", root); vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude"));
    vi.stubEnv("PHREN_HERDR_HOME", path.join(root, "herdr")); vi.stubEnv("HERDR_ENV", "1");
    vi.stubEnv("HERDR_SOCKET_PATH", path.join(root, "herdr/herdr.sock"));
    vi.stubEnv("HERDR_WORKSPACE_ID", "w1"); vi.stubEnv("HERDR_TAB_ID", "w1:t1"); vi.stubEnv("HERDR_PANE_ID", "w1:p1");
    vi.stubEnv("PHREN_DIALOG_THROTTLE_MS", "0");
    const repo = path.join(root, "repo"), checkout = path.join(root, "checkout");
    await mkdir(repo); await exec("git", ["init", repo]);
    await exec("git", ["-C", repo, "config", "user.name", "Fixture"]);
    await exec("git", ["-C", repo, "config", "user.email", "fixture@example.com"]);
    await exec("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-m", "fixture"]);
    await exec("git", ["-C", repo, "worktree", "add", "-b", "replay", checkout]);
    pane = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: "working", terminal_id: "term-1", foreground_cwd: checkout };
    snapshotValue = { panes: [pane], tabs: [{ workspace_id: "w1", tab_id: "w1:t1", agent_status: "idle" }], workspaces: [{ workspace_id: "w1", label: "fixture" }] };
    screen = `❯ ${prompt}\n⏺ The chat crash fix is\n❯`;
    vi.mocked(snapshot).mockReset().mockImplementation(async () => snapshotValue);
    vi.mocked(validateTarget).mockReset().mockImplementation(async () => pane);
    vi.mocked(rpc).mockReset().mockImplementation(async (_server, method) => {
      if (method === "pane.process_info") return { process_info: { foreground_processes: [{ pid: process.pid }] } };
      if (method === "agent.read") return { read: { text: screen } };
      throw new Error(`Unexpected RPC ${method}`);
    });
    modules = { has: (name: string) => name === "hook" || name === "git", modules: [], generation: "fixture" } as never;
    vi.mocked(activateModules).mockReturnValue(modules);
    hooks = new AgentHooks(undefined, modules); await hooks.start();
    const folder = path.join(root, "claude/projects/fixture"); await mkdir(folder, { recursive: true });
    file = path.join(folder, `${session}.jsonl`); await writeFile(file, JSON.stringify(owner) + "\n");
    await writeFile(path.join(root, "claude-hook.mjs"), FAST_HOOK_SOURCE);
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    hooks.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  async function forward(mode: string, value: Json) {
    const payload = { session_id: session, cwd: pane.foreground_cwd, ...value };
    if (mode === "full") {
      const stdin = vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { yield Buffer.from(JSON.stringify(payload)); });
      try { await agentHook("claude", () => 0); } finally { stdin.mockRestore(); }
    } else {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(root, "claude-hook.mjs"), "claude"], { env: { ...process.env } });
        let error = ""; child.stderr.on("data", chunk => { error += chunk; });
        child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(error)));
        child.stdin.end(JSON.stringify(payload));
      });
    }
    const record = await readTurn("default", "w1:p1");
    trace.push({ channel: "lifecycle", event: value.hook_event_name, prompt: record?.prompt, ...(record ? { phase: turnPhase(record).phase } : {}) });
  }
  async function append(row: Json) { await appendFile(file, JSON.stringify(row) + "\n"); }
  const query = () => new URLSearchParams(target).toString();
  async function open(pathname = "/v1/transcripts", suffix = "") {
    const client = new Client(pathname); clients.push(client);
    const streams = transcriptStreams({ modules, agentHooks: hooks, codexQuestions: { pending: async () => [], availableFor: () => false } as never, info: {} as never, activeCapabilities: {} });
    await streams.stream(client as never, new URL(`http://fixture${pathname}?${query()}${suffix}`)); return client;
  }
  async function overview() {
    const answer = await workspacesReader({ modules, agentHooks: hooks, info: {} as never,
      journal: { record: async () => {} } as never, contextUsage: { read: async () => new Map() } as never,
      tabActivity: { observe: async () => ({ generation: 0, stamps: new Map() }), recordStatus: async () => new Map() } as never,
    })("default", snapshotValue, false);
    const row = objects(objects(answer.groups)[0].children)[0];
    trace.push({ channel: "overview", ...row });
    return row;
  }
  it.each(["full", "fast"])("%s reconciles a callback delivered before its owner row", async mode => {
    await forward(mode, { hook_event_name: "UserPromptSubmit", prompt });
    await append(assistant("Old reply.", true)); await forward(mode, { hook_event_name: "Stop" });
    const before = (await readTurn("default", "w1:p1"))!;
    const text = "Review a second login link";
    const delivery = hooks.deliveries.expect(target, text, 0, undefined, "deferred-owner", "term-1");
    hooks.deliveries.queue("deferred-owner", target);
    await forward(mode, { hook_event_name: "UserPromptSubmit", prompt: text });
    expect((await readTurn("default", "w1:p1"))!.prompt).toEqual(before.prompt);
    expect(hooks.deliveries.status("deferred-owner", target).state).toBe("queued");
    screen = `❯ ${text}\n⏺ New foreground reply\n❯`;
    const stream = await open();
    await append({ ...owner, uuid: "u2", timestamp: new Date().toISOString(), message: { role: "user", content: text } });
    await vi.waitFor(async () => expect(turnPhase((await readTurn("default", "w1:p1"))!).phase).toBe("working"), { timeout: 2500 });
    await vi.waitFor(() => expect(stream.frames.some(frame => (frame.preview as Json)?.text === "New foreground reply")).toBe(true), { timeout: 2500 });
    expect((await readTurn("default", "w1:p1"))!.prompt!.seq).toBeGreaterThan(before.stop!.seq);
    expect(hooks.deliveries.status("deferred-owner", target).state).toBe("delivered");
    expect(await overview()).toMatchObject({ agentStatus: "working" }); await delivery;
    // A deferred notification must retain this new owner, even with ordinary text.
    const current = (await readTurn("default", "w1:p1"))!.prompt;
    await forward(mode, { hook_event_name: "UserPromptSubmit", prompt: "late automatic input" });
    await append({ ...notice, uuid: "late-notice", message: { role: "user", content: "late automatic input" } });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect((await readTurn("default", "w1:p1"))!.prompt).toEqual(current);
    await writeFile(`/tmp/previewflap-deferred-${mode}.json`, JSON.stringify({ reconstructed: true, frames: trace }, null, 2));
  });
  it("keeps a later deferred owner when the first owner resolves", async () => {
    await forward("full", { hook_event_name: "UserPromptSubmit", prompt });
    await forward("full", { hook_event_name: "Stop" });
    const before = (await readTurn(target.server, target.pane))!.prompt;
    const first = "Review the first queued login link", second = "Review the second queued login link";
    for (const [id, text] of [["overlapping-first", first], ["overlapping-second", second]]) {
      void hooks.deliveries.expect(target, text, 0, undefined, id, "term-1");
      hooks.deliveries.queue(id, target);
    }
    // Both callbacks precede their transcript rows and share the old anchor.
    await forward("full", { hook_event_name: "UserPromptSubmit", prompt: first });
    const firstSeq = (await readTurn(target.server, target.pane))!.seq;
    await forward("full", { hook_event_name: "Stop" });
    await forward("full", { hook_event_name: "UserPromptSubmit", prompt: second });
    const secondSeq = (await readTurn(target.server, target.pane))!.seq;
    expect((await readTurn(target.server, target.pane))!.prompt).toEqual(before);
    await append({ ...owner, uuid: "overlapping-first", timestamp: new Date().toISOString(), message: { role: "user", content: first } });
    await vi.waitFor(async () => {
      expect((await readTurn(target.server, target.pane))!.prompt!.seq).toBe(firstSeq);
      expect(hooks.deliveries.status("overlapping-first", target).state).toBe("delivered");
    });
    expect(turnPhase((await readTurn(target.server, target.pane))!).phase).toBe("ended");
    expect(hooks.deliveries.status("overlapping-second", target).state).toBe("queued");
    await append({ ...owner, uuid: "overlapping-second", timestamp: new Date().toISOString(), message: { role: "user", content: second } });
    await vi.waitFor(async () => {
      expect((await readTurn(target.server, target.pane))!.prompt!.seq).toBe(secondSeq);
      expect(hooks.deliveries.status("overlapping-second", target).state).toBe("delivered");
    });
    expect(turnPhase((await readTurn(target.server, target.pane))!).phase).toBe("working");
    pane.agent_status = "idle";
    expect((await open("/v1/status")).frames[0].agentStatus).toMatchObject({ status: "working" });
    expect(await overview()).toMatchObject({ agentStatus: "working" });
  });
  it("keeps a Stop after a deferred callback authoritative when the row lands late", async () => {
    await forward("full", { hook_event_name: "UserPromptSubmit", prompt });
    await forward("full", { hook_event_name: "Stop" });
    const text = "A turn that aborts before its row lands";
    await forward("full", { hook_event_name: "UserPromptSubmit", prompt: text });
    await forward("full", { hook_event_name: "Stop" });
    const stopped = (await readTurn("default", "w1:p1"))!;
    await append({ ...owner, uuid: "aborted", timestamp: new Date().toISOString(), message: { role: "user", content: text } });
    await vi.waitFor(async () => expect((await readTurn("default", "w1:p1"))!.prompt!.seq).toBeGreaterThan(stopped.prompt!.seq));
    const resolved = (await readTurn("default", "w1:p1"))!;
    expect(resolved.prompt!.seq).toBeLessThan(resolved.stop!.seq);
    expect(turnPhase(resolved).phase).toBe("ended");
    screen = `❯ ${text}\n⏺ This aborted turn must not preview\n❯`;
    expect((await open()).frames[0]).not.toHaveProperty("preview");
    expect((await open("/v1/status")).frames[0].agentStatus).toMatchObject({ status: "idle" });
  });
  it("streams foreground output while child enrichment never answers", async () => {
    await forward("full", { hook_event_name: "UserPromptSubmit", prompt });
    vi.spyOn(transcripts, "childAgentTree").mockImplementation(() => new Promise(() => {}));
    pane.agent_status = "idle";
    const limit = new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("transcript blocked on children")), 1500); timer.unref(); });
    const stream = await Promise.race([open(), limit]);
    expect(stream.frames[0].preview).toMatchObject({ text: "The chat crash fix is" });
    await append({ type: "assistant", uuid: "progress", message: { role: "assistant", content: [{ type: "tool_use", id: "progress", name: "Bash", input: { command: "read reviews" } }] } });
    await vi.waitFor(() => expect(stream.frames.some(frame => frame.type === "append")).toBe(true), { timeout: 1500 });
    expect((await open("/v1/status")).frames[0].agentStatus).toMatchObject({ status: "working" });
    screen = "Bash command\n\n  ls\n\nDo you want to proceed?\n ❯ 1. Yes\n   2. No\nEsc to cancel · Tab to amend";
    const ask = forward("full", { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
    await vi.waitFor(() => expect(hooks.approval(target)).toBeDefined());
    expect((await open("/v1/status")).frames[0].agentStatus).toMatchObject({ status: "waiting" });
    await hooks.answer(target, String(hooks.approval(target)!.actionId), "deny");
    await ask;
    await writeFile("/tmp/previewflap-stalled-enrichment.json", JSON.stringify({ reconstructed: true, frames: trace }, null, 2));
  });
  it("ignores a background end_turn and its Stop while foreground previews grow", async () => {
    await forward("full", { hook_event_name: "UserPromptSubmit", prompt });
    const stream = await open();
    await append({ ...assistant("Background final reply.", true), origin: { kind: "task-notification" }, executionId: "background-final" });
    await forward("fast", { hook_event_name: "Stop", execution_id: "background-final", last_assistant_message: "Background final reply." });
    await vi.waitFor(() => expect(stream.frames.some(frame => frame.type === "append")).toBe(true));
    expect(stream.frames.some(frame => frame.preview === null)).toBe(false);
    const bg = stream.frames.flatMap(frame => objects(frame.entries)).find(entry => (entry.raw as Json).phrenExecution === "background");
    expect(bg).toBeDefined(); expect(JSON.stringify(bg)).not.toContain("origin");
    screen = `❯ ${prompt}\n⏺ The chat crash fix is still growing\n❯`;
    await vi.waitFor(() => expect(stream.frames.some(frame => (frame.preview as Json)?.text === "The chat crash fix is still growing")).toBe(true), { timeout: 2000 });
    expect(turnPhase((await readTurn("default", "w1:p1"))!).phase).toBe("working");
    await append(assistant("Foreground final reply.", true)); await forward("full", { hook_event_name: "Stop" });
    await vi.waitFor(() => expect(stream.frames.at(-1)?.preview).toBe(null));
    await writeFile("/tmp/previewflap-background-final.json", JSON.stringify({ reconstructed: true, frames: trace }, null, 2));
  });
  it.each(["", "&afterLine=80"])("recovers retirement outside the opening page (%s)", async suffix => {
    await forward("full", { hook_event_name: "UserPromptSubmit", prompt });
    await append(assistant("Retired block A."));
    for (let i = 0; i < 85; i++) await append({ type: "assistant", uuid: `retirement-${i}`, message: { role: "assistant", content: [{ type: "tool_use", id: `retirement-${i}`, name: "Bash", input: { command: "continue" } }] } });
    screen = `❯ ${prompt}\n⏺ Retired block A.\n❯`;
    const stream = await open("/v1/transcripts", suffix);
    expect(stream.frames[0]).not.toHaveProperty("preview");
    expect(stream.frames[0].entries).not.toContainEqual(expect.objectContaining({ raw: expect.objectContaining({ uuid: "a-Retired block A." }) }));
    screen = `❯ ${prompt}\n⏺ Genuine block B grows\n❯`;
    await vi.waitFor(() => expect(stream.frames.some(frame => (frame.preview as Json)?.text === "Genuine block B grows")).toBe(true), { timeout: 2000 });
    expect(stream.frames.every(frame => (frame.preview as Json)?.text !== "Retired block A.")).toBe(true);
    await writeFile(`/tmp/previewflap-retirement-${suffix ? "cursor" : "opening"}.json`, JSON.stringify({ reconstructed: true, frames: trace }, null, 2));
  });
  it.each(["full", "fast"])("%s forwarder preserves generation, deliveries, checkpoints and replyless final Stop", async mode => {
    await forward(mode, { hook_event_name: "UserPromptSubmit", prompt });
    const initial = (await readTurn("default", "w1:p1"))!;
    const checkpoints = () => checkpointRoute(String(pane.foreground_cwd), target, "list", {}, async () => pane);
    const before = await checkpoints();
    expect((before as Json).checkpoints).toHaveLength(1);
    await writeFile(path.join(String(pane.foreground_cwd), "changed.txt"), "Do not checkpoint a notification");
    const pending = hooks.deliveries.expect(target, notice.message.content, 0, undefined, "unrelated-delivery", "term-1");
    hooks.deliveries.queue("unrelated-delivery", target);
    // Origin deliberately absent from hook payload: verified tail correlation
    // must classify this matching row, rather than accepting ordinary text.
    await append(notice); await forward(mode, { hook_event_name: "UserPromptSubmit", prompt: notice.message.content });
    expect((await readTurn("default", "w1:p1"))!.prompt).toEqual(initial.prompt);
    expect(hooks.deliveries.status("unrelated-delivery", target)).toMatchObject({ state: "queued" });
    for (const row of [
      { type: "attachment", attachment: { type: "queued_command", commandMode: "task-notification", prompt: "queued automatic input" } },
      { ...notice, message: { role: "user", content: `[SYSTEM NOTIFICATION - NOT USER INPUT]\nPRIVATE system payload` } },
      { ...notice, origin: { kind: "auto-continuation" }, message: { role: "user", content: "Continue automatically" } },
    ]) {
      await append(row);
      await forward(mode, { hook_event_name: "UserPromptSubmit", prompt: row.type === "attachment" ? row.attachment!.prompt : row.message!.content });
      expect((await readTurn("default", "w1:p1"))!.prompt).toEqual(initial.prompt);
    }
    expect(await checkpoints()).toEqual(before);
    await forward(mode, { hook_event_name: "UserPromptSubmit", prompt: "unresolved ordinary text" });
    expect((await readTurn("default", "w1:p1"))!.prompt).toEqual(initial.prompt);
    // Available origin must also survive either forwarder with no matching row.
    await forward(mode, { hook_event_name: "UserPromptSubmit", prompt: "not yet in transcript", origin: { kind: "task-notification" } });
    expect((await readTurn("default", "w1:p1"))!.prompt).toEqual(initial.prompt);
    await forward(mode, { hook_event_name: "Stop", origin: { kind: "task-notification" }, last_assistant_message: "background reply" });
    expect(turnPhase((await readTurn("default", "w1:p1"))!).phase).toBe("working");
    resetPaneStatus(); expect(await paneStatus("default", "w1:p1", "term-1")).toMatchObject({ status: "working" });
    // A Stop can also be correlated by execution id to raw assistant provenance.
    await append({ ...assistant("background execution output"), origin: { kind: "task-notification" }, executionId: "bg-execution" });
    await forward(mode, { hook_event_name: "Stop", execution_id: "bg-execution", last_assistant_message: "background execution output" });
    expect(turnPhase((await readTurn("default", "w1:p1"))!).phase).toBe("working");
    // A genuine abort/final Stop needs no reply, even directly after a notice.
    await forward(mode, { hook_event_name: "Stop" });
    expect(turnPhase((await readTurn("default", "w1:p1"))!).phase).toBe("ended");
    hooks.deliveries.fail("unrelated-delivery", target, "fixture cleanup"); await pending;
  });
  it("replays redraws, notification bursts, atomic landing and stale status through reader/stream/overview", async () => {
    await forward("full", { hook_event_name: "UserPromptSubmit", prompt });
    const transcript = await open();
    expect(transcript.frames[0].preview).toEqual({ turnStartedAt: at, text: "The chat crash fix is" });
    // Each real socket's first page drives TranscriptReader -> observe -> update;
    // keep a continuous stream below to exercise continuity across redraws.
    const tick = async (expected?: string) => {
      const before = transcript.frames.length;
      await vi.waitFor(() => expect(transcript.frames.length).toBeGreaterThan(before), { timeout: 2000 });
      const frames = transcript.frames.slice(before);
      if (expected) expect(frames.some(frame => (frame.preview as Json)?.text === expected)).toBe(true);
    };
    screen = `❯ ${prompt}\n⏺ The chat crash fix is in review.\n❯`; await tick("The chat crash fix is in review.");
    for (const row of [notice, { ...notice, uuid: "n2", message: { role: "user", content: monitor } },
      { ...notice, uuid: "n3", message: { role: "user", content: `<system-reminder>${monitor}</system-reminder>` } }]) {
      await append(row); await forward("fast", { hook_event_name: "UserPromptSubmit", prompt: row.message.content });
    }
    pane.agent_status = "idle";
    const status = await open("/v1/status"); expect((status.frames[0].agentStatus as Json).status).toBe("working");
    expect(await overview()).toMatchObject({ agentStatus: "working" });
    expect((await readTurn("default", "w1:p1"))!.stop).toBeUndefined();
    const frameCount = transcript.frames.length;
    screen = `❯ ${prompt}\n⏺ Monitor event: Worker exits\n❯`;
    await new Promise(resolve => setTimeout(resolve, 550));
    screen = `❯ ${prompt}\n⏺ The chat crash fix\n❯`;
    await new Promise(resolve => setTimeout(resolve, 550));
    expect(transcript.frames.slice(frameCount).filter(frame => "preview" in frame)).toEqual([]);
    pane.agent_status = "working";
    screen = `❯ ${prompt}\n⏺ The chat crash fix is in review. More soon.\n❯`; await tick("The chat crash fix is in review. More soon.");
    await append(assistant("The chat crash fix is in review. More soon."));
    await tick();
    expect(transcript.frames.at(-1)).toMatchObject({ type: "append", preview: null, reset: false });
    screen = `❯ ${prompt}\n⏺ A later genuine block\n❯`; await tick("A later genuine block");
    const count = transcript.frames.length;
    screen = `❯ ${prompt}\n⏺ The chat crash fix is in review. More soon.\n❯`;
    await new Promise(resolve => setTimeout(resolve, 550));
    expect(transcript.frames.length).toBe(count);
    await append(assistant("Final answer.", true)); await forward("full", { hook_event_name: "Stop" }); await tick();
    expect(transcript.frames.at(-1)).toMatchObject({ type: "append", preview: null, reset: false });
    expect(await overview()).toMatchObject({ agentStatus: "idle" });
    expect((await open("/v1/status")).frames[0].agentStatus).toMatchObject({ status: "idle" });
    await writeFile("/tmp/previewflap-replay.json", JSON.stringify({ reconstructed: true, frames: trace }, null, 2));
  });
  it("holds a real dialog without retiring an accepted preview", async () => {
    await forward("full", { hook_event_name: "UserPromptSubmit", prompt });
    const transcript = await open();
    screen = "Bash command\n\n  ls\n\nDo you want to proceed?\n ❯ 1. Yes\n   2. No\nEsc to cancel · Tab to amend";
    // The dialog reader's bounded cache expires independently of stream ticks.
    const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now + 4000);
    try {
      expect((await open("/v1/status")).frames[0].agentStatus).toMatchObject({ status: "blocked" });
      expect(await overview()).toMatchObject({ agentStatus: "blocked" });
    } finally { clock.mockRestore(); }
    await append({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", id: "dialog-tool", input: { command: "ls" } }] } });
    await vi.waitFor(() => expect(transcript.frames.length).toBeGreaterThan(1));
    expect(transcript.frames.slice(1).some(frame => frame.preview === null)).toBe(false);
  });
  it("uses running children for stream and overview after the foreground Stop", async () => {
    await forward("full", { hook_event_name: "UserPromptSubmit", prompt });
    await append({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "launch1", name: "Agent", input: { description: "review", prompt: "Review", run_in_background: true } }] } });
    await append({ type: "user", toolUseResult: { agentId: "child1", status: "running", isAsync: true }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "launch1", content: "started" }] } });
    const folder = path.join(path.dirname(file), session, "subagents"); await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "agent-child1.jsonl"), JSON.stringify({ type: "user", sessionId: session, agentId: "child1", isSidechain: true, timestamp: new Date().toISOString(), message: { role: "user", content: "Review" } }) + "\n");
    await append(assistant("Foreground done.", true));
    await forward("fast", { hook_event_name: "Stop", background_tasks: [{ id: "child1", status: "running" }] });
    pane.agent_status = "idle";
    expect((await open("/v1/status")).frames[0].agentStatus).toMatchObject({ status: "working" });
    expect(await overview()).toMatchObject({ agentStatus: "working", runningChildren: 1 });
    expect((await open()).frames[0]).not.toHaveProperty("preview", expect.objectContaining({ text: expect.any(String) }));
  });
  it.each(["full", "fast"])("%s preserves image-only and genuine queued owner boundaries", async mode => {
    await forward(mode, { hook_event_name: "UserPromptSubmit", prompt });
    const first = (await readTurn("default", "w1:p1"))!.prompt!;
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } };
    await append({ type: "user", uuid: "image", timestamp: new Date().toISOString(), message: { role: "user", content: [image] } });
    await forward(mode, { hook_event_name: "UserPromptSubmit", prompt: "", content: [image] });
    expect((await readTurn("default", "w1:p1"))!.prompt!.seq).toBeGreaterThan(first.seq);
    await append({ type: "attachment", attachment: { type: "queued_command", commandMode: "prompt", prompt: "genuine queued owner" } });
    await forward(mode, { hook_event_name: "UserPromptSubmit", prompt: "genuine queued owner" });
    expect((await readTurn("default", "w1:p1"))!.prompt!.seq).toBeGreaterThan(first.seq + 1);
  });
  it.each(["", "&afterLine=85"])("does not recover an older text anchor after image-only owner input (%s)", async suffix => {
    await forward("full", { hook_event_name: "UserPromptSubmit", prompt });
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } };
    await append({ type: "user", uuid: "image", timestamp: "2026-11-01T15:00:04.000Z", message: { role: "user", content: [image] } });
    await forward("full", { hook_event_name: "UserPromptSubmit", prompt: "", content: [image] });
    for (let i = 0; i < 85; i++) await append({ type: "assistant", uuid: `image-tool-${i}`, message: { role: "assistant",
      content: [{ type: "tool_use", id: `image-tool-${i}`, name: "Bash", input: { command: "inspect screenshot" } }], stop_reason: "tool_use" } });
    expect((await open("/v1/transcripts", suffix)).frames[0]).not.toHaveProperty("preview");
  });
  it.each(["", "&afterLine=80"])("recovers the verified owner outside the opening page (%s)", async suffix => {
    await forward("full", { hook_event_name: "UserPromptSubmit", prompt });
    for (let i = 0; i < 85; i++) await append({ type: "assistant", uuid: `t-${i}`, timestamp: at,
      message: { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: "read reviews" } }], stop_reason: "tool_use" } });
    await append(notice);
    const stream = await open("/v1/transcripts", suffix);
    expect(stream.frames[0].preview).toEqual({ turnStartedAt: at, text: "The chat crash fix is" });
    expect(stream.frames[0].entries).not.toContainEqual(expect.objectContaining({ raw: expect.objectContaining({ uuid: "u1" }) }));
    await append({ ...notice, uuid: "more", message: { role: "user", content: "<task-notification><task-id>task1</task-id><tool-use-id>tool1</tool-use-id><status>completed</status><summary>Background command completed</summary></task-notification>" } });
    await vi.waitFor(() => expect(stream.frames.length).toBeGreaterThan(1));
    expect(stream.frames[1]).toMatchObject({ type: "append", reset: false });
    expect(stream.frames[1]).not.toHaveProperty("preview");
    // A replacement with no classified owner must not use an arbitrary screen prompt.
    await writeFile(file, JSON.stringify(notice) + "\n");
    screen = "❯ Arbitrary screen prompt\n⏺ Unverified reply\n❯";
    const unanchored = await open("/v1/transcripts", suffix);
    expect(unanchored.frames[0]).not.toHaveProperty("preview");
  });
});
