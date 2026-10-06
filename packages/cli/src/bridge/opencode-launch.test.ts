import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const ps = vi.hoisted(() => ({ rows: "" }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: async (file: string) => ({ stdout: file === "ps" ? ps.rows : "" }) }),
}));
import { briefArrival } from "./launch-brief.js";
import type { PaneClient, PromptOptions } from "./opencode-pane-server.js";
import { servedPane, setPaneClientFactory } from "./opencode-panes.js";
import type { Json } from "./protocol.js";
import { launchSession } from "./server-launch.js";
import { type AgentStart, type PanePlacement, setTerminalProvider, type TerminalProvider } from "./terminal.js";

const id = "40000000-0000-4000-8000-0000000000c1";
let root: string, restore: () => void, restoreClient: () => void, placements: PanePlacement[], starts: AgentStart[], state: Json;
let prompts: Array<{ session: string; text: string; options?: PromptOptions }>, selected: string[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-oc-launch-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  placements = []; starts = []; prompts = []; selected = []; state = { workspaces: [], tabs: [], panes: [] };
  restore = setTerminalProvider({
    kind: "fake",
    snapshot: async () => structuredClone(state),
    create: async (_server: string, placement: PanePlacement) => {
      placements.push(placement);
      state.workspaces.push({ workspace_id: "w1", label: placement.label });
      state.tabs.push({ tab_id: "w1:t1", workspace_id: "w1", label: placement.label });
      state.panes.push({ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term-1" });
    },
    startAgent: async (_server: string, _pane: string, agent: AgentStart) => {
      starts.push(agent);
      // The pane's OpenCode, and a shim above it without the port.
      ps.rows = `1 /usr/bin/mise exec opencode\n${process.pid} /opt/opencode ${agent.args.join(" ")}\n`;
    },
    processes: async () => ({ foregroundPids: [process.pid] }),
    readScreen: async () => "┃  Do the work.",
  } as unknown as TerminalProvider);
  const client = {
    ready: async () => true,
    createSession: async () => ({ id: "ses_brief" }),
    selectSession: async (session: string) => { selected.push(session); },
    prompt: async (session: string, text: string, options?: PromptOptions) => { prompts.push({ session, text, options }); return { delivered: true, messageId: "msg_1" }; },
  } as unknown as PaneClient;
  restoreClient = setPaneClientFactory(() => client);
});
afterEach(async () => { restore(); restoreClient(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it("registers a launched OpenCode pane and sends its brief over the pane's API", async () => {
  const launched = await launchSession("default", { cwd: root, label: "Worker", kind: "opencode", model: "a/b", effort: "high", brief: { id, text: "Do the work." } });
  expect(launched).toMatchObject({ ok: true, briefLaunched: true, sessionId: "ses_brief",
    target: { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "opencode", session: "ses_brief" } });
  expect(starts[0].args).toEqual(["--model", "a/b", "--variant", "high", "--port", expect.stringMatching(/^\d+$/)]);
  const entry = servedPane("default", "w1:p1");
  expect(entry).toMatchObject({ pid: process.pid, directory: root, port: Number(starts[0].args[5]), defaults: { model: "a/b", variant: "high" } });
  expect(placements[0].env).toMatchObject({ PHREN_DISPATCH_ID: id, OPENCODE_SERVER_PASSWORD: entry!.password, PHREN_OPENCODE_PORT: String(entry!.port) });
  expect(prompts).toEqual([{ session: "ses_brief", text: "Do the work.", options: { model: "a/b", variant: "high", timeoutMs: 10_000 } }]);
  expect(selected).toEqual(["ses_brief"]);
  const pane = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "opencode", session: "ses_brief" };
  expect(await briefArrival(id)).toEqual({ started: { at: expect.any(String), target: pane }, accepted: { at: expect.any(String), target: pane } });
});

it("serves a conductor with its own agent for a session's first prompt", async () => {
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "config"));
  const launched = await launchSession("default", { cwd: root, label: "Lead", kind: "opencode", role: "conductor", effort: "low" });
  expect(launched).toMatchObject({ ok: true, role: "conductor" });
  expect(launched).not.toHaveProperty("briefLaunched");
  expect(servedPane("default", "w1:p1")?.defaults).toEqual({ agent: "conductor", variant: "low" });
  expect(prompts).toEqual([]);
});
