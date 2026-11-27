import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAC_WINDOWS_IDLE_MS, MAC_WINDOWS_STOP_MS,
  type MacWindowsBadge, type MacWindowsHelperCall, type MacWindowsHelperResult, macWindowsAct, macWindowsEnabled, macWindowsList, macWindowsOwnerOnly,
  macWindowsRequestPermission, macWindowsSnapshot, resetMacWindowsState, setMacWindowsDeps, setMacWindowsEnabled,
} from "./mac-windows.js";
import type { Json } from "./protocol.js";

/** Phone control of Mac windows, with the helpers faked (no Mac, no swiftc). */

const WINDOW = {
  id: 7, app: "Safari", bundleId: "com.apple.Safari", pid: 123, title: "Example",
  frame: { x: 0, y: 25, width: 1200, height: 800 }, onScreen: true,
};
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

class FakeBadge implements MacWindowsBadge {
  kills: string[] = [];
  exits: ((code: number | null) => void)[] = [];
  kill(signal: NodeJS.Signals) { this.kills.push(signal); }
  onExit(listener: (code: number | null) => void) { this.exits.push(listener); }
  exit(code: number) { for (const listener of this.exits) listener(code); }
}

let root: string, calls: MacWindowsHelperCall[], spawns: number, badge: FakeBadge;
let behaviour: (call: MacWindowsHelperCall) => Partial<MacWindowsHelperResult> | undefined;
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

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-mac-windows-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  vi.useFakeTimers();
  calls = []; spawns = 0; badge = new FakeBadge(); behaviour = () => undefined;
  resetMacWindowsState();
  restore = setMacWindowsDeps({
    platform: () => "darwin",
    now: () => Date.now(),
    run: async call => { calls.push(call); return answer(call); },
    spawnBadge: async () => { spawns++; return badge; },
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

  it("is owner-only", () => {
    let refusal: unknown;
    try { macWindowsOwnerOnly(false); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ status: 403, details: { code: "mac-windows-owner-only" } });
    expect(() => macWindowsOwnerOnly(true)).not.toThrow();
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

  it("logs characters, never the text, and starts no second session", async () => {
    await macWindowsAct({ action: "type", id: 7, text: "top secret" });
    await macWindowsAct({ action: "raise", id: 7 });
    const rows = await logRows();
    const typed = rows.find(row => row.action === "type");
    expect(typed).toMatchObject({ action: "type", windowId: 7, ok: true, chars: 10, session: expect.any(String) });
    expect(JSON.stringify(rows)).not.toContain("top secret");
    expect(new Set(rows.map(row => row.session)).size).toBe(1);
    expect(spawns).toBe(1);
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
    const permissions = await macWindowsRequestPermission("screen-recording");
    expect(permissions).toEqual({ screenRecording: true, accessibility: true });
    expect(calls.map(call => [call.helper, call.args[0]])).toEqual([["wincap", "prompt"], ["wincap", "check"], ["wininput", "check"]]);
    await expect(macWindowsRequestPermission("microphone")).rejects.toMatchObject({ status: 400 });
  });
});
