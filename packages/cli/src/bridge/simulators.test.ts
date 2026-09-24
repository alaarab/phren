import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => {
  const execFile = Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: mocks.execute });
  return { execFile };
});
import { simulatorAct, type SimulatorAction } from "./simulators.js";
const udid = "AAAAAAAA-1111-4111-8111-111111111111";
let root: string, calls: { file: string; args: string[] }[];
beforeEach(async () => {
  root = await mkdtemp("/tmp/phren-simulator-"); vi.stubEnv("PHREN_BRIDGE_HOME", root);
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  calls = [];
  mocks.execute.mockImplementation(async (file: string, args: string[]) => {
    calls.push({ file, args });
    if (file === "/usr/bin/swiftc") await writeFile(args[args.indexOf("-o") + 1], "compiled binary");
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
  it("verifies the binary again before every exec and rejects tampering without executing it", async () => {
    await simulatorAct(udid, { action: "home" });
    const binary = path.join(root, "native/simtap");
    await writeFile(binary, "TAMPERED");
    await expect(simulatorAct(udid, { action: "home" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("integrity") });
    expect(calls.filter(c => c.file === binary)).toHaveLength(1);
    expect(calls.filter(c => c.file === "/usr/bin/swiftc")).toHaveLength(1);
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
  it("keeps all native event posts behind Simulator PID and foreground checks", async () => {
    const source = await readFile(new URL("./native/simtap.swift", import.meta.url), "utf8");
    expect(source).not.toContain("cghidEventTap");
    expect(source.match(/\.postToPid\(/g)).toHaveLength(1);
    expect(source).toMatch(/frontmostApplication\?\.processIdentifier == app\.processIdentifier else \{ fail\(6, "focus lost"\) \}\s*event\?\.postToPid\(app\.processIdentifier\)/);
    expect(source).toContain("args[3].utf16.count <= 500");
    expect(source).toContain("scalar.value == 10 && submit");
  });
});
