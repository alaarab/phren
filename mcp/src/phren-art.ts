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
export const PHREN_ART: string[] = [
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

// ── Sparkle row: the cyan pixels at row 2 ────────────────────────────────────

const SPARKLE_ROW = 2;
const SPARKLE_CHARS = ["\u2726", "\u2727", "\u2736", " "] as const;

// ── Eye detection: dark navy pixels in row 6 ─────────────────────────────────

const EYE_ROW = 6;
const EYE_R_MAX = 30;
const EYE_G_MAX = 45;
const EYE_B_MAX = 120;
const BLINK_COLOR = "146;130;250";

// ── Line flipping for facing-right ───────────────────────────────────────────

interface PixelSegment {
  codes: string;
  char: string;
}

function flipLine(line: string): string {
  const stripped = line.replace(/\x1b\[[^m]*m/g, "");
  const leadSpaces = stripped.match(/^( *)/)![1].length;
  const trailSpaces = stripped.match(/( *)$/)![1].length;

  const pixels: PixelSegment[] = [];
  const pixelRegex = /((?:\x1b\[[^m]*m)+)([\u2580\u2584])/g;
  let match;
  while ((match = pixelRegex.exec(line)) !== null) {
    const codes = match[1].replace(/\x1b\[0m/g, "");
    if (codes) pixels.push({ codes, char: match[2] });
  }

  if (pixels.length === 0) return line;

  const reversed = [...pixels].reverse();
  const newLead = " ".repeat(trailSpaces);
  const newTrail = " ".repeat(leadSpaces);

  let result = newLead;
  for (const px of reversed) {
    result += px.codes + px.char + "\x1b[0m";
  }
  result += newTrail;

  return result;
}

function generateFlippedArt(art: string[]): string[] {
  return art.map(flipLine);
}

export const PHREN_ART_RIGHT: string[] = generateFlippedArt(PHREN_ART);

// ── Animation engine ─────────────────────────────────────────────────────────

export interface PhrenAnimator {
  getFrame(): string[];
  start(): void;
  stop(): void;
}

interface AnimatorState {
  bobUp: boolean;
  isBlinking: boolean;
  sparkleFrame: number;
  sparkleActive: boolean;
  leanOffset: number;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function applyBlinkToLine(line: string): string {
  return line.replace(
    /\x1b\[38;2;(\d+);(\d+);(\d+)m/g,
    (full, rStr, gStr, bStr) => {
      const r = Number(rStr);
      const g = Number(gStr);
      const b = Number(bStr);
      if (r < EYE_R_MAX && g < EYE_G_MAX && b < EYE_B_MAX) {
        return `\x1b[38;2;${BLINK_COLOR}m`;
      }
      return full;
    },
  );
}

function applySparkleToLine(line: string, frame: number, active: boolean): string {
  if (!active) return line;
  const sparkleChar = SPARKLE_CHARS[frame % SPARKLE_CHARS.length];
  if (sparkleChar === " ") {
    return line.replace(
      /\x1b\[38;2;\d+;2\d\d;2\d\dm[\u2580\u2584]\x1b\[0m/g,
      " ",
    );
  }
  return line.replace(
    /(\x1b\[38;2;\d+;2\d\d;2\d\dm)[\u2580\u2584](\x1b\[0m)/g,
    `$1${sparkleChar}$2`,
  );
}

function applyLean(line: string, offset: number): string {
  if (offset === 0) return line;
  if (offset > 0) {
    return " ".repeat(offset) + line;
  }
  const trimCount = Math.min(-offset, line.match(/^( *)/)![1].length);
  return line.slice(trimCount);
}

export function createPhrenAnimator(options?: {
  facing?: "left" | "right";
  size?: number;
}): PhrenAnimator {
  const facing = options?.facing ?? "left";
  const baseArt = facing === "right" ? PHREN_ART_RIGHT : PHREN_ART;

  const state: AnimatorState = {
    bobUp: false,
    isBlinking: false,
    sparkleFrame: 0,
    sparkleActive: false,
    leanOffset: 0,
  };

  const timers: ReturnType<typeof setTimeout>[] = [];

  function scheduleTimer(fn: () => void, ms: number): void {
    const t = setTimeout(fn, ms);
    timers.push(t);
  }

  function scheduleBob(): void {
    scheduleTimer(() => {
      state.bobUp = !state.bobUp;
      scheduleBob();
    }, 500);
  }

  function scheduleBlink(): void {
    const interval = randInt(2000, 8000);
    scheduleTimer(() => {
      state.isBlinking = true;
      scheduleTimer(() => {
        state.isBlinking = false;
        if (Math.random() < 0.3) {
          scheduleTimer(() => {
            state.isBlinking = true;
            scheduleTimer(() => {
              state.isBlinking = false;
              scheduleBlink();
            }, 150);
          }, 200);
        } else {
          scheduleBlink();
        }
      }, 150);
    }, interval);
  }

  function scheduleSparkle(): void {
    const pause = randInt(1000, 5000);
    scheduleTimer(() => {
      state.sparkleActive = true;
      state.sparkleFrame = 0;
      sparkleStep(0);
    }, pause);
  }

  function sparkleStep(step: number): void {
    if (step >= SPARKLE_CHARS.length) {
      state.sparkleActive = false;
      scheduleSparkle();
      return;
    }
    state.sparkleFrame = step;
    scheduleTimer(() => {
      sparkleStep(step + 1);
    }, 200);
  }

  function scheduleLean(): void {
    const interval = randInt(4000, 10000);
    scheduleTimer(() => {
      const direction = Math.random() < 0.5 ? -1 : 1;
      state.leanOffset = direction;
      const holdTime = randInt(1000, 2000);
      scheduleTimer(() => {
        state.leanOffset = 0;
        scheduleLean();
      }, holdTime);
    }, interval);
  }

  return {
    getFrame(): string[] {
      let lines = baseArt.map((line, i) => {
        let result = line;
        if (state.isBlinking && i === EYE_ROW) {
          result = applyBlinkToLine(result);
        }
        if (i === SPARKLE_ROW) {
          result = applySparkleToLine(result, state.sparkleFrame, state.sparkleActive);
        }
        result = applyLean(result, state.leanOffset);
        return result;
      });
      if (state.bobUp) {
        lines = ["", ...lines.slice(0, -1)];
      }
      return lines;
    },

    start(): void {
      scheduleBob();
      scheduleBlink();
      scheduleSparkle();
      scheduleLean();
    },

    stop(): void {
      for (const t of timers) {
        clearTimeout(t);
      }
      timers.length = 0;
    },
  };
}

/**
 * Return the phren art as a single string, optionally indented.
 */
export function renderPhrenArt(indent = ""): string {
  return PHREN_ART.map(line => indent + line).join("\n");
}
