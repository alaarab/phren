/**
 * Honest sync reporting regression tests.
 *
 * The Stop hook used to report `saved-pushed` / "no changes" on every clean
 * turn, which overwrote the previous run's real `pull-failed`. The failure
 * never accumulated, so a store that had not reached its remote in two months
 * looked perfectly healthy on every single turn.
 */
import { describe, expect, it } from "vitest";
import {
  assessSyncOutage,
  buildSyncStatus,
  FAILED_PUSH_STATUSES,
  SYNC_FAILURE_WARN_DAYS,
  SYNC_FAILURE_WARN_RUNS,
  type SyncStatus,
} from "../governance/policy.js";
import { nextSyncStatus } from "../cli/session-stop.js";

const NOW = "2026-03-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const daysAgo = (n: number) => new Date(NOW_MS - n * 86_400_000).toISOString();

describe("push status vocabulary", () => {
  it("treats every failure mode as a failure, and success as success", () => {
    expect(FAILED_PUSH_STATUSES.has("pull-failed")).toBe(true);
    expect(FAILED_PUSH_STATUSES.has("push-failed")).toBe(true);
    expect(FAILED_PUSH_STATUSES.has("unrelated-histories")).toBe(true);
    expect(FAILED_PUSH_STATUSES.has("error")).toBe(true);
    // `saved-local` means "committed, nothing to push" — not a failure.
    expect(FAILED_PUSH_STATUSES.has("saved-local")).toBe(false);
    expect(FAILED_PUSH_STATUSES.has("saved-pushed")).toBe(false);
  });

  it("buildSyncStatus round-trips the new failure-tracking fields", () => {
    const status = buildSyncStatus({
      now: NOW,
      pushStatus: "unrelated-histories",
      pushDetail: "no merge base",
      consecutiveFailures: 7,
      successfulPushAt: daysAgo(60),
    });
    expect(status.lastPushStatus).toBe("unrelated-histories");
    expect(status.consecutiveFailures).toBe(7);
    expect(status.lastSuccessfulPushAt).toBe(daysAgo(60));
  });
});

describe("nextSyncStatus — failure streak accounting", () => {
  it("increments the streak on each consecutive failure", () => {
    let sync: SyncStatus | undefined;
    for (let i = 1; i <= 4; i++) {
      sync = nextSyncStatus(sync, { lastPushAt: NOW, lastPushStatus: "pull-failed", lastPushDetail: "boom" }, NOW);
      expect(sync.consecutiveFailures).toBe(i);
    }
  });

  it("resets the streak and stamps the timestamp once a push lands", () => {
    const failed = nextSyncStatus(
      { consecutiveFailures: 12 },
      { lastPushAt: NOW, lastPushStatus: "push-failed" },
      NOW,
    );
    expect(failed.consecutiveFailures).toBe(13);

    const recovered = nextSyncStatus(failed, { lastPushAt: NOW, lastPushStatus: "saved-pushed" }, NOW);
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.lastSuccessfulPushAt).toBe(NOW);
  });

  it("preserves the last success timestamp across failures", () => {
    const previous: SyncStatus = { consecutiveFailures: 0, lastSuccessfulPushAt: daysAgo(45) };
    const failed = nextSyncStatus(previous, { lastPushAt: NOW, lastPushStatus: "pull-failed" }, NOW);
    expect(failed.lastSuccessfulPushAt).toBe(daysAgo(45));
  });

  it("does not claim a successful push for a local-only commit", () => {
    // `saved-local` means there was no remote to reach — it must not reset the
    // clock on "when did we last actually sync".
    const previous: SyncStatus = { lastSuccessfulPushAt: daysAgo(45) };
    const local = nextSyncStatus(previous, { lastPushAt: NOW, lastPushStatus: "saved-local" }, NOW);
    expect(local.lastSuccessfulPushAt).toBe(daysAgo(45));
    expect(local.consecutiveFailures).toBe(0);
  });
});

describe("assessSyncOutage", () => {
  it("stays quiet for a healthy store", () => {
    const assessment = assessSyncOutage(
      { lastPushStatus: "saved-pushed", consecutiveFailures: 0, lastSuccessfulPushAt: NOW },
      NOW_MS,
    );
    expect(assessment.degraded).toBe(false);
    expect(assessment.summary).toBe("");
  });

  it("stays quiet for a single transient failure", () => {
    const assessment = assessSyncOutage(
      { lastPushStatus: "push-failed", consecutiveFailures: 1, lastSuccessfulPushAt: daysAgo(0) },
      NOW_MS,
    );
    expect(assessment.degraded).toBe(false);
  });

  it("warns once the failure streak crosses the run threshold", () => {
    const assessment = assessSyncOutage(
      {
        lastPushStatus: "pull-failed",
        consecutiveFailures: SYNC_FAILURE_WARN_RUNS,
        lastPushDetail: "pull --rebase failed",
        lastSuccessfulPushAt: daysAgo(0),
      },
      NOW_MS,
    );
    expect(assessment.degraded).toBe(true);
    expect(assessment.summary).toContain("consecutive failed sync");
    expect(assessment.summary).toContain("pull --rebase failed");
  });

  it("warns on elapsed days even when the streak counter is low", () => {
    // The real outage: hooks kept resetting state, so the counter never grew —
    // but the last successful push was two months old.
    const assessment = assessSyncOutage(
      {
        lastPushStatus: "pull-failed",
        consecutiveFailures: 1,
        lastSuccessfulPushAt: daysAgo(SYNC_FAILURE_WARN_DAYS + 55),
      },
      NOW_MS,
    );
    expect(assessment.degraded).toBe(true);
    expect(assessment.summary).toContain("last successful push");
  });

  it("names the unrelated-histories cause instead of a generic pull failure", () => {
    const assessment = assessSyncOutage(
      {
        lastPushStatus: "unrelated-histories",
        consecutiveFailures: SYNC_FAILURE_WARN_RUNS + 1,
        lastPushDetail: "no merge base",
        unsyncedCommits: 41,
      },
      NOW_MS,
    );
    expect(assessment.degraded).toBe(true);
    expect(assessment.summary).toContain("unrelated");
    expect(assessment.summary).toContain("re-initialized");
    expect(assessment.summary).toContain("41 unpushed");
  });

  it("does not warn when the last attempt succeeded, whatever the old streak was", () => {
    const assessment = assessSyncOutage(
      { lastPushStatus: "saved-pushed", consecutiveFailures: 99, lastSuccessfulPushAt: NOW },
      NOW_MS,
    );
    expect(assessment.degraded).toBe(false);
  });

  it("handles an empty/absent sync record", () => {
    expect(assessSyncOutage(undefined, NOW_MS).degraded).toBe(false);
    expect(assessSyncOutage({}, NOW_MS).degraded).toBe(false);
  });
});
