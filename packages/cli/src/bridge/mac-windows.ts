import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type NativeHelper, verifiedHelper } from "./native-helpers.js";
import { atomicInPrivateDir, BridgeError, bridgeRoot, type Json } from "./protocol.js";

/**
 * Phone control of this Mac's windows: list a Mac's windows, take one still
 * JPEG of a window, tap, type and key into it. Off by default per computer
 * (`phren mac-windows on` writes mac-windows.json); every route is owner-only
 * and every control request is logged without its typed text. The Swift
 * helpers, their commands and their exit codes are in .scratch/CONTRACT.md.
 */

/** How long a session (and its badge) lives after the last request. */
export const MAC_WINDOWS_IDLE_MS = 120_000;
/** How long requests are refused after the person presses Stop on the Mac. */
export const MAC_WINDOWS_STOP_MS = 60_000;

export type MacWindowPermissions = { screenRecording: boolean; accessibility: boolean };
export type MacWindow = { id: number; app: string; bundleId?: string; pid: number; title: string; frame: { x: number; y: number; width: number; height: number }; onScreen: boolean };
export type MacWindowsSnapshot = { enabled: boolean; permissions: MacWindowPermissions; windows: MacWindow[] };
export type MacWindowPermission = "screen-recording" | "accessibility";

const windowID = z.number().int().min(1).max(4_294_967_295);
const fraction = z.number().finite().min(0).max(1);
const modifier = z.enum(["cmd", "shift", "option", "control"]);
/** The keys wininput.swift knows, plus one letter or digit for ⌘-shortcuts. */
export const MAC_WINDOW_KEYS = ["return", "escape", "tab", "delete", "forwarddelete", "space", "up", "down", "left", "right",
  "home", "end", "pageup", "pagedown"] as const;
const windowKey = z.union([z.enum(MAC_WINDOW_KEYS), z.string().regex(/^[a-z0-9]$/)]);
/** One control request, as the phone sends it (the id is on every shape). */
export const macWindowAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tap"), id: windowID, x: fraction, y: fraction }),
  z.object({ action: z.literal("type"), id: windowID, text: z.string().min(1).max(2_000).refine(text => !/[\x00-\x1f\x7f]/.test(text), "Text may not contain control characters."), submit: z.boolean().optional() }),
  z.object({ action: z.literal("key"), id: windowID, key: windowKey, modifiers: z.array(modifier).max(4).optional() }),
  z.object({ action: z.literal("raise"), id: windowID }),
]);
export type MacWindowAction = z.infer<typeof macWindowAction>;

const enabledFile = () => path.join(bridgeRoot(), "mac-windows.json");

/** Whether phone control is on for this computer; off unless its file says so. */
export async function macWindowsEnabled(): Promise<boolean> {
  const saved = await readFile(enabledFile(), "utf8").then(text => JSON.parse(text) as { enabled?: unknown }).catch(() => undefined);
  return saved?.enabled === true;
}

/** Turn phone control on or off for this computer (file 0600, dir 0700). */
export async function setMacWindowsEnabled(enabled: boolean): Promise<void> {
  await atomicInPrivateDir(enabledFile(), { enabled }, 0o600);
}

export interface MacWindowsHelperCall { helper: NativeHelper; args: string[]; input?: string; timeoutMs?: number }
export interface MacWindowsHelperResult { stdout: Buffer; stderr: string; code: number }
/** The winbadge child: its stdin stays open for the session, the Hook kills it. */
export interface MacWindowsBadge { kill(signal: NodeJS.Signals): void; onExit(listener: (code: number | null) => void): void }

interface MacWindowsDeps {
  platform: () => NodeJS.Platform;
  run: (call: MacWindowsHelperCall) => Promise<MacWindowsHelperResult>;
  spawnBadge: () => Promise<MacWindowsBadge>;
  now: () => number;
}

async function runHelperProcess(call: MacWindowsHelperCall): Promise<MacWindowsHelperResult> {
  const binary = await verifiedHelper(call.helper);
  return new Promise(resolve => {
    const child = spawn(binary, call.args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], said: Buffer[] = [];
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: MacWindowsHelperResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ stdout: Buffer.concat(out), stderr: "timed out", code: 124 });
    }, call.timeoutMs ?? 60_000);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => said.push(chunk));
    child.on("error", error => finish({ stdout: Buffer.concat(out), stderr: error.message, code: 127 }));
    child.on("close", code => finish({ stdout: Buffer.concat(out), stderr: Buffer.concat(said).toString("utf8"), code: code ?? 1 }));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(call.input ?? "");
  });
}

async function spawnBadgeProcess(): Promise<MacWindowsBadge> {
  const binary = await verifiedHelper("winbadge");
  const child = spawn(binary, [], { stdio: ["pipe", "ignore", "ignore"] });
  child.stdin?.on("error", () => undefined);
  child.on("error", () => undefined);
  return { kill: signal => { child.kill(signal); }, onExit: listener => { child.once("exit", code => listener(code)); } };
}

const defaultDeps: MacWindowsDeps = {
  platform: () => process.platform,
  run: runHelperProcess,
  spawnBadge: spawnBadgeProcess,
  now: () => Date.now(),
};
let deps: MacWindowsDeps = defaultDeps;

/** Replaces part of the process seam (tests need no Mac); answers a restore. */
export function setMacWindowsDeps(replacement: Partial<MacWindowsDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...replacement };
  return () => { deps = previous; };
}

type Session = { id: string; timer: ReturnType<typeof setTimeout> };
let session: Session | undefined;
/** The newest session id, so a refusal after its end still logs under it. */
let lastSession: string | undefined;
let badge: MacWindowsBadge | undefined;
let stoppedUntil = 0;
let stoppedSession: string | undefined;

/** Test seam: forget the session, badge and stop window. */
export function resetMacWindowsState(): void {
  if (session) clearTimeout(session.timer);
  session = undefined;
  lastSession = undefined;
  badge?.kill("SIGTERM");
  badge = undefined;
  stoppedUntil = 0;
  stoppedSession = undefined;
  inputQueue = Promise.resolve();
  promptedScreenRecording = false;
  promptedAccessibility = false;
}

function requireDarwin(): void {
  if (deps.platform() !== "darwin") throw new BridgeError(404, "Mac windows are macOS only.");
}

function stoppage(): BridgeError | undefined {
  return deps.now() < stoppedUntil
    ? new BridgeError(409, "Phone control was stopped on the Mac. Try again in a minute.", { code: "mac-windows-stopped" })
    : undefined;
}

type SessionRow = { session: string; action: string; windowId?: number; app?: string; ok: boolean; error?: string; chars?: number };

async function appendSessionRow(row: SessionRow): Promise<void> {
  const folder = path.join(bridgeRoot(), "mac-windows");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await appendFile(path.join(folder, "sessions.jsonl"), JSON.stringify({ at: new Date(deps.now()).toISOString(), ...row }) + "\n", { mode: 0o600 });
}

/** An audit row for a request refused before it had a session. */
async function logRefusal(action: string, error: BridgeError, windowId?: number): Promise<void> {
  const id = session?.id ?? stoppedSession ?? lastSession ?? randomUUID();
  await appendSessionRow({ session: id, action, ok: false, error: error.message, ...(windowId !== undefined ? { windowId } : {}) })
    .catch(() => undefined);
}

function armIdleTimer(id: string): Session["timer"] {
  const timer = setTimeout(() => { if (session?.id === id) void endSession().catch(() => undefined); }, MAC_WINDOWS_IDLE_MS);
  timer.unref?.();
  return timer;
}

async function startBadge(id: string): Promise<void> {
  const spawned = await deps.spawnBadge().catch(() => undefined);
  if (!spawned) return;
  // The session may have ended while the helper was built.
  if (session?.id !== id) { spawned.kill("SIGTERM"); return; }
  badge = spawned;
  spawned.onExit(code => {
    if (badge !== spawned) return;
    badge = undefined;
    if (code !== 10) return;
    // The person pressed Stop in the Mac's menu bar: no more control for a minute.
    stoppedUntil = deps.now() + MAC_WINDOWS_STOP_MS;
    stoppedSession = lastSession;
    void endSession().catch(() => undefined);
  });
}

/** Starts the session (and the on-Mac badge) or keeps it alive. */
async function touchSession(): Promise<string> {
  const stopped = stoppage();
  if (stopped) throw stopped;
  if (session) {
    clearTimeout(session.timer);
    session.timer = armIdleTimer(session.id);
    return session.id;
  }
  const id = randomUUID();
  lastSession = id;
  session = { id, timer: armIdleTimer(id) };
  await startBadge(id);
  return id;
}

async function endSession(): Promise<void> {
  const ending = session;
  if (!ending) return;
  session = undefined;
  clearTimeout(ending.timer);
  const running = badge;
  badge = undefined;
  running?.kill("SIGTERM");
  await appendSessionRow({ session: ending.id, action: "session-end", ok: true }).catch(() => undefined);
}

// The badge must go when the Hook does, or it outlives the reason it showed.
process.once("exit", () => { badge?.kill("SIGTERM"); });

let inputQueue: Promise<void> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = inputQueue.catch(() => {}).then(task);
  inputQueue = next.then(() => undefined, () => undefined);
  return next;
}

let promptedScreenRecording = false, promptedAccessibility = false;
/** Asks macOS for a grant, once per Hook run so a burst of requests raises one dialog. */
async function promptOnce(permission: MacWindowPermission): Promise<void> {
  if (permission === "screen-recording") {
    if (promptedScreenRecording) return;
    promptedScreenRecording = true;
    await deps.run({ helper: "wincap", args: ["prompt"], timeoutMs: 15_000 }).catch(() => undefined);
  } else {
    if (promptedAccessibility) return;
    promptedAccessibility = true;
    await deps.run({ helper: "wininput", args: ["prompt"], timeoutMs: 15_000 }).catch(() => undefined);
  }
}

function screenRecordingHelp(): string {
  return "Mac windows need Screen Recording. On the Mac, open System Settings → Privacy & Security → Screen Recording and switch on wincap. "
    + "If it isn't listed, start phone control once more and answer the system dialog.";
}

function accessibilityHelp(): string {
  return "Taps, keys and typing need Accessibility. On the Mac, open System Settings → Privacy & Security → Accessibility and switch on wininput. "
    + "If it isn't listed, start phone control once more and answer the system dialog.";
}

function helperError(result: MacWindowsHelperResult): BridgeError {
  const said = result.stderr.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 160);
  if (result.code === 3 && /screen-recording/.test(said)) return new BridgeError(403, screenRecordingHelp(), { code: "mac-windows-screen-recording" });
  if (result.code === 3 && /accessibility/.test(said)) return new BridgeError(403, accessibilityHelp(), { code: "mac-windows-accessibility" });
  if (result.code === 5 || /^no window/i.test(said)) return new BridgeError(404, "That window is gone from this Mac.");
  if (result.code === 3) return new BridgeError(403, said || "macOS did not grant that permission.", { code: "mac-windows-permission" });
  if (result.code === 2) return new BridgeError(400, `The Mac window helper refused that command: ${said || "bad arguments"}`);
  return new BridgeError(409, `The Mac window helper failed: ${said || "unknown error"}`);
}

async function check(helper: "wincap" | "wininput"): Promise<boolean> {
  const result = await deps.run({ helper, args: ["check"], timeoutMs: 15_000 }).catch(() => undefined);
  return result?.code === 0;
}

/** The two macOS grants the window helpers need. */
export async function macWindowPermissions(): Promise<MacWindowPermissions> {
  requireDarwin();
  const [screenRecording, accessibility] = await Promise.all([check("wincap"), check("wininput")]);
  return { screenRecording, accessibility };
}

const windowsAnswer = z.object({
  windows: z.array(z.object({
    id: windowID,
    app: z.string(),
    bundleId: z.string().optional(),
    pid: z.number().int(),
    title: z.string(),
    frame: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    onScreen: z.boolean(),
  })).max(500),
});

/** `wincap list`: the shareable windows, front to back. */
async function listWindows(): Promise<MacWindow[]> {
  const result = await deps.run({ helper: "wincap", args: ["list"], timeoutMs: 20_000 });
  if (result.code === 3) return [];
  if (result.code !== 0) throw helperError(result);
  let listed: unknown;
  try { listed = JSON.parse(result.stdout.toString("utf8") || "{}"); } catch { listed = undefined; }
  const parsed = windowsAnswer.safeParse(listed);
  if (!parsed.success) throw new BridgeError(409, "The Mac window helper answered something else than a window list.");
  return parsed.data.windows.slice(0, 200);
}

/** Everything the phone asks before showing the Mac windows list. */
export async function macWindowsList(): Promise<MacWindowsSnapshot> {
  requireDarwin();
  if (!await macWindowsEnabled()) {
    // Off: answer 200 with the explanation state, and run no helper at all.
    return { enabled: false, permissions: { screenRecording: false, accessibility: false }, windows: [] };
  }
  const stopped = stoppage();
  if (stopped) { await logRefusal("list", stopped); throw stopped; }
  try {
    const id = await touchSession();
    const permissions = await macWindowPermissions();
    const windows = permissions.screenRecording ? await listWindows() : [];
    await appendSessionRow({ session: id, action: "list", ok: true });
    return { enabled: true, permissions, windows };
  } catch (error) {
    if (error instanceof BridgeError) await logRefusal("list", error);
    throw error;
  }
}

/** One still JPEG of a window, longest side at most `size`, quality 30 to 90. */
export async function macWindowsSnapshot(id: unknown, size: unknown = 1600, quality: unknown = 70): Promise<Buffer> {
  requireDarwin();
  const windowId = windowID.safeParse(typeof id === "string" ? Number(id) : id);
  if (!windowId.success) throw new BridgeError(400, "Snapshot needs a window id between 1 and 4294967295.");
  const maxSide = z.number().int().min(160).max(2_400).safeParse(typeof size === "string" ? Number(size) : size);
  if (!maxSide.success) throw new BridgeError(400, "The snapshot size is 160 to 2400 pixels.");
  const jpegQuality = z.number().int().min(30).max(90).safeParse(typeof quality === "string" ? Number(quality) : quality);
  if (!jpegQuality.success) throw new BridgeError(400, "The snapshot quality is 30 to 90.");
  if (!await macWindowsEnabled()) throw new BridgeError(409, "Phone control is off on this Mac. Run `phren mac-windows on` there.", { code: "mac-windows-disabled" });
  const stopped = stoppage();
  if (stopped) { await logRefusal("snapshot", stopped, windowId.data); throw stopped; }
  let sessionId: string | undefined;
  try {
    sessionId = await touchSession();
    const result = await deps.run({ helper: "wincap", args: ["snapshot", String(windowId.data), String(maxSide.data), String(jpegQuality.data / 100)], timeoutMs: 30_000 });
    if (result.code !== 0) throw helperError(result);
    await appendSessionRow({ session: sessionId, action: "snapshot", windowId: windowId.data, ok: true });
    return result.stdout;
  } catch (error) {
    if (error instanceof BridgeError) {
      if (error.details?.code === "mac-windows-screen-recording") await promptOnce("screen-recording");
      await appendSessionRow({ session: sessionId ?? stoppedSession ?? lastSession ?? randomUUID(), action: "snapshot", windowId: windowId.data, ok: false, error: error.message }).catch(() => undefined);
    }
    throw error;
  }
}

function modifierFlags(modifiers: readonly string[]): string[] {
  return (["cmd", "shift", "option", "control"] as const).filter(name => modifiers.includes(name));
}

async function runAction(action: MacWindowAction): Promise<void> {
  const id = String(action.id);
  switch (action.action) {
    case "tap": {
      const result = await deps.run({ helper: "wininput", args: ["tap", id, String(action.x), String(action.y)], timeoutMs: 30_000 });
      if (result.code !== 0) throw helperError(result);
      return;
    }
    case "type": {
      // The text rides on stdin, never in argv (it would show in ps).
      const result = await deps.run({ helper: "wininput", args: ["type", id], input: action.text + (action.submit === true ? "\n" : ""), timeoutMs: 60_000 });
      if (result.code !== 0) throw helperError(result);
      return;
    }
    case "key": {
      const result = await deps.run({ helper: "wininput", args: ["key", id, action.key, ...modifierFlags(action.modifiers ?? [])], timeoutMs: 30_000 });
      if (result.code !== 0) throw helperError(result);
      return;
    }
    case "raise": {
      const result = await deps.run({ helper: "wininput", args: ["raise", id], timeoutMs: 30_000 });
      if (result.code !== 0) throw helperError(result);
    }
  }
}

/** Taps, types, keys or raises one window; inputs run one at a time. */
export async function macWindowsAct(input: unknown): Promise<Json> {
  requireDarwin();
  const parsed = macWindowAction.safeParse(input);
  if (!parsed.success) throw new BridgeError(400, `That window action is not valid: ${parsed.error.issues[0]?.message ?? "check its fields"}.`);
  const action = parsed.data;
  return serialized(async () => {
    const stopped = stoppage();
    if (stopped) { await logRefusal(action.action, stopped, action.id); throw stopped; }
    if (!await macWindowsEnabled()) {
      const off = new BridgeError(409, "Phone control is off on this Mac. Run `phren mac-windows on` there.", { code: "mac-windows-disabled" });
      await logRefusal(action.action, off, action.id);
      throw off;
    }
    const sessionId = await touchSession();
    try {
      await runAction(action);
      await appendSessionRow({ session: sessionId, action: action.action, windowId: action.id, ok: true,
        ...(action.action === "type" ? { chars: action.text.length } : {}) });
      return { ok: true };
    } catch (error) {
      if (error instanceof BridgeError) {
        if (error.details?.code === "mac-windows-accessibility") await promptOnce("accessibility");
        await appendSessionRow({ session: sessionId, action: action.action, windowId: action.id, ok: false, error: error.message,
          ...(action.action === "type" ? { chars: action.text.length } : {}) }).catch(() => undefined);
      }
      throw error;
    }
  });
}

/** Asks macOS for one grant (it shows the system dialog) and answers both. */
export async function macWindowsRequestPermission(permission: unknown): Promise<MacWindowPermissions> {
  requireDarwin();
  const kind = z.enum(["screen-recording", "accessibility"]).safeParse(permission);
  if (!kind.success) throw new BridgeError(400, "Ask for screen-recording or accessibility.");
  const stopped = stoppage();
  if (stopped) { await logRefusal("permissions", stopped); throw stopped; }
  const sessionId = await touchSession();
  await deps.run({ helper: kind.data === "screen-recording" ? "wincap" : "wininput", args: ["prompt"], timeoutMs: 15_000 }).catch(() => undefined);
  const permissions = await macWindowPermissions();
  await appendSessionRow({ session: sessionId, action: "permissions", ok: true });
  return permissions;
}

/** The owner-only gate the route layer applies to every Mac window route. */
export function macWindowsOwnerOnly(owner: boolean): void {
  if (!owner) throw new BridgeError(403, "Only the owner can control this Mac's windows.", { code: "mac-windows-owner-only" });
}
