import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentHooks } from "./agent-hooks.js";
import { bindingPath, localSocket } from "./agent-hook-stores.js";
import { paneForCodexSession, rpc, snapshot } from "./herdr.js";
import type { Target } from "./protocol.js";

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(), rpc: vi.fn(), snapshot: vi.fn(), paneForCodexSession: vi.fn(),
}));

const session = "01a0deac-2df6-7202-aef7-264f5484fbdb";
// The daemon's environment names the pane that started it the night before.
const origin: Target = { server: "default", workspace: "wC", tab: "wC:t1", pane: "wC:p1", source: "codex", session };
const originPane = { pane_id: "wC:p1", workspace_id: "wC", tab_id: "wC:t1", agent: "codex", terminal_id: "term-c", foreground_cwd: "/work/other" };
const realPane = { pane_id: "wD:p3", workspace_id: "wD", tab_id: "wD:t1", agent: "codex", terminal_id: "term-d", foreground_cwd: "/work/app" };

function post(body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST" }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve(text));
    });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
}
const bindings = async (bridge: string) => (await readdir(path.join(bridge, "bindings", "default")).catch(() => [] as string[])).map(decodeURIComponent);

// The Hook's agent socket is a Unix domain socket at a file path, which Node cannot listen on under Windows.
describe.skipIf(process.platform === "win32")("a Codex callback run inside the app-server daemon", () => {
  let bridge: string, previous: string | undefined, hooks: AgentHooks;
  beforeEach(async () => {
    bridge = await mkdtemp(path.join(tmpdir(), "phren-codexd-hook-"));
    previous = process.env.PHREN_BRIDGE_HOME; process.env.PHREN_BRIDGE_HOME = bridge;
    vi.mocked(snapshot).mockReset().mockResolvedValue({ panes: [originPane, realPane] });
    vi.mocked(rpc).mockReset().mockImplementation(async (_server, method) => {
      if (method === "pane.process_info") return { process_info: { foreground_processes: [{ pid: process.pid }] } };
      throw new Error(`Unexpected RPC ${method}`);
    });
    hooks = new AgentHooks();
    await hooks.start();
  });
  afterEach(async () => {
    hooks.close();
    if (previous === undefined) delete process.env.PHREN_BRIDGE_HOME; else process.env.PHREN_BRIDGE_HOME = previous;
    await rm(bridge, { recursive: true, force: true });
  });

  it("never binds the conversation to the pane that started the daemon", async () => {
    vi.mocked(paneForCodexSession).mockReset().mockResolvedValue(realPane);
    expect(await post({ target: origin, event: "SessionStart", daemon: true, cwd: "/work/app" })).toBe("{}");
    expect(paneForCodexSession).toHaveBeenCalledWith("default", session, "/work/app");
    expect(await bindings(bridge)).toEqual([]);
  });

  it("drops the callback when no pane shows its conversation", async () => {
    vi.mocked(paneForCodexSession).mockReset().mockResolvedValue(undefined);
    expect(await post({ target: origin, event: "Stop", daemon: true, cwd: "/work/app" })).toBe("{}");
    expect(await bindings(bridge)).toEqual([]);
  });

  it("still binds a callback from the pane's own Codex process", async () => {
    vi.mocked(paneForCodexSession).mockReset();
    await post({ target: origin, event: "SessionStart" });
    expect(await bindings(bridge)).toEqual(["wC:p1.json"]);
    expect(path.basename(bindingPath("default", "wC:p1"))).toBe(encodeURIComponent("wC:p1") + ".json");
    expect(paneForCodexSession).not.toHaveBeenCalled();
  });
});
