import { mkdtemp, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { briefArgs, briefArrival, briefIdInPrompt, briefRoot, recordBriefArrival, writeLaunchBrief } from "./launch-brief.js";
import { launchSession } from "./server-launch.js";
import { type AgentStart, type PanePlacement, setTerminalProvider, type TerminalProvider } from "./terminal.js";
import type { Json, Target } from "./protocol.js";

const id = "40000000-0000-4000-8000-000000000001";
const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude", session: "00000004-1111-4111-8111-111111111111" };

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-launch-brief-")); vi.stubEnv("PHREN_BRIDGE_HOME", root); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("a brief that goes with the launch", () => {
  it("is written privately and handed to Claude and Codex as one short argument", async () => {
    const file = await writeLaunchBrief({ id, text: "Line one\nLine two" });
    expect(file).toBe(path.join(root, "briefs", id, "brief.md"));
    expect(await readFile(file, "utf8")).toBe("Line one\nLine two\n");
    // Windows reports no POSIX modes (a file reads back as 0o666).
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
    // Claude may read outside its folder only with permission; `--add-dir` is variadic, so it follows the prompt.
    expect(briefArgs("claude", file)).toEqual([`Read and follow the brief in ${file}`, "--add-dir", path.dirname(file)]);
    expect(briefArgs("codex", file)).toEqual([`Read and follow the brief in ${file}`]);
    // No initial-prompt argument that opens their TUI: the caller types.
    expect(briefArgs("opencode", file)).toBeUndefined();
    expect(briefArgs("copilot", file)).toBeUndefined();
    expect(briefIdInPrompt(`Read and follow the brief in ${file}`)).toBe(id);
    expect(briefIdInPrompt("Read and follow the brief in /tmp/briefs/x/brief.md")).toBeUndefined();
  });

  it("never shows a brief folder without its brief, and rewrites the same id in place", async () => {
    let seen = 0, torn = 0, done = false;
    const watch = (async () => {
      while (!done) {
        for (const name of await readdir(briefRoot()).catch(() => [] as string[])) {
          seen++;
          if (!(await stat(path.join(briefRoot(), name, "brief.md")).catch(() => undefined))) torn++;
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    })();
    for (let n = 0; n < 20; n++) await writeLaunchBrief({ id: `40000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`, text: "x".repeat(200_000) });
    done = true; await watch;
    expect(seen).toBeGreaterThan(0);
    expect(torn).toBe(0);
    expect(await readdir(path.join(root, "briefs-staging"))).toEqual([]);
    await writeLaunchBrief({ id, text: "first" });
    await writeLaunchBrief({ id, text: "second" });
    expect(await readFile(path.join(briefRoot(), id, "brief.md"), "utf8")).toBe("second\n");
  });

  it("keeps a week of briefs", async () => {
    const old = "40000000-0000-4000-8000-00000000000a";
    await writeLaunchBrief({ id: old, text: "old" });
    const week = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await utimes(path.join(briefRoot(), old), week / 1000, week / 1000);
    await writeLaunchBrief({ id, text: "new" });
    expect(await briefArrival(old)).toBeUndefined();
    expect(await briefArrival(id)).toEqual({});
  });

  it("records the first start and the first submitted prompt, only for a brief it wrote", async () => {
    await recordBriefArrival(id, "UserPromptSubmit", target);
    expect(await briefArrival(id)).toBeUndefined();
    await writeLaunchBrief({ id, text: "brief" });
    await recordBriefArrival(id, "SessionStart", target, new Date("2026-09-27T10:00:00Z"));
    await recordBriefArrival(id, "Stop", target);
    expect(await briefArrival(id)).toEqual({ started: { at: "2026-09-27T10:00:00.000Z", target } });
    await recordBriefArrival(id, "UserPromptSubmit", target, new Date("2026-09-27T10:00:05Z"));
    await recordBriefArrival(id, "UserPromptSubmit", { ...target, session: "00000004-2222-4222-8222-222222222222" }, new Date("2026-09-27T10:09:00Z"));
    expect((await briefArrival(id))?.accepted).toEqual({ at: "2026-09-27T10:00:05.000Z", target });
  });
});

describe("launching an agent with its brief", () => {
  let restore: () => void, placements: PanePlacement[], starts: AgentStart[], state: Json;
  beforeEach(() => {
    placements = []; starts = []; state = { workspaces: [], tabs: [], panes: [] };
    restore = setTerminalProvider({
      kind: "fake",
      snapshot: async () => structuredClone(state),
      create: async (_server: string, placement: PanePlacement) => {
        placements.push(placement);
        const n = placements.length;
        state.workspaces.push({ workspace_id: `w${n}`, label: placement.label });
        state.tabs.push({ tab_id: `w${n}:t1`, workspace_id: `w${n}`, label: placement.label });
        state.panes.push({ pane_id: `w${n}:p1`, tab_id: `w${n}:t1`, workspace_id: `w${n}`, terminal_id: `term-${n}` });
      },
      startAgent: async (_server: string, _pane: string, agent: AgentStart) => { starts.push(agent); },
    } as unknown as TerminalProvider);
  });
  afterEach(() => restore());

  it("starts Claude with the brief as its first prompt and its dispatch id in the pane's environment", async () => {
    const launched = await launchSession("default", { cwd: root, label: "Worker", kind: "claude", model: "opus", brief: { id, text: "Do the work." } });
    const file = path.join(root, "briefs", id, "brief.md");
    expect(launched).toMatchObject({ ok: true, briefLaunched: true });
    expect(await readFile(file, "utf8")).toBe("Do the work.\n");
    expect(placements[0].env).toEqual({ PHREN_DISPATCH_ID: id });
    expect(starts[0]).toMatchObject({ kind: "claude", env: { PHREN_DISPATCH_ID: id },
      args: ["--model", "opus", `Read and follow the brief in ${file}`, "--add-dir", path.dirname(file)] });
  });

  it("leaves the brief to be typed for a harness without a first-prompt argument", async () => {
    const launched = await launchSession("default", { cwd: root, label: "Worker", kind: "copilot", brief: { id, text: "Do the work." } });
    expect(launched).toMatchObject({ ok: true, briefLaunched: false });
    expect(starts[0].args).toEqual([]);
    expect(placements[0].env).toEqual({ PHREN_DISPATCH_ID: id });
    await expect(stat(path.join(root, "briefs", id))).rejects.toThrow();
  });

  it("starts OpenCode on a port of its own and types the brief when its server never registers", async () => {
    const launched = await launchSession("default", { cwd: root, label: "Worker", kind: "opencode", brief: { id, text: "Do the work." } });
    expect(launched).toMatchObject({ ok: true, briefLaunched: false });
    const port = starts[0].args[1];
    expect(starts[0].args).toEqual(["--port", expect.stringMatching(/^\d+$/)]);
    expect(placements[0].env).toEqual({ PHREN_DISPATCH_ID: id, PHREN_OPENCODE_PORT: port, OPENCODE_SERVER_PASSWORD: expect.stringMatching(/^[\w-]{43}$/) });
    // The brief is on file so a served send can record its arrival.
    expect(await briefArrival(id)).toEqual({});
  });

  it("launches as before without a brief, and refuses one for a conductor", async () => {
    const launched = await launchSession("default", { cwd: root, label: "Plain", kind: "codex" });
    expect(launched).not.toHaveProperty("briefLaunched");
    expect(placements[0]).not.toHaveProperty("env");
    expect(starts[0]).not.toHaveProperty("env");
    await expect(launchSession("default", { cwd: root, label: "Lead", kind: "claude", role: "conductor", brief: { id, text: "x" } }))
      .rejects.toThrow("A conductor starts with its own brief.");
    await expect(launchSession("default", { cwd: root, label: "Bad", kind: "claude", brief: { id: "../../etc", text: "x" } })).rejects.toThrow();
  });
});
