import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Json } from "./protocol.js";
import { createRouteHandler } from "./server-routes.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";

vi.mock("./herdr.js", async original => ({ ...await original<typeof import("./herdr.js")>(),
  servers: async () => [{ id: "herdr:default", kind: "herdr", session: "default", running: true },
    { id: "tmux:tmux", kind: "tmux", session: "tmux", running: true }],
}));

let root: string, restore: () => void;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-mux-compat-"));
  vi.stubEnv("PHREN_HERDR_HOME", root);
  restore = setTerminalProvider({ snapshot: async () => ({
    workspaces: [{ workspace_id: "w1", label: "atlas" }],
    tabs: [{ workspace_id: "w1", tab_id: "w1:t1" }],
    panes: [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", agent: null }],
  }) } as unknown as TerminalProvider);
});
afterEach(async () => { restore(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function get(route: string): Promise<Json> {
  const handler = createRouteHandler({ modules: { has: () => true }, info: {}, streams: {},
    agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set() },
    journal: { record: async () => {} }, tabActivity: { observe: async () => new Map() },
    contextUsage: { read: async () => new Map() },
  } as never);
  let result = "";
  const response = { statusCode: 200, setHeader() {}, end(value: string) { result = value; } };
  await handler({ url: route, method: "GET" } as IncomingMessage, response as unknown as ServerResponse);
  expect(response.statusCode, result).toBe(200);
  return JSON.parse(result);
}

it("keeps discovery usable by installed clients and negotiates accurate typed sources", async () => {
  const legacy = await get("/v1/muxes");
  expect(legacy.muxes).toEqual([
    { id: "herdr:default", kind: "herdr", session: "default", running: true },
    { id: "herdr:tmux", kind: "herdr", session: "tmux", running: true,
      mux: { id: "tmux:tmux", kind: "tmux", session: "tmux" } },
  ]);
  const typed = await get("/v1/muxes?typed=1");
  expect(typed.muxes).toEqual([
    { id: "herdr:default", kind: "herdr", session: "default", running: true },
    { id: "tmux:tmux", kind: "tmux", session: "tmux", running: true },
  ]);
});

it.each(["/v1/workspaces", "/v1/workspaces/panes?groupId=w1&childId=w1:t1"])(
  "preserves legacy %s envelopes and opts typed tmux requests in", async route => {
    const separator = route.includes("?") ? "&" : "?";
    for (const selector of ["server=tmux", "mux=herdr:tmux"]) {
      expect(await get(`${route}${separator}${selector}`)).toMatchObject({ kind: "herdr",
        mux: { id: "tmux:tmux", kind: "tmux", session: "tmux" } });
    }
    expect(await get(`${route}${separator}mux=tmux:tmux`)).toMatchObject({ kind: "tmux",
      mux: { id: "tmux:tmux", kind: "tmux", session: "tmux" } });
    expect(await get(route)).toMatchObject({ kind: "herdr" });
  });
