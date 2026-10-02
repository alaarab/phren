import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const state = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(),
  execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: state.exec }),
}));
import { paneIdentity } from "./herdr.js";
import { assignDaemonConversation, parseElapsed, resetCodexDaemonCache, resumedConversation, rolloutMeta, underCodexDaemon } from "./codex-daemon.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";
import { bindingPath } from "./agent-hook-stores.js";

/** Codex 0.157: TUIs in panes, conversations in one app-server daemon that the
 * first pane (p1) started the night before and that launchd now parents. */
const DAEMON = "/Users/me/.codex/packages/app-server-daemon/releases/0.157.1-aarch64-apple-darwin/bin/codex app-server --listen unix:// --managed-daemon";
const id = (n: number) => `01a0dea${n}-2df6-7202-aef7-264f5484fbdb`;
const MIN = 60_000;
const etime = (ms: number) => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return `${h ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

let root: string, codex: string, restore: () => void;
let rows: string[], held: Record<number, string[]>, panes: Record<string, { cwd: string; pids: number[] }>;
let folder: string;

function pane(key: string) { return { pane_id: key, workspace_id: "w", tab_id: "w:t", terminal_id: `term-${key}`, agent: "codex", foreground_cwd: panes[key].cwd }; }
/** A process `ago` ms old. */
function proc(pid: number, ppid: number, ago: number, command: string) { rows.push(`${pid} ${ppid} ${etime(ago)} ${command}`); }
/** A TUI pane started `ago` ms ago, in `cwd`, as Codex's npm wrapper chain. */
function tui(key: string, cwd: string, pid: number, ago: number) {
  proc(pid, 1, ago, "/bin/sh /Users/me/.local/bin/codex -m gpt"); proc(pid + 1, pid, ago - 2000, "node /opt/homebrew/bin/codex -m gpt");
  proc(pid + 2, pid + 1, ago - 2000, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/bin/codex -m gpt");
  panes[key] = { cwd, pids: [pid, pid + 1, pid + 2] };
}
/** A rollout begun `ago` ms ago in `cwd`, its first line as Codex 0.157.1 writes it. */
async function rollout(n: number, cwd: string, ago: number, options: { instructions?: number; subagent?: boolean } = {}) {
  const at = new Date(Date.now() - ago).toISOString();
  const meta = { timestamp: at, ordinal: 0, type: "session_meta", payload: { session_id: id(n), id: id(n), timestamp: at, cwd,
    originator: "codex-tui", cli_version: "0.157.1", source: options.subagent ? { subagent: { thread_spawn: { parent_thread_id: id(0) } } } : "vscode",
    thread_source: options.subagent ? "subagent" : "user", base_instructions: { text: "Neutral instructions \"quoted\" \"cwd\":\"/nowhere\" ".repeat(options.instructions ?? 4) } } };
  const file = path.join(folder, `rollout-2026-09-26T10-03-41-${id(n)}.jsonl`);
  await writeFile(file, JSON.stringify(meta) + "\n" + JSON.stringify({ timestamp: at, ordinal: 1, type: "world_state", payload: {} }) + "\n");
  const seconds = (Date.now() - ago) / 1000;
  await utimes(file, seconds, seconds);
  return file;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-codexd-"));
  codex = path.join(root, "codex");
  const today = new Date();
  folder = path.join(codex, "sessions", String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0"));
  await mkdir(folder, { recursive: true });
  vi.stubEnv("CODEX_HOME", codex); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "bridge"));
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  rows = []; held = {}; panes = {};
  resetCodexDaemonCache();
  state.exec.mockReset().mockImplementation(async (file: string, args: string[]) => {
    if (file === "ps") return { stdout: rows.join("\n") + "\n" };
    if (file === "/usr/sbin/lsof") return { stdout: (held[Number(args[2])] ?? []).map(name => `n${name}`).join("\n") + "\n" };
    throw new Error(`unexpected ${file}`);
  });
  restore = setTerminalProvider({
    kind: "fake",
    snapshot: async () => ({ panes: Object.keys(panes).map(pane) }),
    processes: async (_server: string, key: string) => ({ foregroundPids: panes[key]?.pids ?? [] }),
  } as unknown as TerminalProvider);
});
afterEach(async () => { restore(); vi.restoreAllMocks(); vi.unstubAllEnvs(); resetCodexDaemonCache(); await rm(root, { recursive: true, force: true }); });

describe("Codex 0.157 daemon conversations", () => {
  it("names the pane by the rollout the daemon holds for its folder since its TUI started, and refuses the origin pane's binding", async () => {
    proc(50728, 1, 10 * 60 * MIN, DAEMON);
    proc(50746, 1, 10 * 60 * MIN, DAEMON.replace("--listen unix:// --managed-daemon", "daemon pid-update-loop"));
    tui("wC:p1", "/work/other", 400, 11 * 60 * MIN);
    tui("wD:p3", "/work/app", 8250, 7 * MIN);
    const mine = await rollout(1, "/work/app", 7 * MIN - 20_000, { instructions: 3000 });
    const earlier = await rollout(2, "/work/app", 9 * 60 * MIN);
    held[50728] = [mine, earlier, path.join(codex, "thread-writer-locks", `${id(1)}.lock`)];
    // Before the fix, the daemon's hooks bound its conversation to the pane that started it.
    await mkdir(path.dirname(bindingPath("default", "wC:p1")), { recursive: true });
    await writeFile(bindingPath("default", "wC:p1"), JSON.stringify({ terminal: "term-wC:p1", source: "codex", session: id(1), pids: panes["wC:p1"].pids }));
    expect(await paneIdentity("default", pane("wD:p3"), true)).toBe(id(1));
    expect(await paneIdentity("default", pane("wC:p1"), true)).toBeUndefined();
  });

  it("keeps two Codex panes in different folders apart", async () => {
    proc(500, 1, 60 * MIN, DAEMON);
    tui("a", "/work/a", 1000, 20 * MIN); tui("b", "/work/b", 2000, 5 * MIN);
    held[500] = [await rollout(1, "/work/a", 19 * MIN), await rollout(2, "/work/b", 4 * MIN)];
    expect(await paneIdentity("default", pane("a"), true)).toBe(id(1));
    expect(await paneIdentity("default", pane("b"), true)).toBe(id(2));
  });

  it("never gives a pane a conversation begun before its TUI or held by another pane's own process", async () => {
    proc(500, 1, 60 * MIN, DAEMON);
    tui("old", "/work/a", 1000, 30 * MIN); tui("new", "/work/a", 2000, 2 * MIN); tui("own", "/work/a", 3000, 90_000);
    const first = await rollout(1, "/work/a", 29 * MIN), third = await rollout(3, "/work/a", 60_000);
    held[500] = [first, third];
    // An older Codex in the third pane runs its conversation itself.
    held[3002] = [third];
    expect(await paneIdentity("default", pane("old"), true)).toBe(id(1));
    expect(await paneIdentity("default", pane("new"), true)).toBeUndefined();
    expect(await paneIdentity("default", pane("own"), true)).toBe(id(3));
  });

  it("gives each of several Codex panes in one folder the conversation begun after it started", async () => {
    proc(500, 1, 60 * MIN, DAEMON);
    tui("x", "/work/a", 1000, 30 * MIN); tui("y", "/work/a", 2000, 10 * MIN);
    held[500] = [await rollout(1, "/work/a", 29 * MIN), await rollout(2, "/work/a", 9 * MIN)];
    expect(await paneIdentity("default", pane("x"), true)).toBe(id(1));
    expect(await paneIdentity("default", pane("y"), true)).toBe(id(2));
  });

  it("follows a /new in the only Codex pane of its folder to the most recently active conversation", async () => {
    proc(500, 1, 60 * MIN, DAEMON);
    tui("p", "/work/a", 1000, 20 * MIN);
    held[500] = [await rollout(1, "/work/a", 19 * MIN), await rollout(2, "/work/a", 60_000), await rollout(4, "/work/a", 30_000, { subagent: true })];
    expect(await paneIdentity("default", pane("p"), true)).toBe(id(2));
  });

  it("reads recent rollouts from the sessions folder when the daemon holds none open", async () => {
    proc(500, 1, 60 * MIN, DAEMON);
    tui("p", "/work/a", 1000, 20 * MIN);
    await rollout(1, "/work/a", 19 * MIN, { instructions: 3000 });
    await rollout(2, "/work/b", 5 * MIN);
    expect(await paneIdentity("default", pane("p"), true)).toBe(id(1));
  });

  it("recovers an explicitly resumed older conversation held by the daemon, then follows /new", async () => {
    proc(500, 1, 60 * MIN, DAEMON);
    tui("p", "/work/a", 1000, 5 * MIN);
    rows = rows.map(row => row.includes("codex -m gpt") ? row.replace("codex -m gpt", `codex resume ${id(1)}`) : row);
    const old = await rollout(1, "/work/a", 30 * MIN);
    const recent = new Date(Date.now() - MIN);
    await utimes(old, recent, recent);
    held[500] = [old];
    expect(await paneIdentity("default", pane("p"), true)).toBe(id(1));
    held[500].push(await rollout(2, "/work/a", 30_000));
    resetCodexDaemonCache();
    expect(await paneIdentity("default", pane("p"), true)).toBe(id(2));
  });

  it("leaves a Codex pane starting when no daemon runs", async () => {
    tui("p", "/work/a", 1000, 20 * MIN);
    await rollout(1, "/work/a", 19 * MIN);
    expect(await paneIdentity("default", pane("p"), true)).toBeUndefined();
    expect(state.exec.mock.calls.filter(call => call[0] === "/usr/sbin/lsof").map(call => call[1][2])).not.toContain("500");
  });
});

describe("codex-daemon helpers", () => {
  it("uses only an explicit foreground resume launch, not a command embedded in a prompt", () => {
    const row = (pid: number, command: string) => ({ pid, ppid: 1, startedAt: 0, command });
    for (const prefix of ["codex", "/bin/codex", "node /bin/codex", "/bin/sh /home/me/.local/bin/codex"]) {
      expect(resumedConversation([row(1, `${prefix} resume ${id(1)}`)], [1])).toBe(id(1));
    }
    for (const command of [`codex exec echo codex resume ${id(1)}`, `echo codex resume ${id(1)}`, "codex resume --last", "codex resume malformed"]) {
      expect(resumedConversation([row(1, command)], [1])).toBeUndefined();
    }
    expect(resumedConversation([row(2, `codex resume ${id(1)}`)], [1])).toBeUndefined();
    expect(resumedConversation([row(1, `codex resume ${id(1)}`), row(2, `codex resume ${id(2)}`)], [1, 2])).toBeUndefined();
  });

  it("refuses stale, unheld, claimed, ambiguous or competing older resume matches", () => {
    const old = { id: id(1), cwd: "/a", startedAt: 1000, activeAt: 25_000, held: true };
    const self = { key: "a", start: 20_000, resumed: id(1) };
    const match = (here = [old], claimed = new Set<string>(), rivals: { key: string; start: number }[] = []) => assignDaemonConversation(here, self, claimed, rivals, 30_000);
    expect(match()).toBe(id(1));
    expect(match([{ ...old, activeAt: 19_000 }])).toBeUndefined();
    expect(match([{ ...old, activeAt: 100_000 }])).toBeUndefined();
    expect(match([{ ...old, held: false }])).toBeUndefined();
    expect(match([old], new Set([id(1)]))).toBeUndefined();
    expect(match([old, { ...old, id: id(2) }])).toBeUndefined();
    expect(match([old], new Set(), [{ key: "b", start: 10_000 }])).toBeUndefined();
    expect(assignDaemonConversation([old], { ...self, resumed: undefined }, new Set(), [], 30_000)).toBeUndefined();
    expect(assignDaemonConversation([old], { ...self, resumed: id(2) }, new Set(), [], 30_000)).toBeUndefined();
  });

  it("parses ps elapsed times", () => {
    expect(parseElapsed("07:36")).toBe(456_000);
    expect(parseElapsed("10:27:13")).toBe(37_633_000);
    expect(parseElapsed("2-01:00:00")).toBe(176_400_000);
    expect(parseElapsed("soon")).toBeUndefined();
  });

  it("reads a session_meta line longer than the read cap field by field", async () => {
    const file = await rollout(7, "/work/a", MIN, { instructions: 5000 });
    expect(await rolloutMeta(file)).toMatchObject({ id: id(7), cwd: "/work/a", subagent: false });
    const other = path.join(folder, `rollout-2026-09-26T10-03-41-${id(8)}.jsonl`);
    await writeFile(other, JSON.stringify({ type: "session_meta", payload: { id: id(7), cwd: "/work/a", timestamp: new Date().toISOString() } }) + "\n");
    // The id inside must match the file's own name.
    expect(await rolloutMeta(other)).toBeUndefined();
  });

  it("orders equal start times by pane key so two panes never pick the same conversation", () => {
    const here = [1, 2].map(n => ({ id: id(n), cwd: "/a", startedAt: 1000 + n, activeAt: 0, held: true }));
    const a = assignDaemonConversation(here, { key: "a", start: 1000 }, new Set(), [{ key: "b", start: 1000 }], 10_000);
    const b = assignDaemonConversation(here, { key: "b", start: 1000 }, new Set(), [{ key: "a", start: 1000 }], 10_000);
    expect(new Set([a, b])).toEqual(new Set([id(1), id(2)]));
  });

  it("knows a hook runs under the Codex daemon from its process ancestry", async () => {
    proc(500, 1, 60 * MIN, DAEMON);
    proc(900, 500, 1000, "/bin/sh -c node bridge-hook.mjs hook codex");
    proc(901, 900, 1000, "node bridge-hook.mjs hook codex");
    tui("p", "/work/a", 1000, 20 * MIN);
    proc(1100, 1002, 1000, "node bridge-hook.mjs hook codex");
    expect(await underCodexDaemon({}, 901)).toBe(true);
    expect(await underCodexDaemon({}, 1100)).toBe(false);
    expect(await underCodexDaemon({ CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1" }, 1100)).toBe(true);
  });
});
