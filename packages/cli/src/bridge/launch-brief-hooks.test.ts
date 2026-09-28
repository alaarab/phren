import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentHooks } from "./agent-hooks.js";
import { localSocket } from "./agent-hook-stores.js";
import { paneForCodexSession, rpc, snapshot } from "./herdr.js";
import { briefArrival, writeLaunchBrief } from "./launch-brief.js";
import type { Target } from "./protocol.js";

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(), rpc: vi.fn(), snapshot: vi.fn(), paneForCodexSession: vi.fn(),
}));

const id = "40000000-0000-4000-8000-000000000002";
const session = "01a0deac-2df6-7202-aef7-264f5484fbdc";
const worker: Target = { server: "default", workspace: "wD", tab: "wD:t1", pane: "wD:p3", source: "codex", session };
const workerPane = { pane_id: "wD:p3", workspace_id: "wD", tab_id: "wD:t1", agent: "codex", terminal_id: "term-d", foreground_cwd: "/work/app" };
// The pane whose variables a shared Codex daemon inherited.
const other: Target = { ...worker, workspace: "wC", tab: "wC:t1", pane: "wC:p1" };
const otherPane = { ...workerPane, pane_id: "wC:p1", workspace_id: "wC", tab_id: "wC:t1", terminal_id: "term-c" };

function post(body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST" }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve(text));
    });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
}

// The Hook's agent socket is a Unix domain socket at a file path, which Node cannot listen on under Windows.
describe.skipIf(process.platform === "win32")("a launched worker's hooks confirm its brief by dispatch id", () => {
  let bridge: string, hooks: AgentHooks;
  beforeEach(async () => {
    bridge = await mkdtemp(path.join(tmpdir(), "phren-brief-hook-"));
    vi.stubEnv("PHREN_BRIDGE_HOME", bridge);
    vi.mocked(snapshot).mockReset().mockResolvedValue({ panes: [otherPane, workerPane] });
    vi.mocked(rpc).mockReset().mockImplementation(async (_server, method) => {
      if (method === "pane.process_info") return { process_info: { foreground_processes: [{ pid: process.pid }] } };
      throw new Error(`Unexpected RPC ${method}`);
    });
    hooks = new AgentHooks();
    await hooks.start();
  });
  afterEach(async () => {
    hooks.close();
    vi.unstubAllEnvs();
    await rm(bridge, { recursive: true, force: true });
  });

  it("records SessionStart as started and UserPromptSubmit as accepted", async () => {
    const file = await writeLaunchBrief({ id, text: "Do the work." });
    await post({ target: worker, event: "SessionStart", dispatchId: id });
    expect(await briefArrival(id)).toEqual({ started: { at: expect.any(String), target: worker } });
    await post({ target: worker, event: "UserPromptSubmit", dispatchId: id, prompt: `Read and follow the brief in ${file}` });
    expect((await briefArrival(id))?.accepted).toEqual({ at: expect.any(String), target: worker });
  });

  it("ignores a daemon's inherited id but takes the brief path in the prompt, placed on the real pane", async () => {
    const file = await writeLaunchBrief({ id, text: "Do the work." });
    vi.mocked(paneForCodexSession).mockReset().mockResolvedValue(workerPane);
    await post({ target: other, event: "SessionStart", daemon: true, dispatchId: id, cwd: "/work/app" });
    expect(await briefArrival(id)).toEqual({});
    await post({ target: other, event: "UserPromptSubmit", daemon: true, dispatchId: id, cwd: "/work/app", prompt: `Read and follow the brief in ${file}` });
    expect((await briefArrival(id))?.accepted?.target).toEqual(worker);
  });

  it("writes nothing for an id this computer never launched", async () => {
    await post({ target: worker, event: "UserPromptSubmit", dispatchId: id, prompt: "hello" });
    expect(await briefArrival(id)).toBeUndefined();
  });
});
