// The titlebar's account usage: every computer's own report, fetched in
// parallel and merged by account exactly as the phone and the Hook do, so one
// account is one allowance whichever computers report it.
import { mergeAccountUsage, type AccountUsageRow, type AccountUsageView, type ComputerUsage } from "@phren/cli/client/account-usage";
import type { Computer, HookRequest } from "./contract.js";

/** The sources the daemon asks every Hook for; the same list the Hook serves. */
const SOURCES = ["claude", "codex", "copilot", "opencode", "opencode-go", "openrouter"];
const USAGE_ROUTE = `/v1/usage?${new URLSearchParams({ sources: SOURCES.join(","), goPlan: "1", accounts: "all" })}`;
const REQUEST_TIMEOUT_MS = 6_000;
const CACHE_MS = 60_000;

export interface UsageSnapshot {
  accounts: AccountUsageRow[];
  noData: AccountUsageView["noData"];
  /** The computers that answered, in report order. */
  computers: string[];
  /** Computers whose report failed or timed out: their usage is unknown, not zero. */
  unreachable: Array<{ computer: string; error: string }>;
  at: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Usage request timed out after ${ms / 1000} s.`)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

/** The accounts a Hook's `/v1/usage` answer carries; anything else is ignored. */
function accountsOf(answer: unknown): ComputerUsage["accounts"] {
  if (typeof answer !== "object" || answer === null) return [];
  const list = (answer as { accounts?: unknown }).accounts;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is ComputerUsage["accounts"][number] => {
    if (typeof item !== "object" || item === null) return false;
    const row = item as { source?: unknown; windows?: unknown };
    return typeof row.source === "string" && Array.isArray(row.windows);
  });
}

/** Fetch every computer's report in parallel and merge by account. Failures are
 * skipped, not fatal: a computer that cannot answer reports unknown usage. */
export async function fetchUsage(computers: readonly Computer[], hookRequest: HookRequest, now = Date.now()): Promise<UsageSnapshot> {
  const unreachable: UsageSnapshot["unreachable"] = [];
  const reports = await Promise.all(computers.map(async (computer): Promise<ComputerUsage | null> => {
    try {
      const res = await withTimeout(hookRequest(computer, "GET", USAGE_ROUTE), REQUEST_TIMEOUT_MS);
      if (res.status !== 200) throw new Error(`Usage returned ${res.status}.`);
      return { computer: computer.name, accounts: accountsOf(JSON.parse(res.body.toString("utf8"))) };
    } catch (error) {
      unreachable.push({ computer: computer.name, error: error instanceof Error ? error.message.slice(0, 300) : "Unreachable." });
      return null;
    }
  }));
  const answered = reports.filter((report): report is ComputerUsage => report !== null);
  return {
    ...mergeAccountUsage(answered, now),
    computers: answered.map(report => report.computer),
    unreachable,
    at: new Date(now).toISOString(),
  };
}

let cached: { at: number; value: UsageSnapshot } | undefined;

/** `fetchUsage` behind a 60 s cache, so a polling titlebar never storms the Hooks. */
export async function collectUsage(computers: readonly Computer[], hookRequest: HookRequest, now = Date.now()): Promise<UsageSnapshot> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = await fetchUsage(computers, hookRequest, now);
  cached = { at: now, value };
  return value;
}
