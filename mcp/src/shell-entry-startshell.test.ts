/**
 * Tests for startShell() that require module-level mocking.
 * Separated from shell-entry.test.ts because vi.mock is hoisted and
 * would interfere with tests that use real implementations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks (hoisted) ──────────────────────────────────────────────────

vi.mock("./shell/shell.js", () => {
  class MockPhrenShell {
    render = vi.fn().mockResolvedValue("mocked-render");
    handleRawKey = vi.fn().mockResolvedValue(true);
    handleInput = vi.fn().mockResolvedValue(true);
    setMessage = vi.fn();
    close = vi.fn();
    invalidateSubsectionsCache = vi.fn();
  }
  return { PhrenShell: MockPhrenShell };
});

vi.mock("./shell/render.js", () => ({
  style: {
    dim: (s: string) => s,
    bold: (s: string) => s,
    boldCyan: (s: string) => s,
    boldBlue: (s: string) => s,
    red: (s: string) => s,
  },
  clearScreen: vi.fn(),
  clearToEnd: vi.fn(),
  shellStartupFrames: vi.fn().mockReturnValue(["frame1"]),
  gradient: (s: string) => s,
  badge: (s: string) => s,
  stripAnsi: (s: string) => s,
}));

vi.mock("./phren-art.js", () => ({
  createPhrenAnimator: vi.fn().mockReturnValue({
    start: vi.fn(),
    stop: vi.fn(),
    getFrame: vi.fn().mockReturnValue(["line1"]),
  }),
}));

vi.mock("./shared.js", () => ({
  computePhrenLiveStateToken: vi.fn().mockReturnValue("tok"),
}));

vi.mock("./init/shared.js", () => ({
  VERSION: "0.0.0-test",
}));

vi.mock("./shell/state-store.js", () => ({
  loadShellState: vi.fn().mockReturnValue({
    version: 2,
    view: "Projects",
    introMode: "off",
  }),
  saveShellState: vi.fn(),
}));

vi.mock("./utils.js", () => ({
  errorMessage: (err: unknown) => String(err),
}));

import { startShell } from "./shell/entry.js";

/**
 * In CI / non-TTY test runners, process.stdin.setRawMode doesn't exist.
 * We define a stub so vi.spyOn can attach to it.
 */
function ensureSetRawMode(): void {
  if (typeof (process.stdin as Record<string, unknown>).setRawMode !== "function") {
    (process.stdin as Record<string, unknown>).setRawMode = function () {
      return process.stdin;
    };
  }
}

describe("startShell — TTY path (signal handling and cleanup)", () => {
  let origStdinTTY: boolean | undefined;
  let origStdoutTTY: boolean | undefined;
  let stdinOnSpy: ReturnType<typeof vi.spyOn>;
  let stdoutOnSpy: ReturnType<typeof vi.spyOn>;
  let onceSpy: ReturnType<typeof vi.spyOn>;
  let stdinRemoveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ensureSetRawMode();
    origStdinTTY = process.stdin.isTTY;
    origStdoutTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    stdinOnSpy = vi.spyOn(process.stdin, "on").mockReturnValue(process.stdin);
    stdoutOnSpy = vi.spyOn(process.stdout, "on").mockReturnValue(process.stdout);
    stdinRemoveSpy = vi.spyOn(process.stdin, "removeListener").mockReturnValue(process.stdin);
    vi.spyOn(process.stdout, "removeListener").mockReturnValue(process.stdout);
    vi.spyOn(process, "removeListener").mockReturnValue(process);
    onceSpy = vi.spyOn(process, "once").mockImplementation((_event: string, _listener: (...args: unknown[]) => void) => process);
    vi.spyOn(process.stdin, "setRawMode" as never).mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: origStdinTTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: origStdoutTTY, configurable: true });
    vi.restoreAllMocks();
  });

  it("registers SIGINT, SIGTERM, and exit handlers", async () => {
    const shellPromise = startShell("/tmp/test-phren", "default");
    await new Promise((r) => setTimeout(r, 20));

    const registered = onceSpy.mock.calls.map(c => c[0]);
    expect(registered).toContain("SIGINT");
    expect(registered).toContain("SIGTERM");
    expect(registered).toContain("exit");

    // Trigger SIGINT to let shell exit
    const sigintCall = onceSpy.mock.calls.find(c => c[0] === "SIGINT");
    if (sigintCall) (sigintCall[1] as () => void)();
    await shellPromise.catch(() => {});
  });

  it("registers data listener on stdin and resize listener on stdout", async () => {
    const shellPromise = startShell("/tmp/test-phren", "default");
    await new Promise((r) => setTimeout(r, 20));

    const stdinEvents = stdinOnSpy.mock.calls.map(c => c[0]);
    expect(stdinEvents).toContain("data");

    const stdoutEvents = stdoutOnSpy.mock.calls.map(c => c[0]);
    expect(stdoutEvents).toContain("resize");

    // Cleanup
    const sigintCall = onceSpy.mock.calls.find(c => c[0] === "SIGINT");
    if (sigintCall) (sigintCall[1] as () => void)();
    await shellPromise.catch(() => {});
  });

  it("enables raw mode and enters alt screen buffer on TTY", async () => {
    const setRawSpy = vi.spyOn(process.stdin, "setRawMode" as never).mockReturnValue(process.stdin);
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const shellPromise = startShell("/tmp/test-phren", "default");
    await new Promise((r) => setTimeout(r, 20));

    expect(setRawSpy).toHaveBeenCalledWith(true);

    const writes = writeSpy.mock.calls.map(c => c[0]);
    expect(writes).toContain("\x1b[?1049h");

    const sigintCall = onceSpy.mock.calls.find(c => c[0] === "SIGINT");
    if (sigintCall) (sigintCall[1] as () => void)();
    await shellPromise.catch(() => {});
  });

  it("restores terminal on SIGINT (exit cleanup)", async () => {
    const setRawSpy = vi.spyOn(process.stdin, "setRawMode" as never).mockReturnValue(process.stdin);
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const pauseSpy = vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);

    const shellPromise = startShell("/tmp/test-phren", "default");
    await new Promise((r) => setTimeout(r, 20));

    const sigintCall = onceSpy.mock.calls.find(c => c[0] === "SIGINT");
    expect(sigintCall).toBeDefined();
    (sigintCall![1] as () => void)();
    await shellPromise.catch(() => {});

    // Terminal should be restored: setRawMode(false) and alt screen exit
    expect(setRawSpy).toHaveBeenCalledWith(false);
    const writes = writeSpy.mock.calls.map(c => c[0]);
    expect(writes).toContain("\x1b[?1049l");
    expect(pauseSpy).toHaveBeenCalled();
  });

  it("removes stdin data listener during cleanup", async () => {
    const shellPromise = startShell("/tmp/test-phren", "default");
    await new Promise((r) => setTimeout(r, 20));

    const sigintCall = onceSpy.mock.calls.find(c => c[0] === "SIGINT");
    (sigintCall![1] as () => void)();
    await shellPromise.catch(() => {});

    const removedStdinEvents = stdinRemoveSpy.mock.calls.map(c => c[0]);
    expect(removedStdinEvents).toContain("data");
  });

  it("SIGTERM triggers the same cleanup as SIGINT", async () => {
    const setRawSpy = vi.spyOn(process.stdin, "setRawMode" as never).mockReturnValue(process.stdin);
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const shellPromise = startShell("/tmp/test-phren", "default");
    await new Promise((r) => setTimeout(r, 20));

    // Trigger SIGTERM instead of SIGINT
    const sigtermCall = onceSpy.mock.calls.find(c => c[0] === "SIGTERM");
    expect(sigtermCall).toBeDefined();
    (sigtermCall![1] as () => void)();
    await shellPromise.catch(() => {});

    expect(setRawSpy).toHaveBeenCalledWith(false);
    const writes = writeSpy.mock.calls.map(c => c[0]);
    expect(writes).toContain("\x1b[?1049l");
  });
});

describe("startShell — non-TTY path", () => {
  let origStdinTTY: boolean | undefined;
  let origStdoutTTY: boolean | undefined;

  beforeEach(() => {
    ensureSetRawMode();
    origStdinTTY = process.stdin.isTTY;
    origStdoutTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: origStdinTTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: origStdoutTTY, configurable: true });
    vi.restoreAllMocks();
  });

  it("does not enter raw mode or alt screen when stdin is not a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    const setRawSpy = vi.spyOn(process.stdin, "setRawMode" as never).mockReturnValue(process.stdin);
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    // startShell dynamically imports readline; we can't easily mock it in ESM,
    // but the non-TTY path will create a readline interface and wait for "close".
    // We spy on stdin.on to capture and immediately fire the "close" event on the rl.
    // Since we can't mock readline.createInterface in ESM, we instead verify that
    // the TTY-specific setup (raw mode, alt screen) was NOT performed.
    // The shell will hang waiting for readline close, so we race with a timeout.
    const shellPromise = Promise.race([
      startShell("/tmp/test-phren", "default"),
      new Promise<void>((resolve) => setTimeout(resolve, 50)),
    ]);
    await shellPromise;

    // The TTY-specific raw mode should NOT have been called
    expect(setRawSpy).not.toHaveBeenCalled();

    // Alt screen buffer escape should NOT appear in writes
    const writes = writeSpy.mock.calls.map(c => c[0]);
    expect(writes).not.toContain("\x1b[?1049h");
  });
});
