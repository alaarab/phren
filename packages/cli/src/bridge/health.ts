import { execFile, spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assessSyncOutage, FAILED_PUSH_STATUSES, getRuntimeHealth } from "../governance/policy.js";
import { getProjectDirs } from "../phren-paths.js";
import { resolveAllStores } from "../store-registry.js";
import { publicComputerKey } from "./computers.js";
import { hookPeers, peerRequest, type HookPeer } from "./peers.js";
import { BridgeError, bridgeRoot, errorCode, type Json } from "./protocol.js";
import { canonicalComputer, readScheduleDocument, readScheduleRuns, scheduleRunsFile } from "./schedules.js";
import { countGit } from "./metrics.js";
import { tmuxHealth, type TmuxHealth } from "./terminal-tmux.js";

const exec = promisify(execFile);

/** One tool's installed version, or why there is none. */
export interface ToolVersion { tool: string; status: "ok" | "missing" | "error"; version?: string; detail?: string }

export interface StoreSync {
  name: string; role: string; available: boolean;
  branch?: string; upstream?: string; ahead?: number; behind?: number;
  lastPushStatus?: string; lastPushAt?: string; lastSuccessfulPushAt?: string; consecutiveFailures?: number;
  /** The last sync failure in plain words, only while the store is failing. */
  error?: string;
  degraded: boolean;
}

export interface LastScheduledRun {
  name?: string; project: string; status: string; reason?: string; startedAt: string; finishedAt?: string;
}

export interface PeerHealth {
  name: string; reachable: boolean; ms: number; error?: string; version?: string;
  /** Why an unreachable peer failed, as a stable offline code (docs/phren-hook.md#offline-reasons). */
  code?: string;
  /** Whether the peer's own hooks.yaml lists this computer; null when its Hook is too old to say. */
  listsBack: boolean | null;
}

export interface CanaryStep { name: string; status: "ok" | "failed" | "skipped"; durationMs: number; reason?: string; detail?: string }
export interface CanaryResult {
  version: 1; trigger: "manual" | "daily"; computer: string; startedAt: string; finishedAt: string; durationMs: number;
  ok: boolean; steps: CanaryStep[];
}

export interface HealthDetails {
  product: "phren-hook"; computer: { name: string; id?: string }; checkedAt: string;
  versions: ToolVersion[];
  stores: StoreSync[];
  schedules: { running: boolean | null; lastTickAt?: string; lastRun: LastScheduledRun | null };
  peers: { configured: boolean; error?: string; computers: PeerHealth[] };
  push: { configured: boolean; devices?: number };
  canary: CanaryResult | null;
  terminal: TerminalHealth;
}

/** Which terminal multiplexer the Hook drives, per running server, and tmux's state. */
export interface TerminalHealth {
  /** "herdr" while a Herdr server answers, else "tmux" when tmux can host agents, else "none". */
  provider: "herdr" | "tmux" | "none";
  servers: { name: string; provider: "herdr" | "tmux" }[];
  tmux: TmuxHealth;
}

/** The running servers the Hook lists (Herdr's, else tmux's) and tmux's own state. */
export async function terminalHealth(): Promise<TerminalHealth> {
  const [{ servers }, tmux] = await Promise.all([import("./herdr.js"), tmuxHealth()]);
  const running = (await servers().catch(() => [] as Json[])).map(server => ({ name: String(server.session),
    provider: server.terminal === "tmux" ? "tmux" as const : "herdr" as const }));
  const provider = running.some(server => server.provider === "herdr") ? "herdr" : running.length ? "tmux" : "none";
  return { provider, servers: running, tmux };
}

/** One line on the terminal: the provider, its servers and tmux's state. */
export function describeTerminal(terminal: TerminalHealth): string {
  const tmux = terminal.tmux;
  const hidden = tmux.hidden ? `hidden server ${tmux.hidden.running ? `running (${tmux.hidden.sessions ?? 0} session${tmux.hidden.sessions === 1 ? "" : "s"})` : "not started"}` : undefined;
  const tmuxText = tmux.state === "off" ? "tmux off (PHREN_TMUX=off)" : tmux.state === "missing" ? "tmux not installed"
    : [`tmux ${tmux.version ?? "(version unknown)"}`, tmux.launches === false ? "too old to start agents (needs 3.0)" : undefined, hidden].filter(Boolean).join(", ");
  const names = terminal.servers.map(server => server.name).join(", ");
  if (terminal.provider === "herdr") return `herdr (${names}); ${tmuxText}`;
  if (terminal.provider === "tmux") return `tmux (${names}); ${tmuxText}`;
  return `none: Herdr is not running; ${tmuxText}`;
}

export interface HealthOptions {
  /** The running Hook's own version; undefined when asked from outside a Hook. */
  hookVersion?: string;
  computerId?: string;
  store: string;
  /** The Hook knows whether its scheduler runs; a CLI caller does not. */
  scheduler?: { running: boolean; lastTickAt?: Date };
  /** The Hook's loaded APNs sender; a CLI caller checks for apns.json instead. */
  push?: { configured: boolean; devices: number };
}

const VERSION_TIMEOUT_MS = 3_000;
const VERSION_CACHE_MS = 5 * 60_000;
const PEER_TIMEOUT_MS = 5_000;
const versionCache = new Map<string, { at: number; value: Promise<ToolVersion> }>();

/** `<tool> --version`, bounded to 3 seconds and remembered for 5 minutes. */
export function toolVersion(tool: string, executable = tool): Promise<ToolVersion> {
  const cached = versionCache.get(tool);
  if (cached && Date.now() - cached.at < VERSION_CACHE_MS) return cached.value;
  const value = new Promise<ToolVersion>(resolve => {
    let out = "", done = false;
    const child = spawn(executable, ["--version"], { cwd: homedir(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    const finish = (result: ToolVersion) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ tool, status: "error", detail: "--version did not answer within 3 seconds" }); }, VERSION_TIMEOUT_MS);
    const collect = (chunk: Buffer) => { if (out.length < 4_096) out += chunk.toString(); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? { tool, status: "missing" }
      : { tool, status: "error", detail: error.code ?? "could not run" }));
    child.on("close", code => {
      const version = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/.exec(out)?.[0];
      finish(version ? { tool, status: "ok", version } : { tool, status: "error", detail: `--version exited ${code ?? "by signal"} without a version` });
    });
  });
  versionCache.set(tool, { at: Date.now(), value });
  return value;
}

/** Only for tests: forget cached versions. */
export function clearVersionCache(): void { versionCache.clear(); }

/** A sync failure message without credentials a remote URL might carry. */
function plainError(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/gi, match => match.replace(/\/\/[^\s/@]+@/, "//"))
    .replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300) || undefined;
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    countGit("health");
    const { stdout } = await exec("git", args, { cwd, timeout: 5_000, maxBuffer: 65_536, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return stdout.trim();
  } catch { return undefined; }
}

/** Branch and ahead/behind against the upstream as last fetched; nothing is fetched here. */
export async function storeSync(store: string): Promise<StoreSync[]> {
  let stores: ReturnType<typeof resolveAllStores>;
  try { stores = resolveAllStores(store); } catch { return []; }
  return Promise.all(stores.slice(0, 16).map(async entry => {
    const result: StoreSync = { name: entry.name, role: entry.role, available: entry.available !== false, degraded: false };
    if (!result.available) { result.error = "The store's folder is missing on this computer."; result.degraded = true; return result; }
    const branch = await git(entry.path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch) result.branch = branch;
    const upstream = branch ? await git(entry.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) : undefined;
    if (upstream) {
      result.upstream = upstream;
      const counts = /^(\d+)\s+(\d+)$/.exec(await git(entry.path, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]) ?? "");
      if (counts) { result.ahead = Number(counts[1]); result.behind = Number(counts[2]); }
    }
    const sync = getRuntimeHealth(entry.path).lastSync;
    if (sync?.lastPushStatus) result.lastPushStatus = sync.lastPushStatus;
    if (sync?.lastPushAt) result.lastPushAt = sync.lastPushAt;
    if (sync?.lastSuccessfulPushAt) result.lastSuccessfulPushAt = sync.lastSuccessfulPushAt;
    if (sync?.consecutiveFailures) result.consecutiveFailures = sync.consecutiveFailures;
    const failing = sync?.lastPushStatus !== undefined && FAILED_PUSH_STATUSES.has(sync.lastPushStatus);
    const pullFailed = sync?.lastPullStatus === "error";
    if (failing || pullFailed) result.error = plainError(sync?.lastPushDetail || sync?.lastPullDetail) ?? `Last sync: ${sync?.lastPushStatus ?? "pull failed"}`;
    result.degraded = assessSyncOutage(sync).degraded;
    return result;
  }));
}

/** The newest run in schedule-runs.jsonl, with its schedule's name when the project still has it. */
export async function lastScheduledRun(store: string, runsFile = scheduleRunsFile()): Promise<LastScheduledRun | null> {
  const runs = await readScheduleRuns(runsFile).catch(() => []);
  const last = runs.reduce<(typeof runs)[number] | undefined>((newest, run) => !newest || run.startedAt >= newest.startedAt ? run : newest, undefined);
  if (!last) return null;
  let name: string | undefined;
  const directory = getProjectDirs(store).find(dir => path.basename(dir).toLowerCase() === last.project.toLowerCase());
  if (directory) name = (await readScheduleDocument(directory).catch(() => undefined))?.schedules.find(item => item.id === last.scheduleId)?.name;
  return { ...(name ? { name } : {}), project: last.project, status: last.status, ...(last.reason ? { reason: plainError(last.reason) } : {}),
    startedAt: last.startedAt, ...(last.finishedAt ? { finishedAt: last.finishedAt } : {}) };
}

/** This computer's public SSH host key, the pin a peer's hooks.yaml holds for it. */
async function ownHostKey(): Promise<string | undefined> {
  try { return publicComputerKey(await readFile("/etc/ssh/ssh_host_ed25519_key.pub", "utf8")); } catch { return undefined; }
}

/** Whether this computer's hooks.yaml lists the caller, by pinned host key or by name. */
export async function listsCaller(caller: { name?: string; hostKey?: string }): Promise<{ computers: string[]; knowsCaller: boolean }> {
  const peers = await hookPeers().catch(() => [] as HookPeer[]);
  const short = (value: string) => canonicalComputer(value).split(".")[0];
  const name = caller.name ? short(caller.name) : undefined;
  let key: string | undefined;
  try { key = caller.hostKey ? publicComputerKey(caller.hostKey) : undefined; } catch { key = undefined; }
  const knowsCaller = peers.some(peer => (key !== undefined && peer.hostKey === key)
    || (name !== undefined && (short(peer.name) === name || short(peer.address) === name)));
  return { computers: peers.map(peer => peer.name), knowsCaller };
}

async function probePeer(peer: HookPeer, caller: { name: string; hostKey?: string }): Promise<PeerHealth> {
  const started = Date.now();
  const query = new URLSearchParams({ name: caller.name, ...(caller.hostKey ? { hostKey: caller.hostKey } : {}) });
  try {
    let listsBack: boolean | null = null;
    let version: string | undefined;
    try {
      const answer = await peerRequest(peer, `/v1/health/peers?${query}`, undefined, PEER_TIMEOUT_MS);
      listsBack = answer.knowsCaller === true;
      if (typeof answer.version === "string") version = answer.version;
    } catch (error) {
      // A Hook from before /v1/health/peers still proves it is reachable.
      if (!(error instanceof BridgeError && error.status === 404)) throw error;
      const answer = await peerRequest(peer, "/v1/health", undefined, Math.max(1_000, PEER_TIMEOUT_MS - (Date.now() - started)));
      if (typeof answer.version === "string") version = answer.version;
    }
    return { name: peer.name, reachable: true, ms: Date.now() - started, listsBack, ...(version ? { version } : {}) };
  } catch (error) {
    const reason = error instanceof BridgeError && error.status === 504 ? "No answer within 5 seconds."
      : error instanceof Error ? error.message : "Unreachable.";
    const code = errorCode(error);
    return { name: peer.name, reachable: false, ms: Date.now() - started, error: plainError(reason), ...(code ? { code } : {}), listsBack: null };
  }
}

export function canaryFile(root = bridgeRoot()): string { return path.join(root, "canary.json"); }

export async function readCanary(root = bridgeRoot()): Promise<CanaryResult | null> {
  try {
    const info = await lstat(canaryFile(root));
    if (!info.isFile() || info.size > 65_536) return null;
    const value = JSON.parse(await readFile(canaryFile(root), "utf8")) as CanaryResult;
    return value && value.version === 1 && Array.isArray(value.steps) ? value : null;
  } catch { return null; }
}

async function pushConfigured(): Promise<{ configured: boolean }> {
  const file = process.env.PHREN_APNS_CONFIG || path.join(bridgeRoot(), "apns.json");
  const info = await lstat(file).catch(() => undefined);
  return { configured: !!info?.isFile() };
}

/** Everything a person needs to tell whether phren is healthy on this computer.
 * Bounded: versions are cached, each peer probe stops at 5 seconds, and nothing
 * here returns a secret, a file's contents or a store path. */
export async function healthDetails(options: HealthOptions): Promise<HealthDetails> {
  const name = hostname();
  const hostKey = await ownHostKey();
  const peersPromise = (async (): Promise<HealthDetails["peers"]> => {
    let peers: HookPeer[];
    try { peers = await hookPeers(); }
    catch (error) {
      if (error instanceof BridgeError && error.status === 409 && /Configure peers/.test(error.message)) return { configured: false, computers: [] };
      return { configured: true, error: plainError(error instanceof Error ? error.message : "hooks.yaml could not be read."), computers: [] };
    }
    return { configured: true, computers: await Promise.all(peers.map(peer => probePeer(peer, { name, hostKey }))) };
  })();
  const [versions, stores, lastRun, peers, canary, push, terminal] = await Promise.all([
    Promise.all([
      Promise.resolve<ToolVersion>(options.hookVersion ? { tool: "hook", status: "ok", version: options.hookVersion } : { tool: "hook", status: "missing", detail: "Phren Hook is not running." }),
      ...["herdr", "claude", "codex", "copilot", "opencode"].map(tool => toolVersion(tool)),
    ]),
    storeSync(options.store),
    lastScheduledRun(options.store),
    peersPromise,
    readCanary(),
    options.push ? Promise.resolve(options.push) : pushConfigured(),
    terminalHealth(),
  ]);
  return {
    product: "phren-hook", computer: { name, ...(options.computerId ? { id: options.computerId } : {}) }, checkedAt: new Date().toISOString(),
    versions, stores,
    schedules: { running: options.scheduler ? options.scheduler.running : null,
      ...(options.scheduler?.lastTickAt ? { lastTickAt: options.scheduler.lastTickAt.toISOString() } : {}), lastRun },
    peers, push, canary, terminal,
  };
}

/** Plain lines for `phren status`. */
export function formatHealth(health: HealthDetails, color: { dim: string; reset: string; red: string; yellow: string; green: string }): string[] {
  const { dim, reset, red, yellow, green } = color;
  const lines: string[] = [];
  lines.push(`  ${dim}versions${reset} ${health.versions.map(item => `${item.tool} ${item.status === "ok" ? item.version : item.status === "missing" ? `${dim}${item.tool === "hook" ? "not running" : "not installed"}${reset}` : `${yellow}?${reset}`}`).join(" · ")}`);
  for (const store of health.stores) {
    const counts = store.ahead !== undefined ? ` ${store.ahead} ahead, ${store.behind} behind${store.upstream ? ` ${dim}${store.upstream}${reset}` : ""}` : store.branch ? ` ${dim}no upstream${reset}` : "";
    lines.push(`  ${dim}sync${reset}     ${store.name}${store.branch ? ` ${dim}(${store.branch})${reset}` : ""}${counts}${store.lastPushStatus ? ` · last ${store.lastPushStatus}` : ""}`);
    if (store.error) lines.push(`           ${store.degraded ? red : yellow}! ${store.error}${reset}`);
  }
  const run = health.schedules.lastRun;
  lines.push(`  ${dim}schedule${reset} ${run ? `${run.name ?? "a schedule"} in ${run.project}: ${run.status === "failed" ? `${red}failed${reset}` : run.status} ${dim}${run.startedAt}${reset}${run.reason ? ` · ${run.reason}` : ""}` : `${dim}no runs yet${reset}`}`);
  if (!health.peers.configured) lines.push(`  ${dim}peers${reset}    ${dim}none enrolled${reset}`);
  else if (health.peers.error) lines.push(`  ${dim}peers${reset}    ${red}${health.peers.error}${reset}`);
  for (const peer of health.peers.computers) {
    const state = !peer.reachable ? `${red}unreachable${reset} ${dim}${peer.error ?? ""}${reset}`
      : peer.listsBack === false ? `${yellow}one-way${reset} ${dim}(${peer.name} does not list this computer)${reset}` : `${green}ok${reset} ${dim}${peer.ms} ms${reset}`;
    lines.push(`  ${dim}peer${reset}     ${peer.name} ${state}`);
  }
  if (health.terminal) lines.push(`  ${dim}terminal${reset} ${health.terminal.provider === "none" ? `${yellow}${describeTerminal(health.terminal)}${reset}` : describeTerminal(health.terminal)}`);
  lines.push(`  ${dim}push${reset}     ${health.push.configured ? `${green}configured${reset}` : `${dim}not configured${reset}`}`);
  if (health.canary) {
    const failed = health.canary.steps.filter(step => step.status === "failed");
    lines.push(`  ${dim}canary${reset}   ${health.canary.ok ? `${green}passed${reset}` : `${red}failed${reset}`} ${dim}${health.canary.startedAt}${reset}${failed.length ? ` · ${failed.map(step => `${step.name}: ${step.reason}`).join("; ")}` : ""}`);
  }
  return lines;
}
