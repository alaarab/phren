// Phren Story Loop — side-scrolling adventure for LinkedIn ad GIF.
// Camera follows phren as he traverses zones.
// 800×450 stage, ~22s loop.

const { useState: usS, useEffect: usE, useRef: usR } = React;

const ZONE_W = 600;
const STAGE_W = 800;
const STAGE_H = 450;
const GROUND_Y = 360;          // y-coord where phren's feet touch

// ── Story beats ──────────────────────────────────────────────────────────
//  0  parachute down                  0.0 -  3.0   (3.0s)
//  1  run to cabinet                  3.0 -  4.5   (1.5s)
//  2  open cabinet, recall findings   4.5 -  6.8   (2.3s)
//  3  run to claude                   6.8 -  8.8   (2.0s)
//  4  chat with claude                8.8 - 11.0   (2.2s)
//  5  skateboard + kickflip + toss    11.0 - 14.5  (3.5s)
//  6  run                             14.5 - 16.0  (1.5s)
//  7  juggle (front-facing)           16.0 - 18.5  (2.5s)
//  8  run final                       18.5 - 19.5  (1.0s)
//  9  task complete jump              19.5 - 22.0  (2.5s)
const BEATS = [
  { t: 0.0,  end: 3.0,  name: "parachuting in",     zone: 0 },
  { t: 3.0,  end: 4.5,  name: "running",            zone: 1 },
  { t: 4.5,  end: 6.8,  name: "recall findings",    zone: 2 },
  { t: 6.8,  end: 8.8,  name: "running",            zone: 3 },
  { t: 8.8,  end: 11.0, name: "chat with claude",   zone: 4 },
  { t: 11.0, end: 14.5, name: "skating to teammate", zone: 5 },
  { t: 14.5, end: 17.0, name: "run + juggle",       zone: 7 },
  { t: 17.0, end: 18.0, name: "sprint",             zone: 8 },
  { t: 18.0, end: 21.5, name: "task complete!",     zone: 9 },
  { t: 21.5, end: 26.0, name: "phren",             zone: 10 },
];
const TOTAL = 26.0;

// World x-coords for fixed objects
const X_LAND       = 200;                 // where phren lands from parachute
const X_CABINET    = ZONE_W * 1 + 50;     // cabinet body
const X_CABINET_STAND = X_CABINET - 70;   // where phren stands at cabinet
const X_CLAUDE     = ZONE_W * 2 + 250;
const X_CLAUDE_STAND = X_CLAUDE - 80;
const X_TEAMMATE   = ZONE_W * 4 + 100;
const X_TEAMMATE_STAND = X_TEAMMATE - 90; // phren stops here on board to toss note
const X_JUGGLE     = ZONE_W * 5 + 200;
const X_TASK       = ZONE_W * 6 + 200;

// Phren's x position over time (world coords)
function phrenX(t) {
  const points = [
    [0.0,  X_LAND - 220],          // entering from upper-left (will descend down-right)
    [3.0,  X_LAND],                // landed
    [4.5,  X_CABINET_STAND],       // ran to cabinet
    [6.8,  X_CABINET_STAND],       // standing at cabinet
    [8.8,  X_CLAUDE_STAND],        // ran to claude
    [11.0, X_CLAUDE_STAND],        // chatting
    [13.5, X_TEAMMATE_STAND],      // skated up to teammate (slow down)
    [14.5, X_TEAMMATE_STAND + 80], // rolled past teammate after toss
    [17.0, X_JUGGLE],              // run+juggle through (faster pace)
    [18.0, X_TASK],                // sprint to task spot
    [21.5, X_TASK],                // celebrating
    [26.0, X_TASK],                // logo reveal hold
  ];
  for (let i = 0; i < points.length - 1; i++) {
    const [t0, x0] = points[i];
    const [t1, x1] = points[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return x0 + (x1 - x0) * f;
    }
  }
  return points[points.length - 1][1];
}

function currentBeat(t) {
  for (const b of BEATS) if (t >= b.t && t < b.end) return b;
  return BEATS[BEATS.length - 1];
}

// Camera centers phren in the left-third of the stage.
// At the end of the loop, dolly forward fast past phren for the logo reveal.
function cameraX(t) {
  const px = phrenX(t);
  const baseTarget = px - 280;
  // Dolly forward 21.5 → 22.4 (0.9s rocket pan past phren)
  if (t >= 21.5) {
    const f = Math.min(1, (t - 21.5) / 0.9);
    // ease-in-cubic — slow start, screams forward
    const eased = f * f * f;
    const dollyDistance = 1400;
    return Math.max(0, baseTarget + eased * dollyDistance);
  }
  return Math.max(0, baseTarget);
}

// ── Time hook ────────────────────────────────────────────────────────────
function useTime() {
  const [t, setT] = usS(0);
  const startRef = usR(performance.now());
  usE(() => {
    let raf, iv;
    const tick = (now) => {
      const offset = (window.__seekOffset || 0);
      const live = ((now - startRef.current) / 1000) * 1.3;
      // If a seek is active (debug/screenshot tool), pin time to offset; otherwise live.
      const elapsed = (offset > 0 ? offset : live) % TOTAL;
      setT(elapsed);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Fallback for hidden iframes (screenshot capture) where RAF is throttled
    iv = setInterval(() => tick(performance.now()), 50);
    return () => { cancelAnimationFrame(raf); clearInterval(iv); };
  }, []);
  return t;
}

// ── World background ─────────────────────────────────────────────────────
function World({ t, camX }) {
  return (
    <>
      <div style={{
        position: "absolute", inset: 0,
        background: "linear-gradient(180deg, #1a1838 0%, #2a1f48 50%, #0e0e22 100%)",
      }} />

      {Array.from({ length: 30 }).map((_, i) => {
        const x = ((i * 137) % 800);
        const y = ((i * 73) % 200);
        const tw = (Math.sin(t * 2 + i) + 1) / 2;
        return (
          <div key={"s" + i} style={{
            position: "absolute", left: x, top: y,
            width: 2, height: 2, background: "#fff",
            opacity: 0.2 + tw * 0.6,
            borderRadius: "50%",
          }} />
        );
      })}

      <svg style={{ position: "absolute", left: -camX * 0.3, top: 240, width: 8000, height: 200 }} viewBox="0 0 8000 200" preserveAspectRatio="none">
        <polygon fill="#1f1a3a" points="0,200 200,80 400,140 600,60 800,120 1000,90 1200,150 1400,70 1600,130 1800,100 2000,80 2200,150 2400,90 2600,120 2800,70 3000,140 3200,80 3400,130 3600,90 3800,150 4000,80 4200,120 4400,90 4600,140 4800,80 5000,130 5200,90 5400,150 5600,80 5800,120 6000,90 6200,140 6400,80 6600,130 6800,90 7000,150 7200,80 7400,120 7600,90 7800,140 8000,90 8000,200" />
      </svg>

      <svg style={{ position: "absolute", left: -camX * 0.6, top: 280, width: 8000, height: 200 }} viewBox="0 0 8000 200" preserveAspectRatio="none">
        <polygon fill="#2a2456" points="0,200 100,140 250,170 400,120 550,150 700,110 850,160 1000,130 1150,170 1300,120 1450,150 1600,110 1750,170 1900,130 2050,150 2200,110 2350,160 2500,120 2650,170 2800,130 2950,150 3100,110 3250,170 3400,130 3550,150 3700,110 3850,170 4000,130 4150,150 4300,110 4450,170 4600,130 4750,150 4900,110 5050,170 5200,130 5350,150 5500,110 5650,170 5800,130 5950,150 6100,110 6250,170 6400,130 6550,150 6700,110 6850,170 7000,130 7150,150 7300,110 7450,170 7600,130 7750,150 7900,110 8000,150 8000,200" />
      </svg>

      <div style={{
        position: "absolute", left: 0, right: 0, bottom: 0,
        height: STAGE_H - GROUND_Y,
        background: "linear-gradient(180deg, #2a2244 0%, #14102a 100%)",
        borderTop: "2px solid #3a2f5e",
      }} />

      <svg style={{ position: "absolute", left: -camX, bottom: 0, width: 8000, height: 90 }} viewBox="0 0 8000 90">
        {Array.from({ length: 80 }).map((_, i) => (
          <line key={i} x1={i * 100} y1="0" x2={i * 100} y2="90" stroke="#3a2f5e" strokeWidth="1" opacity="0.3" />
        ))}
        {Array.from({ length: 4 }).map((_, i) => (
          <line key={"h" + i} x1="0" y1={i * 25} x2="8000" y2={i * 25} stroke="#3a2f5e" strokeWidth="1" opacity="0.2" />
        ))}
      </svg>
    </>
  );
}

// ── Cabinet ──────────────────────────────────────────────────────────────
function Cabinet({ t, beat }) {
  const active = beat && beat.zone === 2;
  // open during recall: 4.7..6.5
  const open = t >= 4.7 && t <= 6.5;
  const drawerOffset = open ? -28 : 0;

  return (
    <div style={{
      position: "absolute",
      left: X_CABINET,
      bottom: STAGE_H - GROUND_Y,
      width: 110, height: 140,
    }}>
      <div style={{
        position: "absolute", inset: 0,
        background: "#3a2f5e",
        border: "2px solid #1a1538",
        borderRadius: 3,
        boxShadow: "inset 0 0 12px rgba(0,0,0,0.4)",
      }} />
      {[0, 1, 2].map((i) => (
        <div key={i} style={{
          position: "absolute",
          left: 8, right: 8,
          top: 8 + i * 44,
          height: 38,
          background: "#4a3d6e",
          border: "1.5px solid #1a1538",
          borderRadius: 2,
          transform: i === 1 ? `translateX(${drawerOffset}px)` : "none",
          transition: "transform 0.25s",
        }}>
          <div style={{
            position: "absolute", left: "50%", top: "50%",
            transform: "translate(-50%, -50%)",
            width: 24, height: 4,
            background: "#28D3F2",
            borderRadius: 2,
          }} />
          <div style={{
            position: "absolute", left: 8, top: 4,
            fontFamily: "var(--mono)", fontSize: 6,
            color: "#28D3F2", letterSpacing: 1.5,
          }}>{["projects/", "findings/", "sessions/"][i]}</div>
        </div>
      ))}

      {/* cards flying out */}
      {open && Array.from({ length: 5 }).map((_, i) => {
        const cardT = (t - 4.9) - i * 0.22;
        if (cardT < 0 || cardT > 1.4) return null;
        const f = cardT / 1.4;
        const cx = -drawerOffset + 20 + f * 40;
        const cy = -52 - Math.sin(f * Math.PI) * 50 - f * 10;
        const rot = (i * 13 - 25) + f * 90;
        return (
          <div key={"card" + i} style={{
            position: "absolute",
            left: cx, top: cy,
            width: 22, height: 16,
            background: "#fffdf8",
            border: "1.5px solid #1a1538",
            borderRadius: 1,
            transform: `rotate(${rot}deg)`,
            opacity: 1 - Math.max(0, f - 0.7) / 0.3,
            boxShadow: "1px 1px 0 #1a1538",
          }}>
            <div style={{ position: "absolute", left: 2, top: 2, width: 16, height: 1, background: "#7C3AED" }} />
            <div style={{ position: "absolute", left: 2, top: 5, width: 12, height: 1, background: "#9aa1c2" }} />
            <div style={{ position: "absolute", left: 2, top: 8, width: 14, height: 1, background: "#9aa1c2" }} />
            <div style={{ position: "absolute", left: 2, top: 11, width: 10, height: 1, background: "#9aa1c2" }} />
          </div>
        );
      })}

      {active && (
        <div style={{
          position: "absolute", left: 50, top: -20,
          fontFamily: "var(--mono)", fontSize: 16, color: "#28D3F2",
          opacity: 0.6 + Math.sin(t * 8) * 0.4,
        }}>✦</div>
      )}
    </div>
  );
}

// ── Claude ───────────────────────────────────────────────────────────────
function Claude({ t, beat }) {
  const active = beat && beat.zone === 4;
  const bubbleT = t - 9.0;
  const showBubble = active && bubbleT > 0;
  // Phren delivers context first, claude thanks him
  const stage = bubbleT < 1.2 ? 0 : 1;
  const bubbleText = ["", "thanks phren ✨"][stage];
  const showClaudeBubble = showBubble && bubbleText !== "";

  // Claude is a small space-invader; size ~52px so he reads slightly TALLER than phren
  // (phren is 64 tall but body is ~48). Claude grounded at GROUND_Y.
  const claudeH = 60;
  return (
    <div style={{
      position: "absolute",
      left: X_CLAUDE - 30,
      top: GROUND_Y - claudeH,    // grounded so feet at GROUND_Y
      width: 60, height: claudeH,
    }}>
      <ClaudeSprite size={60} bob={Math.sin(t * 3) * 1.5} />

      {showClaudeBubble && (
        <div style={{
          position: "absolute",
          left: -50, top: -36,
          background: "#fffdf8",
          color: "#1a1538",
          padding: "5px 9px",
          borderRadius: 6,
          fontFamily: "var(--mono)", fontSize: 9,
          fontWeight: 700,
          border: "2px solid #1a1538",
          boxShadow: "2px 2px 0 #1a1538",
          whiteSpace: "nowrap",
          animation: "bubbleIn 0.25s ease-out",
        }}>
          {bubbleText}
          <div style={{
            position: "absolute", bottom: -7, left: 18,
            width: 0, height: 0,
            borderLeft: "5px solid transparent",
            borderRight: "5px solid transparent",
            borderTop: "7px solid #1a1538",
          }} />
        </div>
      )}
    </div>
  );
}

function ClaudeSprite({ size = 60, bob = 0 }) {
  // 24×24 grid pink invader — body ~10 wide, 8 tall, with arms + 4 legs.
  const px = [];
  // body fill rows 6-13, cols 7-16
  for (let r = 6; r <= 13; r++) {
    for (let c = 7; c <= 16; c++) {
      const isEdge = r === 6 || r === 13 || c === 7 || c === 16;
      px.push({ c, r, color: isEdge ? "#a83253" : "#e98aa3" });
    }
  }
  // eyes
  px.push({ c: 9, r: 9, color: "#1a1538" });
  px.push({ c: 14, r: 9, color: "#1a1538" });
  // arms (small stubs out the sides)
  px.push({ c: 6, r: 9, color: "#a83253" });
  px.push({ c: 17, r: 9, color: "#a83253" });
  // 4 legs
  [8, 11, 12, 15].forEach((c) => {
    px.push({ c, r: 14, color: "#a83253" });
    px.push({ c, r: 15, color: "#a83253" });
  });
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}
      style={{ shapeRendering: "crispEdges", transform: `translateY(${bob}px)` }}>
      {px.map((p, i) => (
        <rect key={i} x={p.c} y={p.r} width="1.02" height="1.02" fill={p.color} />
      ))}
    </svg>
  );
}

// ── Teammate (another phren on the right) ────────────────────────────────
function Teammate({ t, beat }) {
  const caught = t > 13.6 && t < 19.0;
  const wave = t > 13.0 && t < 14.5;
  return (
    <div style={{
      position: "absolute",
      left: X_TEAMMATE - 32,
      top: GROUND_Y - 60,
      width: 64, height: 64,
    }}>
      <PhrenSprite
        size={64}
        pose="idle"
        facing="left"
        mouth={caught ? "smile" : null}
        armUp={wave && !caught}
        sparkle={false}
        bob={Math.floor(t * 2) % 2}
      />
      {caught && t < 14.5 && (
        <div style={{
          position: "absolute", left: -16, top: -22,
          background: "#7C3AED", color: "#fff",
          padding: "3px 8px",
          fontFamily: "var(--mono)", fontSize: 8,
          fontWeight: 700,
          border: "1.5px solid #1a1538",
          borderRadius: 4,
          whiteSpace: "nowrap",
          animation: "bubbleIn 0.2s ease-out",
        }}>got it!</div>
      )}
    </div>
  );
}

// ── Confetti rays radiating from phren — matches front-page celebration ──
// (phrenScreenX, phrenScreenY) is where to anchor the burst (phren center).
function TaskComplete({ t, beat, phrenScreenX, phrenScreenY }) {
  const active = beat && beat.zone === 9;
  if (!active) return null;
  const ageT = t - beat.t;
  if (ageT < 0) return null;
  // Steady "useTick"-style frame counter so confetti orbits like SceneCelebrate
  const tick = ageT * 14;
  return (
    <div style={{
      position: "absolute",
      left: 0, top: 0,
      width: STAGE_W, height: STAGE_H,
      pointerEvents: "none",
      zIndex: 7,
    }}>
      {/* "task complete" banner — floats above phren */}
      <div style={{
        position: "absolute",
        left: phrenScreenX - 90,
        top: phrenScreenY - 60,
        width: 180,
        textAlign: "center",
        opacity: ageT < 0.2 ? ageT / 0.2 : 1,
      }}>
        <div style={{
          display: "inline-block",
          background: "#7C3AED", color: "#fff",
          padding: "8px 14px",
          fontFamily: "var(--mono)", fontSize: 11,
          fontWeight: 700, letterSpacing: 1.5,
          border: "2px solid #1a1538",
          boxShadow: "3px 3px 0 #1a1538",
          textTransform: "uppercase",
          transform: `translateY(${Math.sin(ageT * 4) * 3}px)`,
        }}>task complete ✓</div>
      </div>
      {/* radial confetti — 14 dots orbit out from phren center */}
      {Array.from({ length: 14 }).map((_, i) => {
        const angle = (i / 14) * Math.PI * 2;
        const radius = 70 + ((tick + i * 3) % 30);
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        const colors = ["#7C3AED", "#28D3F2", "#fff", "#9c8ff8"];
        return (
          <div key={i} style={{
            position: "absolute",
            left: phrenScreenX + x - 2,
            top: phrenScreenY + y - 2,
            width: 4, height: 4,
            background: colors[i % 4],
            transform: `rotate(${i * 30}deg)`,
          }} />
        );
      })}
    </div>
  );
}

// ── Phren ────────────────────────────────────────────────────────────────
function PhrenInScene({ t, camX, onPos }) {
  const beat = currentBeat(t);
  const px = phrenX(t);
  const screenX = px - camX;
  const size = 64;

  let pose = "run";
  let mouth = null;
  let y = GROUND_Y - 60;
  let facing = "right";
  let armUp = false;
  let armsUp = false;
  let extras = null;
  let tilt = 0;
  let bobIdx = Math.floor(t * 8);
  let flash = false;
  let sprite = null; // override the whole sprite render

  if (beat.zone === 0) {
    // Parachuting — descend
    pose = "idle";
    facing = "right";
    armUp = true;
    const f = t / 3.0;
    y = GROUND_Y - 60 - (1 - f) * 240;
    extras = <Parachute screenX={screenX} y={y} f={f} />;
  } else if (beat.zone === 1) {
    pose = "run";
    mouth = "smile";
  } else if (beat.zone === 2) {
    pose = "idle";
    facing = "right";
    armUp = t >= 4.7 && t < 6.5;
    mouth = "smile";
  } else if (beat.zone === 3) {
    pose = "run";
    mouth = "smile";
  } else if (beat.zone === 4) {
    // phren delivers context to claude (gesture + speech)
    pose = "idle";
    facing = "right";
    armUp = t >= 8.9 && t < 9.9;
    if (t >= 8.9 && t < 9.8) mouth = "open";
    else mouth = "smile";
    extras = <PhrenSpeech t={t - 8.9} screenX={screenX} y={y} />;
  } else if (beat.zone === 5) {
    // Skateboarding: kickflip happens between t=12.0..12.8, toss note at t=13.6..14.0
    pose = "skate";
    facing = "right";
    const flipT = t - 12.0;
    const inFlip = flipT >= 0 && flipT <= 0.8;
    if (inFlip) {
      // air time — phren goes up and comes down
      const ff = flipT / 0.8;
      const lift = Math.sin(ff * Math.PI) * 50;
      y = GROUND_Y - 60 - lift;
      tilt = Math.sin(ff * Math.PI) * 12;
    } else {
      y = GROUND_Y - 60 - Math.abs(Math.sin(t * 8)) * 2;
    }
    extras = (
      <>
        <Skateboard screenX={screenX} y={y + 60} t={t} flipT={inFlip ? flipT / 0.8 : -1} />
        <HandoffCard t={t - 13.6} screenX={screenX} y={y} camX={camX} />
      </>
    );
  } else if (beat.zone === 6) {
    pose = "run";
    mouth = "smile";
  } else if (beat.zone === 7) {
    // Juggle while RUNNING — keep moving, balls overhead
    pose = "run";
    facing = "right";
    mouth = "open";
    extras = <JuggleBalls screenX={screenX} y={y} t={t} />;
  } else if (beat.zone === 8) {
    pose = "run";
    mouth = "smile";
  } else if (beat.zone === 9) {
    // BIG celebratory jump — bounce twice with sparkle flash on each peak
    pose = "jump";
    mouth = "open";
    armsUp = true;
    facing = "right";
    const f = (t - beat.t) / (beat.end - beat.t);
    let lift;
    if (f < 0.3) lift = Math.sin(f * Math.PI / 0.3) * 110;
    else if (f < 0.55) lift = Math.sin((f - 0.3) * Math.PI / 0.25) * 50;
    else lift = Math.abs(Math.sin((f - 0.55) * 8)) * 6;
    y = GROUND_Y - 60 - lift;
    // flash when up in the air (sparkle effect like SceneCelebrate)
    flash = lift > 18;
  }

  // Run bob
  if (pose === "run") {
    y = GROUND_Y - 60 - Math.abs(Math.sin(t * 16)) * 4;
  }

  // Report position to parent so the celebration can anchor on phren
  if (onPos) onPos(screenX, y + size / 2);

  return (
    <>
      {extras}
      <div style={{
        position: "absolute",
        left: screenX - size / 2,
        top: y,
        width: size, height: size,
        zIndex: 5,
        transform: tilt ? `rotate(${tilt}deg)` : undefined,
      }}>
        <PhrenSprite
          size={size}
          pose={pose}
          facing={facing}
          mouth={mouth}
          armUp={armUp}
          armsUp={armsUp}
          bob={bobIdx}
          flash={flash}
          blinking={Math.floor(t * 1.2) % 5 === 0 && (t * 1.2) % 1 < 0.15}
          sparkle={false}
        />
      </div>
    </>
  );
}

// ── Props ────────────────────────────────────────────────────────────────
function Parachute({ screenX, y, f }) {
  // chute released at f≈0.85 (just before landing)
  if (f > 0.92) return null;
  const sway = Math.sin(f * 6) * 6;
  return (
    <div style={{
      position: "absolute",
      left: screenX - 40 + sway,
      top: y - 80,
      width: 80, height: 60,
      zIndex: 6,
    }}>
      <svg viewBox="0 0 80 60" width="80" height="60">
        <path d="M 0 32 Q 40 -10 80 32 Z" fill="#7C3AED" stroke="#1a1538" strokeWidth="2" />
        <path d="M 18 18 L 18 32" stroke="#28D3F2" strokeWidth="6" />
        <path d="M 38 9 L 38 32" stroke="#F5DC5A" strokeWidth="6" />
        <path d="M 58 18 L 58 32" stroke="#F5A5A5" strokeWidth="6" />
        <line x1="6" y1="32" x2="32" y2="58" stroke="#1a1538" strokeWidth="1.5" />
        <line x1="40" y1="9" x2="40" y2="58" stroke="#1a1538" strokeWidth="1.5" />
        <line x1="74" y1="32" x2="48" y2="58" stroke="#1a1538" strokeWidth="1.5" />
      </svg>
    </div>
  );
}

function Skateboard({ screenX, y, t, flipT }) {
  // y is approx phren feet level; show board at y
  const inFlip = flipT >= 0;
  const flipRot = inFlip ? flipT * 360 : 0;
  // during flip, board lifts a tiny bit then comes back
  const flipLift = inFlip ? Math.sin(flipT * Math.PI) * 25 : 0;
  return (
    <div style={{
      position: "absolute",
      left: screenX - 30,
      top: y - 8 - flipLift,
      width: 60, height: 16,
      zIndex: 4,
      transform: `rotate(${flipRot}deg)`,
    }}>
      <div style={{
        position: "absolute",
        left: 4, top: 2,
        width: 52, height: 6,
        background: "#D97757",
        border: "1.5px solid #1a1538",
        borderRadius: 6,
      }} />
      {[6, 50].map((wx, i) => (
        <div key={i} style={{
          position: "absolute",
          left: wx, top: 8,
          width: 8, height: 8,
          background: "#7C3AED",
          border: "1.5px solid #1a1538",
          borderRadius: "50%",
        }}>
          <div style={{
            position: "absolute", left: 2, top: 2, width: 2, height: 2,
            background: "#fff", borderRadius: "50%",
            transform: `rotate(${t * 720}deg)`, transformOrigin: "0 0",
          }} />
        </div>
      ))}
    </div>
  );
}

function JuggleBalls({ screenX, y, t }) {
  return (
    <>
      {[0, 1, 2].map((i) => {
        const phase = (t * 2.5 + i * 0.66) % 2;
        // arc goes left-right alternately
        const bx = screenX + (phase < 1
          ? -22 + phase * 44
          : 22 - (phase - 1) * 44);
        const by = y - 8 - Math.sin(phase * Math.PI) * 60;
        const colors = ["#F5A5A5", "#28D3F2", "#F5DC5A"];
        return (
          <div key={i} style={{
            position: "absolute",
            left: bx - 5, top: by - 5,
            width: 10, height: 10,
            background: colors[i],
            border: "1.5px solid #1a1538",
            borderRadius: "50%",
            zIndex: 6,
          }} />
        );
      })}
    </>
  );
}

function PhrenSpeech({ t, screenX, y }) {
  // Phren says something to Claude during 8.9..9.9
  if (t < 0 || t > 1.2) return null;
  return (
    <div style={{
      position: "absolute",
      left: screenX - 90, top: y - 30,
      background: "#fffdf8",
      color: "#1a1538",
      padding: "5px 9px",
      borderRadius: 6,
      fontFamily: "var(--mono)", fontSize: 9,
      fontWeight: 700,
      border: "2px solid #1a1538",
      boxShadow: "2px 2px 0 #1a1538",
      whiteSpace: "nowrap",
      animation: "bubbleIn 0.2s ease-out",
      zIndex: 10,
    }}>
      here's last sprint's notes →
      <div style={{
        position: "absolute", bottom: -7, right: 14,
        width: 0, height: 0,
        borderLeft: "5px solid transparent",
        borderRight: "5px solid transparent",
        borderTop: "7px solid #1a1538",
      }} />
    </div>
  );
}

function HandoffCard({ t, screenX, y, camX }) {
  // card flies from phren's hand to teammate; t is local — relative to 13.6
  if (t < 0 || t > 1.4) return null;
  const f = Math.min(t / 1.0, 1);
  // teammate is at world X_TEAMMATE; convert to screen
  const teammateScreenX = X_TEAMMATE - camX;
  const startX = screenX + 20;
  const endX = teammateScreenX - 10; // land just in front of teammate's hand
  const cx = startX + (endX - startX) * f;
  const cy = y + 20 - Math.sin(f * Math.PI) * 35;
  return (
    <div style={{
      position: "absolute",
      left: cx, top: cy,
      width: 24, height: 18,
      background: "#fffdf8",
      border: "1.5px solid #1a1538",
      borderRadius: 1,
      transform: `rotate(${f * 360}deg)`,
      zIndex: 6,
      boxShadow: "1px 1px 0 #1a1538",
    }}>
      <div style={{ position: "absolute", left: 2, top: 2, width: 18, height: 1.5, background: "#7C3AED" }} />
      <div style={{ position: "absolute", left: 2, top: 6, width: 14, height: 1, background: "#9aa1c2" }} />
      <div style={{ position: "absolute", left: 2, top: 9, width: 16, height: 1, background: "#9aa1c2" }} />
      <div style={{ position: "absolute", left: 2, top: 12, width: 10, height: 1, background: "#9aa1c2" }} />
    </div>
  );
}

// ── Zone label ──────────────────────────────────────────────────────────
function ZoneLabel({ beat, t }) {
  if (!beat) return null;
  const dur = beat.end - beat.t;
  const local = t - beat.t;
  let op = 1;
  if (local < 0.3) op = local / 0.3;
  if (local > dur - 0.3) op = (dur - local) / 0.3;
  op = Math.max(0, Math.min(1, op));
  return (
    <div style={{
      position: "absolute",
      left: 24, top: 24,
      fontFamily: "var(--mono)", fontSize: 11,
      color: "#28D3F2",
      letterSpacing: 3,
      textTransform: "uppercase",
      opacity: op,
      transition: "opacity 0.15s",
    }}>
      <span style={{ color: "#7C3AED" }}>›</span> {beat.name}
    </div>
  );
}

// ── Speed lines for the dolly whoosh ────────────────────────────────────
function SpeedLines({ t }) {
  // Active 21.5 -> 22.5
  const f = (t - 21.5) / 1.0;
  if (f < 0 || f > 1) return null;
  const opacity = f < 0.5 ? f * 2 : (1 - f) * 2;
  const lines = [];
  for (let i = 0; i < 14; i++) {
    const seed = (i * 47) % 100;
    const top = (seed / 100) * 420 + 10;
    const len = 90 + ((i * 31) % 80);
    const speed = 1 + ((i * 13) % 5) / 5;
    const x = ((t * 1800 * speed) % 1100) - 200;
    lines.push(
      <div key={i} style={{
        position: "absolute",
        left: x, top,
        width: len, height: 2,
        background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.85))",
        opacity,
        borderRadius: 2,
      }} />
    );
  }
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
      {lines}
    </div>
  );
}

// ── Big logo reveal ──────────────────────────────────────────────────────
function LogoReveal({ t }) {
  // Active 22.0 -> 26.0
  if (t < 22.0) return null;
  const age = t - 22.0;
  // wordmark slides in 0 -> 0.5s, holds, then breathes
  const slideF = Math.min(1, age / 0.55);
  const ease = 1 - Math.pow(1 - slideF, 3); // ease-out-cubic
  const wordX = -40 + ease * 40;
  const wordOp = ease;
  // tagline fades 0.6 -> 1.1
  const tagF = Math.max(0, Math.min(1, (age - 0.55) / 0.55));
  const tagOp = tagF;
  const tagY = (1 - tagF) * 14;
  // sparkle pop at the moment wordmark lands
  const sparkleF = Math.max(0, Math.min(1, (age - 0.4) / 0.45));
  const sparkleScale = sparkleF < 0.5 ? sparkleF * 2 : 1;
  const sparkleOp = sparkleF < 0.7 ? 1 : 1 - (sparkleF - 0.7) / 0.3;

  return (
    <div className="logo-reveal" style={{
      position: "absolute",
      inset: 0,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      pointerEvents: "none",
      background: "radial-gradient(ellipse at center, rgba(18,18,42,0) 0%, rgba(18,18,42,0.55) 70%)",
    }}>
      {/* sparkle behind wordmark */}
      <div style={{
        position: "absolute",
        left: "50%", top: "50%",
        transform: `translate(-50%, -50%) scale(${sparkleScale})`,
        opacity: sparkleOp,
        width: 4, height: 4,
        pointerEvents: "none",
      }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{
            position: "absolute",
            left: "50%", top: "50%",
            width: 4, height: 220,
            transform: `translate(-50%, -50%) rotate(${i * 45}deg)`,
            background: "linear-gradient(180deg, transparent, #28D3F2 50%, transparent)",
            opacity: 0.85,
          }} />
        ))}
      </div>

      {/* wordmark */}
      <div className="logo-wordmark" style={{
        fontFamily: "var(--sans)",
        fontWeight: 900,
        fontSize: 132,
        letterSpacing: -4,
        color: "#fff",
        opacity: wordOp,
        transform: `translateX(${wordX}px)`,
        textShadow: "0 6px 0 rgba(124,58,237,0.55), 0 14px 30px rgba(40,211,242,0.25)",
        lineHeight: 1,
      }}>
        <span style={{ color: "#fff" }}>phren</span>
        <span style={{ color: "#28D3F2" }}>.</span>
      </div>

      {/* tagline */}
      <div className="logo-tagline" style={{
        marginTop: 14,
        fontFamily: "var(--mono)",
        fontWeight: 600,
        fontSize: 18,
        letterSpacing: 3,
        color: "#c8c4f0",
        opacity: tagOp,
        transform: `translateY(${tagY}px)`,
        textTransform: "uppercase",
      }}>
        memory for your agents
      </div>
    </div>
  );
}

function BrandStamp() {
  return (
    <div style={{
      position: "absolute",
      right: 24, bottom: 22,
      fontFamily: "var(--sans)", fontSize: 13,
      color: "#9aa1c2",
      letterSpacing: 1,
      fontWeight: 600,
      display: "flex", alignItems: "center", gap: 8,
    }}>
      <span style={{ color: "#28D3F2" }}>✦</span>
      phren
      <span style={{ color: "rgba(154,161,194,0.4)", fontWeight: 400, fontSize: 11 }}>· memory for your agents</span>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────
function StoryLoop() {
  const t = useTime();
  const beat = currentBeat(t);
  const camX = cameraX(t);

  usE(() => {
    const nameEl = document.getElementById("beat-name");
    if (nameEl) nameEl.textContent = beat ? beat.name : "—";
    const bar = document.getElementById("progress-bar");
    if (bar) bar.style.width = ((t / TOTAL) * 100) + "%";
  }, [t, beat]);

  // Phren position for this frame (so the celebration can follow him)
  const phrenWorldX = phrenX(t);
  const phrenScreenX = phrenWorldX - camX;
  // Mirror PhrenInScene's vertical placement for zone 9 so the burst centers on him
  let phrenY = GROUND_Y - 60;
  if (beat && beat.zone === 9) {
    const f = (t - beat.t) / (beat.end - beat.t);
    let lift;
    if (f < 0.3) lift = Math.sin(f * Math.PI / 0.3) * 110;
    else if (f < 0.55) lift = Math.sin((f - 0.3) * Math.PI / 0.25) * 50;
    else lift = Math.abs(Math.sin((f - 0.55) * 8)) * 6;
    phrenY = GROUND_Y - 60 - lift;
  }
  const phrenCenterY = phrenY + 32;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <World t={t} camX={camX} />

      <div style={{
        position: "absolute", left: -camX, top: 0,
        width: 8000, height: STAGE_H,
      }}>
        <Cabinet t={t} beat={beat} />
        <Claude t={t} beat={beat} />
        <Teammate t={t} beat={beat} />
      </div>

      {(!beat || beat.zone !== 10) && <PhrenInScene t={t} camX={camX} />}
      <TaskComplete t={t} beat={beat} phrenScreenX={phrenScreenX} phrenScreenY={phrenCenterY} />

      <SpeedLines t={t} />
      <LogoReveal t={t} />

      {(!beat || beat.zone !== 10) && <ZoneLabel beat={beat} t={t} />}
      {(!beat || beat.zone !== 10) && <BrandStamp />}

      <style>{`
        @keyframes bubbleIn {
          from { transform: scale(0.6); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ── Mount ─────────────────────────────────────────────────────────────────
const stage = document.getElementById("stage");
ReactDOM.createRoot(stage).render(<StoryLoop />);

document.getElementById("restart-btn").addEventListener("click", () => location.reload());
