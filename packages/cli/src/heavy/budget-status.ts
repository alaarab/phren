import { pressureReason, readBudget, type Pressure } from "./budget.js";
import { poolStatus, priorityName, slotsRoot, type Ticket } from "./slots.js";

/** One pool as the phone shows it: its slots, what runs and what waits, oldest first. */
export interface PoolView {
  slots: number;
  running: number;
  waiting: number;
  jobs: Array<{ label: string; state: "running" | "waiting"; priority: "release" | "normal" | "low"; sinceSeconds: number }>;
}

/**
 * This computer's budget for agent work (`phren fanout run`, `phren heavy`) as
 * it stands now: the two pools and, when memory or load is past the budget,
 * why nothing new should start. Served on the resources reading.
 */
export interface AgentBudget {
  workers: PoolView;
  heavy: PoolView;
  minFreeBytes: number;
  maxLoadPerCore: number;
  overBudget?: string;
}

const MAX_JOBS = 8;

function view(tickets: Ticket[], slots: number, now: number): PoolView {
  const running = tickets.filter(t => t.state === "running").length;
  return {
    slots, running, waiting: tickets.length - running,
    jobs: tickets.slice(0, MAX_JOBS).map(t => ({
      label: (t.label || "job").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80),
      state: t.state,
      priority: priorityName(t.priority),
      sinceSeconds: Math.max(0, Math.round((now - (t.state === "running" ? t.startedAt ?? t.createdAt : t.createdAt)) / 1000)),
    })),
  };
}

export function agentBudget(pressure: Pressure, now = Date.now(), root = slotsRoot(), env: NodeJS.ProcessEnv = process.env): AgentBudget {
  const budget = readBudget(pressure.totalBytes, env);
  const overBudget = pressureReason(pressure, budget);
  return {
    workers: view(poolStatus("workers", root), budget.workers, now),
    heavy: view(poolStatus("heavy", root), budget.heavySlots, now),
    minFreeBytes: budget.minFreeBytes,
    maxLoadPerCore: budget.maxLoadPerCore,
    ...(overBudget ? { overBudget } : {}),
  };
}
