/**
 * Watch mode for the terminal graph.
 *
 * Every memory phren lands on — an MCP `search_knowledge` hit, a memory a
 * hook injected before a prompt, a finding just written — is appended to
 * `.runtime/lookup-events.jsonl`. Watch mode tails that log so a graph open
 * in one terminal lights up as an agent works in another: the node pulses,
 * the camera flies to it, and the finding's full text lands in the pane.
 *
 * This module owns the event plumbing only. Drawing lives in graph-view.ts
 * and camera/selection in controller.ts.
 */

import { lookupEventsLogFile } from "../../shared.js";
import { readRecentLookups, type LookupEvent } from "../../governance/activity.js";
import { LookupTail } from "../../shared/lookup-tail.js";

/** How long a touched node stays lit, in ms. */
export const HEAT_MS = 6000;
/** Events kept for the activity feed. */
export const ACTIVITY_LIMIT = 60;
const DEFAULT_POLL_MS = 700;
/** Backfilled rows shown when watch mode starts, so the feed is never empty. */
const BACKFILL = 12;

export interface ActivityItem {
  event: LookupEvent;
  /** Wall-clock ms when this arrived; drives heat decay and the feed's age column. */
  seenAt: number;
  /** Graph node this event points at, when resolvable. */
  nodeId?: string;
  /** True for rows loaded as history rather than seen live. */
  historical: boolean;
}

export interface GraphWatchOptions {
  pollMs?: number;
  /** Injected in tests so no real file or timer is needed. */
  tail?: { poll: () => LookupEvent[] };
  backfill?: (phrenPath: string, limit: number) => LookupEvent[];
  now?: () => number;
}

export class GraphWatch {
  /** Newest first. */
  activity: ActivityItem[] = [];
  private heat = new Map<string, number>();
  private tail: { poll: () => LookupEvent[] } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private onEvents: ((items: ActivityItem[]) => void) | null = null;
  private readonly pollMs: number;
  private readonly injectedTail?: { poll: () => LookupEvent[] };
  private readonly backfillFn: (phrenPath: string, limit: number) => LookupEvent[];
  private readonly now: () => number;

  constructor(readonly phrenPath: string, opts: GraphWatchOptions = {}) {
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.injectedTail = opts.tail;
    this.backfillFn = opts.backfill ?? readRecentLookups;
    this.now = opts.now ?? (() => Date.now());
  }

  get running(): boolean {
    return this.tail !== null;
  }

  /**
   * Begin tailing. Recent history is loaded into the feed immediately but is
   * never treated as live: it does not pulse and never moves the camera.
   */
  start(onEvents: (items: ActivityItem[]) => void): void {
    if (this.tail) return;
    this.onEvents = onEvents;
    this.tail = this.injectedTail ?? new LookupTail(lookupEventsLogFile(this.phrenPath));
    if (!this.activity.length) {
      try {
        const seenAt = this.now();
        this.activity = this.backfillFn(this.phrenPath, BACKFILL).map((event) => ({
          event,
          seenAt,
          nodeId: targetNodeId(event),
          historical: true,
        }));
      } catch {
        this.activity = [];
      }
    }
    if (!this.injectedTail) {
      this.timer = setInterval(() => this.poll(), this.pollMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.tail = null;
    this.onEvents = null;
    this.heat.clear();
  }

  /** Drain the log. Returns the new items, newest last, and lights their nodes. */
  poll(): ActivityItem[] {
    if (!this.tail) return [];
    let events: LookupEvent[];
    try {
      events = this.tail.poll();
    } catch {
      return [];
    }
    if (!events.length) return [];
    const seenAt = this.now();
    const items: ActivityItem[] = events.map((event) => ({ event, seenAt, nodeId: targetNodeId(event), historical: false }));
    for (const item of items) {
      if (item.nodeId) this.heat.set(item.nodeId, seenAt);
    }
    this.activity = [...items].reverse().concat(this.activity).slice(0, ACTIVITY_LIMIT);
    this.onEvents?.(items);
    return items;
  }

  /** 1 right after a node was touched, easing to 0 over HEAT_MS. */
  heatOf(nodeId: string): number {
    const at = this.heat.get(nodeId);
    if (at === undefined) return 0;
    const age = this.now() - at;
    if (age >= HEAT_MS) { this.heat.delete(nodeId); return 0; }
    return 1 - age / HEAT_MS;
  }

  /** True while any node is still lit, so the host keeps animating. */
  get hot(): boolean {
    if (!this.heat.size) return false;
    const now = this.now();
    for (const at of this.heat.values()) {
      if (now - at < HEAT_MS) return true;
    }
    this.heat.clear();
    return false;
  }

  clearActivity(): void {
    this.activity = [];
    this.heat.clear();
  }
}

/**
 * The graph node an event points at. Findings carry a precomputed `nodeId`
 * (the same id `buildGraph` assigns); everything else falls back to the
 * project node, whose id is the project name.
 */
export function targetNodeId(event: LookupEvent): string | undefined {
  if (event.nodeId) return event.nodeId;
  return event.project || undefined;
}

/** "just now", "4s", "2m" — the feed's age column. */
export function formatAge(ms: number): string {
  if (ms < 1500) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}
