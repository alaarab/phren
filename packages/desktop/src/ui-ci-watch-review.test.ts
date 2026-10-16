import { afterEach, describe, expect, it, vi } from "vitest";
import { startCiWatch } from "../ui/shell/ci-watch.js";
import { inQuietHours } from "../ui/shell/quiet.js";

// The watcher end to end: one session, a scripted /v1/git/pulls, fake timers.
const apiState = vi.hoisted(() => ({ pull: {} as Record<string, unknown> }));
vi.mock("../ui/api.js", () => ({ hookPost: async () => ({ current: { number: 42, title: "Keep the session", state: "OPEN", ...apiState.pull }, host: { terms: { ref: "#" } } }) }));
vi.mock("../ui/shell/store.js", () => ({
  projectOf: () => "phren",
  store: {
    sessions: () => [{ computer: "mini", child: { target: { id: "t" }, agentStatus: "working", lastChangedAt: new Date().toISOString() } }],
    subscribe: () => () => {},
  },
}));

describe("startCiWatch review notifications", () => {
  afterEach(() => { vi.useRealTimers(); });

  async function watch(opts: { checks?: boolean; reviews?: () => boolean } = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00"));
    const notes: unknown[][] = [];
    const watcher = startCiWatch({
      notify: (...args: unknown[]) => { notes.push(args); },
      enabled: () => opts.checks ?? false,
      reviewEnabled: opts.reviews ?? (() => true),
    });
    const tick = async (pull: Record<string, unknown>) => { apiState.pull = pull; await vi.advanceTimersByTimeAsync(120_000); };
    return { notes, tick, stop: () => watcher.stop() };
  }

  it("notifies once per transition with the session key, none on first sight", async () => {
    apiState.pull = { reviewDecision: null };
    const { notes, tick, stop } = await watch();
    await vi.advanceTimersByTimeAsync(0); // first look: baseline
    await tick({ reviewDecision: "CHANGES_REQUESTED" });
    await tick({ reviewDecision: "CHANGES_REQUESTED" });
    await tick({ reviewDecision: "APPROVED", mergeState: "DIRTY" });
    stop();
    expect(notes).toEqual([
      ["Changes requested on #42 Keep the session", "phren · mini", { key: "pulls:mini\u0000phren" }],
      ["Approved: #42 Keep the session", "phren · mini", { key: "pulls:mini\u0000phren" }],
      ["#42 Keep the session now has conflicts", "phren · mini", { key: "pulls:mini\u0000phren" }],
    ]);
  });

  it("is silent when the setting is off, even while checks notifications keep it polling", async () => {
    apiState.pull = { reviewDecision: null };
    const { notes, tick, stop } = await watch({ checks: true, reviews: () => false });
    await vi.advanceTimersByTimeAsync(0);
    await tick({ reviewDecision: "CHANGES_REQUESTED" });
    await tick({ reviewDecision: "APPROVED" });
    stop();
    expect(notes).toEqual([]);
  });

  it("stays silent in quiet hours and does not announce a transition it missed afterwards", async () => {
    apiState.pull = { reviewDecision: null };
    let hour = "23:00";
    const { notes, tick, stop } = await watch({ reviews: () => !inQuietHours(new Date(`2026-10-16T${hour}:00`), "22:00", "07:00") });
    await vi.advanceTimersByTimeAsync(0);
    await tick({ reviewDecision: "CHANGES_REQUESTED" }); // quiet: skipped
    hour = "12:00";
    await tick({ reviewDecision: "CHANGES_REQUESTED" }); // no new transition
    await tick({ reviewDecision: "APPROVED" });
    stop();
    expect(notes.map((n) => n[0])).toEqual(["Approved: #42 Keep the session"]);
  });
});
