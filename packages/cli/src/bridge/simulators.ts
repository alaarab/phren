import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { BridgeError, type Json } from "./protocol.js";

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
