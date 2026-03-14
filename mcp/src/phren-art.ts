/**
 * Phren character ASCII/Unicode art and spinner for CLI presence.
 *
 * Based on the pixel art: purple 8-bit brain with diamond eyes,
 * smile, little legs, and cyan sparkle.
 */

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const PURPLE = `${ESC}35m`;       // magenta — body
const BRIGHT_PURPLE = `${ESC}95m`; // bright magenta — highlights
const CYAN = `${ESC}96m`;          // bright cyan — sparkle
const DIM = `${ESC}2m`;
const DARK_PURPLE = `${ESC}38;5;57m`;  // deep purple — shadow/outline
const LIGHT_PURPLE = `${ESC}38;5;141m`; // lavender — brain highlights
const MID_PURPLE = `${ESC}38;5;98m`;    // mid tone
const NAVY = `${ESC}38;5;18m`;          // darkest outline

/**
 * Phren ASCII art (~11 lines tall, ~20 cols wide).
 * Matches the pixel-art PNG: round purple brain with wrinkle texture,
 * diamond eyes, cute smile, stubby legs, cyan sparkle.
 * Uses Unicode half-blocks and ANSI 256-color for shading depth.
 */
export const PHREN_ART = [
  `                  ${CYAN}✦${RESET}`,
  `       ${NAVY}▄${DARK_PURPLE}▄▄${PURPLE}████${DARK_PURPLE}▄▄${NAVY}▄${RESET}`,
  `     ${NAVY}▄${PURPLE}██${LIGHT_PURPLE}▓▓${PURPLE}██${LIGHT_PURPLE}▓▓${PURPLE}██${NAVY}▄${RESET}`,
  `    ${NAVY}█${PURPLE}██${LIGHT_PURPLE}░${BRIGHT_PURPLE}▓${PURPLE}██${LIGHT_PURPLE}░${BRIGHT_PURPLE}▓${PURPLE}███${NAVY}█${RESET}`,
  `   ${NAVY}█${PURPLE}███${MID_PURPLE}▄${PURPLE}████${MID_PURPLE}▄${PURPLE}███${NAVY}█${RESET}`,
  `   ${NAVY}█${PURPLE}█${NAVY}◆${PURPLE}██${DARK_PURPLE}▀${PURPLE}██${NAVY}◆${PURPLE}████${NAVY}█${RESET}`,
  `   ${NAVY}█${PURPLE}███${DIM}${PURPLE}ᵥ${RESET}${PURPLE}██████${BRIGHT_PURPLE}█${NAVY}█${RESET}`,
  `    ${NAVY}█${PURPLE}██████████${NAVY}█${RESET}`,
  `     ${NAVY}▀${DARK_PURPLE}▀${PURPLE}████████${DARK_PURPLE}▀${NAVY}▀${RESET}`,
  `       ${DARK_PURPLE}██${RESET}    ${DARK_PURPLE}██${RESET}`,
  `      ${NAVY}▀▀▀${RESET}  ${NAVY}▀▀▀${RESET}`,
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
