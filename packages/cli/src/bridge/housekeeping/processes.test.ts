import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { PaneRef, ProcessRow } from "../resources.js";
import { endProcess, listProcesses, processGroups, type ProcessSources } from "./processes.js";

const MB = 1024 ** 2;
const row = (pid: number, ppid: number, command: string, rssMB: number, cpu = 0): ProcessRow =>
  ({ pid, ppid, pgid: pid, cpu, rssKB: rssMB * 1024, command, args: `${command} --flag` });
const UID = 501;
const sources = (rows: ProcessRow[], over: Partial<ProcessSources> = {}): ProcessSources => ({
  rows: async () => rows, platform: "darwin", uid: UID, selfPid: 9999,
  uids: async pids => new Map(pids.map(pid => [pid, pid === 700 ? 0 : UID])),
  starts: async pids => new Map(pids.map(pid => [pid, `start-${pid}`])),
  swap: async () => new Map([[11, 300 * MB]]), cpu: async () => new Map(), ...over,
});

describe("processes", () => {
  // A browser with renderers, a hog, a busy compiler, Phren Hook, a root daemon, the session's compositor, an agent pane.
  const table = [
    row(1, 0, "/sbin/launchd", 20),
    row(10, 1, "/usr/lib/chromium/chromium", 400), row(11, 10, "/usr/lib/chromium/chromium", 900), row(12, 10, "/usr/lib/chromium/chromium", 700),
    row(20, 1, "/usr/bin/node", 2_000), row(30, 1, "swift-frontend", 120, 380),
    row(9998, 1, "node", 300), row(9999, 9998, "node", 200),
    row(700, 1, "/usr/sbin/mds_stores", 600), row(800, 1, "Hyprland", 500),
    row(900, 1, "zsh", 10), row(901, 900, "claude", 800),
    { ...row(40, 1, "/usr/bin/psql", 300), args: "psql postgres://admin:hunter2secret@db.internal/prod --set token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
  ];
  const owners = new Map<number, PaneRef>([[900, { server: "default", pane: "w1:p1", label: "lead" }]]);

  it("groups a program's helpers under the process that started them", () => {
    expect(processGroups(table).get(10)?.map(r => r.pid)).toEqual([10, 11, 12]);
    expect(processGroups(table).has(11)).toBe(false);
  });

  it("lists the biggest programs with memory, swap and CPU, and says why one can't be ended", async () => {
    const list = await listProcesses(sources(table, { owners: async () => owners, conductors: async () => new Set() }));
    const by = (pid: number) => list.find(r => r.pid === pid)!;
    expect(list[0]).toMatchObject({ name: "chromium", pid: 10, processes: 3, memoryBytes: 2_000 * MB, swapBytes: 300 * MB });
    expect(by(10).action).toMatchObject({ kind: "end-process", allowed: true, label: "End chromium (3 processes)" });
    expect(by(20).action.allowed).toBe(true);
    expect(by(30)).toMatchObject({ cpuPercent: 380 });
    expect(by(9998).action.reason).toBe("It runs Phren Hook.");
    expect(by(700).action.reason).toBe("It belongs to another user.");
    expect(by(800).action.reason).toBe("Your computer or session needs Hyprland.");
    // The agent's own child is fair game; the pane's shell is closed from Sessions.
    expect(by(901)).toMatchObject({ pane: { server: "default", pane: "w1:p1", label: "lead" } });
    expect(by(901).action.allowed).toBe(true);
    // Secrets in a command line never leave the computer.
    expect(by(40).command).not.toMatch(/hunter2secret|ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
    // Tiny processes (launchd at 20 MB, the shell) are not listed.
    expect(list.some(r => r.pid === 1 || r.pid === 900)).toBe(false);
  });

  it("never ends the conductor, and a changed process gets a new id", async () => {
    const conductor = await listProcesses(sources(table, { owners: async () => owners, conductors: async () => new Set(["default/w1:p1"]) }));
    expect(conductor.find(r => r.pid === 901)?.action.reason).toBe("It is the conductor.");
    const first = (await listProcesses(sources(table))).find(r => r.pid === 20)!.id;
    const restarted = (await listProcesses(sources(table, { starts: async pids => new Map(pids.map(pid => [pid, "later"])) }))).find(r => r.pid === 20)!.id;
    expect(restarted).not.toBe(first);
  });

  it("ends the approved program, and refuses one that is gone or protected", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise(done => child.once("spawn", done));
    const exited = new Promise(done => child.once("exit", done));
    const pid = child.pid!;
    const live = [row(pid, process.pid, "hog", 500)];
    const src = sources(live, { selfPid: 1, uids: async pids => new Map(pids.map(p => [p, UID])) });
    const [hog] = await listProcesses(src);
    expect(await endProcess("nope", src)).toMatchObject({ status: "gone" });
    expect(await endProcess(hog.id, src)).toEqual({ status: "done", freedBytes: 500 * MB });
    await exited;
    const protectedRow = await listProcesses(sources(table));
    const hyprland = protectedRow.find(r => r.pid === 800)!;
    expect(await endProcess(hyprland.id, sources(table))).toEqual({ status: "refused", reason: "Your computer or session needs Hyprland." });
  });
});
