import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real helper runner is exercised by the pre-spawn and CLI probe tests.
const runner = vi.hoisted(() => ({ spawns: [] as string[][], code: 0 }));
vi.mock("./native-helpers.js", () => ({ verifiedHelper: async () => "/fake/phren-helper" }));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: (file: string, args: string[]) => {
      runner.spawns.push([file, ...args]);
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { on(): void; end(): void }; kill(): void };
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { on() {}, end() {} }, kill() {} });
      queueMicrotask(() => child.emit("close", runner.code));
      return child;
    },
  };
});

import type { Json } from "./protocol.js";
import {
  graphemeCount, MAC_WINDOWS_BUILD_MS, MAC_WINDOWS_IDLE_MS, MAC_WINDOWS_STOP_MS, macWindowAction, macWindowPermissions, macWindowsAct,
  macWindowsEnabled, macWindowsList, macWindowsLocalPermissionReport, macWindowsOwnerOnly, macWindowsRequestPermission, macWindowsSnapshot,
  macWindowsSupported, resetMacWindowsState, runMacWindowsHelper, setMacWindowsDeps, setMacWindowsEnabled, stopMacWindows,
  type MacWindowsBadge, type MacWindowsHelperCall, type MacWindowsHelperResult,
} from "./mac-windows.js";

/** Phone control of Mac windows, with the helpers faked (no Mac, no swiftc). */

const WINDOW = {
  id: 7, app: "Safari", bundleId: "com.apple.Safari", pid: 123, title: "Example",
  frame: { x: 0, y: 25, width: 1200, height: 800 }, onScreen: true,
};
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

class FakeBadge implements MacWindowsBadge {
  ready: Promise<void>;
  kills: string[] = [];
  exits: ((code: number | null) => void)[] = [];
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  constructor(autoReady = true) {
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => undefined);
    if (autoReady) this.resolveReady();
  }
  kill(signal: NodeJS.Signals) { this.kills.push(signal); }
  onExit(listener: (code: number | null) => void) { this.exits.push(listener); }
  exit(code: number) { for (const listener of [...this.exits]) listener(code); }
  becomeReady() { this.resolveReady(); }
  failReady(error = new Error("no ready line")) { this.rejectReady(error); }
}

type Call = { helper: string; args: string[]; input?: string };

let root: string, calls: Call[], spawns: number, badge: FakeBadge, releaseValue: string;
let behaviour: (call: MacWindowsHelperCall) => Partial<MacWindowsHelperResult> | undefined;
let custom: ((call: MacWindowsHelperCall, signal: AbortSignal) => Promise<MacWindowsHelperResult> | undefined) | undefined;
let spawnDelay: (() => Promise<FakeBadge>) | undefined;
let restore: (() => void) | undefined;

function answer(call: MacWindowsHelperCall): MacWindowsHelperResult {
  const base: MacWindowsHelperResult = call.helper === "wincap" && call.args[0] === "list"
    ? { stdout: Buffer.from(JSON.stringify({ windows: [WINDOW] })), stderr: "", code: 0 }
    : call.helper === "wincap" && call.args[0] === "snapshot"
      ? { stdout: JPEG, stderr: "", code: 0 }
      : { stdout: Buffer.alloc(0), stderr: "", code: 0 };
  return { ...base, ...behaviour(call) };
}

const logRows = async (): Promise<Json[]> => {
  const text = await readFile(path.join(root, "mac-windows", "sessions.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as Json);
};

/** Polls a condition on real timers, for lifecycle tests that need actual events. */
async function until(condition: () => boolean, label = "condition"): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-mac-windows-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  vi.useFakeTimers();
  calls = []; spawns = 0; badge = new FakeBadge(); releaseValue = "23.6.0";
  behaviour = () => undefined; custom = undefined; spawnDelay = undefined;
  runner.spawns = []; runner.code = 0;
  resetMacWindowsState();
  restore = setMacWindowsDeps({
    platform: () => "darwin",
    release: () => releaseValue,
    now: () => Date.now(),
    // The 500 ms enable poll would otherwise fire hundreds of times when a test advances the idle clock.
    pollMs: () => 3_600_000,
    run: async (call, signal) => {
      calls.push({ helper: call.helper, args: call.args, ...(call.input !== undefined ? { input: call.input } : {}) });
      return custom?.(call, signal) ?? answer(call);
    },
    spawnBadge: async () => { spawns++; return spawnDelay ? spawnDelay() : badge; },
  });
});

afterEach(async () => {
  restore?.(); restore = undefined;
  resetMacWindowsState();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("mac windows: off, validation and the setting file", () => {
  it("answers disabled without running a helper, and off by default", async () => {
    expect(await macWindowsEnabled()).toBe(false);
    expect(await macWindowsList()).toEqual({ enabled: false, permissions: { screenRecording: false, accessibility: false }, windows: [] });
    expect(calls).toEqual([]);
    expect(spawns).toBe(0);
  });

  it("writes and reads the per-computer setting", async () => {
    await setMacWindowsEnabled(true);
    expect(await macWindowsEnabled()).toBe(true);
    const file = path.join(root, "mac-windows.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ enabled: true });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    await setMacWindowsEnabled(false);
    expect(await macWindowsEnabled()).toBe(false);
  });

  it("refuses invalid ids, points, text, keys and modifiers before anything runs", async () => {
    const invalid = [
      { action: "tap", id: 0, x: 0.5, y: 0.5 },
      { action: "tap", id: 5, x: 1.5, y: 0.5 },
      { action: "tap", id: 2 ** 32, x: 0.5, y: 0.5 },
      { action: "type", id: 5, text: "" },
      { action: "type", id: 5, text: "a".repeat(2_001) },
      { action: "type", id: 5, text: "a\u0000b" },
      { action: "type", id: 5, text: "a", submit: "yes" },
      { action: "key", id: 5, key: "f13" },
      { action: "key", id: 5, key: "a", modifiers: ["meta"] },
      { action: "raise", id: 0 },
    ];
    for (const body of invalid) await expect(macWindowsAct(body)).rejects.toMatchObject({ status: 400 });
    await expect(macWindowsSnapshot("nope")).rejects.toMatchObject({ status: 400 });
    await expect(macWindowsSnapshot(5, 100)).rejects.toMatchObject({ status: 400 });
    await expect(macWindowsSnapshot(5, 1600, 95)).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
    expect(spawns).toBe(0);
  });

  it("counts user-perceived characters, so emoji fit and submit adds Return after the limit", () => {
    expect(graphemeCount("👨‍👩‍👧‍👦")).toBe(1);
    expect(graphemeCount("a".repeat(2_000))).toBe(2_000);
    expect(macWindowAction.safeParse({ action: "type", id: 5, text: "😀".repeat(1_001), submit: true }).success).toBe(true);
    expect(macWindowAction.safeParse({ action: "type", id: 5, text: "😀".repeat(2_001) }).success).toBe(false);
  });

  it("is owner-only", () => {
    let refusal: unknown;
    try { macWindowsOwnerOnly(false); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ status: 403, details: { code: "mac-windows-owner-only" } });
    expect(() => macWindowsOwnerOnly(true)).not.toThrow();
  });

  it("is offered on macOS 14 or later only", async () => {
    expect(macWindowsSupported("darwin", "23.0.0")).toBe(true);
    expect(macWindowsSupported("darwin", "22.6.0")).toBe(false);
    expect(macWindowsSupported("linux", "23.0.0")).toBe(false);
    releaseValue = "22.6.0";
    await expect(macWindowsList()).rejects.toMatchObject({ status: 404, message: "Mac windows need macOS 14 or later." });
    expect(calls).toEqual([]);
  });
});

describe("mac windows: requests", () => {
  beforeEach(async () => { await setMacWindowsEnabled(true); });

  it("passes tap, type, key and raise as the helper's argv, with text only on stdin", async () => {
    await macWindowsAct({ action: "tap", id: 42, x: 0.25, y: 0.75 });
    await macWindowsAct({ action: "type", id: 42, text: "hello", submit: true });
    await macWindowsAct({ action: "type", id: 42, text: "quiet" });
    await macWindowsAct({ action: "key", id: 42, key: "a", modifiers: ["control", "cmd"] });
    await macWindowsAct({ action: "raise", id: 42 });
    const ran = calls.filter(call => call.helper === "wininput" && !["check", "prompt"].includes(call.args[0]));
    expect(ran.map(call => call.args)).toEqual([
      ["tap", "42", "0.25", "0.75"],
      ["type", "42"],
      ["type", "42"],
      ["key", "42", "a", "cmd", "control"],
      ["raise", "42"],
    ]);
    expect(ran.map(call => call.input)).toEqual([undefined, "hello\n", "quiet", undefined, undefined]);
    expect(ran.every(call => !call.args.some(arg => /hello|quiet/.test(arg)))).toBe(true);
  });

  it("captures one JPEG with the contract's size and quality arguments", async () => {
    expect(await macWindowsSnapshot(7, 320, 50)).toEqual(JPEG);
    expect(calls.filter(call => call.helper === "wincap" && call.args[0] === "snapshot").map(call => call.args)).toEqual([
      ["snapshot", "7", "320", "0.5"],
    ]);
  });

  it("logs admission and completion with characters, never the text, in one session", async () => {
    await macWindowsAct({ action: "type", id: 7, text: "top secret" });
    await macWindowsAct({ action: "raise", id: 7 });
    const rows = await logRows();
    const typed = rows.filter(row => row.action === "type");
    expect(typed).toHaveLength(2);
    expect(typed[0]).toMatchObject({ windowId: 7, ok: true, chars: 10, admitted: true, session: expect.any(String) });
    expect(typed[1]).toMatchObject({ windowId: 7, ok: true, chars: 10 });
    expect(JSON.stringify(rows)).not.toContain("top secret");
    expect(new Set(rows.map(row => row.session)).size).toBe(1);
    expect(spawns).toBe(1);
  });

  it("shares one indicator startup between concurrent first requests", async () => {
    // The indicator build/spawn and its ready line happen on real timers here.
    vi.useRealTimers();
    badge = new FakeBadge(false);
    const first = macWindowsAct({ action: "tap", id: 7, x: 0.1, y: 0.1 });
    const second = macWindowsAct({ action: "tap", id: 7, x: 0.9, y: 0.9 });
    await until(() => spawns === 1, "one badge spawn");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(spawns).toBe(1);
    expect(calls.filter(call => call.helper === "wininput" && call.args[0] === "tap")).toHaveLength(0);
    badge.becomeReady();
    await Promise.all([first, second]);
    expect(calls.filter(call => call.helper === "wininput" && call.args[0] === "tap")).toHaveLength(2);
  });

  it("refuses when the indicator never reports ready", async () => {
    vi.useRealTimers();
    badge = new FakeBadge(false);
    const pending = macWindowsList();
    await until(() => spawns === 1, "the badge spawn");
    badge.failReady();
    await expect(pending).rejects.toMatchObject({ status: 409, details: { code: "mac-windows-indicator" } });
    expect(calls).toEqual([]);
  });

  it("spawns one badge, SIGTERMs it after 120 s idle and writes session-end", async () => {
    await macWindowsList();
    await macWindowsList();
    expect(spawns).toBe(1);
    expect(badge.kills).toEqual([]);
    const listed = (await logRows()).filter(row => row.action === "list");
    expect(listed).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(MAC_WINDOWS_IDLE_MS + 1);
    expect(badge.kills).toEqual(["SIGTERM"]);
    // The session-end row is written asynchronously; wait on real timers for it.
    vi.useRealTimers();
    await vi.waitFor(async () => {
      const end = (await logRows()).at(-1);
      expect(end).toMatchObject({ action: "session-end", session: listed[0].session });
    });
    await macWindowsList();
    expect(spawns).toBe(2);
  });

  it("ends the session and refuses for a minute when Stop is pressed on the Mac", async () => {
    await macWindowsList();
    badge.exit(10);
    await expect(macWindowsAct({ action: "raise", id: 7 })).rejects.toMatchObject({ status: 409, details: { code: "mac-windows-stopped" } });
    await vi.advanceTimersByTimeAsync(MAC_WINDOWS_STOP_MS + 1);
    await expect(macWindowsAct({ action: "raise", id: 7 })).resolves.toEqual({ ok: true });
    expect(spawns).toBe(2);
  });

  it("stops a running input cooperatively when Stop is pressed", async () => {
    vi.useRealTimers();
    let stopped = false;
    custom = (call, signal) => call.helper === "wininput" && call.args[0] === "type"
      ? new Promise(resolve => signal.addEventListener("abort", () => {
        stopped = true;
        resolve({ stdout: Buffer.alloc(0), stderr: "cancelled\n", code: 8 });
      }, { once: true }))
      : undefined;
    const typing = macWindowsAct({ action: "type", id: 7, text: "secret" });
    await until(() => calls.some(call => call.helper === "wininput" && call.args[0] === "type"), "the typing child");
    badge.exit(10);
    await expect(typing).rejects.toMatchObject({
      status: 409, message: "Phone control ended before that input finished; part of the text may have been typed.", details: { code: "mac-windows-cancelled" },
    });
    expect(stopped).toBe(true);
  });

  it("reports success when the helper finished as cancellation arrived", async () => {
    vi.useRealTimers();
    custom = (call, signal) => call.helper === "wininput" && call.args[0] === "type"
      ? new Promise(resolve => signal.addEventListener("abort", () => resolve({ stdout: Buffer.alloc(0), stderr: "", code: 0 }), { once: true }))
      : undefined;
    const typing = macWindowsAct({ action: "type", id: 7, text: "hello" });
    await until(() => calls.some(call => call.helper === "wininput" && call.args[0] === "type"), "the typing child");
    badge.exit(10);
    await expect(typing).resolves.toEqual({ ok: true });
  });

  it("refuses a queued action after the feature is turned off", async () => {
    vi.useRealTimers();
    let releaseFirst!: () => void;
    custom = call => call.helper === "wininput" && call.args[0] === "tap"
      ? new Promise(resolve => {
        if (call.args[2] === "0.1") releaseFirst = () => resolve({ stdout: Buffer.alloc(0), stderr: "", code: 0 });
        else resolve({ stdout: Buffer.alloc(0), stderr: "", code: 0 });
      })
      : undefined;
    const first = macWindowsAct({ action: "tap", id: 7, x: 0.1, y: 0.1 });
    const second = macWindowsAct({ action: "tap", id: 7, x: 0.2, y: 0.2 });
    await until(() => calls.filter(call => call.args[0] === "tap").length === 1, "the first tap");
    await setMacWindowsEnabled(false);
    releaseFirst();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).rejects.toMatchObject({ status: 409, details: { code: "mac-windows-disabled" } });
    expect(calls.filter(call => call.args[0] === "tap")).toHaveLength(1);
  });

  it("does not idle out a request that is in flight", async () => {
    let release!: () => void;
    custom = call => call.helper === "wininput" && call.args[0] === "raise"
      ? new Promise(resolve => { release = () => resolve({ stdout: Buffer.alloc(0), stderr: "", code: 0 }); })
      : undefined;
    const raising = macWindowsAct({ action: "raise", id: 7 });
    for (let tick = 0; tick < 50 && !calls.some(call => call.args[0] === "raise"); tick++) await vi.advanceTimersByTimeAsync(5);
    expect(calls.some(call => call.args[0] === "raise")).toBe(true);
    await vi.advanceTimersByTimeAsync(MAC_WINDOWS_IDLE_MS + 1);
    expect(badge.kills).toEqual([]);
    release();
    await expect(raising).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(MAC_WINDOWS_IDLE_MS + 1);
    expect(badge.kills).toEqual(["SIGTERM"]);
  });

  it("refuses new sessions while shutting down and disposes a late badge", async () => {
    vi.useRealTimers();
    let releaseSpawn!: () => void;
    const lateBadge = new FakeBadge(false);
    spawnDelay = () => new Promise<FakeBadge>(resolve => { releaseSpawn = () => resolve(lateBadge); });
    const starting = macWindowsList().catch(error => error);
    await until(() => spawns === 1, "the badge spawn");
    const stopping = stopMacWindows();
    releaseSpawn();
    await stopping;
    await expect(starting).resolves.toMatchObject({ status: 409 });
    expect(lateBadge.kills).toContain("SIGTERM");
    await expect(macWindowsList()).rejects.toMatchObject({ status: 503, details: { code: "mac-windows-shutdown" } });
  });

  it("disposes a badge that arrives after the startup deadline", async () => {
    let releaseSpawn!: () => void;
    const lateBadge = new FakeBadge(false);
    spawnDelay = () => new Promise<FakeBadge>(resolve => { releaseSpawn = () => resolve(lateBadge); });
    const starting = macWindowsList().catch(error => error);
    for (let tick = 0; tick < 50 && spawns === 0; tick++) await vi.advanceTimersByTimeAsync(5);
    expect(spawns).toBe(1);
    await vi.advanceTimersByTimeAsync(MAC_WINDOWS_BUILD_MS + 1);
    releaseSpawn();
    await vi.advanceTimersByTimeAsync(0);
    expect(lateBadge.kills).toContain("SIGTERM");
    await expect(starting).resolves.toMatchObject({ status: 409, details: { code: "mac-windows-indicator" } });
  });

  it("reports a window that lost focus before the input landed", async () => {
    behaviour = call => call.helper === "wininput" && call.args[0] === "tap" ? { code: 6, stderr: "focus\n" } : undefined;
    await expect(macWindowsAct({ action: "tap", id: 7, x: 0.2, y: 0.2 })).rejects.toMatchObject({
      status: 409, message: "That window lost focus on the Mac before the input landed. Nothing more was sent.", details: { code: "mac-windows-focus" },
    });
  });

  it("reports a helper that stopped because its parent died", async () => {
    behaviour = call => call.helper === "wininput" && call.args[0] === "tap" ? { code: 7, stderr: "orphaned\n" } : undefined;
    await expect(macWindowsAct({ action: "tap", id: 7, x: 0.2, y: 0.2 })).rejects.toMatchObject({
      status: 409, message: "The Mac window helper stopped.", details: { code: "mac-windows-helper" },
    });
  });

  it("does not spawn when the session ends during the pre-spawn setting read", async () => {
    vi.useRealTimers();
    let releaseRead!: (enabled: boolean) => void, reads = 0;
    setMacWindowsDeps({ run: runMacWindowsHelper, enabled: () => { reads++; return new Promise<boolean>(resolve => { releaseRead = resolve; }); } });
    await setMacWindowsEnabled(true);
    const acting = macWindowsAct({ action: "raise", id: 7 }).catch(error => error);
    await until(() => reads === 1, "the pre-spawn setting read");
    const stopping = stopMacWindows();
    releaseRead(true);
    await stopping;
    await expect(acting).resolves.toMatchObject({ status: 409, details: { code: "mac-windows-cancelled" } });
    expect(runner.spawns).toEqual([]);
  });

  it("maps helper exit codes to permission and missing-window errors, prompting once", async () => {
    behaviour = call => call.helper === "wininput" && call.args[0] === "tap" ? { code: 3, stderr: "accessibility\n" } : undefined;
    await expect(macWindowsAct({ action: "tap", id: 7, x: 0.1, y: 0.1 })).rejects.toMatchObject({ status: 403, details: { code: "mac-windows-accessibility" } });
    await expect(macWindowsAct({ action: "tap", id: 7, x: 0.1, y: 0.1 })).rejects.toMatchObject({ status: 403, details: { code: "mac-windows-accessibility" } });
    expect(calls.filter(call => call.helper === "wininput" && call.args[0] === "prompt")).toHaveLength(1);

    behaviour = call => call.helper === "wincap" && call.args[0] === "snapshot" ? { code: 3, stderr: "screen-recording\n" } : undefined;
    await expect(macWindowsSnapshot(7)).rejects.toMatchObject({ status: 403, details: { code: "mac-windows-screen-recording" } });
    await expect(macWindowsSnapshot(7)).rejects.toMatchObject({ status: 403, details: { code: "mac-windows-screen-recording" } });
    expect(calls.filter(call => call.helper === "wincap" && call.args[0] === "prompt")).toHaveLength(1);

    behaviour = call => call.helper === "wincap" && call.args[0] === "snapshot" ? { code: 5, stderr: "no window\n" } : undefined;
    await expect(macWindowsSnapshot(7)).rejects.toMatchObject({ status: 404 });
  });
});

describe("mac windows: permissions", () => {
  it("lists windows only with Screen Recording and reports both grants", async () => {
    await setMacWindowsEnabled(true);
    const full = await macWindowsList();
    expect(full).toMatchObject({ enabled: true, permissions: { screenRecording: true, accessibility: true }, windows: [WINDOW] });

    behaviour = call => call.helper === "wincap" && call.args[0] === "check" ? { code: 3 } : undefined;
    calls = [];
    const missing = await macWindowsList();
    expect(missing).toMatchObject({ enabled: true, permissions: { screenRecording: false, accessibility: true }, windows: [] });
    expect(calls.some(call => call.args[0] === "list")).toBe(false);
  });

  it("asks for one grant and answers both permissions", async () => {
    await setMacWindowsEnabled(true);
    const permissions = await macWindowsRequestPermission("screen-recording");
    expect(permissions).toEqual({ screenRecording: true, accessibility: true });
    expect(calls.map(call => [call.helper, call.args[0]])).toEqual([["wincap", "prompt"], ["wincap", "check"], ["wininput", "check"]]);
    await expect(macWindowsRequestPermission("microphone")).rejects.toMatchObject({ status: 400 });
  });

  it("refuses the permission prompt while the feature is off", async () => {
    await expect(macWindowsRequestPermission("screen-recording")).rejects.toMatchObject({ status: 409, details: { code: "mac-windows-disabled" } });
    expect(calls).toEqual([]);
    expect(spawns).toBe(0);
  });

  it("fails the list when a helper cannot be built or run, instead of reporting a denied grant", async () => {
    await setMacWindowsEnabled(true);
    behaviour = call => call.helper === "wincap" && call.args[0] === "check" ? { code: 127, stderr: "spawn failed\n" } : undefined;
    await expect(macWindowsList()).rejects.toMatchObject({ status: 409, details: { code: "mac-windows-helper" }, message: expect.stringContaining("spawn failed") });
    expect(calls.some(call => call.args[0] === "list")).toBe(false);
  });

  it("answers the CLI status probes while phone control is off", async () => {
    vi.useRealTimers();
    setMacWindowsDeps({ run: runMacWindowsHelper });
    const report = await macWindowsLocalPermissionReport();
    expect(report).toEqual({ screenRecording: { granted: true }, accessibility: { granted: true } });
    expect(runner.spawns).toHaveLength(2);
    expect(runner.spawns.every(args => args[1] === "check")).toBe(true);
    // Session work still refuses without the setting.
    await expect(macWindowPermissions()).rejects.toMatchObject({ status: 409, details: { code: "mac-windows-disabled" } });
  });

  it("refuses the permission route when Stop arrives during its probes", async () => {
    vi.useRealTimers();
    await setMacWindowsEnabled(true);
    custom = (call, signal) => call.args[0] === "check"
      ? new Promise(resolve => signal.addEventListener("abort", () => resolve({ stdout: Buffer.alloc(0), stderr: "", code: 0 }), { once: true }))
      : undefined;
    const asking = macWindowsRequestPermission("accessibility").catch(error => error);
    await until(() => calls.filter(call => call.args[0] === "check").length === 2, "both probes");
    badge.exit(10);
    await expect(asking).resolves.toMatchObject({ status: 409, details: { code: "mac-windows-cancelled" } });
  });
});
