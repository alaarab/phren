/**
 * The phren splash: mascot + wordmark text effect, shared by every terminal
 * host (the interactive shell, phren-agent, anything embedding phren).
 *
 * The shell drives it from its own intro policy (once per version, always,
 * off); other hosts call `playSplash` directly. Everything is injectable so
 * the sequence can be tested without a terminal or real time.
 */
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
    screen?: {
        enter: () => void;
        exit: () => void;
    };
}
/**
 * Play the splash and return when it is dismissed. Does nothing when stdout
 * is not a terminal.
 */
export declare function playSplash(opts: SplashOptions): Promise<void>;
