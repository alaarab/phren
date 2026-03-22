/**
 * Shell entry point: wires PhrenShell to stdin/stdout.
 * Extracted from shell.ts to keep the orchestrator under 300 lines.
 */

import { PhrenShell } from "./shell.js";
import { style, clearScreen, clearToEnd, shellStartupFrames, gradient, badge } from "./shell-render.js";
import { createPhrenAnimator, PHREN_ART_RIGHT } from "../phren-art.js";
import { errorMessage } from "../utils.js";
import { computePhrenLiveStateToken } from "../shared.js";
import { VERSION } from "../init/init-shared.js";
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

export function resolveStartupIntroPlan(phrenPath: string, version = VERSION): StartupIntroPlan {
  const state = loadShellState(phrenPath);
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

function markStartupIntroSeen(phrenPath: string, version = VERSION): void {
  const state = loadShellState(phrenPath);
  if (state.introSeenVersion === version) return;
  saveShellState(phrenPath, { ...state, introSeenVersion: version });
}

async function playStartupIntro(phrenPath: string, plan = resolveStartupIntroPlan(phrenPath)): Promise<void> {
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

  // Start animated phren during loading
  const animator = createPhrenAnimator({ facing: "right" });
  animator.start();

  const cols = process.stdout.columns || 80;
  const tagline = style.dim("local memory for working agents");
  const versionBadge = badge(`v${VERSION}`, style.boldBlue);
  const logoLines = [
    "██████╗ ██╗  ██╗██████╗ ███████╗███╗   ██╗",
    "██╔══██╗██║  ██║██╔══██╗██╔════╝████╗  ██║",
    "██████╔╝███████║██████╔╝█████╗  ██╔██╗ ██║",
    "██╔═══╝ ██╔══██║██╔══██╗██╔══╝  ██║╚██╗██║",
    "██║     ██║  ██║██║  ██║███████╗██║ ╚████║",
    "╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝",
  ].map(l => gradient(l));
  const infoLine = `${gradient("◆")} ${style.bold("phren")}  ${versionBadge}  ${tagline}`;

  function renderAnimatedFrame(hint?: string): void {
    const phrenLines = animator.getFrame();
    const rightSide = ["", "", ...logoLines, "", infoLine];
    const charWidth = 26;
    const maxLines = Math.max(phrenLines.length, rightSide.length);
    const merged: string[] = [""];
    for (let i = 0; i < maxLines; i++) {
      const left = (i < phrenLines.length ? phrenLines[i] : "").padEnd(charWidth);
      const right = i < rightSide.length ? rightSide[i] : "";
      merged.push(left + right);
    }
    if (hint) merged.push("", `  ${hint}`);
    merged.push("");
    renderIntroFrame(merged.join("\n"));
  }

  // Animate during dwell/loading period
  if (plan.holdForKeypress) {
    const animInterval = setInterval(() => renderAnimatedFrame(renderHint), 200);
    renderAnimatedFrame(renderHint);
    await waitForAnyKeypress();
    clearInterval(animInterval);
  } else if (plan.dwellMs > 0) {
    const startTime = Date.now();
    while (Date.now() - startTime < plan.dwellMs) {
      renderAnimatedFrame(renderHint);
      await sleep(200);
    }
  } else {
    renderAnimatedFrame(renderHint);
  }

  animator.stop();

  if (plan.markSeen) {
    markStartupIntroSeen(phrenPath);
  }
}

export function startLiveStatePoller({
  phrenPath,
  shell,
  repaint,
  isExiting = () => false,
  intervalMs = LIVE_STATE_POLL_MS,
  computeToken = computePhrenLiveStateToken,
}: {
  phrenPath: string;
  shell: LiveStateHost;
  repaint: () => Promise<void>;
  isExiting?: () => boolean;
  intervalMs?: number;
  computeToken?: (phrenPath: string) => string;
}): () => void {
  let liveStateToken = computeToken(phrenPath);
  let stopped = false;
  let inFlight = false;

  const pollOnce = async () => {
    if (stopped || inFlight || isExiting()) return;
    inFlight = true;
    try {
      const nextToken = computeToken(phrenPath);
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

export async function startShell(phrenPath: string, profile: string): Promise<void> {
  const shell = new PhrenShell(phrenPath, profile);

  if (!process.stdin.isTTY) {
    const { createInterface } = await import("readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY ?? false });
    const repaint = async () => { clearScreen(); process.stdout.write(await shell.render()); rl.setPrompt(`\n${style.boldCyan(":phren>")} `); rl.prompt(); };
    const stopPoll = startLiveStatePoller({ phrenPath, shell, repaint });
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
  const stopPoll = startLiveStatePoller({ phrenPath, shell, repaint, isExiting: () => exiting });

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
    await playStartupIntro(phrenPath);
    await repaint();
    await exitPromise;
  } finally {
    finish();
  }
}
