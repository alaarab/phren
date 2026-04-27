// Phren extra loops — curated, quality over quantity.
// 7 scenes, each crafted deliberately.

const { useEffect: useE, useState: useS } = React;

function tickEx(ms) {
  const [t, setT] = useS(0);
  useE(() => {
    const id = setInterval(() => setT((v) => v + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}

function FloorLine({ y = 48, opacity = 0.12 }) {
  return <div style={{ position: "absolute", left: 12, right: 12, bottom: y, height: 1, background: `rgba(255,255,255,${opacity})` }} />;
}

// ─────────────────────────────────────────────────────────────────────────
// PARACHUTE — drifting down, canopy sways opposite to body like real physics
function SceneParachute({ speed = 1 }) {
  const t = tickEx(120 / speed);
  const sway = Math.sin(t / 8) * 12;
  const canopySway = Math.sin(t / 8 - 0.6) * 16; // lags body
  const drift = ((t * 0.4) % 40) - 20;
  return (
    <SceneFrame label="parachute">
      {/* clouds */}
      <div style={{ position: "absolute", left: 30, top: 40, width: 34, height: 10, background: "rgba(255,255,255,0.18)", borderRadius: 8 }} />
      <div style={{ position: "absolute", right: 40, top: 90, width: 46, height: 12, background: "rgba(255,255,255,0.12)", borderRadius: 8 }} />
      <div style={{ position: "absolute", left: "50%", top: 60 + drift, transform: `translateX(-50%) translateX(${sway}px)` }}>
        {/* canopy */}
        <svg width="140" height="70" viewBox="0 0 140 70" style={{ display: "block", transform: `translateX(${canopySway - sway}px)` }}>
          <path d="M6 48 Q 70 -6 134 48 L 122 50 L 110 44 L 98 50 L 86 44 L 74 50 L 62 44 L 50 50 L 38 44 L 26 50 L 14 44 Z" fill="#7C3AED" stroke="#12122a" strokeWidth="2" strokeLinejoin="round" />
          <path d="M50 48 Q 70 14 90 48" fill="#9c8ff8" opacity="0.7" />
          {/* risers */}
          <line x1="14" y1="44" x2="58" y2="68" stroke="#12122a" strokeWidth="1" />
          <line x1="50" y1="50" x2="64" y2="68" stroke="#12122a" strokeWidth="1" />
          <line x1="90" y1="50" x2="76" y2="68" stroke="#12122a" strokeWidth="1" />
          <line x1="126" y1="44" x2="82" y2="68" stroke="#12122a" strokeWidth="1" />
        </svg>
        {/* phren, legs dangling */}
        <div style={{ marginTop: -6, display: "flex", justifyContent: "center" }}>
          <PhrenSprite size={64} pose="jump" armUp />
        </div>
      </div>
    </SceneFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// JUGGLING — phren faces camera, looks up. Hands out front at shoulder height,
// alternating up (just threw) and down (catching). 3-ball cascade pattern.
function SceneJuggle({ speed = 1 }) {
  const t = tickEx(50 / speed);
  const T = 60;
  const H = T / 2;
  const balls = [0, 1, 2].map((i) => {
    const raw = (t + i * (T / 3)) % T;
    const throwIdx = Math.floor(raw / H);
    const p = (raw % H) / H;
    const dir = throwIdx === 0 ? 1 : -1;
    const bx = dir * (p * 2 - 1) * 40;
    const by = -Math.sin(p * Math.PI) * 70 - 6;
    return { bx, by, p };
  });
  // For each hand, find the ball closest to it near the bottom of its arc.
  // Left hand lives at bx≈-40, right hand at bx≈+40. Hand follows that ball's
  // bx when it's low (p near 0 or 1), else sits at rest.
  function handFollow(targetSide) {
    // Find the ball closest to this hand (in bx) among those near the bottom of arc
    const rest = { x: targetSide * 40, yOffset: 0 };
    let best = null;
    let bestScore = Infinity;
    balls.forEach((b) => {
      // "lowness" — how close to hand height
      const lowness = 1 - Math.abs(Math.sin(b.p * Math.PI)); // 1 = at hand, 0 = peak
      // which side the ball is on
      const onThisSide = Math.sign(b.bx) === targetSide || b.bx === 0;
      if (!onThisSide) return;
      const score = Math.abs(b.bx - targetSide * 40) - lowness * 60;
      if (score < bestScore) {
        bestScore = score;
        best = { x: b.bx, lowness };
      }
    });
    if (best && best.lowness > 0.4) {
      // Hand reaches up toward that ball
      return { x: best.x, yOffset: -best.lowness * 6 };
    }
    return rest;
  }
  const leftHand = handFollow(-1);
  const rightHand = handFollow(1);

  return (
    <SceneFrame label="juggling">
      <div style={{ position: "absolute", left: "50%", bottom: 28, transform: "translateX(-50%)", width: 160, height: 190 }}>
        <div style={{ position: "absolute", left: "50%", bottom: 0, transform: "translateX(-50%)" }}>
          <PhrenSprite size={120} blinking={false} sparkle={false} />
        </div>
        {/* left hand — follows ball on left */}
        <div style={{
          position: "absolute",
          left: `calc(50% + ${leftHand.x - 6}px)`,
          bottom: 52 + leftHand.yOffset,
          width: 12, height: 12,
          background: "rgb(117,92,249)", border: "1.5px solid #12122a",
          transition: "left 0.09s linear, bottom 0.09s linear",
        }} />
        {/* right hand — follows ball on right */}
        <div style={{
          position: "absolute",
          left: `calc(50% + ${rightHand.x - 6}px)`,
          bottom: 52 + rightHand.yOffset,
          width: 12, height: 12,
          background: "rgb(117,92,249)", border: "1.5px solid #12122a",
          transition: "left 0.09s linear, bottom 0.09s linear",
        }} />
        {balls.map((b, i) => (
          <div key={i} style={{
            position: "absolute", left: "50%", bottom: 60,
            transform: `translate(calc(-50% + ${b.bx}px), ${b.by}px)`,
            width: 14, height: 14, borderRadius: "50%",
            background: ["#F5A5A5", "#28D3F2", "#D97757"][i],
            border: "1.5px solid #12122a",
            boxShadow: "1px 1px 0 rgba(0,0,0,0.3)",
          }} />
        ))}
      </div>
    </SceneFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// COMPILING — progress bar
function SceneBuild({ speed = 1 }) {
  const t = tickEx(280 / speed);
  const pct = (t * 6) % 101;
  const stage = pct < 33 ? "resolving deps…" : pct < 66 ? "bundling…" : pct < 95 ? "minifying…" : "done ✓";
  return (
    <SceneFrame label="compiling">
      <div style={{ position: "absolute", left: "50%", bottom: 34, transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <PhrenSprite size={90} blinking={t % 5 === 0} />
        <div style={{ width: 160, height: 10, background: "#1a1530", border: "1px solid #12122a", marginTop: 6, position: "relative" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: "#7C3AED", transition: "width 0.25s linear" }} />
        </div>
        <div style={{ fontFamily: "ui-monospace,monospace", fontSize: 9, color: "rgba(255,255,255,0.55)", marginTop: 4 }}>
          {stage} {Math.floor(pct)}%
        </div>
      </div>
    </SceneFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// GROWING — phren waters, plant visibly grows from seed → stem → leaves → flower, then resets
function ScenePlant({ speed = 1 }) {
  const t = tickEx(400 / speed);
  const stage = t % 6; // 0..5
  // stage 0: seed, 1: sprout, 2: stem, 3: leaves, 4: bud, 5: flower, reset

  return (
    <SceneFrame label="growing">
      <FloorLine y={34} />
      {/* pot — centered */}
      <div style={{ position: "absolute", left: "calc(50% + 20px)", bottom: 34, width: 44, height: 26, background: "#D97757", border: "2px solid #12122a", borderRadius: "2px 2px 8px 8px" }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 4, background: "#B8613F" }} />
      </div>
      {/* plant (draws above pot) */}
      <svg width="60" height="100" viewBox="0 0 60 100" style={{ position: "absolute", left: "calc(50% + 12px)", bottom: 58 }}>
        {stage >= 1 && (
          <line x1="30" y1="100" x2="30" y2={100 - Math.min(stage, 4) * 18} stroke="#7CFFB2" strokeWidth="3" strokeLinecap="round" />
        )}
        {stage >= 3 && (
          <>
            <ellipse cx="20" cy={60} rx="8" ry="4" fill="#7CFFB2" stroke="#12122a" strokeWidth="1" transform="rotate(-20 20 60)" />
            <ellipse cx="40" cy={46} rx="8" ry="4" fill="#7CFFB2" stroke="#12122a" strokeWidth="1" transform="rotate(25 40 46)" />
          </>
        )}
        {stage >= 4 && <circle cx="30" cy={32 - (stage - 4) * 4} r="5" fill="#9c8ff8" stroke="#12122a" strokeWidth="1" />}
        {stage === 5 && (
          <g transform={`translate(30 ${24})`}>
            {[0, 1, 2, 3, 4].map((i) => {
              const a = (i / 5) * Math.PI * 2;
              return <circle key={i} cx={Math.cos(a) * 6} cy={Math.sin(a) * 6} r="4" fill="#F5A5A5" stroke="#12122a" strokeWidth="1" />;
            })}
            <circle r="3" fill="#D97757" stroke="#12122a" strokeWidth="1" />
          </g>
        )}
      </svg>
      {/* phren watering — close to pot, holding cup forward */}
      <div style={{ position: "absolute", left: "calc(50% - 52px)", bottom: 26 }}>
        <PhrenSprite size={82} facing="right" armOut blinking={t % 6 === 0} />
      </div>
      {/* cup — held right over the pot */}
      <svg width="18" height="16" viewBox="0 0 18 16" style={{ position: "absolute", left: "calc(50% + 18px)", bottom: 62, transform: "rotate(-16deg)" }}>
        <rect x="2" y="1" width="14" height="12" fill="#28D3F2" stroke="#12122a" strokeWidth="1.5" />
        <rect x="2" y="1" width="14" height="2.5" fill="#12122a" opacity="0.25" />
      </svg>
      {/* water stream — short, and droplets disappear on pot rim (bottom 60) */}
      <div style={{
        position: "absolute",
        left: `calc(50% + 32px)`,
        bottom: 62,
        width: 3,
        height: 5,
        background: "#28D3F2",
        opacity: 0.85,
      }} />
      {[0, 1].map((i) => {
        const p = ((t * 3 + i * 12) % 24) / 24;
        const y = 60 - p * 2;
        // fade out as drop nears the pot (p > 0.7)
        const op = p < 0.7 ? 0.9 : Math.max(0, 0.9 * (1 - (p - 0.7) / 0.3));
        return (
          <div key={i} style={{
            position: "absolute",
            left: `calc(50% + 32px)`,
            bottom: y,
            width: 3, height: 5,
            background: "#28D3F2",
            borderRadius: "50% 50% 50% 50% / 60% 60% 40% 40%",
            opacity: op,
          }} />
        );
      })}
    </SceneFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// SKATEBOARDING — phren rolling across, periodically popping a kickflip
function SceneBed({ speed = 1 }) {
  const t = tickEx(80 / speed);
  // horizontal loop: phren rolls left→right, resets
  const loopLen = 100;
  const prog = (t % loopLen) / loopLen; // 0..1 across frame
  const phrenX = -20 + prog * 140; // left→right in % (scene is ~240 wide)
  // Kickflip trigger: every 40 ticks do a 20-tick flip
  const flipCycle = t % 40;
  const flipping = flipCycle < 18;
  const flipP = flipping ? flipCycle / 18 : 0; // 0..1
  const flipY = flipping ? -Math.sin(flipP * Math.PI) * 30 : 0; // hop arc
  const boardRot = flipping ? flipP * 360 : 0; // one full spin
  const phrenRot = flipping ? Math.sin(flipP * Math.PI) * -10 : 0; // slight lean

  return (
    <SceneFrame label="skateboarding">
      {/* ground */}
      <FloorLine y={34} />
      {/* motion lines behind */}
      {[0, 1, 2].map((i) => (
        <div key={i} style={{
          position: "absolute",
          left: `${phrenX - 8 - i * 6}%`,
          bottom: 44 + i * 4,
          width: 18, height: 2,
          background: "rgba(156,143,248,0.35)",
        }} />
      ))}
      {/* phren + board group */}
      <div style={{
        position: "absolute",
        left: `${phrenX}%`,
        bottom: 34,
        transform: `translateX(-50%) translateY(${flipY}px) rotate(${phrenRot}deg)`,
        transformOrigin: "50% 100%",
        transition: "transform 0.05s linear",
      }}>
        {/* phren — crouched a bit when flipping, otherwise idle with legs tucked */}
        <div style={{ position: "relative" }}>
          <PhrenSprite
            size={76}
            pose={flipping ? "jump" : "idle"}
            facing="right"
            blinking={t % 7 === 0}
            sparkle={false}
          />
        </div>
        {/* board — positioned under feet */}
        <div style={{
          position: "absolute",
          left: "50%",
          bottom: -6,
          transform: `translateX(-50%) rotate(${boardRot}deg)`,
          width: 60,
          height: 10,
        }}>
          {/* deck */}
          <div style={{
            position: "absolute", left: 0, top: 2,
            width: 60, height: 6,
            background: "#D97757",
            border: "1.5px solid #12122a",
            borderRadius: 6,
          }}>
            {/* grip stripe */}
            <div style={{ position: "absolute", inset: "1px 3px", background: "#12122a", borderRadius: 4, opacity: 0.6 }} />
          </div>
          {/* wheels */}
          <div style={{ position: "absolute", left: 6, top: 7, width: 6, height: 6, borderRadius: "50%", background: "#9c8ff8", border: "1.5px solid #12122a" }} />
          <div style={{ position: "absolute", right: 6, top: 7, width: 6, height: 6, borderRadius: "50%", background: "#9c8ff8", border: "1.5px solid #12122a" }} />
        </div>
      </div>
    </SceneFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ZERO G — floats in space, slow rotation, stars parallax
function SceneAstro({ speed = 1 }) {
  const t = tickEx(120 / speed);
  const driftX = Math.sin(t / 20) * 24;
  const driftY = Math.cos(t / 24) * 16;
  const rot = (t * 0.6) % 360;
  return (
    <SceneFrame label="zero g">
      {/* deep space bg tint */}
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 30% 40%, rgba(124,58,237,0.18), transparent 60%)" }} />
      {/* stars */}
      {[...Array(18)].map((_, i) => {
        const x = (i * 53) % 100;
        const y = (i * 37) % 100;
        const s = i % 3 === 0 ? 2 : 1;
        const twinkle = (t + i) % 6 < 3 ? 1 : 0.4;
        return <div key={i} style={{ position: "absolute", left: `${x}%`, top: `${y}%`, width: s, height: s, background: "#fff", borderRadius: "50%", opacity: twinkle }} />;
      })}
      {/* distant planet — top right */}
      <svg style={{ position: "absolute", right: 12, top: 12 }} width="60" height="48" viewBox="0 0 70 56">
        <circle cx="34" cy="28" r="22" fill="#9c8ff8" />
        <ellipse cx="34" cy="28" rx="32" ry="6" fill="none" stroke="#7C3AED" strokeWidth="2" opacity="0.7" />
        <circle cx="26" cy="22" r="4" fill="#7C3AED" opacity="0.5" />
        <circle cx="42" cy="34" r="3" fill="#7C3AED" opacity="0.5" />
      </svg>
      {/* phren floating, rotating slowly */}
      <div style={{ position: "absolute", left: `calc(40% + ${driftX}px)`, top: `calc(40% + ${driftY}px)`, transform: `translate(-50%, -50%) rotate(${rot}deg)` }}>
        <div style={{ position: "relative" }}>
          <PhrenSprite size={90} pose="jump" />
          {/* helmet glass ring */}
          <div style={{ position: "absolute", inset: -5, border: "2px solid rgba(40,211,242,0.55)", borderRadius: "50%", background: "radial-gradient(circle at 30% 30%, rgba(255,255,255,0.15), transparent 70%)" }} />
        </div>
      </div>
    </SceneFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// DANCE — actual dance moves: bounce-step, arms alternate overhead, hip sway, spin every 8 beats
function SceneDance({ speed = 1 }) {
  const t = tickEx(160 / speed);
  const beat = t % 8;
  const hipSway = Math.sin(t / 2) * 8;
  const bounce = beat % 2 === 0 ? -4 : 0;
  const leftArm = beat % 4 < 2;
  const spinning = beat === 7;
  const spinRot = spinning ? ((t % 1) * 360) : 0;

  return (
    <SceneFrame label="dance">
      {/* disco floor tiles */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 40, display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 1, padding: 2, opacity: 0.5 }}>
        {[...Array(12)].map((_, i) => (
          <div key={i} style={{
            background: ["#7C3AED", "#28D3F2", "#F5A5A5", "#D97757"][(i + t) % 4],
            opacity: (i + t) % 3 === 0 ? 0.9 : 0.2,
          }} />
        ))}
      </div>
      {/* dancer */}
      <div style={{
        position: "absolute", left: "50%", bottom: 42,
        transform: `translateX(-50%) translateX(${hipSway}px) translateY(${bounce}px) rotate(${spinRot}deg)`,
        transition: "transform 0.12s ease-out",
      }}>
        <div style={{ position: "relative" }}>
          <PhrenSprite size={110} pose={bounce ? "jump" : "idle"} />
          {/* arms overhead — two small purple blocks that alternate */}
          <div style={{
            position: "absolute", left: 14, top: -6,
            width: 10, height: 26,
            background: "rgb(117,92,249)", border: "1px solid #12122a",
            transform: leftArm ? "rotate(-18deg)" : "rotate(20deg) translateY(14px)",
            transformOrigin: "50% 100%",
            transition: "transform 0.14s ease",
          }} />
          <div style={{
            position: "absolute", right: 14, top: -6,
            width: 10, height: 26,
            background: "rgb(117,92,249)", border: "1px solid #12122a",
            transform: leftArm ? "rotate(20deg) translateY(14px)" : "rotate(18deg)",
            transformOrigin: "50% 100%",
            transition: "transform 0.14s ease",
          }} />
        </div>
      </div>
      {/* disco light beams */}
      {[0, 1, 2, 3].map((i) => {
        const a = (i / 4 + t / 16) * Math.PI * 2;
        return (
          <div key={i} style={{
            position: "absolute", left: "50%", top: 6,
            width: 2, height: 60,
            background: ["#F5A5A5", "#28D3F2", "#7C3AED", "#7CFFB2"][i],
            opacity: 0.4,
            transform: `translateX(-50%) rotate(${a}rad)`,
            transformOrigin: "50% 0%",
          }} />
        );
      })}
    </SceneFrame>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// DJ — overhead DJ controller. Phren sits right on top of the booth (big,
// front-facing, looking at us). No stick arms — his hands come out from
// directly beneath him onto the decks. Pad grids on each deck, faders on
// each side, crossfader in the middle.
function SceneDJ({ speed = 1 }) {
  const t = tickEx(120 / speed);
  const beat = t % 4;
  const kick = beat === 0 || beat === 2;
  const bob = kick ? -2 : 0;

  const leftRot = (t * 20) % 360;
  const rightRot = (-t * 20) % 360;
  const leftScratch = Math.sin(t * 0.9) * 12;

  const leftHandX = Math.sin(t * 0.9) * 2;
  const rightHandY = kick ? -2 : 0;

  const activePadL = t % 8;
  const activePadR = (t + 3) % 8;

  return (
    <SceneFrame label="dj">
      {/* dark club floor */}
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 50% 100%, rgba(124,58,237,0.2), transparent 70%)" }} />

      {/* ── DJ CONTROLLER — wide, centered, takes up most of the bottom ── */}
      <div style={{
        position: "absolute",
        left: "50%", bottom: 6,
        transform: "translateX(-50%)",
        width: 310, height: 140,
        background: "#18182e",
        border: "2px solid #0a0a1a",
        borderRadius: 8,
        boxShadow: "inset 0 0 12px rgba(0,0,0,0.5)",
      }}>
        {/* ═══ LEFT DECK ═══ */}
        {/* Jog wheel */}
        <div style={{ position: "absolute", left: 12, top: 8, width: 68, height: 68 }}>
          <div style={{ position: "absolute", inset: 0, background: "#2a2a44", borderRadius: "50%", border: "1.5px solid #0a0a1a" }} />
          <div style={{
            position: "absolute", inset: 5,
            background: "radial-gradient(circle at 40% 40%, #4a4a66, #1a1a2e 75%)",
            borderRadius: "50%",
            border: "1px solid #0a0a1a",
            transform: `rotate(${leftRot + leftScratch}deg)`,
          }}>
            <div style={{ position: "absolute", inset: 4, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.06)" }} />
            <div style={{ position: "absolute", inset: 10, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.08)" }} />
            <div style={{ position: "absolute", inset: 20, background: "#0a0a1a", borderRadius: "50%", border: "1px solid #2a2a44" }}>
              <div style={{ position: "absolute", top: 2, left: "50%", width: 2, height: 7, background: "#F5A5A5", transform: "translateX(-50%)" }} />
            </div>
          </div>
        </div>

        {/* Left deck performance pads — 2 rows of 4, under the jog wheel */}
        {[0, 1].map((row) => (
          <div key={row} style={{
            position: "absolute",
            left: 14,
            top: 84 + row * 12,
            display: "flex", gap: 2,
          }}>
            {[0, 1, 2, 3].map((col) => {
              const idx = row * 4 + col;
              const active = idx === activePadL;
              const colors = ["#F5A5A5", "#28D3F2", "#7C3AED", "#F5DC5A"];
              return (
                <div key={col} style={{
                  width: 14, height: 10,
                  background: active ? colors[col] : "#2a2a44",
                  border: "1px solid #0a0a1a",
                  borderRadius: 1,
                  boxShadow: active ? `0 0 5px ${colors[col]}` : "none",
                }} />
              );
            })}
          </div>
        ))}

        {/* ═══ RIGHT DECK ═══ */}
        <div style={{ position: "absolute", right: 12, top: 8, width: 68, height: 68 }}>
          <div style={{ position: "absolute", inset: 0, background: "#2a2a44", borderRadius: "50%", border: "1.5px solid #0a0a1a" }} />
          <div style={{
            position: "absolute", inset: 5,
            background: "radial-gradient(circle at 40% 40%, #4a4a66, #1a1a2e 75%)",
            borderRadius: "50%",
            border: "1px solid #0a0a1a",
            transform: `rotate(${rightRot}deg)`,
          }}>
            <div style={{ position: "absolute", inset: 4, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.06)" }} />
            <div style={{ position: "absolute", inset: 10, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.08)" }} />
            <div style={{ position: "absolute", inset: 20, background: "#0a0a1a", borderRadius: "50%", border: "1px solid #2a2a44" }}>
              <div style={{ position: "absolute", top: 2, left: "50%", width: 2, height: 7, background: "#28D3F2", transform: "translateX(-50%)" }} />
            </div>
          </div>
        </div>

        {/* Right deck pads */}
        {[0, 1].map((row) => (
          <div key={row} style={{
            position: "absolute",
            right: 14,
            top: 84 + row * 12,
            display: "flex", gap: 2,
          }}>
            {[0, 1, 2, 3].map((col) => {
              const idx = row * 4 + col;
              const active = idx === activePadR;
              const colors = ["#F5A5A5", "#28D3F2", "#7C3AED", "#F5DC5A"];
              return (
                <div key={col} style={{
                  width: 14, height: 10,
                  background: active ? colors[col] : "#2a2a44",
                  border: "1px solid #0a0a1a",
                  borderRadius: 1,
                  boxShadow: active ? `0 0 5px ${colors[col]}` : "none",
                }} />
              );
            })}
          </div>
        ))}

        {/* ═══ CENTER MIXER ═══ */}
        {/* EQ knobs row 1 (highs) */}
        <div style={{ position: "absolute", left: "50%", top: 10, transform: "translateX(-50%)", display: "flex", gap: 6 }}>
          {[0, 1].map((i) => (
            <div key={i} style={{
              width: 12, height: 12, borderRadius: "50%",
              background: "#3a3a56",
              border: "1px solid #0a0a1a",
              position: "relative",
            }}>
              <div style={{
                position: "absolute", top: 1, left: "50%",
                width: 1.5, height: 5,
                background: "#F5A5A5",
                transform: `translateX(-50%) rotate(${40 + Math.sin(t / 5 + i) * 40}deg)`,
                transformOrigin: "50% 100%",
              }} />
            </div>
          ))}
        </div>
        {/* EQ row 2 (mids) */}
        <div style={{ position: "absolute", left: "50%", top: 26, transform: "translateX(-50%)", display: "flex", gap: 6 }}>
          {[0, 1].map((i) => (
            <div key={i} style={{
              width: 12, height: 12, borderRadius: "50%",
              background: "#3a3a56",
              border: "1px solid #0a0a1a",
              position: "relative",
            }}>
              <div style={{
                position: "absolute", top: 1, left: "50%",
                width: 1.5, height: 5,
                background: "#28D3F2",
                transform: `translateX(-50%) rotate(${-30 + Math.sin(t / 4 + i) * 30}deg)`,
                transformOrigin: "50% 100%",
              }} />
            </div>
          ))}
        </div>
        {/* EQ row 3 (lows) */}
        <div style={{ position: "absolute", left: "50%", top: 42, transform: "translateX(-50%)", display: "flex", gap: 6 }}>
          {[0, 1].map((i) => (
            <div key={i} style={{
              width: 12, height: 12, borderRadius: "50%",
              background: "#3a3a56",
              border: "1px solid #0a0a1a",
              position: "relative",
            }}>
              <div style={{
                position: "absolute", top: 1, left: "50%",
                width: 1.5, height: 5,
                background: "#7CFFB2",
                transform: `translateX(-50%) rotate(${20 + Math.sin(t / 6 + i) * 20}deg)`,
                transformOrigin: "50% 100%",
              }} />
            </div>
          ))}
        </div>

        {/* Channel faders — 2 vertical in middle */}
        <div style={{ position: "absolute", left: "50%", top: 62, transform: "translateX(-50%)", display: "flex", gap: 8 }}>
          {[0, 1].map((i) => {
            const pos = Math.sin(t / (4 + i)) * 10 + 14;
            return (
              <div key={i} style={{ position: "relative", width: 6, height: 36, background: "#0a0a1a", border: "1px solid #2a2a44" }}>
                <div style={{
                  position: "absolute", bottom: pos, left: -2, right: -2, height: 6,
                  background: i === 0 ? "#F5A5A5" : "#28D3F2",
                  border: "1px solid #0a0a1a",
                }} />
              </div>
            );
          })}
        </div>

        {/* Crossfader — horizontal bottom center */}
        <div style={{
          position: "absolute", left: "50%", bottom: 10,
          transform: "translateX(-50%)",
          width: 60, height: 5,
          background: "#0a0a1a", border: "1px solid #2a2a44",
        }}>
          <div style={{
            position: "absolute",
            left: `calc(50% + ${Math.sin(t / 3) * 20}px - 5px)`,
            top: -3, width: 10, height: 9,
            background: "#f0f0f0", border: "1px solid #0a0a1a", borderRadius: 1,
          }} />
        </div>
      </div>

      {/* ── PHREN — front-facing with built-in arms reaching out to the decks ── */}
      <div style={{
        position: "absolute",
        left: "50%", bottom: 60 + bob,
        transform: "translateX(-50%)",
        transition: "bottom 0.08s",
        zIndex: 3,
      }}>
        <PhrenSprite
          size={260}
          pose="dj"
          headphones
          mouth="open"
          blinking={t % 9 === 0}
          sparkle={false}
        />
      </div>

      {/* label */}
      <div style={{
        position: "absolute", left: 10, top: 8,
        fontFamily: "ui-monospace, monospace",
        fontSize: 8, color: "#28D3F2", opacity: 0.7, letterSpacing: 2,
        zIndex: 5,
      }}>PHREN · DDJ-400</div>

      {/* floating music notes */}
      {[0, 1].map((i) => {
        const age = (t * 2 + i * 14) % 28;
        const p = age / 28;
        const x = 20 + i * 340 + Math.sin(p * 6) * 4;
        const y = 140 - p * 120;
        return (
          <div key={i} style={{
            position: "absolute",
            left: x, top: y,
            color: i === 0 ? "#F5A5A5" : "#28D3F2",
            fontFamily: "serif",
            fontSize: 14, fontWeight: 700,
            opacity: 0.8 * (1 - p),
            zIndex: 1,
          }}>{i === 0 ? "♪" : "♫"}</div>
        );
      })}
    </SceneFrame>
  );
}

Object.assign(window, {
  SceneParachute, SceneJuggle, SceneBuild, ScenePlant,
  SceneBed, SceneAstro, SceneDance, SceneDJ,
});
