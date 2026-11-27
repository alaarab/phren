import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { release as osRelease } from "node:os";
import path from "node:path";
import { z } from "zod";
import { type NativeHelper, verifiedHelper } from "./native-helpers.js";
import { atomicInPrivateDir, BridgeError, bridgeRoot, errorCode, type Json } from "./protocol.js";

/**
 * Phone control of this Mac's windows: list a Mac's windows, take one still
 * JPEG of a window, tap, type and key into it. Off by default per computer
 * (`phren mac-windows on` writes mac-windows.json); every route is owner-only
 * and every control request is audited without its typed text. The Swift
 * helpers, their commands and their exit codes are in docs/phren-hook.md
 * ("Mac windows on a Mac").
 */

/** How long a session (and its badge) lives after the last request. */
export const MAC_WINDOWS_IDLE_MS = 120_000;
/** How long requests are refused after the person presses Stop on the Mac. */
export const MAC_WINDOWS_STOP_MS = 60_000;
/** The whole indicator startup (swiftc build included). */
export const MAC_WINDOWS_BUILD_MS = 240_000;
/** The badge's "ready" line, counted from the spawn. */
export const MAC_WINDOWS_READY_MS = 10_000;
/** How often an open session re-reads the enable file. */
export const MAC_WINDOWS_ENABLE_POLL_MS = 500;
/** How long wininput gets to finish its event pair after SIGTERM. */
export const MAC_WINDOWS_TERM_GRACE_MS = 500;
/** macOS 14 is Darwin 23; ScreenCaptureKit's single-window capture needs it. */
const MACOS_14_DARWIN_MAJOR = 23;

export type MacWindowPermissions = { screenRecording: boolean; accessibility: boolean };
/** One grant: `granted`, or why the helper could not even say ("helper unavailable"). */
export type MacWindowPermissionState = { granted: boolean; unavailable?: string };
export type MacWindowPermissionReport = { screenRecording: MacWindowPermissionState; accessibility: MacWindowPermissionState };
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

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** User-perceived characters, as the phone and wininput.swift count them. */
export function graphemeCount(text: string): number { return [...segmenter.segment(text)].length; }

/** One control request, as the phone sends it (the id is on every shape). */
export const macWindowAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tap"), id: windowID, x: fraction, y: fraction }),
  z.object({ action: z.literal("type"), id: windowID, text: z.string().refine(text => !/[\x00-\x1f\x7f]/.test(text), "Text may not contain control characters.")
    .refine(text => graphemeCount(text) >= 1 && graphemeCount(text) <= 2_000, "Text is 1 to 2000 characters."), submit: z.boolean().optional() }),
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

/** macOS 14 or later on a Mac: the one check behind the capability and every route. */
export function macWindowsSupported(platform: NodeJS.Platform = process.platform, release: string = osRelease()): boolean {
  return platform === "darwin" && Number(release.split(".")[0]) >= MACOS_14_DARWIN_MAJOR;
}

export interface MacWindowsHelperCall { helper: NativeHelper; args: string[]; input?: string; timeoutMs?: number; local?: boolean }
export interface MacWindowsHelperResult { stdout: Buffer; stderr: string; code: number }
/** The winbadge child: its stdin stays open for the session, `ready` when it shows. */
export interface MacWindowsBadge {
  ready: Promise<void>;
  kill(signal: NodeJS.Signals): void;
  onExit(listener: (code: number | null) => void): void;
}

interface MacWindowsDeps {
  platform: () => NodeJS.Platform;
  release: () => string;
  run: (call: MacWindowsHelperCall, signal: AbortSignal) => Promise<MacWindowsHelperResult>;
  spawnBadge: (signal: AbortSignal) => Promise<MacWindowsBadge>;
  now: () => number;
  pollMs: () => number;
  /** The pre-spawn setting read (local probes skip it). */
  enabled: () => Promise<boolean>;
}

/** An ended session (Stop, idle, disable, shutdown) refuses its helpers. */
function cancelled(): BridgeError {
  return new BridgeError(409, "Phone control ended before that finished.", { code: "mac-windows-cancelled" });
}

function disabledError(): BridgeError {
  return new BridgeError(409, "Phone control is off on this Mac. Run `phren mac-windows on` there.", { code: "mac-windows-disabled" });
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    timer.unref?.();
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/** Runs one helper with the session signal; local probes skip the setting gate. */
export async function runMacWindowsHelper(call: MacWindowsHelperCall, signal: AbortSignal): Promise<MacWindowsHelperResult> {
  if (signal.aborted) throw cancelled();
  const binary = await verifiedHelper(call.helper);
  if (signal.aborted) throw cancelled();
  // The CLI's status probes are local and read-only; session work is gated on the setting.
  if (!call.local && !await deps.enabled()) throw disabledError();
  // The read took time: an `off`, Stop or shutdown that landed meanwhile must not spawn.
  if (signal.aborted) throw cancelled();
  return new Promise(resolve => {
    const child = spawn(binary, call.args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], said: Buffer[] = [];
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined, escalate: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: MacWindowsHelperResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", kill);
      if (timer) clearTimeout(timer);
      if (escalate) clearTimeout(escalate);
      resolve(result);
    };
    // wininput stops at the next event-pair boundary and exits 8; anything else is killed now.
    const kill = () => {
      if (call.helper !== "wininput") { child.kill("SIGKILL"); return; }
      child.kill("SIGTERM");
      escalate = setTimeout(() => child.kill("SIGKILL"), MAC_WINDOWS_TERM_GRACE_MS);
      escalate.unref?.();
    };
    signal.addEventListener("abort", kill, { once: true });
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

async function spawnBadgeProcess(signal: AbortSignal): Promise<MacWindowsBadge> {
  const binary = await verifiedHelper("winbadge");
  // The build can outlast the session or the setting; a child that nobody wants must not start.
  if (signal.aborted) throw new Error("the session ended while the indicator was building");
  if (!await macWindowsEnabled()) throw new Error("phone control is off");
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
  child.stdin?.on("error", () => undefined);
  child.on("error", () => undefined);
  // The helper prints one line once its panels are on screen.
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false, said = "";
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => done(new Error("the indicator did not report ready")), MAC_WINDOWS_READY_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      said += chunk.toString("utf8");
      if (/^ready\r?\n/.test(said)) done();
    });
    child.on("close", code => done(new Error(`the indicator exited (${code ?? "signal"})`)));
  });
  // A caller that gives up early must not leave an unhandled rejection behind.
  ready.catch(() => undefined);
  return { ready, kill: signal => { child.kill(signal); }, onExit: listener => { child.once("exit", code => listener(code)); } };
}

const defaultDeps: MacWindowsDeps = {
  platform: () => process.platform,
  release: () => osRelease(),
  run: runMacWindowsHelper,
  spawnBadge: spawnBadgeProcess,
  now: () => Date.now(),
  pollMs: () => MAC_WINDOWS_ENABLE_POLL_MS,
  enabled: () => macWindowsEnabled(),
};
let deps: MacWindowsDeps = defaultDeps;

/** Replaces part of the process seam (tests need no Mac); answers a restore. */
export function setMacWindowsDeps(replacement: Partial<MacWindowsDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...replacement };
  return () => { deps = previous; };
}

/** One session, shared by concurrent requests: its indicator, id and cancellation. */
type Session = {
  id: string;
  ready: Promise<void>;
  abort: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  poll?: ReturnType<typeof setInterval>;
  inflight: number;
  readyDone: boolean;
  ended: boolean;
};

let session: Session | undefined;
/** The newest session id, so a refusal after its end still logs under it. */
let lastSession: string | undefined;
let badge: MacWindowsBadge | undefined;
let stoppedUntil = 0;
let stoppedSession: string | undefined;
let shuttingDown = false;
let sessionEnding: Promise<void> = Promise.resolve();

/** Test seam: forget the session, badge and stop window. */
export function resetMacWindowsState(): void {
  if (session?.timer) clearTimeout(session.timer);
  if (session?.poll) clearInterval(session.poll);
  session?.abort.abort();
  session = undefined;
  lastSession = undefined;
  badge?.kill("SIGTERM");
  badge = undefined;
  stoppedUntil = 0;
  stoppedSession = undefined;
  shuttingDown = false;
  sessionEnding = Promise.resolve();
  inputQueue = Promise.resolve();
  promptedScreenRecording = false;
  promptedAccessibility = false;
}

function requireSupport(): void {
  if (!macWindowsSupported(deps.platform(), deps.release())) throw new BridgeError(404, "Mac windows need macOS 14 or later.");
}

function stoppage(): BridgeError | undefined {
  return deps.now() < stoppedUntil
    ? new BridgeError(409, "Phone control was stopped on the Mac. Try again in a minute.", { code: "mac-windows-stopped" })
    : undefined;
}

type SessionRow = { session: string; action: string; windowId?: number; app?: string; ok: boolean; error?: string; chars?: number; admitted?: boolean };

/** The only action names the audit log ever carries. */
export const MAC_WINDOW_AUDIT_ACTIONS = ["tap", "type", "key", "raise", "list", "snapshot", "permissions", "session-end", "invalid"] as const;
function auditedAction(action: unknown): string {
  return typeof action === "string" && (MAC_WINDOW_AUDIT_ACTIONS as readonly string[]).includes(action) ? action : "invalid";
}

async function appendSessionRow(row: SessionRow): Promise<void> {
  const folder = path.join(bridgeRoot(), "mac-windows");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await appendFile(path.join(folder, "sessions.jsonl"), JSON.stringify({ at: new Date(deps.now()).toISOString(), ...row }) + "\n", { mode: 0o600 });
}

/** The session a refusal row belongs to (a fresh id only before any session). */
function auditSessionID(): string { return session?.id ?? stoppedSession ?? lastSession ?? randomUUID(); }

const auditedErrors = new WeakSet<BridgeError>();
function audited(error: BridgeError): BridgeError { auditedErrors.add(error); return error; }

/**
 * Logs a refused request with fixed fields: one of MAC_WINDOW_AUDIT_ACTIONS, a
 * parseable window id and a stable error code. Called at the route boundary, so
 * owner-proof, body-parse, owner-only, disabled and invalid-input refusals are
 * audited too. Errors whose row already exists are left alone.
 */
export async function macWindowsRefusal(action: unknown, id: unknown, error: unknown): Promise<void> {
  if (error instanceof BridgeError && auditedErrors.has(error)) return;
  const parsed = typeof id === "string" ? (id.trim() ? Number(id) : NaN) : typeof id === "number" ? id : NaN;
  const windowId = Number.isInteger(parsed) && parsed >= 1 && parsed <= 4_294_967_295 ? parsed : undefined;
  const code = errorCode(error) ?? "error";
  await appendSessionRow({ session: auditSessionID(), action: auditedAction(action), ...(windowId !== undefined ? { windowId } : {}), ok: false, error: code })
    .catch(() => undefined);
}

function armIdle(target: Session): void {
  if (target.ended || session !== target || !target.readyDone) return;
  if (target.timer) clearTimeout(target.timer);
  target.timer = setTimeout(() => target.ended || target.inflight > 0 ? undefined : endSession(target).catch(() => undefined), MAC_WINDOWS_IDLE_MS);
  target.timer.unref?.();
}

/** Counts a request in flight and refreshes the idle clock as it is admitted. */
function beginRequest(target: Session): void {
  target.inflight++;
  armIdle(target);
}

function finishRequest(target: Session): void {
  target.inflight = Math.max(0, target.inflight - 1);
  armIdle(target);
}

/** An open session re-reads the enable file, so `phren mac-windows off` reaches it. */
function watchEnabled(target: Session): void {
  target.poll = setInterval(() => {
    void macWindowsEnabled().then(enabled => {
      if (!enabled && !target.ended) return endSession(target);
    }, () => undefined);
  }, deps.pollMs());
  target.poll.unref?.();
}
async function endSession(target?: Session): Promise<void> {
  const ending = target ?? session;
  if (!ending || ending.ended) return;
  ending.ended = true;
  if (session === ending) session = undefined;
  if (ending.timer) clearTimeout(ending.timer);
  if (ending.poll) clearInterval(ending.poll);
  // Cancels a running helper and refuses whatever is still queued.
  ending.abort.abort();
  const running = badge;
  badge = undefined;
  running?.kill("SIGTERM");
  sessionEnding = appendSessionRow({ session: ending.id, action: "session-end", ok: true }).catch(() => undefined);
  await sessionEnding;
}

/** Test seam: the audit write of the most recent session end. */
export function macWindowsSessionEnd(): Promise<void> { return sessionEnding; }

/** Ends the current session and kills the badge; the Hook calls this when it stops. */
export async function stopMacWindows(): Promise<void> {
  // Set before any await, so a handler resuming later cannot start a session.
  shuttingDown = true;
  const pending = session?.ready;
  await endSession();
  // A badge still being built is disposed of by its own startup check; wait for it to get there.
  await pending?.catch(() => undefined);
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
async function promptOnce(permission: MacWindowPermission, signal: AbortSignal): Promise<void> {
  if (permission === "screen-recording") {
    if (promptedScreenRecording) return;
    promptedScreenRecording = true;
    await deps.run({ helper: "wincap", args: ["prompt"], timeoutMs: 15_000 }, signal).catch(() => undefined);
  } else {
    if (promptedAccessibility) return;
    promptedAccessibility = true;
    await deps.run({ helper: "wininput", args: ["prompt"], timeoutMs: 15_000 }, signal).catch(() => undefined);
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
  if (result.code === 6 || /^focus/i.test(said)) return new BridgeError(409, "That window lost focus on the Mac before the input landed. Nothing more was sent.", { code: "mac-windows-focus" });
  if (result.code === 7 || /^orphaned/i.test(said)) return new BridgeError(409, "The Mac window helper stopped.", { code: "mac-windows-helper" });
  if (result.code === 8 || /^cancelled/i.test(said)) {
    return new BridgeError(409, "Phone control ended before that input finished; part of the text may have been typed.", { code: "mac-windows-cancelled" });
  }
  if (result.code === 5 || /^no window/i.test(said)) return new BridgeError(404, "That window is gone from this Mac.");
  if (result.code === 3) return new BridgeError(403, said || "macOS did not grant that permission.", { code: "mac-windows-permission" });
  if (result.code === 2) return new BridgeError(400, `The Mac window helper refused that command: ${said || "bad arguments"}`);
  return new BridgeError(409, `The Mac window helper failed: ${said || "unknown error"}`);
}

async function runHelper(call: MacWindowsHelperCall, timeoutMs: number, signal: AbortSignal): Promise<MacWindowsHelperResult> {
  if (signal.aborted) throw cancelled();
  const result = await deps.run({ ...call, timeoutMs }, signal);
  // A helper that finished an event pair cleanly just before the abort is a success;
  // exit 8 is the cooperative stop and carries its own message.
  if (signal.aborted && result.code !== 0 && result.code !== 8) throw cancelled();
  return result;
}

async function permissionCheck(helper: "wincap" | "wininput", signal?: AbortSignal, local = false): Promise<MacWindowPermissionState> {
  try {
    const result = await deps.run({ helper, args: ["check"], timeoutMs: 15_000, ...(local ? { local: true } : {}) }, signal ?? new AbortController().signal);
    // A probe that finished after Stop reports the cancellation, never a grant.
    if (signal?.aborted) throw cancelled();
    if (result.code === 0) return { granted: true };
    if (result.code === 3) return { granted: false };
    const said = result.stderr.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 160);
    return { granted: false, unavailable: said || `the helper exited ${result.code}` };
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    // Cancellation and a mid-probe disable are not a missing grant.
    if (error instanceof BridgeError && ["mac-windows-cancelled", "mac-windows-disabled"].includes(String(error.details?.code))) throw error;
    return { granted: false, unavailable: error instanceof Error ? error.message : String(error) };
  }
}

/** Both grants, with a helper that could not build or run told apart from a denied grant. */
export async function macWindowsPermissionReport(signal?: AbortSignal, local = false): Promise<MacWindowPermissionReport> {
  requireSupport();
  const [screenRecording, accessibility] = await Promise.all([permissionCheck("wincap", signal, local), permissionCheck("wininput", signal, local)]);
  return { screenRecording, accessibility };
}

/** The CLI status probes: local and read-only, so the setting and a session do not gate them. */
export function macWindowsLocalPermissionReport(): Promise<MacWindowPermissionReport> {
  return macWindowsPermissionReport(undefined, true);
}

/** The two macOS grants the window helpers need. */
export async function macWindowPermissions(signal?: AbortSignal): Promise<MacWindowPermissions> {
  const report = await macWindowsPermissionReport(signal);
  return { screenRecording: report.screenRecording.granted, accessibility: report.accessibility.granted };
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
async function listWindows(signal: AbortSignal): Promise<MacWindow[]> {
  const result = await runHelper({ helper: "wincap", args: ["list"] }, 20_000, signal);
  if (result.code === 3) return [];
  if (result.code !== 0) throw helperError(result);
  let listed: unknown;
  try { listed = JSON.parse(result.stdout.toString("utf8") || "{}"); } catch { listed = undefined; }
  const parsed = windowsAnswer.safeParse(listed);
  if (!parsed.success) throw new BridgeError(409, "The Mac window helper answered something else than a window list.");
  return parsed.data.windows.slice(0, 200);
}

function indicatorError(): BridgeError {
  return new BridgeError(409, "The on-Mac indicator did not start.", { code: "mac-windows-indicator" });
}

async function startIndicator(target: Session): Promise<void> {
  try {
    let late = false;
    const spawning = deps.spawnBadge(target.abort.signal);
    // A build that finishes after the deadline or the session's end leaves an unwanted child.
    spawning.then(spawned => {
      if (late || target.ended || target.abort.signal.aborted) spawned.kill("SIGTERM");
    }).catch(() => undefined);
    let spawned: MacWindowsBadge;
    try {
      spawned = await within(spawning, MAC_WINDOWS_BUILD_MS);
    } catch (error) {
      late = true;
      throw error;
    }
    if (target.ended || target.abort.signal.aborted) { spawned.kill("SIGTERM"); throw indicatorError(); }
    badge = spawned;
    let earlyExit: (() => void) | undefined;
    const exit = new Promise<never>((_resolve, reject) => {
      earlyExit = () => reject(indicatorError());
    });
    spawned.onExit(code => {
      earlyExit?.();
      if (session !== target) return;
      // Any indicator exit invalidates the session; Stop also refuses for a minute.
      if (code === 10) { stoppedUntil = deps.now() + MAC_WINDOWS_STOP_MS; stoppedSession = target.id; }
      void endSession(target).catch(() => undefined);
    });
    await within(Promise.race([spawned.ready, exit]), MAC_WINDOWS_READY_MS);
    if (target.ended || target.abort.signal.aborted) throw indicatorError();
    target.readyDone = true;
    watchEnabled(target);
    armIdle(target);
  } catch {
    await endSession(target).catch(() => undefined);
    throw indicatorError();
  }
}

/** The session, starting the indicator on the first request; concurrent requests share it. */
function openSession(): Session {
  if (shuttingDown) throw new BridgeError(503, "The Hook is shutting down.", { code: "mac-windows-shutdown" });
  const stopped = stoppage();
  if (stopped) throw stopped;
  if (session) return session;
  const target: Session = { id: randomUUID(), ready: Promise.resolve(), abort: new AbortController(), inflight: 0, readyDone: false, ended: false };
  lastSession = target.id;
  session = target;
  target.ready = startIndicator(target);
  target.ready.catch(() => undefined);
  return target;
}

/** Refuses work whose session ended while it waited (queue, startup, disable). */
function requireLive(target: Session): void {
  if (target.ended || session !== target || target.abort.signal.aborted) throw cancelled();
}

/** Everything the phone asks before showing the Mac windows list. */
export async function macWindowsList(): Promise<MacWindowsSnapshot> {
  requireSupport();
  if (!await macWindowsEnabled()) {
    // Off: answer 200 with the explanation state, run no helper, and record why nothing is listed.
    await endSession();
    await appendSessionRow({ session: auditSessionID(), action: "list", ok: false, error: "mac-windows-disabled" }).catch(() => undefined);
    return { enabled: false, permissions: { screenRecording: false, accessibility: false }, windows: [] };
  }
  const target = openSession();
  try {
    await target.ready;
    requireLive(target);
    beginRequest(target);
    const report = await macWindowsPermissionReport(target.abort.signal);
    // A helper that cannot build or run is not a denied grant.
    const unavailable = report.screenRecording.unavailable ?? report.accessibility.unavailable;
    if (unavailable) throw new BridgeError(409, `The Mac window helper could not run: ${unavailable}`, { code: "mac-windows-helper" });
    const permissions = { screenRecording: report.screenRecording.granted, accessibility: report.accessibility.granted };
    const windows = permissions.screenRecording ? await listWindows(target.abort.signal) : [];
    requireLive(target);
    await appendSessionRow({ session: target.id, action: "list", ok: true });
    return { enabled: true, permissions, windows };
  } catch (error) {
    if (error instanceof BridgeError) {
      await appendSessionRow({ session: target.id, action: "list", ok: false, error: errorCode(error) ?? "error" }).catch(() => undefined);
      throw audited(error);
    }
    throw error;
  } finally {
    finishRequest(target);
  }
}

/** One still JPEG of a window, longest side at most `size`, quality 30 to 90. */
export async function macWindowsSnapshot(id: unknown, size: unknown = 1600, quality: unknown = 70): Promise<Buffer> {
  requireSupport();
  const windowId = windowID.safeParse(typeof id === "string" ? Number(id) : id);
  if (!windowId.success) throw new BridgeError(400, "Snapshot needs a window id between 1 and 4294967295.");
  const maxSide = z.number().int().min(160).max(2_400).safeParse(typeof size === "string" ? Number(size) : size);
  if (!maxSide.success) throw new BridgeError(400, "The snapshot size is 160 to 2400 pixels.");
  const jpegQuality = z.number().int().min(30).max(90).safeParse(typeof quality === "string" ? Number(quality) : quality);
  if (!jpegQuality.success) throw new BridgeError(400, "The snapshot quality is 30 to 90.");
  if (!await macWindowsEnabled()) {
    await endSession();
    throw disabledError();
  }
  const target = openSession();
  try {
    await target.ready;
    requireLive(target);
    beginRequest(target);
    const result = await runHelper({ helper: "wincap", args: ["snapshot", String(windowId.data), String(maxSide.data), String(jpegQuality.data / 100)] },
      30_000, target.abort.signal);
    if (result.code !== 0) throw helperError(result);
    await appendSessionRow({ session: target.id, action: "snapshot", windowId: windowId.data, ok: true });
    return result.stdout;
  } catch (error) {
    if (error instanceof BridgeError) {
      if (error.details?.code === "mac-windows-screen-recording") await promptOnce("screen-recording", target.abort.signal);
      await appendSessionRow({ session: target.id, action: "snapshot", windowId: windowId.data, ok: false, error: errorCode(error) ?? "error" }).catch(() => undefined);
      throw audited(error);
    }
    throw error;
  } finally {
    finishRequest(target);
  }
}

function modifierFlags(modifiers: readonly string[]): string[] {
  return (["cmd", "shift", "option", "control"] as const).filter(name => modifiers.includes(name));
}

async function runAction(action: MacWindowAction, signal: AbortSignal): Promise<void> {
  const id = String(action.id);
  switch (action.action) {
    case "tap": {
      const result = await runHelper({ helper: "wininput", args: ["tap", id, String(action.x), String(action.y)] }, 30_000, signal);
      if (result.code !== 0) throw helperError(result);
      return;
    }
    case "type": {
      // The text rides on stdin, never in argv (it would show in ps). `submit` adds Return.
      const result = await runHelper({ helper: "wininput", args: ["type", id], input: action.text + (action.submit === true ? "\n" : "") }, 60_000, signal);
      if (result.code !== 0) throw helperError(result);
      return;
    }
    case "key": {
      const result = await runHelper({ helper: "wininput", args: ["key", id, action.key, ...modifierFlags(action.modifiers ?? [])] }, 30_000, signal);
      if (result.code !== 0) throw helperError(result);
      return;
    }
    case "raise": {
      const result = await runHelper({ helper: "wininput", args: ["raise", id] }, 30_000, signal);
      if (result.code !== 0) throw helperError(result);
    }
  }
}

/** Taps, types, keys or raises one window; inputs run one at a time. */
export async function macWindowsAct(input: unknown): Promise<Json> {
  requireSupport();
  const parsed = macWindowAction.safeParse(input);
  if (!parsed.success) throw new BridgeError(400, `That window action is not valid: ${parsed.error.issues[0]?.message ?? "check its fields"}.`);
  const action = parsed.data;
  if (!await macWindowsEnabled()) {
    await endSession();
    throw disabledError();
  }
  const target = openSession();
  return serialized(async () => {
    try {
      await target.ready;
      requireLive(target);
      // Re-read at the head of the queue: an `off` that landed while this waited refuses it.
      if (!await deps.enabled()) {
        await endSession(target);
        throw disabledError();
      }
      beginRequest(target);
      const chars = action.action === "type" ? graphemeCount(action.text) : undefined;
      // Admitted before any input: an input that lands must have an audit row.
      try {
        await appendSessionRow({ session: target.id, action: action.action, windowId: action.id, ok: true, ...(chars !== undefined ? { chars } : {}), admitted: true });
      } catch {
        throw new BridgeError(503, "The Mac window audit log could not be written, so nothing ran.", { code: "mac-windows-audit" });
      }
      try {
        await runAction(action, target.abort.signal);
      } catch (error) {
        if (error instanceof BridgeError && error.details?.code === "mac-windows-accessibility") await promptOnce("accessibility", target.abort.signal);
        await appendSessionRow({ session: target.id, action: action.action, windowId: action.id, ok: false,
          error: error instanceof BridgeError ? errorCode(error) ?? "error" : "error", ...(chars !== undefined ? { chars } : {}) }).catch(() => undefined);
        throw error instanceof BridgeError ? audited(error) : error;
      }
      // The input already landed; a lost completion row must not look like a failure.
      await appendSessionRow({ session: target.id, action: action.action, windowId: action.id, ok: true, ...(chars !== undefined ? { chars } : {}) }).catch(() => undefined);
      return { ok: true };
    } finally {
      finishRequest(target);
    }
  });
}

/** Asks macOS for one grant (it shows the system dialog) and answers both. */
export async function macWindowsRequestPermission(permission: unknown): Promise<MacWindowPermissions> {
  requireSupport();
  const kind = z.enum(["screen-recording", "accessibility"]).safeParse(permission);
  if (!kind.success) throw new BridgeError(400, "Ask for screen-recording or accessibility.");
  if (!await macWindowsEnabled()) {
    await endSession();
    throw disabledError();
  }
  const target = openSession();
  try {
    await target.ready;
    requireLive(target);
    beginRequest(target);
    await runHelper({ helper: kind.data === "screen-recording" ? "wincap" : "wininput", args: ["prompt"] }, 15_000, target.abort.signal).catch(() => undefined);
    const permissions = await macWindowPermissions(target.abort.signal);
    requireLive(target);
    await appendSessionRow({ session: target.id, action: "permissions", ok: true });
    return permissions;
  } finally {
    finishRequest(target);
  }
}

/** The owner-only gate the route layer applies to every Mac window route. */
export function macWindowsOwnerOnly(owner: boolean): void {
  if (!owner) throw new BridgeError(403, "Only the owner can control this Mac's windows.", { code: "mac-windows-owner-only" });
}
