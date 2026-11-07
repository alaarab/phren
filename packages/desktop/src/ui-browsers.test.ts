import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Plain browser ESM.
import { controlState, frameAtTime, normalizedPoint, wheelCoalescer } from "../ui/browsers/logic.js";

// These contracts own input geometry, bandwidth and authority. The e2e separately
// checks their wiring to the viewer and the wire protocol, rather than duplicating them.
describe("browser input over a fitted frame", () => {
  const box = { left: 20, top: 40, width: 400, height: 400 };
  it("ignores top/bottom letterboxes and maps the visible image, including its edges", () => {
    expect(normalizedPoint(box, 800, 400, 220, 90)).toBeNull();
    expect(normalizedPoint(box, 800, 400, 220, 390)).toBeNull();
    expect(normalizedPoint(box, 800, 400, 220, 240)).toEqual({ x: .5, y: .5 });
    expect(normalizedPoint(box, 800, 400, 20, 140)).toEqual({ x: 0, y: 0 });
    expect(normalizedPoint(box, 800, 400, 420, 340)).toEqual({ x: 1, y: 1 });
  });
  it("handles side gutters, offsets and unready images", () => {
    expect(normalizedPoint(box, 400, 800, 50, 240)).toBeNull();
    expect(normalizedPoint(box, 400, 800, 170, 340)).toEqual({ x: .25, y: .75 });
    expect(normalizedPoint(box, 0, 800, 220, 240)).toBeNull();
    expect(normalizedPoint(box, 400, 800, NaN, 240)).toBeNull();
  });
});

describe("browser wheel batching", () => {
  afterEach(() => vi.useRealTimers());
  it("sends at most 30 batches per second, preserving summed movement and latest position", () => {
    vi.useFakeTimers();
    const send = vi.fn(), wheel = wheelCoalescer(send);
    wheel.add({ x: .1, y: .2, dx: .02, dy: .1 });
    vi.advanceTimersByTime(10);
    wheel.add({ x: .7, y: .8, dx: .03, dy: .2 });
    vi.advanceTimersByTime(23); expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenLastCalledWith({ x: .7, y: .8, dx: .05, dy: .30000000000000004 });
    send.mockClear();
    for (let n = 0; n < 1000; n++) {
      wheel.add({ x: .5, y: .5, dx: 0, dy: .01 }); vi.advanceTimersByTime(1);
    }
    expect(send.mock.calls.length).toBeLessThanOrEqual(30);
    wheel.cancel();
  });
  it("cancels queued input on release and caps a large scroll to the Hook limit", () => {
    vi.useFakeTimers();
    const send = vi.fn(), wheel = wheelCoalescer(send);
    wheel.add({ x: 0, y: 0, dx: 1, dy: 1 }); wheel.cancel();
    vi.advanceTimersByTime(100); expect(send).not.toHaveBeenCalled();
    wheel.add({ x: 1, y: 1, dx: -10, dy: 9 }); vi.advanceTimersByTime(34);
    expect(send).toHaveBeenCalledExactlyOnceWith({ x: 1, y: 1, dx: -5, dy: 5 });
  });
});

describe("browser control authority", () => {
  it("uses confirmed ownership, handles takeover/help resolution, and drops stale confirmations after close", () => {
    let state = { connected: false, holder: null, help: { reason: "Sign in", t: 1 }, error: "" };
    state = controlState(state, { type: "connected" });
    expect(controlState(state, { type: "taking" }).holder).toBeNull();
    state = controlState(state, { type: "control", holder: "you", help: state.help });
    expect(state.holder).toBe("you");
    state = controlState(state, { type: "control", holder: "other", help: null });
    expect(state.holder).toBe("other"); expect(state.help).toBeNull();
    state = controlState(state, { type: "error", message: "Browser ended" });
    expect(state.error).toBe("Browser ended");
    state = controlState(state, { type: "closed" });
    expect(state.holder).toBeNull(); expect(state.connected).toBe(false);
    expect(controlState(state, { type: "control", holder: "you" })).toEqual(state);
  });
});

it("seeks a recording marker to the preceding frame, including markers outside the frame interval", () => {
  const frames = [{ t: 100 }, { t: 300 }, { t: 600 }];
  expect([50, 100, 299, 300, 999].map(t => frameAtTime(frames, t))).toEqual([0, 0, 0, 1, 2]);
});
