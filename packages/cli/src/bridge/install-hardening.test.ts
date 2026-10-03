import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const state = vi.hoisted(() => ({ home: "", exec: vi.fn(), health: vi.fn(), failSettingsRead: false, failActivation: false }));
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), homedir: () => state.home }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(),
  execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: state.exec }),
}));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs,
    readFile: (...args: Parameters<typeof fs.readFile>) => {
      if (state.failSettingsRead && String(args[0]).endsWith("settings.json")) return Promise.reject(new Error("settings rollback denied"));
      return fs.readFile(...args);
    },
    rename: async (from: string, to: string) => {
      if (state.failActivation && to.endsWith("/current")) { state.failActivation = false; throw new Error("activation rename denied"); }
      return fs.rename(from, to);
    },
    copyFile: async (src: string, dst: string) => src.endsWith("bridge-hook.mjs") ? fs.writeFile(dst, "bundle fixture") : fs.copyFile(src, dst) };
});
vi.mock("./transport.js", () => ({ health: state.health }));
import { install, OPENCODE_PLUGIN_MARKER, opencodePluginNeedsWrite } from "./install.js";

beforeEach(async () => {
  state.failSettingsRead = false; state.failActivation = false;
  state.home = await mkdtemp("/tmp/phren-install-");
  vi.stubEnv("HOME", state.home); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(state.home, "bridge's folder"));
  vi.stubEnv("PHREN_HERDR_HOME", path.join(state.home, "herdr's folder"));
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "COPILOT_HOME"]) vi.stubEnv(name, path.join(state.home, name));
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(console, "log").mockImplementation(() => {});
  state.exec.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
  state.health.mockReset().mockResolvedValue({ version: "0.2.14" });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(state.home, { recursive: true, force: true }); });

// Every test in this file covers the launchd/systemd install, which install.ts refuses on
// Windows ("Phren Hook supports macOS and Linux.").
it.skipIf(process.platform === "win32")("pins both roots in dispatch and launchd, sets launchd Umask, and pre-creates a private service log", async () => {
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

it.skipIf(process.platform === "win32")("creates the service log privately even when service startup is disabled", async () => {
  await install("0.2.14", true);
  const log = await stat(path.join(process.env.PHREN_BRIDGE_HOME!, "service.log"));
  expect(log.size).toBe(0); expect(log.mode & 0o777).toBe(0o600);
});

it.skipIf(process.platform === "win32")("runs the Linux unit at a lower nice value", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  await install("0.2.14");
  const unitFile = await readFile(path.join(state.home, ".config/systemd/user/phren-hook.service"), "utf8");
  expect(unitFile).toContain("Nice=-5\n");
  expect(unitFile).toContain("Restart=always");
});

it.skipIf(process.platform === "win32")("reconciles Hook and Git owners independently and preserves user hooks", async () => {
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
  expect(JSON.stringify(config.hooks.SessionStart)).toContain("claude-hook.mjs");
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
  expect(JSON.stringify(config.hooks.PostToolUse)).toContain("claude-hook.mjs");
  expect(config.hooks.PostToolUse[0]).toEqual(own);
});

it.skipIf(process.platform === "win32")("leaves the Hook alone when init or link reconciles another store", async () => {
  const { reconcileModuleHooks } = await import("./install.js");
  const { initializeModules, setModuleEnabled } = await import("../modules/config.js");
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const store = path.join(state.home, "store"), scratch = path.join(state.home, "scratch");
  vi.stubEnv("PHREN_PATH", store);
  initializeModules(store); setModuleEnabled(store, "hook", true);
  await install("0.2.14", true);
  expect(JSON.parse(await readFile(path.join(process.env.PHREN_BRIDGE_HOME!, "installed.json"), "utf8")).store).toBe(store);
  const settings = await readFile(claudeSettings(), "utf8");
  // A scratch store has no Hook module: before, this stopped the real service.
  initializeModules(scratch);
  state.exec.mockClear();
  await reconcileModuleHooks(scratch);
  expect(state.exec).not.toHaveBeenCalled();
  expect(await readFile(claudeSettings(), "utf8")).toBe(settings);
  // The Hook's own store still turns it off.
  setModuleEnabled(store, "hook", false);
  await reconcileModuleHooks(store);
  expect(state.exec).toHaveBeenCalledWith("systemctl", ["--user", "stop", "phren-hook.service"]);
});

it.skipIf(process.platform === "win32")("names the Codex workers a restart would stop and waits for their running turns", async () => {
  const { waitForCodexWorkers } = await import("./install.js");
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const worker = { id: "0123456789ab", server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p2", socket: "/s", pid: 7, cwd: "/", startedAt: "", dispatchId: "07eebc09-2fa3", activeTurn: "turn-1" };
  const idle = { ...worker, id: "ba9876543210", pane: "w1:p3", activeTurn: undefined, dispatchId: undefined };
  const lines: string[] = [];
  const polls = [[worker, idle], [worker, idle], [idle]];
  await waitForCodexWorkers(60_000, async () => polls.shift() ?? [idle], line => lines.push(line), 1);
  expect(lines[0]).toContain("2 Codex workers run inside the Phren Hook's service");
  expect(lines[0]).toContain("w1:p2 (dispatch 07eebc09), turn running; w1:p3, idle");
  expect(lines.filter(line => line.startsWith("Waiting"))).toHaveLength(2);
  expect(lines.at(-1)).toMatch(/^Waiting/);
  // A turn still running when the wait runs out is named.
  lines.length = 0;
  await waitForCodexWorkers(0, async () => [worker], line => lines.push(line), 1);
  expect(lines.at(-1)).toBe("Restarting anyway: w1:p2 (dispatch 07eebc09), turn running will stop mid-turn and return failed.");
  lines.length = 0;
  await waitForCodexWorkers(60_000, async () => [], line => lines.push(line), 1);
  expect(lines).toEqual([]);
});

const quoted = (file: string) => `'${file.replace(/'/g, "'\\''")}'`;
const forwarder = () => `${quoted(process.execPath)} ${quoted(path.join(process.env.PHREN_BRIDGE_HOME!, "current/claude-hook.mjs"))} claude`;
const claudeSettings = () => path.join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
/** Serves `version` from health and lets the readiness wait run without delays. */
function liveVersion(version: { value: string }) {
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => { queueMicrotask(callback); return {} as NodeJS.Timeout; }) as typeof setTimeout);
  state.health.mockImplementation(async () => ({ version: version.value }));
}

it.skipIf(process.platform === "win32")("moves Claude callbacks an older install wrote onto the forwarder with 15 s limits", async () => {
  const root = process.env.PHREN_BRIDGE_HOME!;
  const settings = claudeSettings();
  await mkdir(path.dirname(settings), { recursive: true });
  const old = (timeout: number) => ({ type: "command", command: `'/old/node' ${quoted(path.join(root, "current/bridge-hook.mjs"))} hook claude`, timeout });
  const user = { type: "command", command: "user-callback", timeout: 3 };
  await writeFile(settings, JSON.stringify({ model: "opus", hooks: {
    UserPromptSubmit: [{ matcher: "", hooks: [user, old(3)] }], Stop: [{ hooks: [old(3)] }], PermissionRequest: [{ hooks: [old(60)] }],
    PostToolUse: [{ matcher: "Bash", hooks: [old(10)] }],
  } }));
  await install("0.2.14", true);
  expect(await readFile(path.join(root, "versions/0.2.14/claude-hook.mjs"), "utf8")).toContain("Installed by Phren Hook");
  const config = JSON.parse(await readFile(settings, "utf8"));
  expect(config.model).toBe("opus");
  const fast = forwarder();
  expect(config.hooks.UserPromptSubmit).toEqual([{ matcher: "", hooks: [user] }, { hooks: [{ type: "command", command: fast, timeout: 15 }] }]);
  for (const event of ["SessionStart", "Stop", "PreCompact"]) expect(config.hooks[event]).toEqual([{ hooks: [{ type: "command", command: fast, timeout: 15 }] }]);
  expect(config.hooks.PermissionRequest).toEqual([{ hooks: [{ type: "command", command: fast, timeout: 60 }] }]);
  // Tool calls go through the forwarder too, still filtered to the editing tools.
  for (const event of ["PreToolUse", "PostToolUse"]) {
    expect(config.hooks[event]).toEqual([{ matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit|apply_patch|str_replace_editor", hooks: [{ type: "command", command: fast, timeout: 10 }] }]);
  }
  expect(JSON.stringify(config.hooks)).not.toContain("bridge-hook.mjs");
  const { planAgentHooks } = await import("./install.js");
  expect((await planAgentHooks(path.join(root, "current/bridge-hook.mjs"))).some(edit => edit.file === settings)).toBe(false);
  const removed = JSON.parse((await planAgentHooks(path.join(root, "current/bridge-hook.mjs"), true)).find(edit => edit.file === settings)!.after);
  expect(removed.hooks.UserPromptSubmit).toEqual([{ matcher: "", hooks: [user] }]);
  expect(removed.hooks.Stop).toEqual([]);
});

it.skipIf(process.platform === "win32")("keeps the running version's own forwarder and settings when an update never becomes ready", async () => {
  const root = process.env.PHREN_BRIDGE_HOME!;
  const live = { value: "0.2.13" };
  liveVersion(live);
  await install("0.2.13");
  await writeFile(path.join(root, "versions/0.2.13/claude-hook.mjs"), "// 0.2.13's forwarder\n");
  const before = await readFile(claudeSettings(), "utf8");
  expect(String(await install("0.2.14").catch((failure: Error) => failure))).toContain("did not become ready");
  expect(await readlink(path.join(root, "current"))).toBe(path.join("versions", "0.2.13"));
  expect(await readFile(path.join(root, "current/claude-hook.mjs"), "utf8")).toBe("// 0.2.13's forwarder\n");
  expect(await readFile(claudeSettings(), "utf8")).toBe(before);
  expect(JSON.parse(before).hooks.Stop).toEqual([{ hooks: [{ type: "command", command: forwarder(), timeout: 15 }] }]);
});

it.skipIf(process.platform === "win32")("restores the prior Mac plist and restarts after activation fails following bootout", async () => {
  const root = process.env.PHREN_BRIDGE_HOME!, plist = path.join(state.home, "Library/LaunchAgents/com.phren.hook.plist");
  await install("0.2.14");
  await writeFile(plist, "prior plist with owner environment");
  state.exec.mockClear(); state.failActivation = true;
  await expect(install("0.2.15")).rejects.toThrow("activation rename denied");
  expect(await readFile(plist, "utf8")).toBe("prior plist with owner environment");
  expect(await readlink(path.join(root, "current"))).toBe(path.join("versions", "0.2.14"));
  expect(state.exec.mock.calls.some(([file, args]) => file === "launchctl" && args[0] === "bootstrap")).toBe(true);
});

it.skipIf(process.platform === "win32")("continues executable and service rollback after an independent settings restoration failure", async () => {
  const root = process.env.PHREN_BRIDGE_HOME!, live = { value: "0.2.14" };
  liveVersion(live);
  await install("0.2.14");
  const plist = path.join(state.home, "Library/LaunchAgents/com.phren.hook.plist"), before = await readFile(plist, "utf8");
  // Force a settings plan; the failing read starts only after activation.
  await writeFile(claudeSettings(), JSON.stringify({ model: "owner-model" }));
  state.health.mockImplementation(async () => { state.failSettingsRead = true; return { version: "0.2.14" }; });
  state.exec.mockClear();
  const error = await install("0.2.15").catch(failure => failure);
  state.failSettingsRead = false;
  expect(String(error)).toContain("did not become ready");
  expect(String(error)).toContain("settings rollback denied");
  expect(await readlink(path.join(root, "current"))).toBe(path.join("versions", "0.2.14"));
  expect(await readFile(plist, "utf8")).toBe(before);
  expect(JSON.parse(await readFile(path.join(root, "installed.json"), "utf8")).version).toBe("0.2.14");
  expect(state.exec.mock.calls.filter(([file, args]) => file === "launchctl" && args[0] === "bootstrap")).toHaveLength(3);
});

it.skipIf(process.platform === "win32")("points Claude back at the bundle when rolling back to a version without the forwarder, and forward again", async () => {
  const root = process.env.PHREN_BRIDGE_HOME!;
  const live = { value: "0.2.13" };
  liveVersion(live);
  await install("0.2.13");
  // A release from before the forwarder ships only its bundle.
  await unlink(path.join(root, "versions/0.2.13/claude-hook.mjs"));
  live.value = "0.2.14";
  await install("0.2.14");
  expect(JSON.stringify(JSON.parse(await readFile(claudeSettings(), "utf8")).hooks.Stop)).toContain("claude-hook.mjs");
  const { rollback } = await import("./install.js");
  await rollback();
  const bundle = `${quoted(process.execPath)} ${quoted(path.join(root, "current/bridge-hook.mjs"))} hook claude`;
  let hooks = JSON.parse(await readFile(claudeSettings(), "utf8")).hooks;
  expect(hooks.Stop).toEqual([{ hooks: [{ type: "command", command: bundle, timeout: 15 }] }]);
  expect(JSON.stringify(hooks)).not.toContain("claude-hook.mjs");
  await rollback();
  hooks = JSON.parse(await readFile(claudeSettings(), "utf8")).hooks;
  expect(hooks.Stop).toEqual([{ hooks: [{ type: "command", command: forwarder(), timeout: 15 }] }]);
  expect(await readFile(path.join(root, "current/claude-hook.mjs"), "utf8")).toContain("Installed by Phren Hook");
});

it.skipIf(process.platform === "win32")("replaces the OpenCode plugin copies it wrote and leaves a user's own copy alone", () => {
  const shipped = `${OPENCODE_PLUGIN_MARKER} and replaced on every update.\nexport const v = 2;\n`;
  expect(opencodePluginNeedsWrite(undefined, shipped)).toBe(true);
  expect(opencodePluginNeedsWrite(shipped, shipped)).toBe(false);
  expect(opencodePluginNeedsWrite(`${OPENCODE_PLUGIN_MARKER} and replaced on every update.\nexport const v = 1;\n`, shipped)).toBe(true);
  expect(opencodePluginNeedsWrite("export const mine = true;\n", shipped)).toBe(false);
});

it.skipIf(process.platform === "win32")("bootstraps into gui/<uid> when someone is logged in at the screen", async () => {
  const uid = process.getuid!();
  await install("0.2.14");
  const calls = state.exec.mock.calls.filter(([file]) => file === "launchctl").map(([, args]) => (args as string[]).slice(0, 2).join(" "));
  expect(calls).toEqual([`bootout gui/${uid}/com.phren.hook`, `bootout user/${uid}/com.phren.hook`, `print gui/${uid}`,
    `bootstrap gui/${uid}`, `kickstart gui/${uid}/com.phren.hook`]);
});

it.skipIf(process.platform === "win32")("rebootstraps when the first kickstart fails and the old Hook still answers", async () => {
  const uid = process.getuid!();
  let bootstraps = 0;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    queueMicrotask(callback); return {} as NodeJS.Timeout;
  }) as typeof setTimeout);
  state.exec.mockImplementation(async (file: string, args: string[]) => {
    if (file === "launchctl" && args[0] === "bootstrap") bootstraps++;
    if (file === "launchctl" && args[0] === "kickstart" && bootstraps === 1) {
      throw Object.assign(new Error("kickstart failed"), { stderr: "Could not kickstart service\n" });
    }
    return { stdout: "", stderr: "" };
  });
  state.health.mockImplementation(async () => ({ version: bootstraps === 1 ? "0.2.13" : "0.2.14" }));

  await install("0.2.14");
  expect(bootstraps).toBe(2);
  const calls = state.exec.mock.calls.filter(([file]) => file === "launchctl").map(([, args]) => (args as string[]).slice(0, 2).join(" "));
  expect(calls).toEqual([`bootout gui/${uid}/com.phren.hook`, `bootout user/${uid}/com.phren.hook`, `print gui/${uid}`,
    `bootstrap gui/${uid}`, `kickstart gui/${uid}/com.phren.hook`, `bootout gui/${uid}/com.phren.hook`,
    `bootout user/${uid}/com.phren.hook`, `print gui/${uid}`, `bootstrap gui/${uid}`, `kickstart gui/${uid}/com.phren.hook`]);
  expect(state.health).toHaveBeenCalled();
  expect(JSON.parse(await readFile(path.join(process.env.PHREN_BRIDGE_HOME!, "installed.json"), "utf8")).version).toBe("0.2.14");
});

it.skipIf(process.platform === "win32")("reports a failed kickstart only after both launchd starts remain on the old version", async () => {
  let bootstraps = 0;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    queueMicrotask(callback); return {} as NodeJS.Timeout;
  }) as typeof setTimeout);
  state.exec.mockImplementation(async (file: string, args: string[]) => {
    if (file === "launchctl" && args[0] === "bootstrap") bootstraps++;
    if (file === "launchctl" && args[0] === "kickstart") {
      throw Object.assign(new Error("kickstart failed"), { stderr: "Could not kickstart service\n" });
    }
    return { stdout: "", stderr: "" };
  });
  state.health.mockResolvedValue({ version: "0.2.13" });

  const error = await install("0.2.14").catch((failure: Error) => failure);
  expect(String(error)).toContain("Phren Hook 0.2.14 did not become ready after two launchd starts");
  expect(String(error)).toContain("Last launchctl kickstart error: Could not kickstart service");
  expect(bootstraps).toBe(2);
});

it.skipIf(process.platform === "win32")("falls back to user/<uid> over an SSH login with no GUI session and says how to move it", async () => {
  const uid = process.getuid!();
  state.exec.mockImplementation(async (file: string, args: string[]) => {
    if (file === "launchctl" && args[0] === "print") throw Object.assign(new Error("Could not find domain"), { stderr: "Bad request.\n" });
    return { stdout: "", stderr: "" };
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await install("0.2.14");
  expect(state.exec.mock.calls.some(([file, args]) => file === "launchctl" && (args as string[])[0] === "bootstrap" && (args as string[])[1] === `user/${uid}`)).toBe(true);
  expect(log.mock.calls.flat().join("\n")).toContain(`runs in user/${uid}. After a screen login, run phren bridge install again`);
});

it.skipIf(process.platform === "win32")("prints the exact launchctl commands when bootstrap fails", async () => {
  const uid = process.getuid!();
  state.exec.mockImplementation(async (file: string, args: string[]) => {
    if (file === "launchctl" && args[0] === "bootstrap") throw Object.assign(new Error("failed"), { stderr: "Bootstrap failed: 125: Domain does not support specified action\n" });
    return { stdout: "", stderr: "" };
  });
  const error = await install("0.2.14").catch((failure: Error) => failure);
  expect(String(error)).toContain(`launchctl could not start the Phren Hook in gui/${uid}: Bootstrap failed: 125`);
  expect(String(error)).toContain(`launchctl kickstart -k gui/${uid}/com.phren.hook`);
  expect(String(error)).toContain(`launchctl bootstrap gui/${uid} '${path.join(state.home, "Library/LaunchAgents/com.phren.hook.plist")}'`);
});

it.skipIf(process.platform === "win32")("keeps the owner's Codex trust when install changes Phren's hook timeouts", async () => {
  const { codexHookHash } = await import("./codex-hook-trust.js");
  const codex = process.env.CODEX_HOME!, hooksFile = path.join(codex, "hooks.json");
  const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const command = `${quote(process.execPath)} ${quote(path.join(process.env.PHREN_BRIDGE_HOME!, "current/bridge-hook.mjs"))} hook codex`;
  const user = { hooks: [{ type: "command", command: "user-callback" }] };
  const hooks = { SessionStart: [user, { hooks: [{ type: "command", command, timeout: 3 }] }], Stop: [{ hooks: [{ type: "command", command, timeout: 3 }] }] };
  await mkdir(codex, { recursive: true });
  await writeFile(hooksFile, JSON.stringify({ hooks }, null, 2));
  const trusted = (key: string, hash: string) => `[hooks.state."${hooksFile}:${key}"]\ntrusted_hash = "${hash}"\n\n`;
  const config = 'model = "x"\n\n' + trusted("session_start:0:0", codexHookHash("SessionStart", user, user.hooks[0]))
    + trusted("session_start:1:0", codexHookHash("SessionStart", {}, hooks.SessionStart[1].hooks[0])) + "[tui]\n";
  await writeFile(path.join(codex, "config.toml"), config);
  await install("0.2.14", true);
  const after = JSON.parse(await readFile(hooksFile, "utf8")) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> };
  const session = after.hooks.SessionStart[1].hooks[0];
  expect(session.timeout).toBe(15);
  const text = await readFile(path.join(codex, "config.toml"), "utf8");
  expect(text).toContain(`trusted_hash = "${codexHookHash("SessionStart", {}, session)}"`);
  // Stop was never trusted, so it still waits for the owner's review.
  expect(text).not.toContain(":stop:");
  expect(text.startsWith('model = "x"\n\n')).toBe(true);
});
