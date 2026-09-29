import { describe, expect, it } from "vitest";
import { StallDetector } from "./stalls.js";
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
