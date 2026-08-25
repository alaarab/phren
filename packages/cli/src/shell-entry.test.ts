import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "path";
import { startLiveStatePoller, resolveStartupIntroPlan } from "./shell/entry.js";
import { shellStartupFrames, composeStartupFrame, fitFrame, stripAnsi } from "./shell/render.js";
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
  let origRows: number | undefined;

  beforeEach(() => {
    origColumns = process.stdout.columns;
    origRows = process.stdout.rows;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", { value: origColumns, writable: true, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: origRows, writable: true, configurable: true });
  });

  it("returns a single merged frame for wide terminals (>= 69 cols)", () => {
    Object.defineProperty(process.stdout, "columns", { value: 120, writable: true, configurable: true });
    const frames = shellStartupFrames("0.0.1");
    expect(frames.length).toBe(1);
    expect(frames[0]).toContain("phren");
  });

  it("returns a single stacked frame for medium terminals (44-68 cols)", () => {
    Object.defineProperty(process.stdout, "columns", { value: 60, writable: true, configurable: true });
    const frames = shellStartupFrames("0.0.1");
    expect(frames.length).toBe(1);
    const plain = stripAnsi(frames[0]);
    expect(plain).toContain("phren");
  });

  it("returns multiple progressive frames for narrow terminals (< 44 cols)", () => {
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
    // 0 || 80 = 80, which is >= 69, so wide layout
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

  // A splash taller or wider than the terminal scrolls the alternate screen,
  // and every cursor-home repaint after that lands on shifted rows — which is
  // what made the intro frames stack on top of each other.
  it("never composes a frame taller than the terminal", () => {
    const art = Array.from({ length: 12 }, () => "x".repeat(24));
    for (const rows of [10, 14, 16, 24, 45]) {
      Object.defineProperty(process.stdout, "rows", { value: rows, writable: true, configurable: true });
      for (const cols of [40, 60, 80, 120]) {
        Object.defineProperty(process.stdout, "columns", { value: cols, writable: true, configurable: true });
        const frame = composeStartupFrame(art, "1.0.0", "Loading shell…");
        expect(frame.length).toBeLessThanOrEqual(rows);
        for (const line of frame) expect(stripAnsi(line).length).toBeLessThan(cols);
      }
    }
  });

  it("keeps the character art aligned with the logo despite ANSI in the art", () => {
    Object.defineProperty(process.stdout, "rows", { value: 40, writable: true, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: 120, writable: true, configurable: true });
    // Art rows carry per-pixel colour codes; padding must measure display cells.
    const art = Array.from({ length: 12 }, () => `\x1b[38;2;1;2;3m${"▒".repeat(24)}\x1b[0m`);
    const frame = composeStartupFrame(art, "1.0.0");
    // Five of the six logo rows carry block glyphs; the last is all box-drawing.
    const logoRows = frame.filter(line => stripAnsi(line).includes("█"));
    expect(logoRows.length).toBe(5);
    const starts = new Set(logoRows.map(line => stripAnsi(line).indexOf("█")));
    expect([...starts]).toEqual([26]);
  });

  it("fitFrame clamps rows and erases the rest of every line", () => {
    Object.defineProperty(process.stdout, "rows", { value: 3, writable: true, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: 20, writable: true, configurable: true });
    const painted = fitFrame(["a", "b", "c", "d", "e"]);
    const lines = painted.split("\n");
    expect(lines.length).toBe(3);
    for (const line of lines) expect(line.endsWith("\x1b[K")).toBe(true);
  });
});
