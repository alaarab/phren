import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentHooks } from "./agent-hooks.js";
import { validateTarget } from "./herdr.js";
import { registerPaneServer, type OpenCodePermission, type OpenCodeQuestion, type PaneClient, type PaneEvent, type PaneServerEntry, type PromptOptions } from "./opencode-pane-server.js";
import {
  listensOn, paneKey, paneServersDir, PaneServerWatcher, prepareServedLaunch, registerServedPane, sendServedPrompt, servedPane,
  setPaneClientFactory, showSession, type PaneAsks,
} from "./opencode-panes.js";
import type { Target } from "./protocol.js";
import type { ApprovalPushService } from "./push.js";
import { paneRoute } from "./server-pane-routes.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(),
  validateTarget: vi.fn(async () => ({ agent_status: "idle" })),
}));

const DIRECTORY = "/tmp/phren-served";
const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "opencode", session: "ses_root" };

/** An OpenCode pane server held in memory: what the Hook asked of it. */
function fakeServer() {
  const state = {
    sessions: new Map<string, { id: string; parentID?: string }>([["ses_root", { id: "ses_root" }], ["ses_child", { id: "ses_child", parentID: "ses_root" }]]),
    permissions: [] as OpenCodePermission[], questions: [] as OpenCodeQuestion[],
    prompts: [] as Array<{ session: string; text: string; options?: PromptOptions }>,
    replies: [] as Array<[string, string]>, answers: [] as Array<[string, string[][]]>, rejected: [] as string[], aborted: [] as string[],
    selected: [] as string[], created: 0, deliver: true, ready: true,
    events: [] as PaneEvent[], wake: () => {},
  };
  const client: PaneClient = {
    ready: async () => state.ready,
    sessions: async () => [...state.sessions.values()],
    session: async id => state.sessions.get(id),
    currentSession: async () => state.sessions.get("ses_root"),
    createSession: async () => { const id = `ses_new${++state.created}`; state.sessions.set(id, { id }); return { id }; },
    selectSession: async id => { state.selected.push(id); },
    prompt: async (session, text, options) => { state.prompts.push({ session, text, options }); return state.deliver ? { delivered: true, messageId: "msg_1" } : { delivered: false, reason: "timeout" }; },
    permissions: async () => state.permissions,
    replyPermission: async (id, reply) => { state.replies.push([id, reply]); state.permissions = state.permissions.filter(ask => ask.id !== id); },
    questions: async () => state.questions,
    replyQuestion: async (id, answers) => { state.answers.push([id, answers]); state.questions = state.questions.filter(ask => ask.id !== id); },
    rejectQuestion: async id => { state.rejected.push(id); state.questions = state.questions.filter(ask => ask.id !== id); },
    abort: async session => { state.aborted.push(session); return true; },
    async *events(signal) {
      yield { type: "server.connected" };
      while (!signal?.aborted) {
        const next = state.events.shift();
        if (next) { yield next; continue; }
        await new Promise<void>(resolve => { state.wake = resolve; signal?.addEventListener("abort", () => resolve(), { once: true }); });
      }
    },
  };
  return { state, client, push(event: PaneEvent) { state.events.push(event); state.wake(); } };
}

function fakePush() {
  const sent: Array<{ binding: string; provider: string; request?: string }> = [];
  return { sent, service: { available: true, notify: vi.fn(async (value: { binding: string; provider: string; request?: string }) => { sent.push(value); return true; }),
    notifyFanoutBlocked: vi.fn(async () => true) } as unknown as ApprovalPushService };
}

const until = async (check: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
};

let bridge: string, restoreClient: () => void, restoreTerminal: () => void, server: ReturnType<typeof fakeServer>;
let screen: string, screenReads: number, typed: string[], keys: string[][];

function entry(overrides: Partial<PaneServerEntry> = {}): PaneServerEntry {
  return { server: "default", pane: "w1:p1", port: 4567, password: "pw", pid: process.pid, directory: DIRECTORY, createdAt: new Date().toISOString(), ...overrides };
}

beforeEach(async () => {
  vi.clearAllMocks();
  bridge = await mkdtemp(path.join(tmpdir(), "phren-served-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", bridge);
  server = fakeServer();
  restoreClient = setPaneClientFactory(() => server.client);
  screen = ""; screenReads = 0; typed = []; keys = [];
  restoreTerminal = setTerminalProvider({
    snapshot: async () => ({ panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "opencode", agent_status: "idle",
      agent_session: { kind: "id", agent: "opencode", value: "ses_root" } }] }),
    processes: async () => ({ foregroundPids: [process.pid] }),
    readScreen: async () => { screenReads++; return screen; },
    prompt: async (_server: string, _pane: string, text: string) => { typed.push(text); },
    sendKeys: async (_server: string, _pane: string, sent: string[]) => { keys.push(sent); },
  } as unknown as TerminalProvider);
});
afterEach(async () => {
  restoreClient(); restoreTerminal(); vi.unstubAllEnvs();
  await rm(bridge, { recursive: true, force: true });
});

describe("launch", () => {
  it("gives each launch its own port, password and pane variables", async () => {
    const launch = await prepareServedLaunch();
    expect(launch.args).toEqual(["--port", String(launch.port)]);
    expect(launch.env).toEqual({ OPENCODE_SERVER_PASSWORD: launch.password, PHREN_OPENCODE_PORT: String(launch.port) });
    expect(launch.password).not.toBe((await prepareServedLaunch()).password);
  });

  it("matches only an OpenCode command line carrying that exact port", () => {
    expect(listensOn("/usr/bin/opencode --model x --port 4567", 4567)).toBe(true);
    expect(listensOn("opencode --port=4567", 4567)).toBe(true);
    expect(listensOn("opencode --port 45678", 4567)).toBe(false);
    expect(listensOn("node server.js --port 4567", 4567)).toBe(false);
  });

  it("registers the pane's own OpenCode process once its server answers", async () => {
    const launch = { port: 4567, password: "pw", args: [], env: {} };
    const table = async () => [{ pid: 1, command: "opencode --port 4567" }, { pid: process.pid, command: "opencode --port 4567" }];
    const registered = await registerServedPane("default", "w1:p1", DIRECTORY, launch, { table, defaults: { model: "a/b" } });
    expect(registered).toMatchObject({ server: "default", pane: "w1:p1", port: 4567, pid: process.pid, directory: DIRECTORY, defaults: { model: "a/b" } });
    expect(servedPane("default", "w1:p1")).toEqual(registered);
    expect(paneServersDir()).toBe(path.join(bridge, "opencode-panes"));
  });

  it("leaves a pane unregistered when its server never answers", async () => {
    server.state.ready = false;
    const table = async () => [{ pid: process.pid, command: "opencode --port 4567" }];
    expect(await registerServedPane("default", "w1:p1", DIRECTORY, { port: 4567, password: "pw", args: [], env: {} }, { table, readyMs: 300 })).toBeUndefined();
    expect(servedPane("default", "w1:p1")).toBeUndefined();
  });
});

describe("prompts", () => {
  it("sends into a root session and continues its last turn's settings", async () => {
    expect(await sendServedPrompt(entry(), "ses_root", "hello")).toEqual({ sent: true, delivered: true, session: "ses_root" });
    expect(server.state.prompts).toEqual([{ session: "ses_root", text: "hello", options: { inherit: true } }]);
    expect(server.state.selected).toEqual([]);
  });

  it("refuses a subagent's or unknown session without sending", async () => {
    expect(await sendServedPrompt(entry(), "ses_child", "hello")).toMatchObject({ sent: false });
    expect(await sendServedPrompt(entry(), "ses_gone", "hello")).toMatchObject({ sent: false });
    expect(server.state.prompts).toEqual([]);
  });

  it("starts a new session with the launch's settings and shows it in the TUI", async () => {
    screen = "┃  Read the brief";
    const sent = await sendServedPrompt(entry({ defaults: { agent: "conductor", model: "a/b", variant: "high" } }), undefined, "Read the brief\nand more");
    expect(sent).toEqual({ sent: true, delivered: true, session: "ses_new1" });
    expect(server.state.prompts[0]).toEqual({ session: "ses_new1", text: "Read the brief\nand more", options: { agent: "conductor", model: "a/b", variant: "high" } });
    expect(server.state.selected).toEqual(["ses_new1"]);
  });

  it("keeps the session it showed for a pane whose conversation is not named yet", async () => {
    screen = "┃  first";
    const pane = entry({ pane: "w1:p7" });
    expect(await sendServedPrompt(pane, undefined, "first")).toMatchObject({ sent: true, session: "ses_new1" });
    expect(await sendServedPrompt(pane, undefined, "second")).toMatchObject({ sent: true, session: "ses_new1" });
    expect(server.state.prompts.map(prompt => [prompt.session, prompt.options])).toEqual([["ses_new1", {}], ["ses_new1", { inherit: true }]]);
    expect(server.state.selected).toEqual(["ses_new1"]);
    // Gone from the server (deleted in the TUI): a new one is made and shown.
    server.state.sessions.delete("ses_new1");
    screen = "┃  third";
    expect(await sendServedPrompt(pane, undefined, "third")).toMatchObject({ sent: true, session: "ses_new2" });
    expect(server.state.selected).toEqual(["ses_new1", "ses_new2"]);
  });

  it("asks a starting TUI to show the session again until the pane draws it", async () => {
    let looks = 0;
    const shown = await showSession(entry(), server.client, "ses_root", "hello", { intervalMs: 5, shows: async () => ++looks >= 3 });
    expect(shown).toBe(true);
    expect(server.state.selected).toEqual(["ses_root", "ses_root", "ses_root"]);
    expect(await showSession(entry(), server.client, "ses_root", "hello", { intervalMs: 5, timeoutMs: 20, shows: async () => false })).toBe(false);
  });

  it("routes a phone prompt over the API for a served pane and types otherwise", async () => {
    registerPaneServer(paneServersDir(), entry());
    const context = { agentHooks: new AgentHooks(), modelSwitcher: { assertAvailable() {} }, sideQuestions: { assertAvailable() {} } } as never;
    const send = (text: string, deliveryId?: string) => paneRoute(context, new URL("http://phren.local/v1/prompt"), { target, text, ...(deliveryId ? { deliveryId } : {}) }, {} as never);
    expect(await send("hello", "delivery-served-1")).toEqual({ ok: true, delivered: true });
    expect(await send("hello", "delivery-served-1")).toEqual({ ok: true, delivered: true, replayed: true });
    server.state.deliver = false;
    expect(await send("later")).toEqual({ ok: true, deliveryUncertain: true });
    expect(server.state.prompts.map(prompt => prompt.text)).toEqual(["hello", "later"]);
    expect(typed).toEqual([]);
    // The TUI's own slash commands are typed into it.
    await send("/models").catch(() => undefined);
    expect(typed).toEqual(["/models"]);
  });

  it("types into a pane the Hook did not start", async () => {
    const context = { agentHooks: new AgentHooks(), modelSwitcher: { assertAvailable() {} }, sideQuestions: { assertAvailable() {} } } as never;
    await paneRoute(context, new URL("http://phren.local/v1/prompt"), { target, text: "hello" }, {} as never).catch(() => undefined);
    expect(typed).toEqual(["hello"]);
    expect(server.state.prompts).toEqual([]);
  });
});

describe("asks", () => {
  const permission: OpenCodePermission = { id: "per_1", sessionID: "ses_child", permission: "bash", patterns: ["rm -rf /tmp/x"] };
  const question: OpenCodeQuestion = { id: "que_1", sessionID: "ses_root", questions: [{ question: "Red or blue?", header: "Colour",
    options: [{ label: "Red", description: "warm" }, { label: "Blue" }] }] };
  const asks = (value: Partial<PaneAsks>): PaneAsks => ({ permissions: [], questions: [], ...value });

  it("shows a served permission on the conversation the pane shows, pushes it once, and answers it over HTTP", async () => {
    registerPaneServer(paneServersDir(), entry());
    const push = fakePush();
    const hooks = new AgentHooks(push.service);
    server.state.permissions = [permission];
    await hooks.servedAsks(entry(), server.client, asks({ permissions: [permission] }));
    await hooks.servedAsks(entry(), server.client, asks({ permissions: [permission] }));
    expect(hooks.approval(target)).toMatchObject({ actionId: "per_1", toolName: "bash", title: "Allow bash?", message: "bash: rm -rf /tmp/x" });
    expect(hooks.pendingPanes("default", { panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "opencode" }] })).toEqual(new Set(["w1:p1"]));
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]).toMatchObject({ provider: "opencode" });
    // The file sweep leaves a served ask alone.
    await hooks.sweepOpencodeApprovals();
    expect(hooks.approval(target)).toMatchObject({ actionId: "per_1" });
    await hooks.answer(target, "per_1", "approve");
    expect(validateTarget).toHaveBeenCalledWith(target);
    expect(server.state.replies).toEqual([["per_1", "once"]]);
    expect(hooks.approval(target)).toBeUndefined();
    await expect(hooks.answer(target, "per_1", "approve")).rejects.toThrow("no longer pending");
  });

  it("denies with reject and refuses an answer for another conversation", async () => {
    registerPaneServer(paneServersDir(), entry());
    const hooks = new AgentHooks();
    await hooks.servedAsks(entry(), server.client, asks({ permissions: [permission] }));
    await expect(hooks.answer({ ...target, session: "ses_other" }, "per_1", "approve")).rejects.toThrow("no longer pending");
    await hooks.answer(target, "per_1", "deny");
    expect(server.state.replies).toEqual([["per_1", "reject"]]);
  });

  it("clears the card when the TUI answered first or the pane is gone", async () => {
    const hooks = new AgentHooks();
    await hooks.servedAsks(entry(), server.client, asks({ permissions: [permission], questions: [question] }));
    expect(hooks.approval(target)).toBeDefined();
    expect(hooks.servedQuestion(target)).toBeDefined();
    await hooks.servedAsks(entry(), server.client, asks({ questions: [question] }));
    expect(hooks.approval(target)).toBeUndefined();
    hooks.servedGone(paneKey(entry()));
    expect(hooks.servedQuestion(target)).toBeUndefined();
  });

  it("offers a served question in the phone's question shape and answers it by label", async () => {
    registerPaneServer(paneServersDir(), entry());
    const hooks = new AgentHooks();
    server.state.questions = [question];
    await hooks.servedAsks(entry(), server.client, asks({ questions: [question] }));
    expect(hooks.servedQuestion(target)).toMatchObject({ toolName: "AskUserQuestion", actionId: "que_1", questionIndex: 0,
      questions: [{ question: "Red or blue?", header: "Colour", options: [{ label: "Red", description: "warm" }, { label: "Blue" }] }],
      choice: { title: "Red or blue?", options: [{ label: "Red", key: "1" }, { label: "Blue", key: "2" }] } });
    const shown = [{ question: "Red or blue?", options: [{ label: "Red" }, { label: "Green" }] }];
    await expect(hooks.answerServedQuestion(target, shown, [{ options: [1] }])).rejects.toThrow("changed");
    await hooks.answerServedQuestion(target, [{ question: "Red or blue?", options: [{ label: "Red" }, { label: "Blue" }] }], [{ options: [1], text: "navy" }]);
    expect(server.state.answers).toEqual([["que_1", [["Blue", "navy"]]]]);
    expect(hooks.servedQuestion(target)).toBeUndefined();
  });

  it("answers the question through the phone's question route", async () => {
    registerPaneServer(paneServersDir(), entry());
    const hooks = new AgentHooks();
    await hooks.servedAsks(entry(), server.client, asks({ questions: [question] }));
    const context = { agentHooks: hooks, modelSwitcher: { assertAvailable() {} }, sideQuestions: { assertAvailable() {} }, codexQuestions: { answer: vi.fn() } } as never;
    expect(await paneRoute(context, new URL("http://phren.local/v1/questions/answer"),
      { target, questions: [{ question: "Red or blue?", options: ["Red", "Blue"] }], answers: [{ optionIndexes: [0] }] }, {} as never)).toEqual({ ok: true });
    expect(server.state.answers).toEqual([["que_1", [["Red"]]]]);
  });

  it("leaves question sets it cannot show whole to the TUI", async () => {
    const hooks = new AgentHooks();
    const partial: OpenCodeQuestion = { id: "que_2", sessionID: "ses_root", questions: [question.questions![0], { question: "No options", options: [] }] };
    await hooks.servedAsks(entry(), server.client, asks({ questions: [partial] }));
    expect(hooks.servedQuestion(target)).toBeUndefined();
  });

  it("maps Esc and digits to the API: decline a question, abort a working turn, pick an answer", async () => {
    registerPaneServer(paneServersDir(), entry());
    const hooks = new AgentHooks();
    await hooks.servedAsks(entry(), server.client, asks({ questions: [question] }));
    expect(await hooks.servedKeys(target, ["Escape"], "blocked")).toBe(true);
    expect(server.state.rejected).toEqual(["que_1"]);
    await hooks.servedAsks(entry(), server.client, asks({ questions: [{ ...question, id: "que_3" }] }));
    expect(await hooks.servedKeys(target, ["2"], "blocked")).toBe(true);
    expect(server.state.answers).toEqual([["que_3", [["Blue"]]]]);
    expect(await hooks.servedKeys(target, ["Escape"], "working")).toBe(true);
    expect(server.state.aborted).toEqual(["ses_root"]);
    expect(await hooks.servedKeys(target, ["Escape"], "idle")).toBe(false);
    expect(await hooks.servedKeys(target, ["Enter"], "working")).toBe(false);
    expect(await hooks.servedKeys({ ...target, pane: "w1:p9" }, ["Escape"], "working")).toBe(false);
  });

  it("stops a working served pane from the phone's Esc without typing it", async () => {
    registerPaneServer(paneServersDir(), entry());
    vi.mocked(validateTarget).mockResolvedValueOnce({ agent_status: "working" });
    const context = { agentHooks: new AgentHooks(), modelSwitcher: { assertAvailable() {} }, sideQuestions: { assertAvailable() {} } } as never;
    expect(await paneRoute(context, new URL("http://phren.local/v1/keys"), { target, keys: ["Escape"] }, {} as never)).toEqual({ ok: true });
    expect(server.state.aborted).toEqual(["ses_root"]);
    expect(keys).toEqual([]);
  });

  it("never reads a served pane's screen for a dialog", async () => {
    registerPaneServer(paneServersDir(), entry());
    const hooks = new AgentHooks();
    await hooks.syncTerminalDialog(target, true);
    expect(screenReads).toBe(0);
  });
});

describe("watcher", () => {
  it("lists asks when the stream opens and on each ask event, and stops for a gone pane", async () => {
    const seen: PaneAsks[] = [], gone: string[] = [];
    let entries = [entry()];
    const watcher = new PaneServerWatcher({ asks: async (_entry, _client, value) => { seen.push(value); }, gone: key => gone.push(key) }, () => entries, 5);
    watcher.tick();
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ permissions: [], questions: [] });
    server.state.permissions = [{ id: "per_9", sessionID: "ses_root", permission: "edit" }];
    server.push({ type: "session.status" });
    server.push({ type: "permission.asked", properties: { id: "per_9" } });
    await until(() => seen.length === 2);
    expect(seen[1].permissions.map(ask => ask.id)).toEqual(["per_9"]);
    expect(watcher.watching()).toEqual([paneKey(entry())]);
    entries = [];
    watcher.tick();
    expect(gone).toEqual([paneKey(entry())]);
    expect(watcher.watching()).toEqual([]);
    watcher.close();
  });

  it("reconnects after the stream drops", async () => {
    let connects = 0;
    restoreClient();
    restoreClient = setPaneClientFactory(() => ({ ...server.client, async *events() { connects++; yield { type: "server.connected" }; } }));
    const watcher = new PaneServerWatcher({ asks: async () => {}, gone: () => {} }, () => [entry()], 5);
    watcher.tick();
    await until(() => connects >= 3);
    watcher.close();
  });
});
