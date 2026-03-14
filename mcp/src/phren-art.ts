/**
 * Phren character ASCII/Unicode art and spinner for CLI presence.
 *
 * Based on the pixel art: purple 8-bit brain with diamond eyes,
 * smile, little legs, and cyan sparkle.
 */

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const PURPLE = `${ESC}35m`;       // magenta
const BRIGHT_PURPLE = `${ESC}95m`; // bright magenta
const CYAN = `${ESC}96m`;          // bright cyan
const DIM = `${ESC}2m`;
const DARK_PURPLE = `${ESC}38;5;57m`;  // deep purple for shading

/**
 * Compact phren ASCII art (~6 lines tall).
 * Uses Unicode block elements and ANSI purple/cyan coloring.
 * Designed for dark terminal backgrounds.
 */
export const PHREN_ART = [
  `${CYAN}        ✦${RESET}`,
  `${DARK_PURPLE}   ▄${PURPLE}██████${DARK_PURPLE}▄${RESET}`,
  `${PURPLE}  ██${BRIGHT_PURPLE}▓▓${PURPLE}██${BRIGHT_PURPLE}▓▓${PURPLE}██${RESET}`,
  `${PURPLE}  █${DARK_PURPLE}◆${PURPLE}██${DARK_PURPLE}◆${PURPLE}███${RESET}`,
  `${PURPLE}  ██${DIM}${PURPLE}▽${RESET}${PURPLE}████${BRIGHT_PURPLE}█${RESET}`,
  `${DARK_PURPLE}   ▀${PURPLE}██████${DARK_PURPLE}▀${RESET}`,
  `${DARK_PURPLE}    ██  ██${RESET}`,
];

/** Single-line compact phren for inline use */
export const PHREN_INLINE = `${PURPLE}◆${RESET}`;

/** Phren spinner frames for search/sync operations — cycles through in purple */
export const PHREN_SPINNER_FRAMES = [
  `${BRIGHT_PURPLE}◆${RESET}`,
  `${PURPLE}◇${RESET}`,
  `${CYAN}✦${RESET}`,
  `${PURPLE}✧${RESET}`,
  `${BRIGHT_PURPLE}◆${RESET}`,
  `${DARK_PURPLE}◇${RESET}`,
];

/** Default spinner interval in ms */
export const PHREN_SPINNER_INTERVAL_MS = 120;

/**
 * Return the phren art as a single string, optionally indented.
 */
export function renderPhrenArt(indent = ""): string {
  return PHREN_ART.map(line => indent + line).join("\n");
}

/**
 * Get a spinner frame by index (wraps around automatically).
 */
export function spinnerFrame(tick: number): string {
  return PHREN_SPINNER_FRAMES[tick % PHREN_SPINNER_FRAMES.length];
}
