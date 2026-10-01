import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentHooks } from "./agent-hooks.js";
import { localSocket } from "./agent-hook-stores.js";
import { rpc, snapshot } from "./herdr.js";
import type { Json, Target } from "./protocol.js";

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(), rpc: vi.fn(), snapshot: vi.fn(),
}));

const session = "01a0deac-2df6-7202-aef7-264f5484fbdc";
const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "phren", session };

function post(body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST" }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve(text));
    });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
}

// Herdr does not detect phren-agent; a pane the Hook reported keeps its status from the agent's own hooks.
describe.skipIf(process.platform === "win32")("phren-agent's lifecycle events on Herdr", () => {
  let bridge: string, hooks: AgentHooks, pane: Json;
  const reports = () => vi.mocked(rpc).mock.calls.filter(call => call[1] === "pane.report_agent").map(call => call[2]);
  beforeEach(async () => {
    bridge = await mkdtemp(path.join(tmpdir(), "phren-agent-status-"));
    vi.stubEnv("PHREN_BRIDGE_HOME", bridge);
    pane = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "phren", agent_status: "idle", terminal_id: "term-1", foreground_cwd: "/work/app" };
    vi.mocked(snapshot).mockReset().mockImplementation(async () => ({ panes: [pane] }));
    vi.mocked(rpc).mockReset().mockImplementation(async (_server, method) =>
      method === "pane.process_info" ? { process_info: { foreground_processes: [{ pid: process.pid }] } } : {});
    hooks = new AgentHooks();
    await hooks.start();
  });
  afterEach(async () => {
    hooks.close();
    vi.unstubAllEnvs();
    await rm(bridge, { recursive: true, force: true });
  });

  it("reports working on a prompt and idle when the turn stops", async () => {
    await post({ target, event: "UserPromptSubmit", prompt: "fix the tests" });
    pane.agent_status = "working";
    await post({ target, event: "Stop" });
    expect(reports()).toEqual([
      { pane_id: "w1:p1", source: "phren-hook", agent: "phren", state: "working" },
      { pane_id: "w1:p1", source: "phren-hook", agent: "phren", state: "idle" },
    ]);
  });

  it("reports nothing Herdr already shows, nor for a pane Herdr does not list as phren", async () => {
    await post({ target, event: "SessionStart" });
    pane.agent = undefined;
    await post({ target, event: "UserPromptSubmit", prompt: "hello" });
    expect(reports()).toEqual([]);
  });
});
