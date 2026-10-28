import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => {
  const execFile = Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: mocks.execute });
  return { execFile };
});
import { DRAG_DEFAULT_MS, SIMULATOR_DEVICE_LIMIT, simulatorAct, simulatorDevices, type SimulatorAction, verifiedHelper } from "./simulators.js";
const udid = "AAAAAAAA-1111-4111-8111-111111111111";
let root: string, calls: { file: string; args: string[] }[], compiled: { output: string; source: string }[];
let options: { timeout?: number; killSignal?: string }[];
beforeEach(async () => {
  root = await mkdtemp("/tmp/phren-simulator-"); vi.stubEnv("PHREN_BRIDGE_HOME", root);
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  calls = []; compiled = []; options = [];
  mocks.execute.mockImplementation(async (file: string, args: string[], given?: { timeout?: number; killSignal?: string }) => {
    calls.push({ file, args });
    if (given) options.push(given);
    if (file === "/usr/bin/swiftc") {
      // What the compiler was given, read before the build deletes it.
      compiled.push({ output: args[args.indexOf("-o") + 1], source: await readFile(args.at(-1)!, "utf8") });
      await writeFile(args[args.indexOf("-o") + 1], "compiled binary");
    }
    return { stdout: file === "/usr/bin/xcrun" ? JSON.stringify({ devices: { "iOS-26-1": [{ udid, name: "iPhone", state: "Booted" }] } }) : "", stderr: "" };
  });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

// iOS Simulator input runs on macOS only (simulators.ts refuses every other platform).
describe.skipIf(process.platform === "win32")("simulator input hardening", () => {
  it.each([
    { action: "type", text: "a".repeat(501) }, { action: "type", text: "line\nnext" },
    ...Array.from({ length: 32 }, (_, code) => ({ action: "type", text: "a" + String.fromCharCode(code), submit: code !== 10 })),
    { action: "launch", bundleId: "--console" }, { action: "unknown" },
  ])("rejects invalid input before any execution: %j", async request => {
    await expect(simulatorAct(udid, request as SimulatorAction)).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });
  it("accepts 500 characters and explicit submit, compiles atomically once, and records both hashes", async () => {
    await simulatorAct(udid, { action: "type", text: "a".repeat(500) });
    await simulatorAct(udid, { action: "type", text: "one\ntwo", submit: true });
    const binary = path.join(root, "native/simtap"), sidecar = JSON.parse(await readFile(binary + ".sha256", "utf8"));
    expect(sidecar).toEqual({ sourceSha: expect.stringMatching(/^[a-f0-9]{64}$/), binarySha: createHash("sha256").update("compiled binary").digest("hex") });
    expect((await stat(binary)).mode & 0o777).toBe(0o700);
    expect((await readdir(path.dirname(binary))).sort()).toEqual(["simtap", "simtap.sha256"]);
    const compile = calls.filter(c => c.file === "/usr/bin/swiftc");
    expect(compile).toHaveLength(1); expect(compile[0].args[2]).toMatch(/simtap\.[a-f0-9-]{36}$/);
    expect(calls.filter(c => c.file === binary).map(c => c.args)).toEqual([
      ["iPhone", "type", "a".repeat(500)], ["iPhone", "type", "one\ntwo", "submit"],
    ]);
    expect(calls.every(c => path.isAbsolute(c.file))).toBe(true);
  });
  it("builds the stream helper beside simtap from its own source, once", async () => {
    await simulatorAct(udid, { action: "home" });
    const binary = await verifiedHelper("simcast");
    expect(binary).toBe(path.join(root, "native/simcast"));
    await verifiedHelper("simcast");
    const source = (name: string) => readFile(new URL(`./native/${name}.swift`, import.meta.url), "utf8");
    expect(compiled).toEqual([
      { output: expect.stringMatching(/simtap\.[a-f0-9-]{36}$/), source: await source("simtap") },
      { output: expect.stringMatching(/simcast\.[a-f0-9-]{36}$/), source: await source("simcast") },
    ]);
    expect(await source("simcast")).not.toBe(await source("simtap"));
    expect((await readdir(path.dirname(binary))).sort()).toEqual(["simcast", "simcast.sha256", "simtap", "simtap.sha256"]);
    await writeFile(binary, "TAMPERED");
    await expect(verifiedHelper("simcast")).rejects.toMatchObject({ status: 409, message: "Simulator stream helper integrity check failed." });
  });
  it("verifies the binary again before every exec and rejects tampering without executing it", async () => {
    await simulatorAct(udid, { action: "home" });
    const binary = path.join(root, "native/simtap");
    await writeFile(binary, "TAMPERED");
    await expect(simulatorAct(udid, { action: "home" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("integrity") });
    expect(calls.filter(c => c.file === binary)).toHaveLength(1);
    expect(calls.filter(c => c.file === "/usr/bin/swiftc")).toHaveLength(1);
  });
  it("kills every simulator child outright at its timeout", async () => {
    // SIGTERM, the default, could be ignored and leave a stream's slot taken for good.
    await simulatorAct(udid, { action: "home" });
    expect(options.length).toBeGreaterThan(1);
    for (const given of options) expect(given).toMatchObject({ timeout: expect.any(Number), killSignal: "SIGKILL" });
  });

  it("serializes both builds and input invocations and recovers after focus loss", async () => {
    const impl = mocks.execute.getMockImplementation()!;
    let active = 0, peak = 0;
    mocks.execute.mockImplementation(async (file, args) => {
      if (file.endsWith("/simtap") || file === "/usr/bin/swiftc") {
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 10)); active--;
      }
      if (file.endsWith("/simtap") && args.includes("first")) throw { stderr: "focus lost" };
      return impl(file, args);
    });
    const results = await Promise.allSettled([simulatorAct(udid, { action: "type", text: "first" }), simulatorAct(udid, { action: "type", text: "second" })]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { status: 409, message: expect.stringContaining("focus lost") } });
    expect(results[1]).toMatchObject({ status: "fulfilled", value: { ok: true } });
    expect(peak).toBe(1); expect(calls.filter(c => c.file === "/usr/bin/swiftc")).toHaveLength(1);
  });
  it("cleans failed builds without installing partial binaries", async () => {
    mocks.execute.mockImplementation(async (file: string, args: string[]) => {
      if (file === "/usr/bin/swiftc") { await writeFile(args[2], "partial"); throw new Error("failed"); }
      return { stdout: JSON.stringify({ devices: { ios: [{ udid, name: "iPhone", state: "Booted" }] } }) };
    });
    await expect(simulatorAct(udid, { action: "home" })).rejects.toMatchObject({ status: 409 });
    expect(await readdir(path.join(root, "native"))).toEqual([]);
  });
  it("asks macOS for the Accessibility grant once, explains the 403, and opens the pane on request", async () => {
    const impl = mocks.execute.getMockImplementation()!;
    mocks.execute.mockImplementation(async (file: string, args: string[]) => {
      if (file.endsWith("/simtap") && args[1] !== "prompt") { calls.push({ file, args }); throw { stderr: "accessibility" }; }
      return impl(file, args);
    });
    const binary = path.join(root, "native/simtap");
    for (let i = 0; i < 2; i++) {
      await expect(simulatorAct(udid, { action: "home" })).rejects.toMatchObject({
        status: 403, message: expect.stringContaining("switch on simtap"), details: { code: "simulator-accessibility", helper: binary },
      });
    }
    const prompts = () => calls.filter(c => c.file === binary && c.args[1] === "prompt");
    expect(prompts()).toHaveLength(1);
    await expect(simulatorAct(udid, { action: "accessibility-settings" })).resolves.toEqual({ ok: true, trusted: true, helper: binary });
    expect(prompts()).toHaveLength(2);
    expect(calls.at(-1)).toEqual({ file: "/usr/bin/open", args: ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"] });
  });
  it.each([
    { action: "drag", x1: -0.1, y1: 0.5, x2: 0.5, y2: 0.5 }, { action: "drag", x1: 0.5, y1: 0.5, x2: 1.2, y2: 0.5 },
    { action: "drag", x1: 0.5, y1: 0.5, x2: 0.5 }, { action: "drag", x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.1, durationMs: 10 },
    { action: "drag", x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.1, durationMs: 9_000 }, { action: "drag", x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.1, durationMs: 120.5 },
  ])("rejects a drag outside the screen or its duration bounds before any execution: %j", async request => {
    await expect(simulatorAct(udid, request as SimulatorAction)).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });
  it("drags from point to point over the given time, 300 ms by default, through the input helper", async () => {
    await simulatorAct(udid, { action: "drag", x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2 });
    await simulatorAct(udid, { action: "drag", x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, durationMs: 1_000 });
    const binary = path.join(root, "native/simtap");
    expect(calls.filter(c => c.file === binary).map(c => c.args)).toEqual([
      ["iPhone", "drag", "0.5", "0.8", "0.5", "0.2", String(DRAG_DEFAULT_MS)], ["iPhone", "drag", "0.1", "0.5", "0.9", "0.5", "1000"],
    ]);
    // The helper presses, moves in interpolated steps through its one checked post, and releases.
    const source = await readFile(new URL("./native/simtap.swift", import.meta.url), "utf8");
    expect(source).toContain('case "drag":');
    expect(source).toMatch(/\.leftMouseDown[\s\S]*\.leftMouseDragged[\s\S]*\.leftMouseUp/);
  });
  it("keeps all native event posts behind Simulator PID and foreground checks", async () => {
    const source = await readFile(new URL("./native/simtap.swift", import.meta.url), "utf8");
    expect(source).not.toContain("cghidEventTap");
    // Every event goes to the Simulator's PID after the foreground check; the one other post is a held drag's
    // release when that check fails, to the same PID, just before the helper exits.
    expect(source.match(/\.postToPid\(/g)).toHaveLength(2);
    expect(source).toMatch(/frontmostApplication\?\.processIdentifier == app\.processIdentifier else \{\s*\/\/[^\n]*\n\s*if let point = held \{ CGEvent\(mouseEventSource: nil, mouseType: \.leftMouseUp, mouseCursorPosition: point, mouseButton: \.left\)\?\.postToPid\(app\.processIdentifier\) \}\s*fail\(6, "focus lost"\)\s*\}\s*event\?\.postToPid\(app\.processIdentifier\)/);
    expect(source).toContain("args[3].utf16.count <= 500");
    expect(source).toContain("scalar.value == 10 && submit");
  });
});

describe.skipIf(process.platform === "win32")("simulator devices, booted or not", () => {
  const other = "BBBBBBBB-2222-4222-8222-222222222222", third = "CCCCCCCC-3333-4333-8333-333333333333";
  /** What the fake `simctl list devices <filter>` knows; boot and shutdown change it. */
  let table: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean }[]>;
  let failBoot = false;
  beforeEach(() => {
    table = {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [{ udid: other, name: "iPhone 15", state: "Shutdown", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [{ udid, name: "iPhone 17 Pro", state: "Booted", isAvailable: true },
        { udid: third, name: "iPad Air", state: "Shutdown", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [{ udid: "DDDDDDDD-4444-4444-8444-444444444444", name: "Apple Watch", state: "Shutdown" }],
    };
    failBoot = false;
    mocks.execute.mockImplementation(async (file: string, args: string[]) => {
      calls.push({ file, args });
      const device = (id: string) => Object.values(table).flat().find(d => d.udid === id);
      if (file === "/usr/bin/xcrun" && args[1] === "list") {
        const booted = args[3] === "booted";
        return { stdout: JSON.stringify({ devices: Object.fromEntries(Object.entries(table).map(([runtime, list]) => [runtime, list.filter(d => !booted || d.state === "Booted")])) }), stderr: "" };
      }
      if (file === "/usr/bin/xcrun" && args[1] === "boot") {
        if (device(args[2])!.state === "Booted") throw new Error("Unable to boot device in current state: Booted");
        device(args[2])!.state = "Booted";
        if (failBoot) throw new Error("timed out");
      }
      if (file === "/usr/bin/xcrun" && args[1] === "shutdown") {
        if (device(args[2])!.state !== "Booted") throw new Error("Unable to shutdown device in current state: Shutdown");
        device(args[2])!.state = "Shutdown";
      }
      return { stdout: "", stderr: "" };
    });
  });

  it("lists every available iOS device with its state, booted first, then the newest runtime, then by name", async () => {
    table["com.apple.CoreSimulator.SimRuntime.iOS-26-1"].push({ udid: "EEEEEEEE-5555-4555-8555-555555555555", name: "Gone", state: "Shutdown", isAvailable: false },
      { udid: "not-a-udid", name: "Bad", state: "Shutdown" });
    expect(await simulatorDevices()).toEqual([
      { udid, name: "iPhone 17 Pro", runtime: "iOS 26.1", state: "Booted" },
      { udid: third, name: "iPad Air", runtime: "iOS 26.1", state: "Shutdown" },
      { udid: other, name: "iPhone 15", runtime: "iOS 18.2", state: "Shutdown" },
    ]);
    expect(calls.map(c => c.args)).toEqual([["simctl", "list", "devices", "available", "-j"]]);
  });

  it("caps the list", async () => {
    table = { "com.apple.CoreSimulator.SimRuntime.iOS-26-1": Array.from({ length: 80 }, (_, i) => ({
      udid: `AAAAAAAA-1111-4111-8111-${String(i).padStart(12, "0")}`, name: `iPhone ${i}`, state: "Shutdown", isAvailable: true })) };
    expect(await simulatorDevices()).toHaveLength(SIMULATOR_DEVICE_LIMIT);
  });

  it("boots a shut-down device and opens its window, and takes one already booted as booted", async () => {
    expect(await simulatorAct(other, { action: "boot" })).toEqual({ ok: true });
    expect(calls.filter(c => c.args[1] === "boot").map(c => c.args)).toEqual([["simctl", "boot", other]]);
    expect(calls.filter(c => c.file === "/usr/bin/open").map(c => c.args)).toEqual([["-a", "Simulator", "--args", "-CurrentDeviceUDID", other]]);
    calls.length = 0;
    expect(await simulatorAct(udid, { action: "boot" })).toEqual({ ok: true });
    expect(calls.some(c => c.args[1] === "boot")).toBe(false);
    // simctl gave up waiting, but the device came up.
    failBoot = true;
    expect(await simulatorAct(third, { action: "boot" })).toEqual({ ok: true });
  });

  it("doesn't refuse a boot when simctl can't list its devices yet, and takes a device on its way up as booting", async () => {
    let listFails = true;
    const impl = mocks.execute.getMockImplementation()!;
    mocks.execute.mockImplementation(async (file: string, args: string[]) => {
      if (file === "/usr/bin/xcrun" && args[1] === "list" && listFails) { calls.push({ file, args }); throw new Error("timed out"); }
      return impl(file, args);
    });
    // CoreSimulatorService still starting: simctl boot itself decides.
    expect(await simulatorAct(other, { action: "boot" })).toEqual({ ok: true });
    expect(calls.filter(c => c.args[1] === "boot").map(c => c.args)).toEqual([["simctl", "boot", other]]);
    listFails = false;
    calls.length = 0;
    table["com.apple.CoreSimulator.SimRuntime.iOS-26-1"][1].state = "Booting";
    expect(await simulatorAct(third, { action: "boot" })).toEqual({ ok: true });
    expect(calls.some(c => c.args[1] === "boot")).toBe(false);
  });

  it("shuts down a booted device whose runtime is no longer available", async () => {
    table["com.apple.CoreSimulator.SimRuntime.iOS-17-0"] = [{ udid: "99999999-9999-4999-8999-999999999999", name: "Old iPhone", state: "Booted", isAvailable: false }];
    expect(await simulatorAct("99999999-9999-4999-8999-999999999999", { action: "shutdown" })).toEqual({ ok: true });
    expect(calls.filter(c => c.args[1] === "shutdown").map(c => c.args)).toEqual([["simctl", "shutdown", "99999999-9999-4999-8999-999999999999"]]);
  });

  it("shuts a booted device down, takes one already shut down as done, and refuses a device it doesn't have", async () => {
    expect(await simulatorAct(udid, { action: "shutdown" })).toEqual({ ok: true });
    expect(calls.filter(c => c.args[1] === "shutdown").map(c => c.args)).toEqual([["simctl", "shutdown", udid]]);
    calls.length = 0;
    expect(await simulatorAct(other, { action: "shutdown" })).toEqual({ ok: true });
    expect(calls.some(c => c.args[1] === "shutdown")).toBe(false);
    await expect(simulatorAct("FFFFFFFF-6666-4666-8666-666666666666", { action: "boot" })).rejects.toMatchObject({ status: 404 });
  });
});
