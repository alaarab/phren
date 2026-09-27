import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectedServer, workspacesReader } from "./server-routes.js";
import { transcriptPath } from "./transcripts.js";

describe("typed terminal sources", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-mux-routing-"));
    vi.stubEnv("PHREN_HERDR_HOME", root);
    vi.stubEnv("CLAUDE_CONFIG_DIR", root);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  it("accepts typed tmux and Herdr IDs while retaining legacy routing", () => {
    for (const [query, server] of [["", "default"], ["mux=herdr:default", "default"], ["mux=tmux:tmux", "tmux"],
      ["mux=tmux:tmux-work", "tmux-work"], ["mux=herdr:tmux", "tmux"], ["server=tmux", "tmux"]]) {
      expect(selectedServer(new URL(`http://phren.local/v1/workspaces?${query}`))).toBe(server);
    }
    for (const query of ["mux=unknown:default", "mux=tmux:../bad", "server=default&mux=tmux:tmux", "mux=tmux:default"]) {
      expect(() => selectedServer(new URL(`http://phren.local/v1/workspaces?${query}`))).toThrow();
    }
  });

  it("identifies each overview source without changing group identity", async () => {
    const read = workspacesReader({ modules: { has: () => false } as never, info: {} as never,
      agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set() } as never,
      journal: { record: async () => {} } as never, tabActivity: { observe: async () => new Map() } as never,
      contextUsage: { read: async () => new Map() } as never });
    const snapshot = { workspaces: [{ workspace_id: "s1", label: "atlas" }], tabs: [], panes: [] };
    const [herdr, tmux] = await Promise.all([read("default", snapshot, false), read("tmux", snapshot, false)]);
    expect(herdr).toMatchObject({ kind: "herdr", mux: { id: "herdr:default", kind: "herdr", session: "default" } });
    expect(tmux).toMatchObject({ kind: "tmux", mux: { id: "tmux:tmux", kind: "tmux", session: "tmux" }, groups: [{ id: "s1", label: "atlas" }] });
  });

  it("codes missing transcripts without relabeling invalid conversation identities", async () => {
    await expect(transcriptPath("claude", "aaaaaaaa-1111-4111-8111-111111111111"))
      .rejects.toMatchObject({ status: 404, details: { code: "transcript-unavailable" } });
    await expect(transcriptPath("claude", "invalid")).rejects.toMatchObject({ status: 400 });
  });
});
