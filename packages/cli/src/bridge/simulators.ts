import { execFile } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { BridgeError, bridgeRoot, type Json } from "./protocol.js";

const exec = promisify(execFile);
const UDID = /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/i;

/** The iOS simulators booted on this Mac, from `simctl`; none elsewhere. */
export async function bootedSimulators(): Promise<Json[]> {
  if (process.platform !== "darwin") return [];
  const { stdout } = await exec("xcrun", ["simctl", "list", "devices", "booted", "-j"], { timeout: 8_000, maxBuffer: 4_194_304 }).catch(() => ({ stdout: "{}" }));
  let parsed: { devices?: Record<string, { udid?: string; name?: string; state?: string }[]> } = {};
  try { parsed = JSON.parse(stdout); } catch { return []; }
  const list: Json[] = [];
  for (const [runtimeID, devices] of Object.entries(parsed.devices ?? {})) {
    // com.apple.CoreSimulator.SimRuntime.iOS-26-1 → iOS 26.1
    const runtime = runtimeID.replace(/^.*SimRuntime\./, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-/g, " ");
    for (const device of devices ?? []) {
      if (device.state !== "Booted" || !device.udid || !UDID.test(device.udid)) continue;
      list.push({ udid: device.udid.toUpperCase(), name: String(device.name ?? "Simulator").slice(0, 120), runtime });
      if (list.length >= 16) return list;
    }
  }
  return list;
}

/** A PNG of one booted simulator's screen. */
export async function simulatorScreenshot(udid: string): Promise<Buffer> {
  if (!UDID.test(udid)) throw new BridgeError(400, "Invalid simulator identifier.");
  if (process.platform !== "darwin") throw new BridgeError(404, "Simulators run on macOS only.");
  const file = path.join(tmpdir(), `phren-sim-${randomUUID()}.png`);
  try {
    await exec("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", file], { timeout: 15_000 });
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
  | { action: "boot" | "shutdown" | "home" | "lock" | "screenshot-ready" }
  | { action: "launch"; bundleId: string }
  | { action: "openurl"; url: string }
  | { action: "tap"; x: number; y: number }
  | { action: "type"; text: string };

/** The native helper (native/simtap.swift) that finds the Simulator window
 * through the Accessibility API and posts touches and keys with CGEvent.
 * AppleScript would need Automation consent, which a launchd agent can never
 * be prompted for; the helper needs one Accessibility grant, added by hand.
 * Compiled once per Hook version with swiftc, which any Mac with the
 * simulators has. */
async function helper(): Promise<string> {
  const dir = path.join(bridgeRoot(), "native");
  const binary = path.join(dir, "simtap");
  const code = typeof SIMTAP_SOURCE === "string" ? SIMTAP_SOURCE : await readFile(new URL("./native/simtap.swift", import.meta.url), "utf8");
  const digest = createHash("sha256").update(code).digest("hex");
  // Rebuilt only when the source changes: the Accessibility grant is tied
  // to this binary, and a needless rebuild would make macOS ask again.
  if (await stat(binary).catch(() => undefined) && (await readFile(binary + ".sha256", "utf8").catch(() => "")) === digest) return binary;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, "simtap.swift");
  await writeFile(temp, code, { mode: 0o600 });
  await exec("swiftc", ["-O", "-o", binary, temp], { timeout: 180_000 }).catch((error: { stderr?: string; message?: string }) => {
    throw new BridgeError(409, `Couldn't build the simulator input helper (needs Xcode's swiftc): ${String(error?.stderr ?? error?.message ?? error).slice(0, 200)}`);
  });
  await writeFile(binary + ".sha256", digest, { mode: 0o600 });
  return binary;
}
declare const SIMTAP_SOURCE: string | undefined;

async function simtap(name: string, ...args: string[]): Promise<void> {
  const binary = await helper();
  try { await exec(binary, [name, ...args], { timeout: 10_000 }); } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    const message = String(failure?.stderr ?? failure?.message ?? "");
    if (/accessibility/.test(message)) throw new BridgeError(403, `Touches and keys need one permission on the Mac: System Settings → Privacy & Security → Accessibility → add ${binary}`);
    if (/no window/.test(message)) throw new BridgeError(409, "That simulator has no window on screen.");
    if (/not running/.test(message)) throw new BridgeError(409, "The Simulator app is not running.");
    throw new BridgeError(409, `The simulator did not take that: ${message.slice(0, 160) || "unknown error"}`);
  }
}

// macOS virtual key codes.
const KEY_H = "4", KEY_L = "37";

export async function simulatorAct(udid: string, request: SimulatorAction): Promise<Json> {
  if (!UDID.test(udid)) throw new BridgeError(400, "Invalid simulator identifier.");
  if (process.platform !== "darwin") throw new BridgeError(404, "Simulators run on macOS only.");
  const simctl = (...args: string[]) => exec("xcrun", ["simctl", ...args], { timeout: 30_000 }).catch(() => { throw new BridgeError(409, `simctl ${args[0]} failed for that simulator.`); });
  switch (request.action) {
    case "boot": await simctl("boot", udid); break;
    case "shutdown": await simctl("shutdown", udid); break;
    case "launch":
      if (!/^[A-Za-z0-9.-]{3,200}$/.test(request.bundleId)) throw new BridgeError(400, "Invalid bundle identifier.");
      await simctl("launch", udid, request.bundleId); break;
    case "openurl":
      if (!/^[a-z][a-z0-9+.-]*:/i.test(request.url) || request.url.length > 2048) throw new BridgeError(400, "Invalid URL.");
      await simctl("openurl", udid, request.url); break;
    case "home": await simtap(await deviceName(udid), "key", KEY_H, "cmd", "shift"); break;
    case "lock": await simtap(await deviceName(udid), "key", KEY_L, "cmd"); break;
    case "type":
      if (typeof request.text !== "string" || !request.text || request.text.length > 2000) throw new BridgeError(400, "Nothing to type.");
      await simtap(await deviceName(udid), "type", request.text); break;
    case "tap": {
      // x and y are fractions of the screenshot.
      const { x, y } = request;
      if (![x, y].every(v => typeof v === "number" && v >= 0 && v <= 1)) throw new BridgeError(400, "Tap outside the screen.");
      await simtap(await deviceName(udid), "tap", String(x), String(y)); break;
    }
    case "screenshot-ready": break;
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
  if (!UDID.test(udid)) throw new BridgeError(400, "Invalid simulator identifier.");
  if (process.platform !== "darwin") return [];
  const { stdout } = await exec("xcrun", ["simctl", "listapps", udid], { timeout: 15_000, maxBuffer: 4_194_304 }).catch(() => ({ stdout: "" }));
  const apps: Json[] = [];
  const blocks = stdout.split(/\n(?=\s{4}"[^"]+" =\s+\{)/);
  for (const block of blocks) {
    const id = /CFBundleIdentifier = "?([^";\n]+)"?;/.exec(block)?.[1], name = /CFBundleDisplayName = "?([^";\n]+)"?;/.exec(block)?.[1];
    const type = /ApplicationType = "?([^";\n]+)"?;/.exec(block)?.[1];
    if (id && name && type === "User" && !/\.xctrunner$/.test(id)) apps.push({ bundleId: id, name });
  }
  return apps.sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(0, 100);
}
