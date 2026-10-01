import { describe, expect, it, vi } from "vitest";
import { StallDetector } from "./stalls.js";
import { BACKGROUND_STALE_MS } from "./session-activity.js";
import type { Target } from "./protocol.js";
const target: Target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude", session: "11111111-1111-4111-8111-111111111111" };
describe("working session stall clock", () => {
  it("requires both unchanged sources, resets on either change, and reports a configurable duration", async () => {
    let now = 0, screen = "running script", transcript = "tool call";
    const detector = new StallDetector({ now: () => now, threshold: () => 300_000, screen: async () => screen, transcript: async () => transcript });
    const pane = { terminal_id: "t", agent_status: "working" };
    expect(await detector.observe(target, pane)).toBeUndefined();
    now = 299_999; expect(await detector.observe(target, pane)).toBeUndefined();
    now = 300_000; expect(await detector.observe(target, pane)).toMatchObject({ stalled: true, stallFor: 300 });
    screen = "new screen"; expect(await detector.observe(target, pane)).toBeUndefined();
    now += 300_000; expect(await detector.observe(target, pane)).toHaveProperty("stalled", true);
    transcript = "new event"; expect(await detector.observe(target, pane)).toBeUndefined();
    now += 300_000; expect(await detector.observe(target, { ...pane, terminal_id: "new terminal" })).toBeUndefined();
    now += 300_000; expect(await detector.observe({ ...target, session: "22222222-2222-4222-8222-222222222222" }, pane)).toBeUndefined();
    now += 300_000; expect(await detector.observe(target, { ...pane, agent_status: "idle" })).toBeUndefined();
    expect(await detector.observe(target, pane)).toBeUndefined();
  });
  it("starts the clock over while the turn's awaited work still runs, and asks only once it runs out", async () => {
    // ios-chat-code-links, 2026-10-01: a Claude worker ended its turn on purpose
    // while an awaited xcodebuild waited on a lock ("1 shell still running").
    let now = 0, running: number | undefined = 1;
    const live = vi.fn(async () => running);
    const detector = new StallDetector({ now: () => now, threshold: () => 300_000, screen: async () => "1 shell still running", transcript: async () => "same" });
    const pane = { terminal_id: "t", agent_status: "working" };
    expect(await detector.observe(target, pane, live)).toBeUndefined();
    now = 299_999; expect(await detector.observe(target, pane, live)).toBeUndefined();
    expect(live).not.toHaveBeenCalled();
    now = 300_000; expect(await detector.observe(target, pane, live)).toBeUndefined();
    now = 600_000; expect(await detector.observe(target, pane, live)).toBeUndefined();
    expect(live).toHaveBeenCalledTimes(2);
    // The build ended and nothing moved since: a stall, timed from the last check.
    running = undefined;
    now = 900_000; expect(await detector.observe(target, pane, live)).toMatchObject({ stalled: true, stalledSince: new Date(600_000).toISOString(), stallFor: 300 });
    // An unreadable transcript counts no live work.
    live.mockRejectedValueOnce(new Error("gone"));
    expect(await detector.observe(target, pane, live)).toHaveProperty("stalled", true);
  });
  // Review of #283: an awaited build deadlocked on a lock, or a child that died
  // without its completion record, restarted the clock forever.
  it("stops letting live work that never ends hold the clock after BACKGROUND_STALE_MS", async () => {
    let now = 0;
    const live = vi.fn(async () => 1);
    const detector = new StallDetector({ now: () => now, threshold: () => 300_000, screen: async () => "1 shell still running", transcript: async () => "same" });
    const pane = { terminal_id: "t", agent_status: "working" };
    expect(await detector.observe(target, pane, live)).toBeUndefined();
    for (now = 300_000; now < BACKGROUND_STALE_MS; now += 300_000) expect(await detector.observe(target, pane, live), String(now)).toBeUndefined();
    expect(now).toBe(BACKGROUND_STALE_MS);
    expect(await detector.observe(target, pane, live)).toMatchObject({ stalled: true, stallFor: 300 });
    // Anything moving starts over, live work included.
    const moved = new StallDetector({ now: () => now, threshold: () => 300_000, screen: async () => String(now), transcript: async () => "same" });
    expect(await moved.observe(target, pane, live)).toBeUndefined();
  });
  it("treats failed observations as unknown, and can be disabled", async () => {
    let now = 0, broken = false, threshold = 10;
    const detector = new StallDetector({ now: () => now, threshold: () => threshold, screen: async () => "same", transcript: async () => { if (broken) throw Error("offline"); return "same"; } });
    const pane = { terminal_id: "t", agent_status: "working" };
    await detector.observe(target, pane); now = 100; broken = true;
    expect(await detector.observe(target, pane)).toBeUndefined(); broken = false;
    expect(await detector.observe(target, pane)).toBeUndefined(); now += 20;
    expect(await detector.observe(target, pane)).toHaveProperty("stalled", true);
    threshold = 0; expect(await detector.observe(target, pane)).toBeUndefined();
  });
});
