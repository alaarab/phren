import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentHooks, conductorCall } from "./agent-hooks.js";
import { validateTarget } from "./herdr.js";
import type { ApprovalPushService } from "./push.js";
import type { Target } from "./protocol.js";

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(),
  validateTarget: vi.fn(async () => ({})),
}));

const session = "ses_f4a6b5c11ffe6nZrRlGZbXXNli";
const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "opencode", session };
const requestFile = (store: string) => path.join(store, ".runtime", "approvals", `opencode-${session}.request.json`);
const answerFile = (store: string) => path.join(store, ".runtime", "approvals", `opencode-${session}.answer.json`);
const bindingFile = (bridge: string) => path.join(bridge, "bindings", "default", "w1%3Ap1.json");

/** A push service that records what would have gone to APNs. */
function fakePush() {
  const sent: { binding: string; provider: string; title?: string; message?: string }[] = [];
  return { sent, service: { available: true,
    notify: vi.fn(async (value: { binding: string; provider: string; title?: string; message?: string }) => { sent.push(value); return true; }),
    notifyFanoutBlocked: vi.fn(async () => true) } as unknown as ApprovalPushService };
}

describe("opencode file approvals", () => {
  let store: string, bridge: string, previousPath: string | undefined, previousBridge: string | undefined;
  beforeEach(async () => {
    vi.clearAllMocks();
    store = await mkdtemp(path.join(tmpdir(), "phren-opencode-"));
    bridge = await mkdtemp(path.join(tmpdir(), "phren-bridge-"));
    previousPath = process.env.PHREN_PATH; previousBridge = process.env.PHREN_BRIDGE_HOME;
    process.env.PHREN_PATH = store; process.env.PHREN_BRIDGE_HOME = bridge;
    await mkdir(path.dirname(requestFile(store)), { recursive: true });
  });
  afterEach(async () => {
    if (previousPath === undefined) delete process.env.PHREN_PATH; else process.env.PHREN_PATH = previousPath;
    if (previousBridge === undefined) delete process.env.PHREN_BRIDGE_HOME; else process.env.PHREN_BRIDGE_HOME = previousBridge;
    await rm(store, { recursive: true, force: true });
    await rm(bridge, { recursive: true, force: true });
  });

  it("surfaces a live opencode request and marks its pane", async () => {
    await writeFile(requestFile(store), JSON.stringify({ id: "per_abc123", sessionID: session, type: "bash",
      title: "Allow bash?", message: "bash: rm -rf /tmp/x", createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString() }));
    const hooks = new AgentHooks();
    expect(hooks.approval(target)).toMatchObject({ actionId: "per_abc123", toolName: "bash", title: "Allow bash?", message: "bash: rm -rf /tmp/x" });
    const state = { panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "opencode",
      agent_session: { kind: "id", agent: "opencode", value: session } }] };
    expect(hooks.pendingPanes("default", state)).toEqual(new Set(["w1:p1"]));
  });

  it("ignores absent, malformed, expired, and unsafe requests", async () => {
    const hooks = new AgentHooks();
    expect(hooks.approval(target)).toBeUndefined();
    await writeFile(requestFile(store), "{ not json");
    expect(hooks.approval(target)).toBeUndefined();
    await writeFile(requestFile(store), JSON.stringify({ id: "per_abc123", sessionID: session, type: "bash",
      expiresAt: new Date(Date.now() - 1).toISOString() }));
    expect(hooks.approval(target)).toBeUndefined();
    expect(hooks.approval({ ...target, session: "ses_ok/../escape" })).toBeUndefined();
    expect(hooks.pendingPanes("default", { panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1",
      agent: "opencode", agent_session: { kind: "id", agent: "opencode", value: "ses_ok/../escape" } }] })).toEqual(new Set());
  });

  it("answers by writing the answer file atomically", async () => {
    await writeFile(requestFile(store), JSON.stringify({ id: "per_abc123", sessionID: session, type: "bash",
      title: "Allow bash?", message: "bash: rm -rf /tmp/x", expiresAt: new Date(Date.now() + 30_000).toISOString() }));
    const hooks = new AgentHooks();
    await hooks.answer(target, "per_abc123", "approve");
    expect(validateTarget).toHaveBeenCalledWith(target);
    expect(JSON.parse(await readFile(answerFile(store), "utf8"))).toEqual({ id: "per_abc123", decision: "approve" });
    await expect(hooks.answer(target, "per_abc123", "maybe")).rejects.toThrow("not valid");
  });

  it("pushes a bound opencode request and lists it", async () => {
    const push = fakePush(), hooks = new AgentHooks(push.service);
    await mkdir(path.dirname(bindingFile(bridge)), { recursive: true });
    await writeFile(bindingFile(bridge), JSON.stringify({ terminal: "term-1", source: "opencode", session,
      pids: [process.pid], workspace: "w1", tab: "w1:t1" }));
    await writeFile(requestFile(store), JSON.stringify({ id: "per_ext1", sessionID: session, type: "external_directory",
      title: "Allow external_directory?", message: "external_directory: /private/tmp/x",
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() }));
    await Promise.all([hooks.sweepOpencodeApprovals(), hooks.sweepOpencodeApprovals()]);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]).toMatchObject({ provider: "opencode", title: "Allow external_directory?", message: "external_directory: /private/tmp/x" });
    expect(push.sent[0].binding).toMatch(/^[0-9a-f-]{36}$/);
    expect(hooks.approval(target)).toMatchObject({ actionId: "per_ext1", toolName: "external_directory",
      title: "Allow external_directory?", message: "external_directory: /private/tmp/x" });
  });

  it("answers a pushed opencode request by writing the answer file", async () => {
    const push = fakePush(), hooks = new AgentHooks(push.service);
    await mkdir(path.dirname(bindingFile(bridge)), { recursive: true });
    await writeFile(bindingFile(bridge), JSON.stringify({ terminal: "term-1", source: "opencode", session,
      pids: [process.pid], workspace: "w1", tab: "w1:t1" }));
    await writeFile(requestFile(store), JSON.stringify({ id: "per_ext2", sessionID: session, type: "external_directory",
      title: "Allow external_directory?", message: "external_directory: /private/tmp/x",
      expiresAt: new Date(Date.now() + 30_000).toISOString() }));
    await hooks.sweepOpencodeApprovals();
    await hooks.answerPush(push.sent[0].binding, "approve");
    expect(JSON.parse(await readFile(answerFile(store), "utf8"))).toEqual({ id: "per_ext2", decision: "approve" });
    await expect(hooks.answerPush(push.sent[0].binding, "approve")).rejects.toThrow("no longer pending");
  });

  it("holds a fan-out request only when the named job's manifest confirms the session", async () => {
    const push = fakePush(), hooks = new AgentHooks(push.service);
    const job = path.join(store, ".runtime", "agent-fanouts", "opencode-abc");
    await mkdir(job, { recursive: true });
    const manifest = { schemaVersion: 1, id: "opencode-abc", provider: "opencode", taskLabel: "worker", cwd: store, worktree: store,
      eventLog: "events.jsonl", createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      status: "running", session: "ses_other1", parent: { provider: "opencode", session } };
    await writeFile(path.join(job, "manifest.json"), JSON.stringify(manifest));
    const worker = "ses_worker1", request = path.join(store, ".runtime", "approvals", `opencode-${worker}.request.json`);
    await writeFile(request, JSON.stringify({ id: "per_w1", sessionID: worker, type: "external_directory", title: "Allow?", message: "m",
      fanout: "opencode-abc", expiresAt: new Date(Date.now() + 30_000).toISOString() }));
    await hooks.sweepOpencodeApprovals();
    expect(push.sent).toHaveLength(0);
    // Once the manifest names the worker, an opencode parent gets a token-shaped action id.
    await writeFile(path.join(job, "manifest.json"), JSON.stringify({ ...manifest, session: worker }));
    await mkdir(path.dirname(bindingFile(bridge)), { recursive: true });
    await writeFile(bindingFile(bridge), JSON.stringify({ terminal: "term-1", source: "opencode", session, pids: [process.pid], workspace: "w1", tab: "w1:t1" }));
    await hooks.sweepOpencodeApprovals();
    expect(push.sent).toHaveLength(1);
    const approval = hooks.approval(target);
    expect(String(approval?.actionId)).toMatch(/^[0-9a-f]{32}$/);
    await hooks.answer(target, String(approval!.actionId), "deny");
    expect(JSON.parse(await readFile(path.join(store, ".runtime", "approvals", `opencode-${worker}.answer.json`), "utf8"))).toEqual({ id: "per_w1", decision: "deny" });
  });
});

it("recognizes conductor tool names without splitting hand_off", () => {
  for (const tool of ["hand_off", "phren.hand_off", "mcp__phren__hand_off"]) {
    expect(conductorCall(tool, { project: "demo" })).toEqual({ action: "hand_off", project: "demo" });
  }
  expect(conductorCall("mcp__phren__phren_admin", { action: "dispatch", project: "demo" }))
    .toEqual({ action: "dispatch", project: "demo" });
});
