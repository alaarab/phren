import { hostname } from "node:os";
import { hookRequest } from "../bridge/client.js";
import type { ComputerResources } from "../bridge/resources.js";
import type { AccountUsage, UsageWindow } from "../bridge/usage.js";
import type { Json } from "../bridge/protocol.js";

/**
 * The memory-free computers surface: every read goes to the local Hook's
 * socket (`GET /v1/resources?peers=1`, `GET /v1/usage?peers=1`), which answers
 * for itself and asks each linked computer over its pinned SSH pipe. Nothing
 * here opens, needs or reports a Phren store, findings or tasks, and nothing
 * writes: `phren computers`, `phren usage` and `phren computers mcp` share it.
 */

export interface ComputerReport {
  name: string;
  /** This computer, the one whose Hook answered. */
  local: boolean;
  online: boolean;
  resources?: ComputerResources;
  error?: string;
}

/** Every harness the Hook reads usage for, in the order people look for them. */
export const USAGE_SOURCES = ["claude", "codex", "copilot", "opencode", "opencode-go", "openrouter"] as const;
export const HARNESS_NAMES: Record<string, string> = {
  claude: "Claude", codex: "Codex", copilot: "GitHub Copilot",
  opencode: "OpenCode (local spend, any provider incl. DeepSeek)", "opencode-go": "OpenCode Go", openrouter: "OpenRouter",
};

export interface HarnessUsage {
  source: string;
  harness: string;
  windows: Array<UsageWindow & { resetsIn?: string }>;
  spend?: AccountUsage["spend"];
  updatedAt?: string;
  /** What the harness said, or why it gave nothing. Never a guess. */
  message?: string;
}

export interface UsageReport {
  computers: Array<{ name: string; local: boolean; harnesses?: HarnessUsage[]; error?: string }>;
  /** Across computers: account limits from the freshest report, local spend summed. */
  combined: HarnessUsage[];
}

type Request = (route: string) => Promise<Json>;
const defaultRequest: Request = route => hookRequest(route, undefined, undefined, 30_000);

function hookMissing(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ECONNREFUSED") return "Phren Hook is not running on this computer (phren bridge status).";
  if ((error as { status?: unknown })?.status === 404) return "This computer's Phren Hook predates this report; update it with phren bridge update.";
  return error instanceof Error ? error.message.slice(0, 300) : "Phren Hook did not answer.";
}

function computerName(value: unknown, fallback: string): string {
  const name = (value as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && name ? name : fallback;
}

export async function readComputers(options: { peers?: boolean; request?: Request; localFallback?: () => Promise<ComputerResources> } = {}): Promise<{ computers: ComputerReport[]; hookError?: string; peerError?: string }> {
  const request = options.request ?? defaultRequest;
  let answer: Json;
  try {
    answer = await request(`/v1/resources${options.peers === false ? "" : "?peers=1"}`);
  } catch (error) {
    const hookError = hookMissing(error);
    // Without a Hook this computer can still report itself; peers need the Hook.
    const fallback = options.localFallback ?? (async () => new (await import("../bridge/resources.js")).ResourceMonitor().read());
    const resources = await fallback().catch(() => undefined);
    return { hookError, computers: [{ name: hostname(), local: true, online: Boolean(resources), ...(resources ? { resources } : { error: hookError }) }] };
  }
  const computers: ComputerReport[] = [{ name: computerName(answer.computer, hostname()), local: true, online: true, resources: answer.resources as ComputerResources }];
  for (const peer of Array.isArray(answer.peers) ? answer.peers as Json[] : []) {
    const name = computerName(peer.computer, String(peer.name ?? "peer"));
    computers.push(peer.resources && !peer.error
      ? { name, local: false, online: true, resources: peer.resources as ComputerResources }
      : { name, local: false, online: false, error: typeof peer.error === "string" ? peer.error : "Unavailable" });
  }
  return { computers, ...(typeof answer.peerError === "string" ? { peerError: answer.peerError } : {}) };
}

export function findComputer(computers: ComputerReport[], name: string | undefined): ComputerReport | undefined {
  if (!name || name === "local" || name === "this") return computers.find(c => c.local);
  const wanted = name.toLowerCase().replace(/\.local$/, "");
  return computers.find(c => c.name.toLowerCase().replace(/\.local$/, "") === wanted)
    ?? computers.find(c => c.name.toLowerCase().startsWith(wanted));
}

export type PlatformChoice = "mac" | "linux" | "any";

/**
 * The least-loaded online computer: stressed ones last, then by overall
 * pressure, then load per core, then free disk. Each candidate carries why.
 */
export function pickComputer(computers: ComputerReport[], platform: PlatformChoice = "mac", exclude: string[] = []): { pick?: ComputerReport; reason: string; ranked: Array<{ name: string; score: number; level: string; why: string }> } {
  const skip = new Set(exclude.map(name => name.toLowerCase()));
  const wanted = (r: ComputerResources) => platform === "any" || (platform === "mac" ? r.platform === "darwin" : r.platform === platform);
  const candidates = computers.filter(c => c.online && c.resources && wanted(c.resources) && !skip.has(c.name.toLowerCase()));
  const rank = (c: ComputerReport) => {
    const r = c.resources!;
    return [r.level === "stressed" ? 1 : 0, r.pressure.overall, r.cpu.loadPerCore, -(r.disk?.freeBytes ?? 0)];
  };
  candidates.sort((a, b) => {
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  const ranked = candidates.map(c => ({ name: c.name, score: c.resources!.pressure.overall, level: c.resources!.level, why: describe(c.resources!) }));
  const pick = candidates[0];
  const label = platform === "mac" ? "Mac" : platform === "linux" ? "Linux computer" : "computer";
  if (!pick) return { reason: `No online ${label} reported resources.`, ranked };
  const stressedNote = pick.resources!.level === "stressed" ? " Every candidate is stressed; expect slow runs." : "";
  return { pick, reason: `${pick.name} is the least-loaded ${label}: ${describe(pick.resources!)}.${stressedNote}`, ranked };
}

const GB = 1024 ** 3;
export function describe(r: ComputerResources): string {
  const parts = [`load ${r.cpu.load1} on ${r.cpu.cores} cores`];
  if (r.memory.availablePercent !== undefined) parts.push(`${r.memory.availablePercent}% memory free`);
  if (r.disk) parts.push(`${(r.disk.freeBytes / GB).toFixed(0)} GB disk free`);
  if (r.warnings.length) parts.push(`warnings: ${r.warnings.join(", ")}`);
  return parts.join(", ");
}

export function resetsIn(resetsAt: string | undefined, now = Date.now()): string | undefined {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(at)) return undefined;
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${rest}m` : `${rest}m`;
}

function harness(account: AccountUsage, now: number): HarnessUsage {
  return { source: account.source, harness: HARNESS_NAMES[account.source] ?? account.source,
    // Only the numbers a person budgets by; no key identity, no origin.
    windows: account.windows.map(({ id, name, usedPercent, usedUSD, limitUSD, usedTokens, resetsAt, asOf }) => {
      const window: UsageWindow & { resetsIn?: string } = { id, name };
      if (usedPercent !== undefined) window.usedPercent = usedPercent;
      if (usedUSD !== undefined) window.usedUSD = usedUSD;
      if (limitUSD !== undefined) window.limitUSD = limitUSD;
      if (usedTokens !== undefined) window.usedTokens = usedTokens;
      if (resetsAt) { window.resetsAt = resetsAt; const left = resetsIn(resetsAt, now); if (left) window.resetsIn = left; }
      if (asOf) window.asOf = asOf;
      return window;
    }),
    ...(account.spend ? { spend: account.spend } : {}),
    ...(account.updatedAt ? { updatedAt: account.updatedAt } : {}),
    ...(account.message ? { message: account.message } : !account.windows.length && !account.spend ? { message: "No usage data reported." } : {}) };
}

const NOT_REPORTED = "This computer's Hook did not report this harness; it may predate it (phren bridge update).";

function harnesses(accounts: unknown, now: number): HarnessUsage[] {
  const list = Array.isArray(accounts) ? accounts as AccountUsage[] : [];
  const bySource = new Map(list.map(account => [account.source, account]));
  // Every harness the Hook knows appears, saying so when it had nothing.
  return USAGE_SOURCES.map(source => bySource.get(source) ? harness(bySource.get(source)!, now)
    : { source, harness: HARNESS_NAMES[source], windows: [], message: source === "openrouter"
      ? "No OpenRouter key is configured on this computer." : NOT_REPORTED });
}

const fresher = (a: HarnessUsage, b: HarnessUsage) => Date.parse(b.updatedAt ?? "") > Date.parse(a.updatedAt ?? "") ? b : a;

/**
 * Account limits are the same account seen from each computer, so the
 * freshest report with windows stands. OpenCode's cost ledger is per
 * computer, so its spend adds up; OpenRouter's is one key, reported once.
 */
export function combineUsage(perComputer: HarnessUsage[][]): HarnessUsage[] {
  return USAGE_SOURCES.map(source => {
    const reports = perComputer.map(list => list.find(item => item.source === source)).filter((item): item is HarnessUsage => Boolean(item));
    const withData = reports.filter(item => item.windows.length || item.spend);
    // With no numbers anywhere, a Hook's own explanation beats "did not report".
    if (!withData.length) return reports.find(item => item.message !== NOT_REPORTED) ?? reports[0] ?? { source, harness: HARNESS_NAMES[source], windows: [], message: "No usage data reported." };
    if (source === "opencode") {
      const spends = withData.filter(item => item.spend);
      const amount = spends.reduce((sum, item) => sum + item.spend!.amountUSD, 0);
      return { ...withData.reduce(fresher), ...(spends.length ? { spend: { amountUSD: Math.round(amount * 100) / 100, period: spends[0].spend!.period } } : {}),
        message: `Local spend summed across ${spends.length} computer${spends.length === 1 ? "" : "s"}.` };
    }
    const best = withData.filter(item => item.windows.length).reduce<HarnessUsage | undefined>((a, b) => a ? fresher(a, b) : b, undefined) ?? withData.reduce(fresher);
    return best;
  });
}

export async function readUsage(options: { peers?: boolean; request?: Request; now?: number } = {}): Promise<UsageReport & { hookError?: string; peerError?: string }> {
  const request = options.request ?? defaultRequest, now = options.now ?? Date.now();
  const query = new URLSearchParams({ sources: USAGE_SOURCES.join(",") });
  if (options.peers !== false) query.set("peers", "1");
  let answer: Json;
  try { answer = await request(`/v1/usage?${query}`); }
  catch (error) {
    return { hookError: hookMissing(error), computers: [{ name: hostname(), local: true, error: hookMissing(error) }], combined: [] };
  }
  const computers: UsageReport["computers"] = [{ name: computerName(answer.computer, hostname()), local: true, harnesses: harnesses(answer.accounts, now) }];
  for (const peer of Array.isArray(answer.peers) ? answer.peers as Json[] : []) {
    const name = computerName(peer.computer, String(peer.name ?? "peer"));
    computers.push(peer.error || !Array.isArray(peer.accounts)
      ? { name, local: false, error: typeof peer.error === "string" ? peer.error : "Unavailable" }
      : { name, local: false, harnesses: harnesses(peer.accounts, now) });
  }
  const combined = combineUsage(computers.flatMap(c => c.harnesses ? [c.harnesses] : []));
  return { computers, combined, ...(typeof answer.peerError === "string" ? { peerError: answer.peerError } : {}) };
}
