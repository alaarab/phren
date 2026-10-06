/**
 * The phren splash: mascot + wordmark text effect, shared by every terminal
 * host (the interactive shell, phren-agent, anything embedding phren).
 *
 * The shell drives it from its own intro policy (once per version, always,
 * off); other hosts call `playSplash` directly. Everything is injectable so
 * the sequence can be tested without a terminal or real time.
 */

import { createPhrenAnimator } from "../phren-art.js";
import {
  LOGO_REVEAL_FRAMES,
  LOGO_REVEAL_FRAME_MS,
  LOGO_SHIMMER_FRAME_MS,
  logoRevealFrame,
  logoShimmerFrame,
} from "./logo-fx.js";
import {
  composeStartupFrame,
  enterFullscreen,
  exitFullscreen,
  fitFrame,
  paintFrame,
  shellStartupFrames,
  style,
} from "./render.js";

export type KeypressWaiter = () => Promise<void>;

export interface SplashOptions {
  version: string;
  /** Replaces "local memory for working agents" beside the wordmark. */
  tagline?: string;
  /** Dimmed line under the splash ("Press any key to enter"). */
  hint?: string;
  /** Play the decrypt reveal; otherwise open on the finished wordmark. */
  reveal?: boolean;
  /** Hold with the shimmer for this long after the reveal. */
  dwellMs?: number;
  /** Hold until this resolves instead of a fixed dwell. */
  waitForKeypress?: KeypressWaiter;
  /** Wrap in the alternate screen — for hosts that are not already fullscreen. */
  fullscreen?: boolean;
  /** Injection points for tests. */
  paint?: (frame: string) => void;
  sleep?: (ms: number) => Promise<void>;
  isTTY?: boolean;
  screen?: { enter: () => void; exit: () => void };
}

const NARROW_STAGE_MS = 160;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Play the splash and return when it is dismissed. Does nothing when stdout
 * is not a terminal.
 */
export async function playSplash(opts: SplashOptions): Promise<void> {
  const isTTY = opts.isTTY ?? Boolean(process.stdout.isTTY);
  if (!isTTY) return;
  const paint = opts.paint ?? paintFrame;
  const sleep = opts.sleep ?? realSleep;
  const screen = opts.screen ?? { enter: enterFullscreen, exit: exitFullscreen };
  const hint = opts.hint ? style.dim(opts.hint) : undefined;
  const dwellMs = opts.dwellMs ?? 0;

  if (opts.fullscreen) screen.enter();
  const animator = createPhrenAnimator({ facing: "right" });
  animator.start();
  let shimmerTick = 0;
  const frame = (logo?: string[], withHint = true): void => {
    paint(fitFrame(composeStartupFrame(
      animator.getFrame(),
      opts.version,
      withHint ? hint : undefined,
      logo ?? logoShimmerFrame(shimmerTick++),
      opts.tagline,
    )));
  };

  try {
    if (opts.reveal) {
      // Terminals too narrow for the wordmark get the staged text reveal instead.
      const stages = shellStartupFrames(opts.version, opts.tagline);
      if (stages.length > 1) {
        for (const stage of stages.slice(0, -1)) { paint(stage); await sleep(NARROW_STAGE_MS); }
      } else {
        for (let i = 0; i < LOGO_REVEAL_FRAMES; i++) {
          frame(logoRevealFrame(i / (LOGO_REVEAL_FRAMES - 1)), false);
          await sleep(LOGO_REVEAL_FRAME_MS);
        }
      }
    }

    if (opts.waitForKeypress) {
      const interval = setInterval(() => frame(), LOGO_SHIMMER_FRAME_MS);
      frame();
      try { await opts.waitForKeypress(); } finally { clearInterval(interval); }
    } else if (dwellMs > 0) {
      const start = Date.now();
      let elapsed = 0;
      do {
        frame();
        await sleep(LOGO_SHIMMER_FRAME_MS);
        elapsed = opts.sleep ? elapsed + LOGO_SHIMMER_FRAME_MS : Date.now() - start;
      } while (elapsed < dwellMs);
    } else {
      frame();
    }
  } finally {
    animator.stop();
    if (opts.fullscreen) screen.exit();
  }
}
