import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { BridgeError, bridgeRoot } from "./protocol.js";

const execFileAsync = promisify(execFile);
/** Every helper child is killed outright at its timeout. SIGTERM, the
 * default, let one that ignored it hold its promise for good. */
const exec = (file: string, args: readonly string[], options: { timeout: number; maxBuffer?: number }) =>
  execFileAsync(file, args, { ...options, killSignal: "SIGKILL", encoding: "utf8" });

/**
 * The native helpers, compiled once per Hook version with swiftc, which any
 * Mac has. simtap (native/simtap.swift) finds the Simulator window through the
 * Accessibility API and posts touches and keys with CGEvent. AppleScript would
 * need Automation consent, which a launchd agent can never be prompted for; the
 * helper needs one Accessibility grant. simcast (native/simcast.swift) streams
 * a simulator's framebuffer for simulator-stream.ts and needs no grant.
 * wincap (native/wincap.swift) lists Mac windows and captures one picture,
 * wininput (native/wininput.swift) taps, types and keys into one, and winbadge
 * (native/winbadge.swift) is the visible "your phone is controlling this Mac"
 * indicator. See .scratch/CONTRACT.md for the window helpers' commands.
 */
export type NativeHelper = "simtap" | "simcast" | "wincap" | "wininput" | "winbadge";
const HELPER_LABEL: Record<NativeHelper, string> = {
  simtap: "simulator input helper",
  simcast: "simulator stream helper",
  wincap: "Mac window capture helper",
  wininput: "Mac window input helper",
  winbadge: "phone control indicator",
};
const building = new Map<NativeHelper, Promise<string>>();
function helper(name: NativeHelper): Promise<string> {
  let build = building.get(name);
  if (!build) { build = buildHelper(name).finally(() => building.delete(name)); building.set(name, build); }
  return build;
}
/** The source a name was bundled with, or undefined when this build predates
 * the Swift file (development builds without it fall back to the source tree). */
function bundledSource(name: NativeHelper): string | undefined {
  switch (name) {
    case "simtap": return typeof SIMTAP_SOURCE === "string" ? SIMTAP_SOURCE : undefined;
    case "simcast": return typeof SIMCAST_SOURCE === "string" ? SIMCAST_SOURCE : undefined;
    case "wincap": return typeof WINCAP_SOURCE === "string" ? WINCAP_SOURCE : undefined;
    case "wininput": return typeof WININPUT_SOURCE === "string" ? WININPUT_SOURCE : undefined;
    case "winbadge": return typeof WINBADGE_SOURCE === "string" ? WINBADGE_SOURCE : undefined;
  }
}
async function helperSource(name: NativeHelper): Promise<string> {
  return bundledSource(name) ?? await readFile(new URL(`./native/${name}.swift`, import.meta.url), "utf8");
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
declare const WINCAP_SOURCE: string | undefined;
declare const WININPUT_SOURCE: string | undefined;
declare const WINBADGE_SOURCE: string | undefined;

/** A helper, hashed again right before it runs. */
export async function verifiedHelper(name: NativeHelper = "simtap"): Promise<string> {
  const binary = await helper(name);
  const saved = await readFile(binary + ".sha256", "utf8").then(JSON.parse).catch(() => undefined);
  const binarySha = createHash("sha256").update(await readFile(binary)).digest("hex");
  if (!saved || saved.binarySha !== binarySha) throw new BridgeError(409, `${HELPER_LABEL[name][0].toUpperCase()}${HELPER_LABEL[name].slice(1)} integrity check failed.`);
  return binary;
}
