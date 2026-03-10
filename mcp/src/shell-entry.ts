/**
 * Shell entry point: wires CortexShell to stdin/stdout.
 * Extracted from shell.ts to keep the orchestrator under 300 lines.
 */

import { CortexShell } from "./shell.js";
import { style, clearScreen, clearToEnd, shellStartupFrames } from "./shell-render.js";
import { errorMessage } from "./utils.js";
import { computeCortexLiveStateToken } from "./shared.js";
import { VERSION } from "./init-shared.js";
import { loadShellState, saveShellState } from "./shell-state-store.js";

const LIVE_STATE_POLL_MS = 2000;

interface LiveStateHost {
  invalidateSubsectionsCache(): void;
  setMessage(message: string): void;
}

export interface StartupIntroPlan {
  mode: "always" | "once-per-version" | "off";
  variant: "full" | "final-frame" | "skip";
  holdForKeypress: boolean;
  dwellMs: number;
  markSeen: boolean;
}

function renderIntroFrame(frame: string, footer?: string): void {
  clearScreen();
  process.stdout.write(footer ? `${frame}\n${footer}\n` : `${frame}\n`);
  clearToEnd();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAnyKeypress(): Promise<void> {
  await new Promise<void>((resolve) => {
    const onData = () => {
      process.stdin.removeListener("data", onData);
      resolve();
    };
    process.stdin.on("data", onData);
  });
}

export function resolveStartupIntroPlan(cortexPath: string, version = VERSION): StartupIntroPlan {
  const state = loadShellState(cortexPath);
  const mode = state.introMode === "always" || state.introMode === "off" ? state.introMode : "once-per-version";

  if (mode === "off") {
    return { mode, variant: "skip", holdForKeypress: false, dwellMs: 0, markSeen: false };
  }
  if (mode === "always") {
    return { mode, variant: "full", holdForKeypress: false, dwellMs: 700, markSeen: true };
  }
  if (state.introSeenVersion !== version) {
    return { mode, variant: "full", holdForKeypress: true, dwellMs: 0, markSeen: true };
  }
  return { mode, variant: "final-frame", holdForKeypress: false, dwellMs: 550, markSeen: false };
}

function markStartupIntroSeen(cortexPath: string, version = VERSION): void {
  const state = loadShellState(cortexPath);
  if (state.introSeenVersion === version) return;
  saveShellState(cortexPath, { ...state, introSeenVersion: version });
}

async function playStartupIntro(cortexPath: string, plan = resolveStartupIntroPlan(cortexPath)): Promise<void> {
  if (!process.stdout.isTTY || plan.variant === "skip") return;

  const frames = shellStartupFrames(VERSION);
  const renderHint = plan.holdForKeypress
    ? `${style.dim("Press any key to enter")}`
    : `${style.dim("Loading shell…")}`;

  if (plan.variant === "full") {
    for (const frame of frames.slice(0, -1)) {
      renderIntroFrame(frame);
      await sleep(160);
    }
  }

  renderIntroFrame(frames[frames.length - 1], renderHint);
  if (plan.holdForKeypress) {
    await waitForAnyKeypress();
  } else if (plan.dwellMs > 0) {
    await sleep(plan.dwellMs);
  }

  if (plan.markSeen) {
    markStartupIntroSeen(cortexPath);
  }
}

export function startLiveStatePoller({
  cortexPath,
  shell,
  repaint,
  isExiting = () => false,
  intervalMs = LIVE_STATE_POLL_MS,
  computeToken = computeCortexLiveStateToken,
}: {
  cortexPath: string;
  shell: LiveStateHost;
  repaint: () => Promise<void>;
  isExiting?: () => boolean;
  intervalMs?: number;
  computeToken?: (cortexPath: string) => string;
}): () => void {
  let liveStateToken = computeToken(cortexPath);
  let stopped = false;
  let inFlight = false;

  const pollOnce = async () => {
    if (stopped || inFlight || isExiting()) return;
    inFlight = true;
    try {
      const nextToken = computeToken(cortexPath);
      if (nextToken === liveStateToken) return;
      liveStateToken = nextToken;
      shell.invalidateSubsectionsCache();
      shell.setMessage(`  ${style.boldCyan("Live")} ${style.dim("store updated")}`);
      await repaint();
    } finally {
      inFlight = false;
    }
  };

  const poll = setInterval(() => {
    void pollOnce();
  }, intervalMs);
  poll.unref?.();

  return () => {
    stopped = true;
    clearInterval(poll);
  };
}

export async function startShell(cortexPath: string, profile: string): Promise<void> {
  const shell = new CortexShell(cortexPath, profile);

  if (!process.stdin.isTTY) {
    const { createInterface } = await import("readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const repaint = async () => { clearScreen(); process.stdout.write(await shell.render()); rl.setPrompt(`\n${style.boldCyan(":cortex>")} `); rl.prompt(); };
    const stopPoll = startLiveStatePoller({ cortexPath, shell, repaint });
    await repaint();
    rl.on("line", async (line) => {
      try { const keep = await shell.handleInput(line); if (!keep) { shell.close(); rl.close(); return; } }
      catch (err: unknown) { process.stdout.write(`\n${style.red("Error:")} ${String(errorMessage(err))}\n`); }
      await repaint();
    });
    rl.on("SIGINT", () => { stopPoll(); shell.close(); rl.close(); });
    rl.on("close", () => { stopPoll(); });
    await new Promise<void>((resolve) => { rl.on("close", () => { shell.close(); resolve(); }); });
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?1049h");
  let exiting = false;
  let cleanedUp = false;
  const repaint = async () => { clearScreen(); process.stdout.write(await shell.render()); clearToEnd(); };
  let done!: () => void;
  const exitPromise = new Promise<void>((resolve) => { done = resolve; });

  const restoreTerminal = () => {
    // Shutdown cleanup is intentionally silent: terminal restoration is best-effort
    // cleanup, not a user-requested write path.
    try { process.stdin.setRawMode(false); } catch {}
    try { process.stdin.pause(); } catch {}
    try { process.stdout.write("\x1b[?1049l"); } catch {}
  };

  const onData = async (key: string) => {
    if (exiting) return;
    try {
      const keep = await shell.handleRawKey(key);
      if (!keep) { exiting = true; finish(); return; }
      await repaint();
    } catch (err: unknown) { shell.setMessage(`Error: ${errorMessage(err)}`); await repaint(); }
  };
  const onResize = async () => { if (!exiting) await repaint(); };
  const onSignal = () => {
    if (exiting) return;
    exiting = true;
    finish();
  };
  const onProcessExit = () => { restoreTerminal(); };
  const stopPoll = startLiveStatePoller({ cortexPath, shell, repaint, isExiting: () => exiting });

  const finish = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    stopPoll();
    process.stdin.removeListener("data", onData);
    process.stdout.removeListener("resize", onResize);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("exit", onProcessExit);
    restoreTerminal();
    shell.close();
    done();
  };

  process.stdin.on("data", onData);
  process.stdout.on("resize", onResize);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("exit", onProcessExit);

  try {
    await playStartupIntro(cortexPath);
    await repaint();
    await exitPromise;
  } finally {
    finish();
  }
}
