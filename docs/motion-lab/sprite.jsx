// Phren sprite renderer — renders the pixel grid as SVG, with rich pose system.
// Assumes window.PHREN_PIXELS loaded.

const PURPLE_DARK = "rgb(36,25,138)";
const PURPLE_MID = "rgb(117,92,249)";
const PURPLE_LIGHT = "rgb(156,143,248)";
const PURPLE_FOOT = "rgb(158,161,248)";
const EYE_NAVY = "rgb(18,22,101)";
const CYAN = "rgb(40,211,242)";
const WHITE = "rgb(255,255,255)";
const RED = "rgb(245,165,165)";
const PINK = "rgb(245,165,165)";
const ORANGE = "rgb(217,119,87)";
const YELLOW = "rgb(245,220,90)";
const BLACK = "rgb(18,18,42)";

function PhrenSprite({
  size = 192,
  pose = "idle",
  blinking = false,
  bob = 0,
  facing = "left",
  sparkle = true,
  flash = false,

  // Arms
  armUp = false,
  armOut = false,       // left arm forward at waist
  armsUp = false,       // both arms overhead V
  armsOverhead = false, // both arms straight up Y
  armsOut = false,      // both arms straight to sides
  armsDown = false,     // clear defaults / hanging
  handsOnHips = false,
  armForward = false,   // single left arm forward at waist (alias armOut)
  pointing = false,     // left arm out, extra pixel as finger
  armBack = false,      // left arm swept back (running)

  // Eyes
  lookUp = false,
  lookDown = false,
  lookLeft = false,
  lookRight = false,
  wide = false,
  squint = false,
  starEyes = false,
  heartEyes = false,
  xEyes = false,

  // Brows
  angry = false,
  worried = false,

  // Mouth
  mouth = null,  // "smile" | "open" | "o" | "yell" | "yawn" | "tongue" | "frown" | "grit"

  // Cheeks
  flush = false,

  // Body
  lean = 0,       // -1..+1 ints (leans left/right as pixel shift)
  squish = false, // compressed vertically
  stretch = false,// extended vertically
  sit = false,    // sitting pose

  // Overlays
  sweat = false,
  hearts = false,

  // Accessories
  headphones = false,
  shades = false,
  hat = null,     // "party" | "cap" | "hardhat" | null

  // Transforms
  tilt = 0,
}) {
  const pixels = window.PHREN_PIXELS;
  const grid = 24;

  let px = pixels.map(([c, r, color]) => ({ c, r, color }));

  // ── Legs / stance ───────────────────────────────────────────────────────
  if (pose === "run") {
    px = px.filter((p) => p.r !== 19);
    if (bob % 2 === 0) {
      px.push({ c: 9, r: 18, color: PURPLE_LIGHT });
      px.push({ c: 9, r: 19, color: PURPLE_FOOT });
      px.push({ c: 14, r: 19, color: PURPLE_LIGHT });
      px.push({ c: 14, r: 20, color: PURPLE_FOOT });
    } else {
      px.push({ c: 10, r: 19, color: PURPLE_LIGHT });
      px.push({ c: 10, r: 20, color: PURPLE_FOOT });
      px.push({ c: 13, r: 18, color: PURPLE_LIGHT });
      px.push({ c: 13, r: 19, color: PURPLE_FOOT });
    }
  } else if (pose === "walk") {
    px = px.filter((p) => p.r !== 19);
    if (bob % 2 === 0) {
      px.push({ c: 10, r: 19, color: PURPLE_FOOT });
      px.push({ c: 13, r: 19, color: PURPLE_FOOT });
    } else {
      px.push({ c: 9, r: 19, color: PURPLE_FOOT });
      px.push({ c: 14, r: 19, color: PURPLE_FOOT });
    }
  } else if (pose === "jump") {
    px = px.filter((p) => p.r !== 19);
    px.push({ c: 10, r: 18, color: PURPLE_LIGHT });
    px.push({ c: 13, r: 18, color: PURPLE_LIGHT });
  } else if (pose === "crouch") {
    px = px.filter((p) => p.r !== 19);
    px = px.map((p) => (p.r < 6 ? { ...p, r: p.r + 1 } : p));
    px.push({ c: 9, r: 19, color: PURPLE_FOOT });
    px.push({ c: 10, r: 19, color: PURPLE_FOOT });
    px.push({ c: 13, r: 19, color: PURPLE_FOOT });
    px.push({ c: 14, r: 19, color: PURPLE_FOOT });
  } else if (pose === "kick") {
    // right leg extended forward (down-right)
    px = px.filter((p) => !(p.r === 19 && p.c === 13));
    px.push({ c: 16, r: 17, color: PURPLE_LIGHT });
    px.push({ c: 17, r: 18, color: PURPLE_FOOT });
  } else if (pose === "split") {
    px = px.filter((p) => p.r !== 19);
    px.push({ c: 6, r: 19, color: PURPLE_FOOT });
    px.push({ c: 7, r: 19, color: PURPLE_FOOT });
    px.push({ c: 16, r: 19, color: PURPLE_FOOT });
    px.push({ c: 17, r: 19, color: PURPLE_FOOT });
  } else if (pose === "skate") {
    // feet apart, one forward one back, slight bend
    px = px.filter((p) => p.r !== 19);
    px.push({ c: 8, r: 19, color: PURPLE_FOOT });
    px.push({ c: 9, r: 19, color: PURPLE_FOOT });
    px.push({ c: 14, r: 19, color: PURPLE_FOOT });
    px.push({ c: 15, r: 19, color: PURPLE_FOOT });
  } else if (pose === "front") {
    // Front-facing brain head — symmetric about c=11.5, with brain folds
    // and speckled dark navy texture like the pixel-art original.
    px = [];

    // Silhouette fill map: which (c,r) cells are INSIDE the head
    const inHead = (c, r) => {
      // symmetric brain blob
      if (r === 5) return c === 9 || c === 10 || c === 13 || c === 14;
      if (r === 6) return c >= 8 && c <= 15 && c !== 11.5;
      if (r === 7) return c >= 7 && c <= 16;
      if (r >= 8 && r <= 13) return c >= 6 && c <= 17;
      if (r === 14) return c >= 7 && c <= 16;
      if (r === 15) return c >= 7 && c <= 16;
      if (r === 16) return c >= 8 && c <= 15;
      return false;
    };

    // Outline: cells that are in-head but have a neighbor outside
    const isOutline = (c, r) => {
      if (!inHead(c, r)) return false;
      return !inHead(c - 1, r) || !inHead(c + 1, r) || !inHead(c, r - 1) || !inHead(c, r + 1);
    };

    for (let r = 5; r <= 16; r++) {
      for (let c = 5; c <= 18; c++) {
        if (!inHead(c, r)) continue;
        if (isOutline(c, r)) {
          px.push({ c, r, color: PURPLE_DARK });
        } else {
          // Upper-left highlight
          const isHighlight = (r <= 8 && c <= 10) || (r === 9 && c <= 8);
          px.push({ c, r, color: isHighlight ? PURPLE_LIGHT : PURPLE_MID });
        }
      }
    }

    // Brain-fold speckles — symmetric dark navy dots
    const folds = [
      // central sulcus (down the middle)
      [11, 7], [12, 7],
      [11, 9], [12, 9],
      [11, 13], [12, 13],
      // mirrored hemisphere wrinkles
      [8, 8], [15, 8],
      [9, 10], [14, 10],
      [7, 11], [16, 11],
      [8, 13], [15, 13],
      [9, 14], [14, 14],
    ];
    folds.forEach(([c, r]) => {
      px = px.filter((p) => !(p.c === c && p.r === r));
      px.push({ c, r, color: EYE_NAVY });
    });

    // Eyes — symmetric, r=11 primary
    const eyeCells = [[8, 11], [9, 11], [14, 11], [15, 11], [8, 12], [9, 12], [14, 12], [15, 12]];
    eyeCells.forEach(([c, r]) => {
      px = px.filter((p) => !(p.c === c && p.r === r));
      px.push({ c, r, color: EYE_NAVY });
    });
  } else if (pose === "dj") {
    // Same as front, PLUS stub arms extending out to where hands rest on decks.
    // Reuse the front pose body first.
    px = [];
    const inHead = (c, r) => {
      if (r === 5) return c === 9 || c === 10 || c === 13 || c === 14;
      if (r === 6) return c >= 8 && c <= 15;
      if (r === 7) return c >= 7 && c <= 16;
      if (r >= 8 && r <= 13) return c >= 6 && c <= 17;
      if (r === 14) return c >= 7 && c <= 16;
      if (r === 15) return c >= 7 && c <= 16;
      if (r === 16) return c >= 8 && c <= 15;
      return false;
    };
    const isOutline = (c, r) => {
      if (!inHead(c, r)) return false;
      return !inHead(c - 1, r) || !inHead(c + 1, r) || !inHead(c, r - 1) || !inHead(c, r + 1);
    };
    for (let r = 5; r <= 16; r++) {
      for (let c = 5; c <= 18; c++) {
        if (!inHead(c, r)) continue;
        if (isOutline(c, r)) {
          px.push({ c, r, color: PURPLE_DARK });
        } else {
          const isHighlight = (r <= 8 && c <= 10) || (r === 9 && c <= 8);
          px.push({ c, r, color: isHighlight ? PURPLE_LIGHT : PURPLE_MID });
        }
      }
    }
    // Brain folds
    const djFolds = [
      [11, 7], [12, 7], [11, 9], [12, 9], [11, 13], [12, 13],
      [8, 8], [15, 8], [9, 10], [14, 10], [7, 11], [16, 11],
      [8, 13], [15, 13], [9, 14], [14, 14],
    ];
    djFolds.forEach(([c, r]) => {
      px = px.filter((p) => !(p.c === c && p.r === r));
      px.push({ c, r, color: EYE_NAVY });
    });
    // Eyes
    const djEyes = [[8, 11], [9, 11], [14, 11], [15, 11], [8, 12], [9, 12], [14, 12], [15, 12]];
    djEyes.forEach(([c, r]) => {
      px = px.filter((p) => !(p.c === c && p.r === r));
      px.push({ c, r, color: EYE_NAVY });
    });

    // ── ARMS stretching out to the sides and DOWN onto the decks ──
    // Left arm: from shoulder (c=6, r=14) diagonally down-left then straight down
    // to hand cluster at c=0-1, r=20-22.
    const leftArm = [
      // shoulder/upper arm going down-left
      [5, 14], [4, 15], [3, 16],
      [2, 17], [1, 18],
      // forearm going straight down
      [1, 19], [1, 20], [2, 20],
      // hand (wider block with knuckles)
      [0, 20], [0, 21], [1, 21], [2, 21], [3, 21],
      [0, 22], [1, 22], [2, 22], [3, 22],
    ];
    const rightArm = [
      [18, 14], [19, 15], [20, 16],
      [21, 17], [22, 18],
      [22, 19], [22, 20], [21, 20],
      [23, 20], [23, 21], [22, 21], [21, 21], [20, 21],
      [23, 22], [22, 22], [21, 22], [20, 22],
    ];
    leftArm.concat(rightArm).forEach(([c, r]) => {
      px.push({ c, r, color: PURPLE_MID });
    });
    // Outline the arms — dark cells where arm meets empty space
    const isArmCell = (c, r) => leftArm.concat(rightArm).some(([cc, rr]) => cc === c && rr === r);
    for (const [c, r] of leftArm.concat(rightArm)) {
      const isArmOutline = !isArmCell(c - 1, r) || !isArmCell(c + 1, r) || !isArmCell(c, r - 1) || !isArmCell(c, r + 1);
      if (isArmOutline) {
        px = px.filter((p) => !(p.c === c && p.r === r && p.color === PURPLE_MID));
        px.push({ c, r, color: PURPLE_DARK });
      }
    }
    // Re-fill interior cells of arms with mid-purple
    for (const [c, r] of leftArm.concat(rightArm)) {
      const isInner = isArmCell(c - 1, r) && isArmCell(c + 1, r) && isArmCell(c, r - 1) && isArmCell(c, r + 1);
      if (isInner) {
        px = px.filter((p) => !(p.c === c && p.r === r));
        px.push({ c, r, color: PURPLE_MID });
      }
    }
    // Hand knuckle highlights — lighter cells inside hand
    [[1, 21], [2, 21], [21, 21], [22, 21]].forEach(([c, r]) => {
      px = px.filter((p) => !(p.c === c && p.r === r));
      px.push({ c, r, color: PURPLE_LIGHT });
    });
  }

  if (sit) {
    // remove lower body, draw folded legs in front
    px = px.filter((p) => p.r < 17);
    for (let c = 8; c <= 15; c++) {
      px.push({ c, r: 17, color: PURPLE_MID });
      px.push({ c, r: 18, color: PURPLE_LIGHT });
    }
    px.push({ c: 7, r: 18, color: PURPLE_FOOT });
    px.push({ c: 16, r: 18, color: PURPLE_FOOT });
  }

  // Squish / stretch
  if (squish) {
    px = px.map((p) => ({ ...p, r: 4 + Math.round((p.r - 4) * 0.85) }));
  }
  // Stretch — pull upper body up and fill the gap between neck and face so it
  // reads as a single tall creature, not two halves
  if (stretch) {
    px = px.map((p) => (p.r < 12 ? { ...p, r: Math.max(2, p.r - 2) } : p));
    // Fill the gap at rows 10-11 across the body width
    for (let c = 6; c <= 13; c++) {
      px.push({ c, r: 10, color: PURPLE_MID });
      px.push({ c, r: 11, color: PURPLE_MID });
    }
    // edge shading
    px.push({ c: 5, r: 10, color: PURPLE_DARK });
    px.push({ c: 5, r: 11, color: PURPLE_DARK });
    px.push({ c: 14, r: 10, color: PURPLE_DARK });
    px.push({ c: 14, r: 11, color: PURPLE_DARK });
  }

  // Lean (pixel-shift tops)
  if (lean) {
    px = px.map((p) => (p.r < 10 ? { ...p, c: p.c + lean } : p));
  }

  // ── Eyes ────────────────────────────────────────────────────────────────
  const isFront = pose === "front" || pose === "dj";
  const isEye = isFront
    ? (p) => (p.r === 11 || p.r === 12) && (p.c === 8 || p.c === 9 || p.c === 14 || p.c === 15)
    : (p) => p.r === 12 && (p.c === 7 || p.c === 11);
  const shiftEye = (p, dr, dc) => ({ ...p, r: p.r + dr, c: p.c + dc });

  if (pose === "sleep" || blinking) {
    px = px.map((p) => (isEye(p) ? { ...p, color: PURPLE_MID } : p));
  } else if (xEyes) {
    px = px.filter((p) => !isEye(p));
    [7, 11].forEach((c) => {
      px.push({ c: c - 1, r: 11, color: EYE_NAVY });
      px.push({ c: c + 1, r: 13, color: EYE_NAVY });
      px.push({ c: c + 1, r: 11, color: EYE_NAVY });
      px.push({ c: c - 1, r: 13, color: EYE_NAVY });
      px.push({ c, r: 12, color: EYE_NAVY });
    });
  } else if (heartEyes) {
    px = px.filter((p) => !isEye(p));
    [7, 11].forEach((c) => {
      px.push({ c: c - 1, r: 11, color: RED });
      px.push({ c, r: 11, color: RED });
      px.push({ c: c + 1, r: 11, color: RED });
      px.push({ c, r: 12, color: RED });
      px.push({ c, r: 13, color: RED });
    });
  } else if (starEyes) {
    px = px.filter((p) => !isEye(p));
    [7, 11].forEach((c) => {
      px.push({ c, r: 11, color: YELLOW });
      px.push({ c: c - 1, r: 12, color: YELLOW });
      px.push({ c, r: 12, color: YELLOW });
      px.push({ c: c + 1, r: 12, color: YELLOW });
      px.push({ c, r: 13, color: YELLOW });
    });
  } else if (wide) {
    px = px.filter((p) => !isEye(p));
    px.push({ c: 6, r: 12, color: EYE_NAVY });
    px.push({ c: 6, r: 13, color: EYE_NAVY });
    px.push({ c: 12, r: 12, color: EYE_NAVY });
    px.push({ c: 12, r: 13, color: EYE_NAVY });
  } else if (squint) {
    // Replace with horizontal dashes
    px = px.filter((p) => !isEye(p));
    px.push({ c: 7, r: 12, color: EYE_NAVY });
    px.push({ c: 11, r: 12, color: EYE_NAVY });
  } else {
    let dr = 0, dc = 0;
    if (lookUp) dr -= 1;
    if (lookDown) dr += 1;
    if (lookLeft) dc -= 1;
    if (lookRight) dc += 1;
    if (dr !== 0 || dc !== 0) {
      px = px.map((p) => (isEye(p) ? shiftEye(p, dr, dc) : p));
    }
  }

  // ── Brows ───────────────────────────────────────────────────────────────
  // (angry / worried brows removed — looked bad at this scale.
  // Use mouth shape + eyes to convey mood instead.)

  // ── Mouth ───────────────────────────────────────────────────────────────
  if (mouth === "open" || mouth === "o") {
    px.push({ c: 9, r: 15, color: EYE_NAVY });
    px.push({ c: 10, r: 15, color: EYE_NAVY });
    px.push({ c: 9, r: 16, color: EYE_NAVY });
    px.push({ c: 10, r: 16, color: EYE_NAVY });
  } else if (mouth === "smile") {
    px.push({ c: 8, r: 15, color: EYE_NAVY });
    px.push({ c: 9, r: 16, color: EYE_NAVY });
    px.push({ c: 10, r: 16, color: EYE_NAVY });
    px.push({ c: 11, r: 15, color: EYE_NAVY });
  } else if (mouth === "frown") {
    // simple downward curve — 2 pixels dipping at center
    px.push({ c: 9, r: 16, color: EYE_NAVY });
    px.push({ c: 10, r: 16, color: EYE_NAVY });
  } else if (mouth === "yell") {
    // big wide open rectangle
    for (let c = 8; c <= 11; c++) {
      for (let r = 15; r <= 17; r++) {
        px.push({ c, r, color: EYE_NAVY });
      }
    }
    px.push({ c: 9, r: 16, color: RED });
    px.push({ c: 10, r: 16, color: RED });
  } else if (mouth === "yawn") {
    // tall oval open
    px.push({ c: 9, r: 15, color: EYE_NAVY });
    px.push({ c: 10, r: 15, color: EYE_NAVY });
    px.push({ c: 9, r: 16, color: EYE_NAVY });
    px.push({ c: 10, r: 16, color: EYE_NAVY });
    px.push({ c: 9, r: 17, color: EYE_NAVY });
    px.push({ c: 10, r: 17, color: EYE_NAVY });
  } else if (mouth === "tongue") {
    px.push({ c: 8, r: 15, color: EYE_NAVY });
    px.push({ c: 9, r: 16, color: EYE_NAVY });
    px.push({ c: 10, r: 16, color: PINK });
    px.push({ c: 11, r: 15, color: EYE_NAVY });
    px.push({ c: 10, r: 17, color: PINK });
  } else if (mouth === "grit") {
    for (let c = 8; c <= 11; c++) {
      px.push({ c, r: 15, color: EYE_NAVY });
      px.push({ c, r: 16, color: WHITE });
    }
  }

  // ── Cheeks ──────────────────────────────────────────────────────────────
  if (flush) {
    px.push({ c: 5, r: 14, color: PINK });
    px.push({ c: 14, r: 14, color: PINK });
  }

  // ── Arms ────────────────────────────────────────────────────────────────
  if (armUp) {
    px.push({ c: 5, r: 10, color: PURPLE_MID });
    px.push({ c: 5, r: 11, color: PURPLE_LIGHT });
    px.push({ c: 4, r: 10, color: PURPLE_LIGHT });
  }
  if (armOut || armForward) {
    px.push({ c: 5, r: 14, color: PURPLE_MID });
    px.push({ c: 4, r: 14, color: PURPLE_LIGHT });
    px.push({ c: 3, r: 14, color: PURPLE_LIGHT });
  }
  if (pointing) {
    px.push({ c: 5, r: 14, color: PURPLE_MID });
    px.push({ c: 4, r: 14, color: PURPLE_LIGHT });
    px.push({ c: 3, r: 14, color: PURPLE_LIGHT });
    px.push({ c: 2, r: 14, color: PURPLE_FOOT });
  }
  if (armBack) {
    // left arm swept back
    px.push({ c: 6, r: 14, color: PURPLE_MID });
    px.push({ c: 7, r: 15, color: PURPLE_LIGHT });
  }
  if (armsUp) {
    px.push({ c: 5, r: 10, color: PURPLE_MID });
    px.push({ c: 4, r: 9, color: PURPLE_LIGHT });
    px.push({ c: 4, r: 8, color: PURPLE_LIGHT });
    px.push({ c: 15, r: 10, color: PURPLE_MID });
    px.push({ c: 16, r: 9, color: PURPLE_LIGHT });
    px.push({ c: 16, r: 8, color: PURPLE_LIGHT });
  }
  if (armsOverhead) {
    // both arms straight up
    px.push({ c: 6, r: 10, color: PURPLE_MID });
    px.push({ c: 6, r: 9, color: PURPLE_LIGHT });
    px.push({ c: 6, r: 8, color: PURPLE_LIGHT });
    px.push({ c: 6, r: 7, color: PURPLE_LIGHT });
    px.push({ c: 14, r: 10, color: PURPLE_MID });
    px.push({ c: 14, r: 9, color: PURPLE_LIGHT });
    px.push({ c: 14, r: 8, color: PURPLE_LIGHT });
    px.push({ c: 14, r: 7, color: PURPLE_LIGHT });
  }
  if (armsOut) {
    px.push({ c: 5, r: 13, color: PURPLE_MID });
    px.push({ c: 4, r: 13, color: PURPLE_LIGHT });
    px.push({ c: 3, r: 13, color: PURPLE_LIGHT });
    px.push({ c: 15, r: 13, color: PURPLE_MID });
    px.push({ c: 16, r: 13, color: PURPLE_LIGHT });
    px.push({ c: 17, r: 13, color: PURPLE_LIGHT });
  }
  if (armsDown) {
    px.push({ c: 6, r: 15, color: PURPLE_MID });
    px.push({ c: 14, r: 15, color: PURPLE_MID });
  }
  if (handsOnHips) {
    // angled arms forming a triangle on sides
    px.push({ c: 5, r: 14, color: PURPLE_MID });
    px.push({ c: 5, r: 13, color: PURPLE_LIGHT });
    px.push({ c: 15, r: 14, color: PURPLE_MID });
    px.push({ c: 15, r: 13, color: PURPLE_LIGHT });
  }

  // ── Overlays ────────────────────────────────────────────────────────────
  if (sweat) {
    px.push({ c: 17, r: 8, color: CYAN });
    px.push({ c: 18, r: 9, color: CYAN });
  }

  // ── Accessories ─────────────────────────────────────────────────────────
  if (headphones) {
    if (pose === "front" || pose === "dj") {
      // Symmetric headphones for front-facing head (head is cols 7-16, centered)
      for (let c = 8; c <= 15; c++) px.push({ c, r: 5, color: BLACK });
      for (let r = 6; r <= 9; r++) {
        px.push({ c: 6, r, color: BLACK });
        px.push({ c: 17, r, color: BLACK });
      }
      px.push({ c: 7, r: 7, color: CYAN });
      px.push({ c: 16, r: 7, color: CYAN });
    } else {
      // band across top + cups on sides
      for (let c = 6; c <= 13; c++) px.push({ c, r: 5, color: BLACK });
      for (let r = 6; r <= 9; r++) {
        px.push({ c: 4, r, color: BLACK });
        px.push({ c: 15, r, color: BLACK });
      }
      px.push({ c: 5, r: 7, color: CYAN });
      px.push({ c: 14, r: 7, color: CYAN });
    }
  }
  if (shades) {
    for (let c = 5; c <= 13; c++) px.push({ c, r: 11, color: BLACK });
    for (let c = 5; c <= 8; c++) px.push({ c, r: 12, color: BLACK });
    for (let c = 10; c <= 13; c++) px.push({ c, r: 12, color: BLACK });
    // small highlight
    px.push({ c: 6, r: 11, color: WHITE });
    px.push({ c: 11, r: 11, color: WHITE });
  }
  if (hat === "party") {
    // cone hat sitting ON head (base at row 5, tip at row 2, pom on top)
    // base (widest)
    for (let c = 8; c <= 11; c++) px.push({ c, r: 5, color: PINK });
    // mid band
    px.push({ c: 9, r: 4, color: CYAN });
    px.push({ c: 10, r: 4, color: PINK });
    // upper band
    px.push({ c: 9, r: 3, color: PINK });
    px.push({ c: 10, r: 3, color: CYAN });
    // tip
    px.push({ c: 9, r: 2, color: PINK });
    // pom-pom
    px.push({ c: 9, r: 1, color: YELLOW });
    px.push({ c: 10, r: 1, color: YELLOW });
  } else if (hat === "cap") {
    // baseball cap: crown on head + brim sticking forward
    for (let c = 7; c <= 12; c++) px.push({ c, r: 5, color: ORANGE });
    for (let c = 8; c <= 11; c++) px.push({ c, r: 4, color: ORANGE });
    // brim
    for (let c = 2; c <= 7; c++) px.push({ c, r: 6, color: ORANGE });
  }

  // ── Flash ───────────────────────────────────────────────────────────────
  if (flash) {
    px = px.map((p) => ({ ...p, color: lighten(p.color, 0.3) }));
  }

  const facingTransform =
    facing === "right" ? `scale(-1,1) translate(${-grid},0)` : "";
  const tiltTransform = tilt ? `rotate(${tilt} ${grid / 2} ${grid / 2})` : "";
  const transform = [tiltTransform, facingTransform].filter(Boolean).join(" ") || undefined;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${grid} ${grid}`}
      shapeRendering="crispEdges"
      style={{ imageRendering: "pixelated", overflow: "visible" }}
    >
      <g transform={transform}>
        {px.map((p, i) => (
          <rect key={i} x={p.c} y={p.r} width={1.02} height={1.02} fill={p.color} />
        ))}
        {sparkle && <Sparkle />}
        {hearts && <Hearts />}
      </g>
    </svg>
  );
}

function Sparkle({ x = 16, y = 5 }) {
  return (
    <g>
      <rect x={x} y={y} width={1} height={1} fill={CYAN}>
        <animate attributeName="opacity" values="1;0.3;1;0.8;1" dur="2s" repeatCount="indefinite" />
      </rect>
      <rect x={x + 2} y={y} width={1} height={1} fill={CYAN}>
        <animate attributeName="opacity" values="0.4;1;0.5;1;0.4" dur="2.3s" repeatCount="indefinite" />
      </rect>
    </g>
  );
}

function Hearts() {
  return (
    <g>
      <rect x={3} y={6} width={1} height={1} fill={RED}><animate attributeName="opacity" values="1;0.2;1" dur="1.6s" repeatCount="indefinite" /></rect>
      <rect x={4} y={6} width={1} height={1} fill={RED}><animate attributeName="opacity" values="0.4;1;0.4" dur="1.6s" repeatCount="indefinite" /></rect>
      <rect x={3} y={5} width={1} height={1} fill={RED}><animate attributeName="opacity" values="1;0.1;1" dur="1.6s" repeatCount="indefinite" /></rect>
      <rect x={4} y={5} width={1} height={1} fill={RED}><animate attributeName="opacity" values="0.3;1;0.3" dur="1.6s" repeatCount="indefinite" /></rect>
    </g>
  );
}

function lighten(rgbStr, amt) {
  const m = rgbStr.match(/rgb\((\d+),(\d+),(\d+)\)/);
  if (!m) return rgbStr;
  const [r, g, b] = [+m[1], +m[2], +m[3]];
  const mix = (c) => Math.min(255, Math.round(c + (255 - c) * amt));
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

Object.assign(window, { PhrenSprite, Sparkle });
