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
 * Phren truecolor art (24px wide, generated from phren-transparent.png).
 * Uses half-block ▀ with RGB foreground+background for pixel-faithful rendering.
 * Requires truecolor terminal (most modern terminals support it).
 */
export const PHREN_ART = [
  "                        ",
  "                        ",
  "                \x1b[38;2;40;211;242m▄\x1b[0m \x1b[38;2;27;210;241m▄\x1b[0m     ",
  "        \x1b[38;2;38;39;142m▄\x1b[0m\x1b[38;2;153;140;248m▄\x1b[0m\x1b[38;2;40;41;142m\x1b[48;2;152;146;247m▀\x1b[0m\x1b[38;2;41;43;144m\x1b[48;2;93;67;243m▀\x1b[0m\x1b[38;2;157;147;250m▄\x1b[0m\x1b[38;2;43;44;147m\x1b[48;2;156;146;249m▀\x1b[0m\x1b[38;2;41;43;144m\x1b[48;2;145;147;247m▀\x1b[0m\x1b[38;2;155;146;248m▄\x1b[0m\x1b[38;2;41;40;141m▄\x1b[0m       ",
  "       \x1b[38;2;39;39;132m▄\x1b[0m\x1b[38;2;150;132;250m\x1b[48;2;151;133;250m▀\x1b[0m\x1b[38;2;154;143;250m\x1b[48;2;148;129;251m▀\x1b[0m\x1b[38;2;104;75;249m\x1b[48;2;156;145;248m▀\x1b[0m\x1b[38;2;156;142;251m\x1b[48;2;92;68;236m▀\x1b[0m\x1b[38;2;156;149;248m\x1b[48;2;85;70;220m▀\x1b[0m\x1b[38;2;157;150;248m\x1b[48;2;157;151;248m▀\x1b[0m\x1b[38;2;151;130;250m\x1b[48;2;86;61;235m▀\x1b[0m\x1b[38;2;149;145;247m\x1b[48;2;105;83;245m▀\x1b[0m\x1b[38;2;155;143;248m\x1b[48;2;191;189;251m▀\x1b[0m\x1b[38;2;41;41;146m\x1b[48;2;153;135;250m▀\x1b[0m\x1b[38;2;71;68;183m▄\x1b[0m     ",
  "      \x1b[38;2;12;31;109m\x1b[48;2;148;132;250m▀\x1b[0m\x1b[38;2;82;67;225m\x1b[48;2;144;126;251m▀\x1b[0m\x1b[38;2;143;122;252m\x1b[48;2;156;143;251m▀\x1b[0m\x1b[38;2;94;67;244m\x1b[48;2;149;132;251m▀\x1b[0m\x1b[38;2;152;144;249m\x1b[48;2;150;132;251m▀\x1b[0m\x1b[38;2;154;143;248m\x1b[48;2;151;133;250m▀\x1b[0m\x1b[38;2;157;153;248m\x1b[48;2;152;134;250m▀\x1b[0m\x1b[38;2;84;61;230m\x1b[48;2;152;139;247m▀\x1b[0m\x1b[38;2;152;139;250m\x1b[48;2;106;93;246m▀\x1b[0m\x1b[38;2;95;71;239m\x1b[48;2;155;141;250m▀\x1b[0m\x1b[38;2;92;68;237m\x1b[48;2;158;141;248m▀\x1b[0m\x1b[38;2;151;139;250m\x1b[48;2;116;101;251m▀\x1b[0m\x1b[38;2;67;61;181m\x1b[48;2;36;41;131m▀\x1b[0m     ",
  "      \x1b[38;2;141;122;250m\x1b[48;2;146;128;248m▀\x1b[0m\x1b[38;2;21;32;101m\x1b[48;2;154;132;250m▀\x1b[0m\x1b[38;2;146;126;251m\x1b[48;2;145;123;251m▀\x1b[0m\x1b[38;2;146;128;250m\x1b[48;2;145;125;250m▀\x1b[0m\x1b[38;2;158;149;250m\x1b[48;2;146;123;248m▀\x1b[0m\x1b[38;2;22;31;104m\x1b[48;2;152;132;248m▀\x1b[0m\x1b[38;2;152;137;250m\x1b[48;2;151;133;251m▀\x1b[0m\x1b[38;2;150;142;249m\x1b[48;2;135;121;250m▀\x1b[0m\x1b[38;2;152;138;250m\x1b[48;2;119;99;247m▀\x1b[0m\x1b[38;2;154;140;251m\x1b[48;2;108;93;249m▀\x1b[0m\x1b[38;2;116;104;252m\x1b[48;2;117;100;251m▀\x1b[0m\x1b[38;2;127;111;251m\x1b[48;2;125;110;250m▀\x1b[0m\x1b[38;2;92;85;242m\x1b[48;2;93;81;242m▀\x1b[0m     ",
  "      \x1b[38;2;10;28;98m▀\x1b[0m\x1b[38;2;147;128;251m\x1b[48;2;77;59;222m▀\x1b[0m\x1b[38;2;145;125;250m\x1b[48;2;100;82;243m▀\x1b[0m\x1b[38;2;48;39;174m\x1b[48;2;136;120;250m▀\x1b[0m\x1b[38;2;146;126;251m\x1b[48;2;102;86;245m▀\x1b[0m\x1b[38;2;146;128;250m\x1b[48;2;103;86;245m▀\x1b[0m\x1b[38;2;111;94;250m\x1b[48;2;116;102;249m▀\x1b[0m\x1b[38;2;122;109;250m\x1b[48;2;114;103;247m▀\x1b[0m\x1b[38;2;120;107;251m\x1b[48;2;86;74;229m▀\x1b[0m\x1b[38;2;121;100;250m\x1b[48;2;106;93;244m▀\x1b[0m\x1b[38;2;92;66;240m\x1b[48;2;36;25;138m▀\x1b[0m\x1b[38;2;117;92;249m\x1b[48;2;83;73;231m▀\x1b[0m\x1b[38;2;7;37;110m▀\x1b[0m     ",
  "        \x1b[38;2;18;22;101m▀\x1b[0m\x1b[38;2;19;24;101m▀\x1b[0m\x1b[38;2;66;51;207m\x1b[48;2;69;51;218m▀\x1b[0m\x1b[38;2;95;83;244m\x1b[48;2;26;24;106m▀\x1b[0m\x1b[38;2;72;59;210m▀\x1b[0m\x1b[38;2;115;96;250m\x1b[48;2;58;46;198m▀\x1b[0m\x1b[38;2;117;104;249m\x1b[48;2;20;31;99m▀\x1b[0m\x1b[38;2;119;104;249m\x1b[48;2;26;29;111m▀\x1b[0m\x1b[38;2;23;21;110m▀\x1b[0m       ",
  "         \x1b[38;2;24;29;112m\x1b[48;2;156;157;248m▀\x1b[0m\x1b[38;2;105;91;248m\x1b[48;2;155;157;248m▀\x1b[0m\x1b[38;2;9;30;102m\x1b[48;2;157;158;248m▀\x1b[0m\x1b[38;2;12;31;104m\x1b[48;2;158;161;248m▀\x1b[0m\x1b[38;2;112;102;250m\x1b[48;2;158;160;248m▀\x1b[0m\x1b[38;2;15;41;120m\x1b[48;2;158;162;248m▀\x1b[0m\x1b[38;2;160;169;250m\x1b[48;2;158;163;247m▀\x1b[0m        ",
  "                        ",
  "                        ",
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
