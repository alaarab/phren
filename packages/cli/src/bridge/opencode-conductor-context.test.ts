import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

type Handler = (input: unknown, output?: Record<string, unknown>) => Promise<void>;
describe.skipIf(process.platform === "win32")("OpenCode conductor context", () => {
  let root: string, server: Server, bodies: unknown[], handlers: Record<string, Handler>;
  beforeEach(async () => {
    root = await mkdtemp("/tmp/phren-oc-context-"); bodies = [];
    vi.stubEnv("PHREN_BRIDGE_HOME", root); vi.stubEnv("PHREN_PATH", root); vi.stubEnv("PHREN_FANOUT_JOB", "");
    server = createServer(async (req, res) => {
      let text = ""; for await (const chunk of req) text += chunk;
      bodies.push({ url: req.url, ...JSON.parse(text) });
      res.end(JSON.stringify({ context: "Phren role for this turn: conductor." }));
    });
    await new Promise<void>(resolve => server.listen(path.join(root, "agent.sock"), resolve));
    const url = new URL("../../plugins/opencode/phren-transcript.js", import.meta.url);
    const plugin = await import(`${url.href}?t=${Date.now()}`);
    handlers = await plugin.PhrenTranscriptPlugin();
    await handlers["chat.message"]({ sessionID: "ses_root" }, { message: { id: "msg_1", role: "user" }, parts: [] });
  });
  afterEach(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    // Let the existing transcript writer finish its scheduled flush.
    await new Promise(resolve => setTimeout(resolve, 300));
    vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  });
  it("adds context on each root request, including continuation after compaction or a model switch", async () => {
    for (let i = 0; i < 2; i++) {
      const output = { system: ["Harness instructions"] };
      await handlers["experimental.chat.system.transform"]({ sessionID: "ses_root" }, output);
      expect(output.system).toEqual(["Harness instructions", "Phren role for this turn: conductor."]);
    }
    expect(bodies).toEqual(Array(2).fill({ url: "/conductor-context", pid: process.pid, session: "ses_root" }));
  });
  it("never gives the role to children, unknown sessions, agent generation or headless fanout", async () => {
    await handlers.event({ event: { type: "session.created", properties: { info: { id: "ses_child", parentID: "ses_root" } } } });
    for (const input of [{ sessionID: "ses_child" }, { sessionID: "ses_other" }, {}]) {
      const output = { system: [] };
      await handlers["experimental.chat.system.transform"](input, output);
      expect(output.system).toEqual([]);
    }
    vi.stubEnv("PHREN_FANOUT_JOB", "fanout-123");
    await handlers["experimental.chat.system.transform"]({ sessionID: "ses_root" }, { system: [] });
    expect(bodies).toEqual([]);
  });
});
