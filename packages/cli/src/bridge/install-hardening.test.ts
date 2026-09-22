import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const state = vi.hoisted(() => ({ home: "", exec: vi.fn() }));
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), homedir: () => state.home }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(),
  execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: state.exec }),
}));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, copyFile: async (src: string, dst: string) => src.endsWith("bridge-hook.mjs") ? fs.writeFile(dst, "bundle fixture") : fs.copyFile(src, dst) };
});
vi.mock("./transport.js", () => ({ health: async () => ({ version: "0.2.14" }) }));
import { install, OPENCODE_PLUGIN_MARKER, opencodePluginNeedsWrite } from "./install.js";

beforeEach(async () => {
  state.home = await mkdtemp("/tmp/phren-install-");
  vi.stubEnv("HOME", state.home); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(state.home, "bridge's folder"));
  vi.stubEnv("PHREN_HERDR_HOME", path.join(state.home, "herdr's folder"));
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "COPILOT_HOME"]) vi.stubEnv(name, path.join(state.home, name));
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(console, "log").mockImplementation(() => {});
  state.exec.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(state.home, { recursive: true, force: true }); });

it("pins both roots in dispatch and launchd, sets launchd Umask, and pre-creates a private service log", async () => {
  const root = process.env.PHREN_BRIDGE_HOME!;
  await mkdir(root); await writeFile(path.join(root, "service.log"), "previous\n", { mode: 0o644 });
  state.exec.mockImplementation(async (file: string, args: string[]) => {
    if (file === "launchctl" && args[0] === "bootstrap") expect((await stat(path.join(root, "service.log"))).mode & 0o777).toBe(0o600);
    return { stdout: "", stderr: "" };
  });
  await install("0.2.14");
  expect(await readFile(path.join(root, "service.log"), "utf8")).toBe("previous\n");
  const plist = await readFile(path.join(state.home, "Library/LaunchAgents/com.phren.hook.plist"), "utf8");
  expect(plist).toContain("<key>Umask</key><integer>63</integer>");
  expect(plist).toContain("<key>Nice</key><integer>-5</integer>");
  expect(plist).toContain(`<key>PHREN_BRIDGE_HOME</key><string>${root}</string>`);
  expect(plist).toContain(`<key>PHREN_HERDR_HOME</key><string>${process.env.PHREN_HERDR_HOME}</string>`);
  const dispatch = await readFile(path.join(root, "dispatch"), "utf8");
  const { execFile } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const exportsOnly = dispatch.split("\n").filter(line => line.startsWith("export ")).join("\n");
  const { stdout } = await promisify(execFile)("/bin/sh", ["-c", exportsOnly + '\nprintf "%s\\n" "$PHREN_BRIDGE_HOME" "$PHREN_HERDR_HOME"'],
    { env: { PHREN_BRIDGE_HOME: "/wrong", PHREN_HERDR_HOME: "/wrong" } });
  expect(stdout.split("\n").slice(0, 2)).toEqual([root, process.env.PHREN_HERDR_HOME]);
  expect(JSON.parse(await readFile(path.join(root, "installed.json"), "utf8")).gateway).toBe("node");
});

it("creates the service log privately even when service startup is disabled", async () => {
  await install("0.2.14", true);
  const log = await stat(path.join(process.env.PHREN_BRIDGE_HOME!, "service.log"));
  expect(log.size).toBe(0); expect(log.mode & 0o777).toBe(0o600);
});

it("runs the Linux unit at a lower nice value", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  await install("0.2.14");
  const unitFile = await readFile(path.join(state.home, ".config/systemd/user/phren-hook.service"), "utf8");
  expect(unitFile).toContain("Nice=-5\n");
  expect(unitFile).toContain("Restart=on-failure");
});

it("reconciles Hook and Git owners independently and preserves user hooks", async () => {
  const { reconcileModuleHooks } = await import("./install.js");
  const { setModuleEnabled, initializeModules } = await import("../modules/config.js");
  const store = path.join(state.home, "store");
  vi.stubEnv("PHREN_PATH", store);
  initializeModules(store);
  setModuleEnabled(store, "hook", true);
  setModuleEnabled(store, "git", true);
  const settings = path.join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
  await mkdir(path.dirname(settings), { recursive: true });
  const own = { hooks: [{ type: "command", command: "user-callback" }] };
  await writeFile(settings, JSON.stringify({ hooks: { SessionStart: [own], PostToolUse: [own] } }));
  await install("0.2.14", true);
  expect(await readFile(settings, "utf8")).toContain("bridge-hook.mjs");
  setModuleEnabled(store, "git", false);
  await reconcileModuleHooks(store);
  let config = JSON.parse(await readFile(settings, "utf8"));
  expect(config.hooks.PostToolUse).toEqual([own]);
  expect(JSON.stringify(config.hooks.SessionStart)).toContain("bridge-hook.mjs");
  setModuleEnabled(store, "hook", false);
  await reconcileModuleHooks(store);
  config = JSON.parse(await readFile(settings, "utf8"));
  expect(config.hooks.SessionStart).toEqual([own]);
  expect(config.hooks.PostToolUse).toEqual([own]);
  expect(config.statusLine).toBeUndefined();
  setModuleEnabled(store, "hook", true);
  setModuleEnabled(store, "git", true);
  await reconcileModuleHooks(store);
  config = JSON.parse(await readFile(settings, "utf8"));
  expect(JSON.stringify(config.hooks.PostToolUse)).toContain("bridge-hook.mjs");
  expect(config.hooks.PostToolUse[0]).toEqual(own);
});

it("replaces the OpenCode plugin copies it wrote and leaves a user's own copy alone", () => {
  const shipped = `${OPENCODE_PLUGIN_MARKER} and replaced on every update.\nexport const v = 2;\n`;
  expect(opencodePluginNeedsWrite(undefined, shipped)).toBe(true);
  expect(opencodePluginNeedsWrite(shipped, shipped)).toBe(false);
  expect(opencodePluginNeedsWrite(`${OPENCODE_PLUGIN_MARKER} and replaced on every update.\nexport const v = 1;\n`, shipped)).toBe(true);
  expect(opencodePluginNeedsWrite("export const mine = true;\n", shipped)).toBe(false);
});
