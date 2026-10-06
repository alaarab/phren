/**
 * Phren character ASCII/Unicode art for CLI presence.
 *
 * Based on the pixel art: purple 8-bit brain with diamond eyes,
 * smile, little legs, and cyan sparkle.
 */
/**
 * Phren truecolor art (24px wide, generated from phren-transparent.png).
 * Uses half-block ▀ with RGB foreground+background for pixel-faithful rendering.
 * Requires truecolor terminal (most modern terminals support it).
 */
export declare const PHREN_ART: string[];
export declare const PHREN_ART_RIGHT: string[];
/**
 * The mascot holds still: it sits at a fixed position beside the wordmark and
 * only its eyes and the sparkle above its head change. Whole-body motion (the
 * vertical bob and the sideways lean) shifted the art by a full cell, which
 * reads as blocky jitter at terminal resolution, so it is gone. Every frame has
 * the same line count and the same display width as `PHREN_ART`.
 */
export interface PhrenAnimator {
    getFrame(): string[];
    start(): void;
    stop(): void;
}
export declare function createPhrenAnimator(options?: {
    facing?: "left" | "right";
    size?: number;
}): PhrenAnimator;
/**
 * Return the phren art as a single string, optionally indented.
 */
export declare function renderPhrenArt(indent?: string): string;
