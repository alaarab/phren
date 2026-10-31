import type { HealthFinding } from "./machine-health.js";

/**
 * Turns the stream of health reads into phone pushes: one push when a `high`
 * finding id first appears, nothing while it stays, and again only if it
 * clears and comes back after `REPEAT_AFTER_MS`. At most `MAX_PER_HOUR`
 * pushes an hour across all ids, so a bad morning is a few alerts, not a
 * storm. State is in memory: a Hook restart may repeat a standing alert once.
 */

export const REPEAT_AFTER_MS = 6 * 3_600_000;
export const MAX_PER_HOUR = 3;
export const ALERT_CHECK_MS = 5 * 60_000;

export class HealthAlerts {
  private active = new Set<string>();
  private lastPushed = new Map<string, number>();
  private sent: number[] = [];
  constructor(private readonly notify: (finding: HealthFinding) => Promise<unknown>) {}

  /** The findings that were pushed for this read. */
  observe(findings: readonly HealthFinding[] | undefined, now: number): HealthFinding[] {
    const high = (findings ?? []).filter(f => f.severity === "high");
    const ids = new Set(high.map(f => f.id));
    for (const id of this.active) if (!ids.has(id)) this.active.delete(id);
    this.sent = this.sent.filter(at => now - at < 3_600_000);
    const pushed: HealthFinding[] = [];
    for (const finding of high) {
      if (this.active.has(finding.id)) continue;
      const last = this.lastPushed.get(finding.id);
      if (last !== undefined && now - last < REPEAT_AFTER_MS) { this.active.add(finding.id); continue; }
      // Over the hourly cap the finding stays new, so the next read retries it.
      if (this.sent.length >= MAX_PER_HOUR) continue;
      this.active.add(finding.id);
      this.lastPushed.set(finding.id, now);
      this.sent.push(now);
      pushed.push(finding);
      void this.notify(finding).catch(() => {});
    }
    return pushed;
  }
}
