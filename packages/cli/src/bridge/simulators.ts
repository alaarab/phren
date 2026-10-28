import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { BridgeError, bridgeRoot, type Json } from "./protocol.js";

const execFileAsync = promisify(execFile);
/** Every simulator child is killed outright at its timeout. SIGTERM, the
 * default, let one that ignored it hold its promise, and with it a stream's
 * slot, for good. */
const exec = (file: string, args: readonly string[], options: { timeout: number; maxBuffer?: number }) =>
  execFileAsync(file, args, { ...options, killSignal: "SIGKILL", encoding: "utf8" });
export const SIMULATOR_UDID = /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/i;

type SimctlDevices = { devices?: Record<string, { udid?: string; name?: string; state?: string; isAvailable?: boolean }[]> };

/** `simctl list devices <filter> -j`, parsed; empty when simctl is missing or answers nonsense. */
async function listDevices(filter: "booted" | "available"): Promise<SimctlDevices> {
  const { stdout } = await exec("/usr/bin/xcrun", ["simctl", "list", "devices", filter, "-j"], { timeout: 8_000, maxBuffer: 8_388_608 }).catch(() => ({ stdout: "{}" }));
  try { return JSON.parse(stdout) as SimctlDevices; } catch { return {}; }
}

/** com.apple.CoreSimulator.SimRuntime.iOS-26-1 → iOS 26.1 */
const runtimeName = (runtimeID: string) => runtimeID.replace(/^.*SimRuntime\./, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-/g, " ");

/** The iOS simulators booted on this Mac, from `simctl`; none elsewhere. */
export async function bootedSimulators(): Promise<Json[]> {
  if (process.platform !== "darwin") return [];
  const parsed = await listDevices("booted");
  const list: Json[] = [];
  for (const [runtimeID, devices] of Object.entries(parsed.devices ?? {})) {
    const runtime = runtimeName(runtimeID);
    for (const device of devices ?? []) {
      if (device.state !== "Booted" || !device.udid || !SIMULATOR_UDID.test(device.udid)) continue;
      list.push({ udid: device.udid.toUpperCase(), name: String(device.name ?? "Simulator").slice(0, 120), runtime });
      if (list.length >= 16) return list;
    }
  }
  return list;
}

/** Most devices `GET /v1/simulators?all=1` lists. */
export const SIMULATOR_DEVICE_LIMIT = 64;

/**
 * Every iOS simulator this Mac can run (`simctl list devices available`), booted or not, with its `state`
 * (`Booted`, `Shutdown`, `Booting`, `Shutting Down`): booted ones first, then the newest runtime, then by
 * name, at most SIMULATOR_DEVICE_LIMIT. For the phone's device picker, which boots one from here.
 */
export async function simulatorDevices(): Promise<Json[]> {
  if (process.platform !== "darwin") return [];
  const parsed = await listDevices("available");
  const list: { udid: string; name: string; runtime: string; state: string; version: number[] }[] = [];
  for (const [runtimeID, devices] of Object.entries(parsed.devices ?? {})) {
    if (!/SimRuntime\.iOS-/.test(runtimeID)) continue;
    const version = (/iOS-(\d+)-(\d+)/.exec(runtimeID) ?? []).slice(1).map(Number);
    for (const device of devices ?? []) {
      if (device.isAvailable === false || !device.udid || !SIMULATOR_UDID.test(device.udid)) continue;
      const state = typeof device.state === "string" && /^[A-Za-z ]{1,32}$/.test(device.state) ? device.state : "Unknown";
      list.push({ udid: device.udid.toUpperCase(), name: String(device.name ?? "Simulator").slice(0, 120), runtime: runtimeName(runtimeID), state, version });
    }
  }
  const newer = (a: number[], b: number[]) => (b[0] ?? 0) - (a[0] ?? 0) || (b[1] ?? 0) - (a[1] ?? 0);
  return list.sort((a, b) => Number(b.state === "Booted") - Number(a.state === "Booted") || newer(a.version, b.version) || a.name.localeCompare(b.name))
    .slice(0, SIMULATOR_DEVICE_LIMIT).map(({ version: _version, ...device }) => device);
}

/** A simulator's state as `simctl` reports it now, or undefined when it has no such device. */
async function deviceState(udid: string): Promise<string | undefined> {
  for (const devices of Object.values((await listDevices("available")).devices ?? {})) {
    const device = devices?.find(d => d.udid?.toUpperCase() === udid.toUpperCase());
    if (device) return String(device.state ?? "");
  }
  return undefined;
}

/** A PNG of one booted simulator's screen. */
export async function simulatorScreenshot(udid: string): Promise<Buffer> {
  if (!SIMULATOR_UDID.test(udid)) throw new BridgeError(400, "Invalid simulator identifier.");
  if (process.platform !== "darwin") throw new BridgeError(404, "Simulators run on macOS only.");
  const file = path.join(tmpdir(), `phren-sim-${randomUUID()}.png`);
  try {
    await exec("/usr/bin/xcrun", ["simctl", "io", udid, "screenshot", "--type=png", file], { timeout: 15_000 });
    return await readFile(file);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(409, "Couldn't capture that simulator. Is it still booted?");
  } finally { await unlink(file).catch(() => undefined); }
}

/** What the phone may ask a simulator to do. Boot, shutdown, launch and
 * URL go through simctl; touches and keys go through the Simulator app's
 * window with UI scripting, which needs Accessibility for the Hook's node. */
export type SimulatorAction =
  | { action: "boot" | "shutdown" | "home" | "lock" | "screenshot-ready" | "accessibility-settings" }
  | { action: "launch"; bundleId: string }
  | { action: "openurl"; url: string }
  | { action: "tap"; x: number; y: number }
  /** A swipe or scroll: press at (x1, y1), move to (x2, y2) over `durationMs` (default 300), release. */
  | { action: "drag"; x1: number; y1: number; x2: number; y2: number; durationMs?: number }
  | { action: "type"; text: string; submit?: boolean };

/** A drag's duration bounds, in ms. */
export const DRAG_DEFAULT_MS = 300, DRAG_MIN_MS = 50, DRAG_MAX_MS = 5_000;

/** The native helpers, compiled once per Hook version with swiftc, which any
 * Mac with the simulators has. simtap (native/simtap.swift) finds the
 * Simulator window through the Accessibility API and posts touches and keys
 * with CGEvent. AppleScript would need Automation consent, which a launchd
 * agent can never be prompted for; the helper needs one Accessibility grant.
 * Its `prompt` command puts it in the Accessibility list and shows the system
 * dialog. simcast (native/simcast.swift) streams a simulator's framebuffer
 * for simulator-stream.ts and needs no grant. */
export type NativeHelper = "simtap" | "simcast";
const HELPER_LABEL: Record<NativeHelper, string> = { simtap: "simulator input helper", simcast: "simulator stream helper" };
const building = new Map<NativeHelper, Promise<string>>();
function helper(name: NativeHelper): Promise<string> {
  let build = building.get(name);
  if (!build) { build = buildHelper(name).finally(() => building.delete(name)); building.set(name, build); }
  return build;
}
async function helperSource(name: NativeHelper): Promise<string> {
  const bundled = name === "simtap" ? (typeof SIMTAP_SOURCE === "string" ? SIMTAP_SOURCE : undefined) : (typeof SIMCAST_SOURCE === "string" ? SIMCAST_SOURCE : undefined);
  return bundled ?? await readFile(new URL(`./native/${name}.swift`, import.meta.url), "utf8");
}
async function buildHelper(name: NativeHelper): Promise<string> {
  const dir = path.join(bridgeRoot(), "native");
  const binary = path.join(dir, name);
  const code = await helperSource(name);
  const digest = createHash("sha256").update(code).digest("hex");
  // Rebuilt only when the source changes: the Accessibility grant is tied
  // to this binary, and a needless rebuild would make macOS ask again.
  const saved = await readFile(binary + ".sha256", "utf8").then(JSON.parse).catch(() => undefined);
  if (await stat(binary).catch(() => undefined) && saved?.sourceSha === digest) return binary;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `${name}.${randomUUID()}`), source = temporary + ".swift";
  const sidecar = temporary + ".sha256";
  try {
    await writeFile(source, code, { mode: 0o600, flag: "wx" });
    await exec("/usr/bin/swiftc", ["-O", "-o", temporary, source], { timeout: 180_000 }).catch(() => {
      throw new BridgeError(409, `Couldn't build the ${HELPER_LABEL[name]} (needs Xcode's swiftc).`);
    });
    await chmod(temporary, 0o700);
    const binarySha = createHash("sha256").update(await readFile(temporary)).digest("hex");
    await writeFile(sidecar, JSON.stringify({ sourceSha: digest, binarySha }), { mode: 0o600, flag: "wx" });
    await rename(temporary, binary);
    await rename(sidecar, binary + ".sha256");
  } finally { await Promise.all([source, temporary, sidecar].map(file => unlink(file).catch(() => undefined))); }
  return binary;
}
declare const SIMTAP_SOURCE: string | undefined;
declare const SIMCAST_SOURCE: string | undefined;

let inputQueue: Promise<void> = Promise.resolve();
function simtap(name: string, ...args: string[]): Promise<void> {
  const task = inputQueue.catch(() => {}).then(() => executeSimtap(name, ...args));
  inputQueue = task;
  return task;
}
/** A helper, hashed again right before it runs. */
export async function verifiedHelper(name: NativeHelper = "simtap"): Promise<string> {
  const binary = await helper(name);
  const saved = await readFile(binary + ".sha256", "utf8").then(JSON.parse).catch(() => undefined);
  const binarySha = createHash("sha256").update(await readFile(binary)).digest("hex");
  if (!saved || saved.binarySha !== binarySha) throw new BridgeError(409, `${HELPER_LABEL[name][0].toUpperCase()}${HELPER_LABEL[name].slice(1)} integrity check failed.`);
  return binary;
}
async function executeSimtap(name: string, ...args: string[]): Promise<void> {
  const binary = await verifiedHelper();
  try { await exec(binary, [name, ...args], { timeout: 60_000 }); } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    const message = String(failure?.stderr ?? failure?.message ?? "");
    if (/accessibility/.test(message)) {
      await promptAccessibility(binary, false);
      throw new BridgeError(403, accessibilityHelp(binary), { code: "simulator-accessibility", helper: binary });
    }
    if (/no window/.test(message)) throw new BridgeError(409, "That simulator has no window on screen.");
    if (/not running/.test(message)) throw new BridgeError(409, "The Simulator app is not running.");
    throw new BridgeError(409, `The simulator did not take that: ${message.slice(0, 160) || "unknown error"}`);
  }
}

/** The steps for the Accessibility grant, for the 403 and the docs. */
export function accessibilityHelp(binary: string): string {
  return "Touches and keys need Accessibility for Phren's simulator helper. On the Mac, open System Settings → Privacy & Security → Accessibility and switch on simtap. "
    + `If it isn't listed, click +, press ⌘⇧G, paste ${binary} and click Open.`;
}

/** Asks macOS for the helper's Accessibility grant: the helper joins the
 * Accessibility list, switched off, and the system dialog shows. Once per Hook
 * run unless the person asks again, so a burst of taps raises one dialog.
 * Resolves whether the helper is already trusted. */
let prompted = false;
async function promptAccessibility(binary: string, force: boolean): Promise<boolean> {
  if (prompted && !force) return false;
  prompted = true;
  return exec(binary, ["-", "prompt"], { timeout: 15_000 }).then(() => true, () => false);
}

const ACCESSIBILITY_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

// macOS virtual key codes.
const KEY_H = "4", KEY_L = "37";

export async function simulatorAct(udid: string, request: SimulatorAction): Promise<Json> {
  if (!SIMULATOR_UDID.test(udid)) throw new BridgeError(400, "Invalid simulator identifier.");
  if (!["boot", "shutdown", "launch", "openurl", "home", "lock", "type", "tap", "drag", "screenshot-ready", "accessibility-settings"].includes(request.action)) throw new BridgeError(400, "Unknown simulator action.");
  if (process.platform !== "darwin") throw new BridgeError(404, "Simulators run on macOS only.");
  const simctl = (...args: string[]) => exec("/usr/bin/xcrun", ["simctl", ...args], { timeout: 30_000 }).catch(() => { throw new BridgeError(409, `simctl ${args[0]} failed for that simulator.`); });
  // Boot and shutdown take any available device, booted or not, and a device already in the asked-for state
  // is not a failure (the phone's picker may be a moment behind).
  const settle = async (verb: "boot" | "shutdown", wanted: string) => {
    const state = await deviceState(udid);
    if (state === undefined) throw new BridgeError(404, "No such simulator on this Mac.");
    if (state === wanted) return;
    try { await simctl(verb, udid); } catch (error) { if (await deviceState(udid) !== wanted) throw error; }
  };
  switch (request.action) {
    case "boot":
      await settle("boot", "Booted");
      // Taps, drags and keys go to the device's window in the Simulator app, which booting alone doesn't open.
      await exec("/usr/bin/open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", udid.toUpperCase()], { timeout: 15_000 }).catch(() => undefined);
      break;
    case "shutdown": await settle("shutdown", "Shutdown"); break;
    case "launch":
      if (typeof request.bundleId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]{2,199}$/.test(request.bundleId)) throw new BridgeError(400, "Invalid bundle identifier.");
      await simctl("launch", udid, request.bundleId); break;
    case "openurl":
      if (typeof request.url !== "string" || !/^[a-z][a-z0-9+.-]*:/i.test(request.url) || request.url.length > 2048) throw new BridgeError(400, "Invalid URL.");
      await simctl("openurl", udid, request.url); break;
    case "home": await simtap(await deviceName(udid), "key", KEY_H, "cmd", "shift"); break;
    case "lock": await simtap(await deviceName(udid), "key", KEY_L, "cmd"); break;
    case "type":
      if (typeof request.text !== "string" || !request.text || request.text.length > 500
          || /[\x00-\x09\x0b-\x1f\x7f]/.test(request.text) || (request.text.includes("\n") && request.submit !== true)
          || (request.submit !== undefined && typeof request.submit !== "boolean")) throw new BridgeError(400, "Type at most 500 characters; newlines require submit: true and other control characters are forbidden.");
      await simtap(await deviceName(udid), "type", request.text, ...(request.submit === true ? ["submit"] : [])); break;
    case "tap": {
      // x and y are fractions of the screenshot.
      const { x, y } = request;
      if (![x, y].every(v => typeof v === "number" && v >= 0 && v <= 1)) throw new BridgeError(400, "Tap outside the screen.");
      await simtap(await deviceName(udid), "tap", String(x), String(y)); break;
    }
    case "drag": {
      // From and to are fractions of the screenshot, as a tap's are.
      const { x1, y1, x2, y2 } = request, durationMs = request.durationMs ?? DRAG_DEFAULT_MS;
      if (![x1, y1, x2, y2].every(v => typeof v === "number" && v >= 0 && v <= 1)) throw new BridgeError(400, "Drag outside the screen.");
      if (typeof durationMs !== "number" || !Number.isInteger(durationMs) || durationMs < DRAG_MIN_MS || durationMs > DRAG_MAX_MS) {
        throw new BridgeError(400, `A drag takes ${DRAG_MIN_MS} to ${DRAG_MAX_MS} ms.`);
      }
      await simtap(await deviceName(udid), "drag", String(x1), String(y1), String(x2), String(y2), String(durationMs)); break;
    }
    case "screenshot-ready": break;
    case "accessibility-settings": {
      // The phone's "Open Accessibility settings": ask for the grant again and
      // open the pane on this Mac, where the switch is.
      const binary = await verifiedHelper();
      const trusted = await promptAccessibility(binary, true);
      await exec("/usr/bin/open", [ACCESSIBILITY_PANE], { timeout: 15_000 }).catch(() => {
        throw new BridgeError(409, "Couldn't open System Settings on the Mac.");
      });
      return { ok: true, trusted, helper: binary };
    }
    default: throw new BridgeError(400, "Unknown simulator action.");
  }
  return { ok: true };
}

async function deviceName(udid: string): Promise<string> {
  const device = (await bootedSimulators()).find(d => d.udid === udid.toUpperCase());
  if (!device) throw new BridgeError(409, "That simulator is not booted.");
  return String(device.name);
}
/** The apps a simulator has, for the launcher. */
export async function simulatorApps(udid: string): Promise<Json[]> {
  if (!SIMULATOR_UDID.test(udid)) throw new BridgeError(400, "Invalid simulator identifier.");
  if (process.platform !== "darwin") return [];
  const { stdout } = await exec("/usr/bin/xcrun", ["simctl", "listapps", udid], { timeout: 15_000, maxBuffer: 4_194_304 }).catch(() => ({ stdout: "" }));
  const apps: Json[] = [];
  const blocks = stdout.split(/\n(?=\s{4}"[^"]+" =\s+\{)/);
  for (const block of blocks) {
    const id = /CFBundleIdentifier = "?([^";\n]+)"?;/.exec(block)?.[1], name = /CFBundleDisplayName = "?([^";\n]+)"?;/.exec(block)?.[1];
    const type = /ApplicationType = "?([^";\n]+)"?;/.exec(block)?.[1];
    if (id && name && type === "User" && !/\.xctrunner$/.test(id)) apps.push({ bundleId: id, name });
  }
  return apps.sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(0, 100);
}
