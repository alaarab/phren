// Main app — single mount point, shared state.

const { useState, useEffect } = React;

const SCENES = [
  { key: "idle",       name: "idle",        Comp: SceneIdle,      desc: "bobs, blinks, sparkles. ambient life for any empty state." },
  { key: "run",        name: "running",     Comp: SceneRun,       desc: "dashing across the viewport. feet animate each frame." },
  { key: "think",      name: "thinking",    Comp: SceneThink,     desc: "retrieving context. thought bubbles ellipsis-cycle." },
  { key: "chat",       name: "with claude", Comp: SceneChat,      desc: "phren hands a finding over. claude says noted." },
  { key: "dig",        name: "recalling",   Comp: SceneDig,       desc: "findings pop out of the cabinet, tagged and dated." },
  { key: "write",      name: "writing",     Comp: SceneWrite,     desc: "capturing a new finding. typewriter cadence." },
  { key: "team",       name: "team sync",   Comp: SceneTeam,      desc: "findings flit between stores. dashed trail shows the wire." },
  { key: "celebrate",  name: "celebrate",   Comp: SceneCelebrate, desc: "task done. confetti, jump, flash." },
  { key: "parachute",  name: "parachute",   Comp: SceneParachute, desc: "drifting down on a purple chute, canopy sways." },
  { key: "dj",         name: "DJing",       Comp: SceneDJ,        desc: "behind the decks, headphones on, scratching to the beat." },
  { key: "juggle",     name: "juggle",      Comp: SceneJuggle,    desc: "hands catch and throw, head tracks the top ball." },
  { key: "build",      name: "compiling",   Comp: SceneBuild,     desc: "progress bar creeping toward 100%." },
  { key: "plant",      name: "growing",     Comp: ScenePlant,     desc: "waters a plant — seed to flower and back." },
  { key: "skate",      name: "skateboarding", Comp: SceneBed,     desc: "rolling along and popping kickflips." },
  { key: "astro",      name: "zero g",      Comp: SceneAstro,     desc: "tumbling slowly past a ringed planet." },
  { key: "dance",      name: "dance",       Comp: SceneDance,     desc: "bounce step, alternating arms, hip sway." },
];

function HeroPhren({ speed, scale }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((v) => v + 1), 500 / speed);
    return () => clearInterval(id);
  }, [speed]);
  const blink = t % 11 === 0;
  const bob = t % 2 ? -4 : 0;
  return (
    <div style={{ transform: `translateY(${bob}px) scale(${scale})`, transition: "transform 0.4s ease" }}>
      <PhrenSprite size={180} blinking={blink} />
    </div>
  );
}

function Reel({ speed }) {
  return (
    <>
      {SCENES.map((s) => (
        <div className="card" key={s.key}>
          <div className="card-scene">
            <s.Comp speed={speed} />
          </div>
          <div className="card-foot">
            <span className="name">{s.name}</span>
            <span className="desc">{s.desc.split(".")[0]}</span>
          </div>
        </div>
      ))}
    </>
  );
}

function Sheet({ scale }) {
  const poses = [
    // Stances
    { label: "idle", props: {} },
    { label: "blink", props: { blinking: true } },
    { label: "run-L", props: { pose: "run", bob: 0 } },
    { label: "run-R", props: { pose: "run", bob: 1 } },
    { label: "jump", props: { pose: "jump" } },
    { label: "crouch", props: { pose: "crouch" } },
    { label: "kick", props: { pose: "kick" } },
    { label: "split", props: { pose: "split" } },
    { label: "skate", props: { pose: "skate" } },
    { label: "sit", props: { sit: true } },
    { label: "sleep", props: { pose: "sleep" } },
    { label: "squish", props: { squish: true } },
    { label: "stretch", props: { stretch: true } },
    // Eyes
    { label: "look up", props: { lookUp: true } },
    { label: "look down", props: { lookDown: true } },
    { label: "look left", props: { lookLeft: true } },
    { label: "look right", props: { lookRight: true } },
    { label: "squint", props: { squint: true } },
    { label: "star eyes", props: { starEyes: true, mouth: "smile" } },
    { label: "heart eyes", props: { heartEyes: true, mouth: "smile", flush: true } },
    { label: "x eyes", props: { xEyes: true, mouth: "open" } },
    // Mouths
    { label: "smile", props: { mouth: "smile" } },
    { label: "open", props: { mouth: "open" } },
    { label: "yell", props: { mouth: "yell" } },
    { label: "yawn", props: { mouth: "yawn", squint: true } },
    { label: "tongue", props: { mouth: "tongue", flush: true } },
    { label: "grit", props: { mouth: "grit" } },
    { label: "flush", props: { flush: true, mouth: "smile" } },
    // Arms
    { label: "arm up", props: { armUp: true } },
    { label: "pointing", props: { pointing: true } },
    { label: "arms V", props: { armsUp: true, mouth: "smile" } },
    { label: "arms Y", props: { armsOverhead: true } },
    { label: "arms out", props: { armsOut: true } },
    { label: "hips", props: { handsOnHips: true } },
    // Accessories
    { label: "headphones", props: { headphones: true } },
    { label: "shades", props: { shades: true, mouth: "smile" } },
    { label: "party", props: { hat: "party", mouth: "smile" } },
    { label: "cap", props: { hat: "cap" } },
    // Extras
    { label: "hearts", props: { hearts: true, heartEyes: true, mouth: "smile", flush: true } },
    { label: "sweat", props: { sweat: true } },
    { label: "flash", props: { flash: true } },
    { label: "facing R", props: { facing: "right" } },
    { label: "tilted", props: { tilt: 15 } },
  ];
  return (
    <div style={{
      background: "var(--panel-bg)",
      border: "1px solid var(--panel-border)",
      borderRadius: 6,
      padding: 20,
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
      gap: 16,
    }}>
      {poses.map((p) => (
        <div key={p.label} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: 12, border: "1px dashed var(--panel-border)", borderRadius: 4 }}>
          <PhrenSprite size={110 * scale} {...p.props} sparkle={false} />
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--muted)", letterSpacing: 1 }}>{p.label}</div>
        </div>
      ))}
    </div>
  );
}

function SpotlightScene({ scene, speed }) {
  useEffect(() => {
    const t = document.getElementById("spot-title");
    const d = document.getElementById("spot-desc");
    if (t) t.textContent = scene.name.replace(/^\w/, (c) => c.toUpperCase());
    if (d) d.textContent = scene.desc;
  }, [scene]);
  const Comp = scene.Comp;
  return <Comp speed={speed} />;
}

// Shared state holder + broadcast
window.__phrenState = {
  theme: window.TWEAKS.theme,
  speed: window.TWEAKS.speed,
  scale: window.TWEAKS.scale,
  spotlight: window.TWEAKS.spotlight,
};
function updateState(patch) {
  window.__phrenState = { ...window.__phrenState, ...patch };
  window.dispatchEvent(new CustomEvent("phren-state", { detail: window.__phrenState }));
  window.parent.postMessage({ type: "__edit_mode_set_keys", edits: patch }, "*");
}
function useSharedState() {
  const [s, setS] = useState(window.__phrenState);
  useEffect(() => {
    function on(e) { setS({ ...e.detail }); }
    window.addEventListener("phren-state", on);
    return () => window.removeEventListener("phren-state", on);
  }, []);
  return s;
}

function Mount({ part }) {
  const s = useSharedState();
  if (part === "hero") return <HeroPhren speed={s.speed} scale={s.scale} />;
  if (part === "spotlight") {
    const sc = SCENES.find((x) => x.key === s.spotlight) || SCENES[0];
    return (
      <>
        <SpotlightScene scene={sc} speed={s.speed} />
        {ReactDOM.createPortal(
          SCENES.map((x) => (
            <div
              key={x.key}
              className={"chip" + (x.key === s.spotlight ? " active" : "")}
              onClick={() => updateState({ spotlight: x.key })}
            >
              {x.name}
            </div>
          )),
          document.getElementById("spot-chips")
        )}
      </>
    );
  }
  if (part === "reel") return <Reel speed={s.speed} />;
  if (part === "sheet") return <Sheet scale={s.scale} />;
  return null;
}

// Mount roots
ReactDOM.createRoot(document.getElementById("hero-phren")).render(<Mount part="hero" />);
ReactDOM.createRoot(document.getElementById("spotlight-scene")).render(<Mount part="spotlight" />);
ReactDOM.createRoot(document.getElementById("reel")).render(<Mount part="reel" />);
ReactDOM.createRoot(document.getElementById("sheet")).render(<Mount part="sheet" />);

// Theme
document.body.classList.toggle("light", window.__phrenState.theme === "light");

// Edit mode wiring + Tweaks panel
(function wireTweaks() {
  const panel = document.getElementById("tweaks-panel");
  function show(v) { panel.style.display = v ? "block" : "none"; }
  window.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.type === "__activate_edit_mode") show(true);
    if (d.type === "__deactivate_edit_mode") show(false);
  });
  window.parent.postMessage({ type: "__edit_mode_available" }, "*");

  const speed = document.getElementById("speed");
  const scale = document.getElementById("scale");
  const spv = document.getElementById("speed-val");
  const scv = document.getElementById("size-val");
  speed.value = window.__phrenState.speed;
  scale.value = window.__phrenState.scale;
  spv.textContent = (+window.__phrenState.speed).toFixed(1) + "×";
  scv.textContent = (+window.__phrenState.scale).toFixed(1) + "×";
  speed.addEventListener("input", (e) => {
    const v = +e.target.value;
    spv.textContent = v.toFixed(1) + "×";
    updateState({ speed: v });
  });
  scale.addEventListener("input", (e) => {
    const v = +e.target.value;
    scv.textContent = v.toFixed(1) + "×";
    updateState({ scale: v });
  });

  const themeSeg = document.getElementById("theme-seg");
  [...themeSeg.querySelectorAll("button")].forEach((b) => b.classList.toggle("active", b.dataset.v === window.__phrenState.theme));
  themeSeg.addEventListener("click", (e) => {
    const v = e.target?.dataset?.v;
    if (!v) return;
    [...themeSeg.querySelectorAll("button")].forEach((b) => b.classList.toggle("active", b.dataset.v === v));
    document.body.classList.toggle("light", v === "light");
    updateState({ theme: v });
  });

  const spotSeg = document.getElementById("spot-seg");
  function renderSpot() {
    spotSeg.innerHTML = "";
    SCENES.forEach((sc) => {
      const b = document.createElement("button");
      b.textContent = sc.key;
      b.dataset.v = sc.key;
      if (sc.key === window.__phrenState.spotlight) b.classList.add("active");
      b.onclick = () => {
        updateState({ spotlight: sc.key });
        renderSpot();
      };
      spotSeg.appendChild(b);
    });
  }
  renderSpot();
  window.addEventListener("phren-state", renderSpot);
})();
