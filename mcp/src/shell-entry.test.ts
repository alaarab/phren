import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "path";
import { startLiveStatePoller, resolveStartupIntroPlan } from "./shell-entry.js";
import { makeTempDir, writeFile } from "./test-helpers.js";

describe("startLiveStatePoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("repaints when the live-state token changes", async () => {
    const shell = {
      invalidateSubsectionsCache: vi.fn(),
      setMessage: vi.fn(),
    };
    const repaint = vi.fn(async () => {});
    const computeToken = vi.fn()
      .mockReturnValueOnce("token-a")
      .mockReturnValueOnce("token-a")
      .mockReturnValueOnce("token-b");

    const stop = startLiveStatePoller({
      cortexPath: "/tmp/cortex",
      shell,
      repaint,
      intervalMs: 100,
      computeToken,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(repaint).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(shell.invalidateSubsectionsCache).toHaveBeenCalledTimes(1);
    expect(shell.setMessage).toHaveBeenCalledTimes(1);
    expect(shell.setMessage.mock.calls[0]?.[0]).toContain("Live");
    expect(repaint).toHaveBeenCalledTimes(1);

    stop();
  });

  it("does not start a new poll while a repaint is still in flight", async () => {
    const shell = {
      invalidateSubsectionsCache: vi.fn(),
      setMessage: vi.fn(),
    };
    let releaseRepaint!: () => void;
    const repaint = vi.fn(() => new Promise<void>((resolve) => {
      releaseRepaint = resolve;
    }));
    const computeToken = vi.fn()
      .mockReturnValueOnce("token-a")
      .mockReturnValueOnce("token-b")
      .mockReturnValue("token-c");

    const stop = startLiveStatePoller({
      cortexPath: "/tmp/cortex",
      shell,
      repaint,
      intervalMs: 100,
      computeToken,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(repaint).toHaveBeenCalledTimes(1);
    expect(computeToken).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(300);
    expect(repaint).toHaveBeenCalledTimes(1);
    expect(computeToken).toHaveBeenCalledTimes(2);

    releaseRepaint();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(100);
    expect(computeToken).toHaveBeenCalledTimes(3);

    stop();
  });

  it("stops polling once the shell is exiting", async () => {
    const shell = {
      invalidateSubsectionsCache: vi.fn(),
      setMessage: vi.fn(),
    };
    const repaint = vi.fn(async () => {});
    const computeToken = vi.fn()
      .mockReturnValueOnce("token-a")
      .mockReturnValue("token-b");

    const stop = startLiveStatePoller({
      cortexPath: "/tmp/cortex",
      shell,
      repaint,
      intervalMs: 100,
      isExiting: () => true,
      computeToken,
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(shell.invalidateSubsectionsCache).not.toHaveBeenCalled();
    expect(repaint).not.toHaveBeenCalled();

    stop();
  });

  it("does not repaint after stop() is called", async () => {
    const shell = {
      invalidateSubsectionsCache: vi.fn(),
      setMessage: vi.fn(),
    };
    const repaint = vi.fn(async () => {});
    const computeToken = vi.fn()
      .mockReturnValueOnce("token-a")
      .mockReturnValueOnce("token-b")
      .mockReturnValue("token-c");

    const stop = startLiveStatePoller({
      cortexPath: "/tmp/cortex",
      shell,
      repaint,
      intervalMs: 100,
      computeToken,
    });

    stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(shell.invalidateSubsectionsCache).not.toHaveBeenCalled();
    expect(repaint).not.toHaveBeenCalled();
  });
});

describe("resolveStartupIntroPlan", () => {
  it("holds on first run of a version and marks it seen", () => {
    const tmp = makeTempDir("shell-intro-plan-");
    try {
      const plan = resolveStartupIntroPlan(tmp.path, "9.9.9");
      expect(plan.mode).toBe("once-per-version");
      expect(plan.variant).toBe("full");
      expect(plan.holdForKeypress).toBe(true);
      expect(plan.markSeen).toBe(true);
    } finally {
      tmp.cleanup();
    }
  });

  it("uses a short final-frame dwell after the version has already been seen", () => {
    const tmp = makeTempDir("shell-intro-plan-");
    try {
      writeFile(path.join(tmp.path, ".runtime", "shell-state.json"), JSON.stringify({
        version: 2,
        view: "Projects",
        introMode: "once-per-version",
        introSeenVersion: "9.9.9",
      }, null, 2));
      const plan = resolveStartupIntroPlan(tmp.path, "9.9.9");
      expect(plan.variant).toBe("final-frame");
      expect(plan.holdForKeypress).toBe(false);
      expect(plan.dwellMs).toBeGreaterThan(0);
    } finally {
      tmp.cleanup();
    }
  });

  it("skips the intro entirely when disabled", () => {
    const tmp = makeTempDir("shell-intro-plan-");
    try {
      writeFile(path.join(tmp.path, ".runtime", "shell-state.json"), JSON.stringify({
        version: 2,
        view: "Projects",
        introMode: "off",
      }, null, 2));
      const plan = resolveStartupIntroPlan(tmp.path, "9.9.9");
      expect(plan.variant).toBe("skip");
      expect(plan.mode).toBe("off");
    } finally {
      tmp.cleanup();
    }
  });
});
