import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "path";
import { startLiveStatePoller, resolveStartupIntroPlan } from "./shell/entry.js";
import { shellStartupFrames, stripAnsi } from "./shell/render.js";
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
      phrenPath: "/tmpphren",
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
      phrenPath: "/tmpphren",
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
      phrenPath: "/tmpphren",
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
      phrenPath: "/tmpphren",
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

  it("always mode produces full variant without holdForKeypress", () => {
    const tmp = makeTempDir("shell-intro-plan-");
    try {
      writeFile(path.join(tmp.path, ".runtime", "shell-state.json"), JSON.stringify({
        version: 2,
        view: "Projects",
        introMode: "always",
        introSeenVersion: "9.9.9",
      }, null, 2));
      const plan = resolveStartupIntroPlan(tmp.path, "9.9.9");
      expect(plan.mode).toBe("always");
      expect(plan.variant).toBe("full");
      expect(plan.holdForKeypress).toBe(false);
      expect(plan.dwellMs).toBe(700);
      expect(plan.markSeen).toBe(true);
    } finally {
      tmp.cleanup();
    }
  });

  it("treats unknown introMode as once-per-version", () => {
    const tmp = makeTempDir("shell-intro-plan-");
    try {
      writeFile(path.join(tmp.path, ".runtime", "shell-state.json"), JSON.stringify({
        version: 2,
        view: "Projects",
        introMode: "bogus",
      }, null, 2));
      const plan = resolveStartupIntroPlan(tmp.path, "9.9.9");
      expect(plan.mode).toBe("once-per-version");
      expect(plan.variant).toBe("full");
      expect(plan.holdForKeypress).toBe(true);
    } finally {
      tmp.cleanup();
    }
  });

  it("off mode returns zero dwellMs and no markSeen", () => {
    const tmp = makeTempDir("shell-intro-plan-");
    try {
      writeFile(path.join(tmp.path, ".runtime", "shell-state.json"), JSON.stringify({
        version: 2,
        view: "Projects",
        introMode: "off",
      }, null, 2));
      const plan = resolveStartupIntroPlan(tmp.path, "9.9.9");
      expect(plan.dwellMs).toBe(0);
      expect(plan.markSeen).toBe(false);
      expect(plan.holdForKeypress).toBe(false);
    } finally {
      tmp.cleanup();
    }
  });

  it("new version after a previously-seen version triggers full intro with hold", () => {
    const tmp = makeTempDir("shell-intro-plan-");
    try {
      writeFile(path.join(tmp.path, ".runtime", "shell-state.json"), JSON.stringify({
        version: 2,
        view: "Projects",
        introMode: "once-per-version",
        introSeenVersion: "1.0.0",
      }, null, 2));
      const plan = resolveStartupIntroPlan(tmp.path, "2.0.0");
      expect(plan.variant).toBe("full");
      expect(plan.holdForKeypress).toBe(true);
      expect(plan.markSeen).toBe(true);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("shellStartupFrames", () => {
  let origColumns: number | undefined;

  beforeEach(() => {
    origColumns = process.stdout.columns;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", { value: origColumns, writable: true, configurable: true });
  });

  it("returns a single merged frame for wide terminals (>= 72 cols)", () => {
    Object.defineProperty(process.stdout, "columns", { value: 120, writable: true, configurable: true });
    const frames = shellStartupFrames("0.0.1");
    expect(frames.length).toBe(1);
    expect(frames[0]).toContain("phren");
  });

  it("returns a single stacked frame for medium terminals (56-71 cols)", () => {
    Object.defineProperty(process.stdout, "columns", { value: 60, writable: true, configurable: true });
    const frames = shellStartupFrames("0.0.1");
    expect(frames.length).toBe(1);
    const plain = stripAnsi(frames[0]);
    expect(plain).toContain("phren");
  });

  it("returns multiple progressive frames for narrow terminals (< 56 cols)", () => {
    Object.defineProperty(process.stdout, "columns", { value: 40, writable: true, configurable: true });
    const frames = shellStartupFrames("0.0.1");
    expect(frames.length).toBe(3);
    const texts = frames.map(f => stripAnsi(f));
    expect(texts[0]).toContain("p");
    expect(texts[1]).toContain("phr");
    expect(texts[2]).toContain("phren");
  });

  it("falls back to 80 columns when process.stdout.columns is 0", () => {
    Object.defineProperty(process.stdout, "columns", { value: 0, writable: true, configurable: true });
    const frames = shellStartupFrames("0.0.1");
    // 0 || 80 = 80, which is >= 72, so wide layout
    expect(frames.length).toBe(1);
  });

  it("includes the version string in the output", () => {
    Object.defineProperty(process.stdout, "columns", { value: 120, writable: true, configurable: true });
    const frames = shellStartupFrames("42.0.0");
    const plain = stripAnsi(frames.join("\n"));
    expect(plain).toContain("v42.0.0");
  });

  it("includes tagline in all terminal widths", () => {
    for (const cols of [40, 60, 120]) {
      Object.defineProperty(process.stdout, "columns", { value: cols, writable: true, configurable: true });
      const frames = shellStartupFrames("1.0.0");
      const plain = stripAnsi(frames.join("\n"));
      expect(plain).toContain("local memory for working agents");
    }
  });
});
