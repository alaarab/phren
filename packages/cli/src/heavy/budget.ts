import * as fs from "node:fs";
import { cpus, freemem, homedir, loadavg, totalmem } from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";

const GB = 1024 ** 3;

/** What this computer can take right now. */
export interface Pressure { totalBytes: number; availableBytes?: number; load1: number; cores: number }

/**
 * The per-machine budget for agent work. Measured on a 31 GB Linux box
 * (2026-11-15): a worker with its full vitest run takes 2 to 8 GB and an app
 * stack 0.6 to 1 GB, so about one worker per 7 GB and one heavy job (a full
 * test run, a native build) per 12 GB keep it out of swap.
 */
export interface Budget {
  /** Agent workers started through `phren fanout run` at once. */
  workers: number;
  /** Jobs run through `phren heavy` at once. */
  heavySlots: number;
  /** Below this much available memory nothing new starts while another holds a slot. */
  minFreeBytes: number;
  /** Above this one-minute load per core nothing new starts while another holds a slot. */
  maxLoadPerCore: number;
}

export const budgetKeys = { workers: "PHREN_FANOUT_WORKERS", heavySlots: "PHREN_HEAVY_SLOTS", minFreeGB: "PHREN_MIN_FREE_GB", maxLoadPerCore: "PHREN_MAX_LOAD_PER_CORE" } as const;

/** `$XDG_CONFIG_HOME/phren/budget.yaml`: this computer's own budget, never synced with the store. */
export function budgetFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "phren", "budget.yaml");
}

export function defaultBudget(totalBytes: number): Budget {
  const gb = totalBytes / GB;
  return { workers: Math.max(1, Math.floor(gb / 7)), heavySlots: Math.max(1, Math.floor(gb / 12)),
    minFreeBytes: Math.max(2, Math.round(gb * 0.1)) * GB, maxLoadPerCore: 1.5 };
}

/** Defaults from the memory size, then budget.yaml, then the environment. Invalid values are ignored. */
export function readBudget(totalBytes: number, env: NodeJS.ProcessEnv = process.env, file = budgetFile(env)): Budget {
  const budget = defaultBudget(totalBytes);
  let config: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(fs.readFileSync(file, "utf8"), { schema: yaml.CORE_SCHEMA });
    if (parsed && typeof parsed === "object") config = parsed as Record<string, unknown>;
  } catch { /* No file or unreadable: defaults. */ }
  const value = (key: keyof typeof budgetKeys) => {
    const raw = env[budgetKeys[key]] ?? config[key];
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const workers = value("workers"), heavySlots = value("heavySlots"), minFree = value("minFreeGB"), load = value("maxLoadPerCore");
  return { workers: workers ? Math.floor(workers) : budget.workers, heavySlots: heavySlots ? Math.floor(heavySlots) : budget.heavySlots,
    minFreeBytes: minFree ? minFree * GB : budget.minFreeBytes, maxLoadPerCore: load ?? budget.maxLoadPerCore };
}

/** Memory comes from the resources gauge's reader (bridge/resources.ts), so the budget and the Hook's gauge agree. */
export async function readPressure(platform: NodeJS.Platform = process.platform): Promise<Pressure> {
  const { readMemory } = await import("../bridge/resources.js");
  const memory = await readMemory(platform).catch(() => ({ totalBytes: totalmem(), availablePercent: undefined }));
  const totalBytes = memory.totalBytes || totalmem();
  return { totalBytes, availableBytes: memory.availablePercent === undefined ? freemem() : Math.round(totalBytes * memory.availablePercent / 100),
    load1: loadavg()[0], cores: cpus().length || 1 };
}

const gb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;

/** Why nothing new should start now, or undefined when the computer has room. */
export function pressureReason(pressure: Pressure, budget: Budget): string | undefined {
  const reasons: string[] = [];
  if (pressure.availableBytes !== undefined && pressure.availableBytes < budget.minFreeBytes) {
    reasons.push(`${gb(pressure.availableBytes)} of ${gb(pressure.totalBytes)} memory available, under the ${gb(budget.minFreeBytes)} floor`);
  }
  const perCore = pressure.load1 / pressure.cores;
  if (perCore > budget.maxLoadPerCore) reasons.push(`load ${pressure.load1.toFixed(1)} on ${pressure.cores} cores, over ${budget.maxLoadPerCore} per core`);
  return reasons.length ? reasons.join("; ") : undefined;
}

export function describePressure(pressure: Pressure): string {
  return `${pressure.availableBytes === undefined ? "memory unknown" : `${gb(pressure.availableBytes)} of ${gb(pressure.totalBytes)} memory available`}, load ${pressure.load1.toFixed(1)} on ${pressure.cores} cores`;
}
