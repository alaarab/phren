/**
 * Text effects for the phren wordmark on the shell splash.
 *
 * Inspired by TerminalTextEffects: the block-letter logo is revealed with a
 * "decrypt" scramble that settles cell by cell into the real glyphs, and the
 * finished wordmark carries a slow light-beam shimmer while the splash holds.
 *
 * Two rules keep the letters intact:
 *  - scramble glyphs come only from the same box-drawing / block family the
 *    logo already uses, so every cell stays one column wide;
 *  - every frame is a pure function of (progress, cell) with hash-based
 *    jitter, so the reveal is deterministic and the final frame equals the
 *    plain gradient logo exactly.
 *
 * This module is imported by render.ts and must not import from it.
 */
export declare const PHREN_LOGO: string[];
export declare const PHREN_GRADIENT: string[];
/** Frames in the reveal and the delay between them. ~1s total. */
export declare const LOGO_REVEAL_FRAMES = 22;
export declare const LOGO_REVEAL_FRAME_MS = 45;
export declare const LOGO_SHIMMER_FRAME_MS = 110;
/** The finished wordmark: identical colours to `gradient(line)` in render.ts. */
export declare function logoPlain(): string[];
/**
 * Decrypt reveal at `progress` in [0, 1]. Cells settle left to right with
 * per-cell jitter; a settling cell flashes white for a moment; unsettled
 * cells churn through scramble glyphs. At progress >= 1 this is `logoPlain()`.
 */
export declare function logoRevealFrame(progress: number): string[];
/**
 * A soft beam of light sweeping across the finished wordmark. `tick` is any
 * increasing integer; the sweep loops with a pause between passes.
 */
export declare function logoShimmerFrame(tick: number): string[];
