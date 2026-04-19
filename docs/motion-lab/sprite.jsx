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
  const isEye = (p) => p.r === 12 && (p.c === 7 || p.c === 11);
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
    // band across top + cups on sides
    for (let c = 6; c <= 13; c++) px.push({ c, r: 5, color: BLACK });
    for (let r = 6; r <= 9; r++) {
      px.push({ c: 4, r, color: BLACK });
      px.push({ c: 15, r, color: BLACK });
    }
    px.push({ c: 5, r: 7, color: CYAN });
    px.push({ c: 14, r: 7, color: CYAN });
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
