// Scenes showcasing Phren. Uses window.PhrenSprite.
// Each scene is self-contained and loops indefinitely.

const { useEffect, useState, useRef } = React;

// ── tiny hook: animation tick ─────────────────────────────────────────────
function useTick(intervalMs = 100) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((v) => v + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return t;
}

// ── Scene 1: Idle ─────────────────────────────────────────────────────────
function SceneIdle({ speed = 1 }) {
  const t = useTick(500 / speed);
  const blink = t % 9 === 0;
  const bob = t % 2 === 0 ? 0 : -4;
  return (
    <SceneFrame label="idle">
      <div style={{ transform: `translateY(${bob}px)`, transition: "transform 0.4s ease" }}>
        <PhrenSprite size={220} blinking={blink} pose="idle" />
      </div>
    </SceneFrame>
  );
}

// ── Scene 2: Running ──────────────────────────────────────────────────────
function SceneRun({ speed = 1 }) {
  const t = useTick(140 / speed);
  // move across
  const period = 40;
  const progress = (t % period) / period;
  const x = -80 + progress * 420;
  return (
    <SceneFrame label="running">
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center" }}>
        {/* ground line */}
        <div style={{ position: "absolute", left: 12, right: 12, bottom: 44, height: 1, background: "rgba(255,255,255,0.08)" }} />
        {/* dust puffs */}
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x - 30 - i * 14,
              bottom: 48,
              width: 10 - i * 2,
              height: 10 - i * 2,
              borderRadius: "50%",
              background: "rgba(156,143,248,0.25)",
              opacity: 0.6 - i * 0.2,
            }}
          />
        ))}
        <div style={{ position: "absolute", left: x, bottom: 28, transform: `translateY(${t % 2 === 0 ? -3 : 0}px)` }}>
          <PhrenSprite size={140} pose="run" bob={t % 2} facing="right" />
        </div>
      </div>
    </SceneFrame>
  );
}

// ── Scene 3: Thinking ─────────────────────────────────────────────────────
function SceneThink({ speed = 1 }) {
  const t = useTick(400 / speed);
  const dots = (t % 4);
  return (
    <SceneFrame label="thinking">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 20 }}>
        <div style={{ position: "relative" }}>
          <PhrenSprite size={170} pose="idle" blinking={t % 12 === 0} />
          {/* thought bubbles */}
          <div style={{ position: "absolute", top: -30, right: -40 }}>
            <div style={bubbleBig}>
              <span style={{ color: dots >= 1 ? "#fff" : "rgba(255,255,255,0.25)" }}>•</span>
              <span style={{ color: dots >= 2 ? "#fff" : "rgba(255,255,255,0.25)", marginLeft: 4 }}>•</span>
              <span style={{ color: dots >= 3 ? "#fff" : "rgba(255,255,255,0.25)", marginLeft: 4 }}>•</span>
            </div>
            <div style={{ ...bubbleSmall, marginTop: 4, marginLeft: 10 }} />
            <div style={{ ...bubbleTiny, marginTop: 4, marginLeft: 6 }} />
          </div>
        </div>
      </div>
    </SceneFrame>
  );
}
const bubbleBig = {
  background: "#1a1530",
  border: "1px solid rgba(156,143,248,0.4)",
  borderRadius: 14,
  padding: "8px 14px",
  fontFamily: "ui-monospace, monospace",
  fontSize: 18,
  color: "#fff",
};
const bubbleSmall = { width: 18, height: 18, borderRadius: "50%", background: "#1a1530", border: "1px solid rgba(156,143,248,0.4)" };
const bubbleTiny = { width: 10, height: 10, borderRadius: "50%", background: "#1a1530", border: "1px solid rgba(156,143,248,0.4)" };

// ── Scene 4: Chatting with Claude ─────────────────────────────────────────
const FACTS = [
  "uses 4-space tabs",
  "hates trailing commas",
  "prefers const over let",
  "ships on fridays",
  "loves rust btw",
];

function SceneChat({ speed = 1 }) {
  const t = useTick(1400 / speed);
  const step = t % 4;
  const fact = FACTS[Math.floor(t / 4) % FACTS.length];
  return (
    <SceneFrame label="chat with claude">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 50, width: "100%", justifyContent: "center", padding: "0 24px 28px" }}>
        {/* Phren column: sprite lifted up so feet align with Claude's */}
        <div style={{ position: "relative", textAlign: "center", paddingBottom: 22, paddingTop: 16 }}>
          <PhrenSprite size={120} facing="right" blinking={t % 7 === 0} />
          {(step === 0 || step === 3) && <Bubble dir="right" top={-12}>{fact}</Bubble>}
          <div style={{ fontFamily: "ui-monospace,monospace", fontSize: 11, color: "rgba(255,255,255,0.5)", position: "absolute", left: 0, right: 0, bottom: 0 }}>phren</div>
        </div>

        <div style={{ position: "relative", textAlign: "center", paddingBottom: 22, paddingTop: 16 }}>
          <div style={{ marginTop: 14 }}><ClaudeMark size={140} blink={t % 7 === 2} /></div>
          {(step === 1 || step === 2) && <Bubble dir="left" top={-12}>noted ✓</Bubble>}
          <div style={{ fontFamily: "ui-monospace,monospace", fontSize: 11, color: "rgba(255,255,255,0.5)", position: "absolute", left: 0, right: 0, bottom: 0 }}>claude</div>
        </div>
      </div>
    </SceneFrame>
  );
}

function Bubble({ children, dir = "right", top = 0 }) {
  return (
    <div
      style={{
        position: "absolute",
        top,
        [dir === "right" ? "right" : "left"]: -20,
        background: "#fff",
        color: "#12122a",
        padding: "6px 12px",
        borderRadius: 12,
        fontFamily: "ui-monospace, monospace",
        fontSize: 12,
        whiteSpace: "nowrap",
        animation: "pop 0.3s ease",
        transform: dir === "right" ? "translateX(100%)" : "translateX(-100%)",
      }}
    >
      {children}
    </div>
  );
}

function ClaudeMark({ size = 96, blink = false }) {
  // Pink Space Invader — flat-topped head, small eyes spread wide, 4 short legs.
  const P = "#E88585";
  const NAVY = "#2a1a10";
  const EYE = blink ? P : NAVY;

  const px = [
    // row 9 — flat top
    [8,9,P],[9,9,P],[10,9,P],[11,9,P],[12,9,P],[13,9,P],[14,9,P],[15,9,P],
    // row 10 — eyes
    [8,10,P],[9,10,EYE],[10,10,P],[11,10,P],[12,10,P],[13,10,P],[14,10,EYE],[15,10,P],
    // row 11 — arms (only 1 row)
    [7,11,P],[8,11,P],[9,11,P],[10,11,P],[11,11,P],[12,11,P],[13,11,P],[14,11,P],[15,11,P],[16,11,P],
    // row 12 — body, no arms
    [8,12,P],[9,12,P],[10,12,P],[11,12,P],[12,12,P],[13,12,P],[14,12,P],[15,12,P],
    // row 13 — filled row above legs (solid base)
    [8,13,P],[9,13,P],[10,13,P],[11,13,P],[12,13,P],[13,13,P],[14,13,P],[15,13,P],
    // row 14 — 4 legs stubs
    [8,14,P],         [10,14,P],         [13,14,P],         [15,14,P],
  ];

  return (
    <svg width={size} height={size} viewBox="6 8 12 8" shapeRendering="crispEdges" style={{ imageRendering: "pixelated", overflow: "visible" }}>
      {px.map(([c,r,color], i) => (
        <rect key={i} x={c} y={r} width={1.02} height={1.02} fill={color} />
      ))}
    </svg>
  );
}

// ── Scene 5: Digging memories ─────────────────────────────────────────────
function SceneDig({ speed = 1 }) {
  const t = useTick(700 / speed);
  const step = t % 6;
  const cardsOut = step >= 2;
  return (
    <SceneFrame label="recalling findings">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 30 }}>
        <div style={{ transform: `translateY(${t % 2 === 0 ? -2 : 0}px)` }}>
          <PhrenSprite size={150} facing="right" armUp={step >= 1} blinking={t % 9 === 0} />
        </div>
        <div style={{ position: "relative" }}>
          <Cabinet />
          {/* card popping out */}
          <div
            style={{
              position: "absolute",
              top: cardsOut ? -40 : 10,
              left: 10,
              opacity: cardsOut ? 1 : 0,
              transition: "all 0.6s cubic-bezier(.22,1.4,.36,1)",
              transform: cardsOut ? "rotate(-6deg)" : "rotate(0)",
            }}
          >
            <FindingCard tag="decision" text="use pnpm workspaces" />
          </div>
          <div
            style={{
              position: "absolute",
              top: cardsOut ? -20 : 10,
              left: 60,
              opacity: cardsOut ? 1 : 0,
              transition: "all 0.7s cubic-bezier(.22,1.4,.36,1) 0.1s",
              transform: cardsOut ? "rotate(8deg)" : "rotate(0)",
            }}
          >
            <FindingCard tag="pitfall" text="don't mutate store" />
          </div>
        </div>
      </div>
    </SceneFrame>
  );
}

function Cabinet() {
  return (
    <svg width={120} height={140} viewBox="0 0 120 140" shapeRendering="crispEdges">
      {/* body */}
      <rect x="10" y="10" width="100" height="120" fill="#2a2450" stroke="#4a3f7a" strokeWidth="2" />
      {/* drawers */}
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x="18" y={22 + i * 35} width="84" height="28" fill="#1a1530" stroke="#4a3f7a" strokeWidth="1" />
          <rect x="52" y={33 + i * 35} width="16" height="4" fill="#9c8ff8" />
        </g>
      ))}
    </svg>
  );
}

function FindingCard({ tag, text }) {
  const tagColors = {
    decision: "#7C3AED",
    pitfall: "#D97757",
    pattern: "#28D3F2",
    bug: "#e04e4e",
  };
  return (
    <div
      style={{
        background: "#fff",
        color: "#12122a",
        width: 120,
        padding: "6px 8px",
        fontFamily: "ui-monospace,monospace",
        fontSize: 10,
        borderRadius: 2,
        boxShadow: "2px 2px 0 rgba(0,0,0,0.4)",
        border: "1px solid #12122a",
      }}
    >
      <div style={{ fontSize: 8, color: tagColors[tag] || "#7C3AED", textTransform: "uppercase", letterSpacing: 1, marginBottom: 2 }}>
        [{tag}]
      </div>
      <div>{text}</div>
    </div>
  );
}

// ── Scene 6: Writing ──────────────────────────────────────────────────────
function SceneWrite({ speed = 1 }) {
  const t = useTick(180 / speed);
  const full = "use FTS5 for search; fall back to semantic";
  const chars = (t * 2) % (full.length + 30);
  const shown = full.slice(0, Math.min(chars, full.length));
  return (
    <SceneFrame label="writing a finding">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 20 }}>
        <PhrenSprite size={140} facing="right" armUp blinking={t % 20 === 0} />
        <div
          style={{
            background: "#fff",
            color: "#12122a",
            padding: "12px 14px",
            width: 240,
            minHeight: 100,
            fontFamily: "ui-monospace,monospace",
            fontSize: 11,
            borderRadius: 2,
            boxShadow: "3px 3px 0 rgba(0,0,0,0.4)",
            border: "1px solid #12122a",
            transform: "rotate(-1.5deg)",
          }}
        >
          <div style={{ fontSize: 9, color: "#7C3AED", letterSpacing: 1, marginBottom: 6 }}>
            [PATTERN]
          </div>
          <div>
            {shown}
            <span style={{ opacity: t % 2 ? 1 : 0 }}>▋</span>
          </div>
        </div>
      </div>
    </SceneFrame>
  );
}

// ── Scene 7: Team sync ────────────────────────────────────────────────────
function SceneTeam({ speed = 1 }) {
  const t = useTick(1600 / speed);
  const goingRight = t % 2 === 0;
  // Random-ish finding number, stable per tick
  const findingNum = 1000 + ((t * 37) % 900);
  const throwDur = 900 / speed;
  const catchDelay = throwDur; // got it! appears after throw finishes
  const gotItDur = 500 / speed; // how long got it! lingers

  return (
    <SceneFrame label="team store sync">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "0 40px", position: "relative" }}>
        <div style={{ position: "relative" }}>
          <PhrenSprite size={110} facing="right" blinking={t % 8 === 0} />
          <div style={{ fontFamily: "ui-monospace,monospace", fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 2, textAlign: "center" }}>~/you</div>
          {/* got it bubble on left when catching (t is odd = just caught here) */}
          {!goingRight && (
            <div
              key={`catch-L-${t}`}
              style={{
                position: "absolute",
                top: -14,
                right: -10,
                background: "#fff",
                color: "#12122a",
                padding: "3px 8px",
                borderRadius: 10,
                fontFamily: "ui-monospace,monospace",
                fontSize: 10,
                whiteSpace: "nowrap",
                border: "1px solid #12122a",
                animation: `gotit-pop ${(throwDur + gotItDur + 200) / 1000}s ease forwards`,
                opacity: 0,
              }}
            >
              got it!
            </div>
          )}
        </div>
        {/* flying card zone */}
        <div style={{ position: "relative", flex: 1, height: 70, margin: "0 20px" }}>
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
            <line x1="0" y1="35" x2="100%" y2="35" stroke="rgba(156,143,248,0.3)" strokeWidth="1" strokeDasharray="3 3" />
          </svg>
          <div
            key={`throw-${t}`}
            style={{
              position: "absolute",
              top: 22,
              fontFamily: "ui-monospace,monospace",
              fontSize: 9,
              background: "#fff",
              color: "#12122a",
              padding: "3px 6px",
              border: "1px solid #12122a",
              boxShadow: "2px 2px 0 rgba(0,0,0,0.3)",
              animation: `${goingRight ? "fly-right" : "fly-left"} ${throwDur / 1000}s cubic-bezier(.3,0,.7,1) forwards`,
              whiteSpace: "nowrap",
            }}
          >
            finding #{findingNum}
          </div>
          <style>{`
            @keyframes fly-right {
              0%   { left: 0%;   transform: translate(0, 0);       opacity: 0; }
              10%  {                                                opacity: 1; }
              50%  {              transform: translate(0, -14px);               }
              85%  { left: 100%; transform: translate(-100%, 0);   opacity: 1; }
              100% { left: 100%; transform: translate(-100%, 0);   opacity: 0; }
            }
            @keyframes fly-left {
              0%   { left: 100%; transform: translate(-100%, 0);   opacity: 0; }
              10%  {                                                opacity: 1; }
              50%  {              transform: translate(-100%, -14px);           }
              85%  { left: 0%;   transform: translate(0, 0);       opacity: 1; }
              100% { left: 0%;   transform: translate(0, 0);       opacity: 0; }
            }
            @keyframes gotit-pop {
              0%   { opacity: 0; transform: scale(0.7) translateY(4px); }
              ${(catchDelay / (throwDur + gotItDur + 200)) * 100}% { opacity: 0; transform: scale(0.7) translateY(4px); }
              ${((catchDelay + 100) / (throwDur + gotItDur + 200)) * 100}% { opacity: 1; transform: scale(1) translateY(0); }
              ${((catchDelay + gotItDur) / (throwDur + gotItDur + 200)) * 100}% { opacity: 1; transform: scale(1) translateY(0); }
              100% { opacity: 0; transform: scale(1) translateY(-2px); }
            }
          `}</style>
        </div>
        <div style={{ position: "relative" }}>
          <PhrenSprite size={110} facing="left" blinking={t % 8 === 3} />
          <div style={{ fontFamily: "ui-monospace,monospace", fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 2, textAlign: "center" }}>~/teammate</div>
          {goingRight && (
            <div
              key={`catch-R-${t}`}
              style={{
                position: "absolute",
                top: -14,
                left: -10,
                background: "#fff",
                color: "#12122a",
                padding: "3px 8px",
                borderRadius: 10,
                fontFamily: "ui-monospace,monospace",
                fontSize: 10,
                whiteSpace: "nowrap",
                border: "1px solid #12122a",
                animation: `gotit-pop ${(throwDur + gotItDur + 200) / 1000}s ease forwards`,
                opacity: 0,
              }}
            >
              got it!
            </div>
          )}
        </div>
      </div>
    </SceneFrame>
  );
}

// ── Scene 8: Celebration ──────────────────────────────────────────────────
function SceneCelebrate({ speed = 1 }) {
  const t = useTick(200 / speed);
  const jump = Math.abs(Math.sin(t * 0.5)) > 0.7;
  return (
    <SceneFrame label="task complete!">
      <div style={{ position: "relative" }}>
        {/* confetti */}
        {Array.from({ length: 14 }).map((_, i) => {
          const angle = (i / 14) * Math.PI * 2;
          const radius = 70 + ((t + i * 3) % 30);
          const x = Math.cos(angle) * radius;
          const y = Math.sin(angle) * radius;
          const colors = ["#7C3AED", "#28D3F2", "#fff", "#9c8ff8"];
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                width: 4,
                height: 4,
                background: colors[i % 4],
                transform: `translate(${x}px, ${y}px) rotate(${i * 30}deg)`,
                transition: "transform 0.3s linear",
              }}
            />
          );
        })}
        <div style={{ transform: `translateY(${jump ? -18 : 0}px)`, transition: "transform 0.2s ease-out" }}>
          <PhrenSprite size={180} pose={jump ? "jump" : "idle"} flash={jump} />
        </div>
      </div>
    </SceneFrame>
  );
}

// ── Frame wrapper ─────────────────────────────────────────────────────────
function SceneFrame({ label, children }) {
  return (
    <div
      style={{
        position: "relative",
        background: "var(--panel-bg, #12122a)",
        border: "1px solid var(--panel-border, rgba(156,143,248,0.2))",
        borderRadius: 6,
        aspectRatio: "16 / 10",
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {/* subtle grid */}
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.12, pointerEvents: "none" }}>
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#9c8ff8" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>
      {children}
      <div
        style={{
          position: "absolute",
          bottom: 8,
          left: 10,
          fontFamily: "ui-monospace,monospace",
          fontSize: 10,
          color: "rgba(255,255,255,0.4)",
          letterSpacing: 1,
          textTransform: "uppercase",
        }}
      >
        ▸ {label}
      </div>
    </div>
  );
}

Object.assign(window, {
  SceneIdle, SceneRun, SceneThink, SceneChat, SceneDig, SceneWrite, SceneTeam, SceneCelebrate,
});
