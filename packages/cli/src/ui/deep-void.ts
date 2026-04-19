// Phren Deep Void — a futuristic dark skin for the web UI.
//
// Ships on top of the base styles in assets.ts. Activates via the existing
// `data-theme="dark"` toggle; the palette swap and glow treatments all scope
// to that attribute so the light "paper" theme is untouched.
//
// Visual language mirrors docs/index.html + docs/motion-lab/:
//   bg       #0a0a1a   cosmic navy
//   panel    #12122a   phren translucent panel
//   accent   #7C3AED   phren violet
//   cyan     #28D3F2   sparkle cyan
//   ink      #ece9f5   soft lavender-white
//
// Tokens override existing vars. Supplementary rules add glow, glass
// panels, a subtle starfield, and richer graph node auras.
export const PHREN_DEEP_VOID_STYLES = `
  /* ── Phren Deep Void — palette tokens ─────────────────────────── */
  [data-theme="dark"] {
    --bg: #0a0a1a;
    --surface: rgba(18, 18, 42, 0.72);
    --surface-raised: rgba(22, 22, 53, 0.78);
    --surface-sunken: #0d0d22;
    --surface-solid: #12122a;

    --ink: #ece9f5;
    --ink-secondary: #c8c3e3;
    --muted: rgba(236, 233, 245, 0.55);

    --accent: #9058f0;
    --accent-hover: #b07aff;
    --accent-solid: #7C3AED;
    --accent-dim: rgba(124, 58, 237, 0.16);
    --accent-glow: rgba(124, 58, 237, 0.42);

    --cyan: #28D3F2;
    --cyan-dim: rgba(40, 211, 242, 0.14);
    --cyan-glow: rgba(40, 211, 242, 0.36);

    --purple: #9058f0;
    --purple-dim: rgba(124, 58, 237, 0.14);

    --border: rgba(156, 143, 248, 0.18);
    --border-light: rgba(156, 143, 248, 0.08);
    --border-strong: rgba(156, 143, 248, 0.32);

    --danger: #f87171;
    --danger-dim: rgba(248, 113, 113, 0.14);
    --warning: #fbbf24;
    --warning-dim: rgba(251, 191, 36, 0.14);
    --success: #4ade80;
    --success-dim: rgba(74, 222, 128, 0.14);

    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.55);
    --shadow: 0 6px 24px rgba(0, 0, 0, 0.55), 0 0 1px rgba(124, 58, 237, 0.35);
    --shadow-lg: 0 16px 48px rgba(0, 0, 0, 0.65),
                 0 0 0 1px rgba(156, 143, 248, 0.12),
                 0 0 32px rgba(124, 58, 237, 0.18);

    --font: "Space Grotesk", "Inter", system-ui, -apple-system, sans-serif;
    --mono: "JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace;

    /* pixel-art crispness */
    --radius: 6px;
    --radius-sm: 4px;
  }

  /* ── Ambient starfield + cosmic gradient ──────────────────────── */
  [data-theme="dark"] body {
    background:
      radial-gradient(1200px 800px at 15% -5%, rgba(124, 58, 237, 0.18), transparent 55%),
      radial-gradient(900px 700px at 105% 20%, rgba(40, 211, 242, 0.12), transparent 55%),
      radial-gradient(700px 500px at 50% 110%, rgba(103, 226, 248, 0.08), transparent 60%),
      var(--bg);
    background-attachment: fixed;
  }
  [data-theme="dark"] body::before {
    /* drifting pixel-dust stars — transform-only, GPU composited */
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    will-change: transform;
    transform: translate3d(0, 0, 0);
    background-image:
      radial-gradient(1px 1px at 10% 20%, rgba(236, 233, 245, 0.5), transparent 60%),
      radial-gradient(1px 1px at 70% 35%, rgba(40, 211, 242, 0.55), transparent 60%),
      radial-gradient(1px 1px at 25% 70%, rgba(124, 58, 237, 0.5), transparent 60%),
      radial-gradient(1px 1px at 85% 80%, rgba(236, 233, 245, 0.45), transparent 60%),
      radial-gradient(1px 1px at 45% 50%, rgba(40, 211, 242, 0.4), transparent 60%),
      radial-gradient(1px 1px at 90% 12%, rgba(236, 233, 245, 0.55), transparent 60%),
      radial-gradient(1px 1px at 5% 55%, rgba(124, 58, 237, 0.45), transparent 60%);
    opacity: 0.9;
    animation: phren-stars-drift 80s linear infinite;
    z-index: 0;
  }
  @keyframes phren-stars-drift {
    0%   { transform: translate3d(0, 0, 0); }
    100% { transform: translate3d(-40px, -24px, 0); }
  }
  /* Respect users who prefer calmer motion: kill long-running ambient loops. */
  @media (prefers-reduced-motion: reduce) {
    [data-theme="dark"] body::before,
    [data-theme="dark"] .graph-nebula,
    [data-theme="dark"] .project-detail-empty::before,
    [data-theme="dark"] .reader-empty::before,
    [data-theme="dark"] .cmdpal-empty::before { animation: none !important; }
  }
  /* Ensure chrome sits above the starfield */
  [data-theme="dark"] .header,
  [data-theme="dark"] .main,
  [data-theme="dark"] .cmdpal-overlay,
  [data-theme="dark"] .toast-container,
  [data-theme="dark"] .batch-bar {
    position: relative;
    z-index: 1;
  }
  [data-theme="dark"] .header { z-index: 100; }

  /* ── Glass header ─────────────────────────────────────────────── */
  [data-theme="dark"] .header {
    background: rgba(10, 10, 26, 0.68);
    backdrop-filter: blur(20px) saturate(1.4);
    -webkit-backdrop-filter: blur(20px) saturate(1.4);
    border-bottom: 1px solid rgba(156, 143, 248, 0.14);
    box-shadow:
      0 1px 0 rgba(156, 143, 248, 0.12),
      0 0 40px rgba(124, 58, 237, 0.06);
  }
  [data-theme="dark"] .header-brand {
    color: var(--ink);
    font-family: var(--font);
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  [data-theme="dark"] .header-brand svg {
    filter: drop-shadow(0 0 6px rgba(124, 58, 237, 0.55));
  }

  /* Active tab: cyan rail + soft glow */
  [data-theme="dark"] .nav-item {
    font-family: var(--font);
    letter-spacing: 0.01em;
    transition: color .18s ease, border-color .18s ease, text-shadow .18s ease;
  }
  [data-theme="dark"] .nav-item:hover {
    color: var(--ink);
    text-shadow: 0 0 12px rgba(40, 211, 242, 0.35);
  }
  [data-theme="dark"] .nav-item.active {
    color: var(--cyan);
    border-bottom-color: var(--cyan);
    text-shadow: 0 0 12px rgba(40, 211, 242, 0.55);
  }
  [data-theme="dark"] .nav-item .count {
    background: var(--accent-dim);
    color: #c8b4ff;
    border: 1px solid rgba(156, 143, 248, 0.22);
    font-family: var(--mono);
    box-shadow: inset 0 0 0 1px rgba(124, 58, 237, 0.08);
  }

  /* ── Cards and panels — glass with violet rim ─────────────────── */
  /* backdrop-filter is expensive on large grids; keep blur modest (10px) and
     only apply where it materially improves the glass feel (cards, nav,
     overlays). Solid surfaces use plain translucent rgba instead. */
  [data-theme="dark"] .card,
  [data-theme="dark"] .project-card,
  [data-theme="dark"] .review-card,
  [data-theme="dark"] .skill-card,
  [data-theme="dark"] .review-help,
  [data-theme="dark"] .split-view,
  [data-theme="dark"] .graph-container,
  [data-theme="dark"] .cmdpal-box {
    background: rgba(18, 18, 42, 0.78);
    backdrop-filter: blur(10px) saturate(1.25);
    -webkit-backdrop-filter: blur(10px) saturate(1.25);
    border: 1px solid rgba(156, 143, 248, 0.16);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.02),
      0 4px 24px rgba(0, 0, 0, 0.45);
  }
  [data-theme="dark"] .card-header { background: rgba(13, 13, 34, 0.6); border-bottom-color: rgba(156, 143, 248, 0.1); }
  [data-theme="dark"] .split-sidebar { background: rgba(10, 10, 26, 0.55); border-right-color: rgba(156, 143, 248, 0.12); }
  [data-theme="dark"] .reader-toolbar { background: rgba(10, 10, 26, 0.6); border-bottom-color: rgba(156, 143, 248, 0.1); }
  [data-theme="dark"] .project-card:hover {
    transform: translateY(-2px);
    border-color: rgba(124, 58, 237, 0.42);
    box-shadow:
      0 12px 36px rgba(0, 0, 0, 0.55),
      0 0 0 1px rgba(124, 58, 237, 0.22),
      0 0 40px rgba(124, 58, 237, 0.18);
  }
  [data-theme="dark"] .project-card.selected {
    border-color: var(--cyan);
    box-shadow:
      0 0 0 1px var(--cyan),
      0 0 32px rgba(40, 211, 242, 0.28);
  }
  [data-theme="dark"] .review-card:hover {
    border-color: rgba(124, 58, 237, 0.36);
    box-shadow:
      0 0 0 1px rgba(124, 58, 237, 0.22),
      0 8px 28px rgba(0, 0, 0, 0.5),
      0 0 30px rgba(124, 58, 237, 0.14);
  }

  /* ── Buttons — solid violet, cyan focus ring ──────────────────── */
  [data-theme="dark"] .btn {
    background: rgba(18, 18, 42, 0.68);
    border-color: rgba(156, 143, 248, 0.22);
    color: var(--ink-secondary);
    font-family: var(--font);
    letter-spacing: 0.01em;
    transition: all .18s ease;
  }
  [data-theme="dark"] .btn:hover {
    border-color: rgba(156, 143, 248, 0.5);
    color: var(--ink);
    background: rgba(28, 28, 64, 0.78);
    box-shadow: 0 0 24px rgba(124, 58, 237, 0.22);
  }
  [data-theme="dark"] .btn-primary {
    background: linear-gradient(180deg, #8b5cf6, #6d32d9);
    color: #fff;
    border: 1px solid rgba(156, 143, 248, 0.55);
    box-shadow:
      0 6px 20px rgba(124, 58, 237, 0.45),
      inset 0 1px 0 rgba(255, 255, 255, 0.18);
  }
  [data-theme="dark"] .btn-primary:hover {
    background: linear-gradient(180deg, #9870ff, #7a3de8);
    box-shadow:
      0 8px 28px rgba(124, 58, 237, 0.55),
      inset 0 1px 0 rgba(255, 255, 255, 0.22);
  }
  [data-theme="dark"] .btn-approve {
    background: rgba(74, 222, 128, 0.14);
    color: #8ef0a8;
    border-color: rgba(74, 222, 128, 0.28);
  }
  [data-theme="dark"] .btn-approve:hover {
    background: linear-gradient(180deg, #4ade80, #22c55e);
    color: #0a0a1a;
    box-shadow: 0 0 24px rgba(74, 222, 128, 0.4);
  }

  /* ── Inputs — cyan focus glow ─────────────────────────────────── */
  [data-theme="dark"] .projects-search,
  [data-theme="dark"] .task-filter-select,
  [data-theme="dark"] .review-filters select,
  [data-theme="dark"] .review-edit-textarea,
  [data-theme="dark"] .cmdpal-input,
  [data-theme="dark"] input[type="text"],
  [data-theme="dark"] input[type="search"],
  [data-theme="dark"] textarea:not(.review-edit-textarea) {
    background: rgba(13, 13, 34, 0.8) !important;
    color: var(--ink);
    border-color: rgba(156, 143, 248, 0.2);
    font-family: var(--mono);
  }
  [data-theme="dark"] .projects-search:focus,
  [data-theme="dark"] input[type="text"]:focus,
  [data-theme="dark"] input[type="search"]:focus,
  [data-theme="dark"] textarea:focus,
  [data-theme="dark"] .cmdpal-input:focus,
  [data-theme="dark"] .review-edit-textarea:focus {
    border-color: var(--cyan) !important;
    box-shadow: 0 0 0 3px var(--cyan-dim), 0 0 24px rgba(40, 211, 242, 0.18) !important;
    outline: none !important;
  }

  /* ── Badges ──────────────────────────────────────────────────── */
  [data-theme="dark"] .badge { background: rgba(18, 18, 42, 0.7); color: var(--ink-secondary); border: 1px solid rgba(156, 143, 248, 0.15); font-family: var(--mono); }
  [data-theme="dark"] .badge-project { background: rgba(124, 58, 237, 0.18); color: #c8b4ff; border-color: rgba(124, 58, 237, 0.35); }
  [data-theme="dark"] .badge-on { background: rgba(74, 222, 128, 0.16); color: #8ef0a8; border-color: rgba(74, 222, 128, 0.3); }
  [data-theme="dark"] .badge-off { background: rgba(248, 113, 113, 0.14); color: #f9a0a0; border-color: rgba(248, 113, 113, 0.28); }
  [data-theme="dark"] .badge-count { background: var(--accent-solid); color: #fff; box-shadow: 0 0 12px rgba(124, 58, 237, 0.5); }

  /* ── Split list (skills / hooks) ─────────────────────────────── */
  [data-theme="dark"] .split-item.selected,
  [data-theme="dark"] .hook-item.selected {
    background: linear-gradient(90deg, rgba(124, 58, 237, 0.22), rgba(124, 58, 237, 0) 85%);
    border-left: 3px solid var(--cyan);
    box-shadow: inset 0 0 18px rgba(40, 211, 242, 0.08);
  }
  [data-theme="dark"] .split-item:hover,
  [data-theme="dark"] .hook-item:hover { background: rgba(124, 58, 237, 0.08); }
  [data-theme="dark"] .split-group-label { background: rgba(10, 10, 26, 0.7); color: var(--cyan); font-family: var(--mono); letter-spacing: 0.12em; border-bottom-color: rgba(156, 143, 248, 0.12); }

  /* ── Graph container + controls ──────────────────────────────── */
  [data-theme="dark"] .graph-container { background: radial-gradient(1600px 900px at 50% 50%, rgba(18, 18, 42, 0.6), rgba(10, 10, 26, 0.9) 70%); border: 1px solid rgba(156, 143, 248, 0.18); }
  [data-theme="dark"] #graph-canvas { filter: drop-shadow(0 0 30px rgba(124, 58, 237, 0.04)); }
  [data-theme="dark"] .graph-controls button {
    background: rgba(18, 18, 42, 0.68);
    border-color: rgba(156, 143, 248, 0.22);
    color: var(--ink);
    font-family: var(--mono);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
  }
  [data-theme="dark"] .graph-controls button:hover { background: rgba(28, 28, 64, 0.85); border-color: var(--cyan); box-shadow: 0 0 18px rgba(40, 211, 242, 0.25); }
  [data-theme="dark"] .graph-tooltip { background: rgba(10, 10, 26, 0.92); border: 1px solid rgba(124, 58, 237, 0.35); color: var(--ink); box-shadow: 0 0 20px rgba(124, 58, 237, 0.25); font-family: var(--mono); font-size: 11px; }
  [data-theme="dark"] .graph-filter-btn { background: rgba(18, 18, 42, 0.72); border: 1px solid rgba(156, 143, 248, 0.2); color: var(--muted); font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.08em; border-radius: 4px; }
  [data-theme="dark"] .graph-filter-btn:hover { border-color: var(--cyan); color: var(--ink); background: rgba(40, 211, 242, 0.08); box-shadow: 0 0 16px rgba(40, 211, 242, 0.2); }
  [data-theme="dark"] .graph-filter-btn.active { background: linear-gradient(180deg, rgba(124, 58, 237, 0.38), rgba(124, 58, 237, 0.22)); color: #fff; border-color: rgba(156, 143, 248, 0.55); box-shadow: 0 0 20px rgba(124, 58, 237, 0.42); }
  [data-theme="dark"] .graph-legend { background: rgba(10, 10, 26, 0.72); border-top: 1px solid rgba(156, 143, 248, 0.14); backdrop-filter: blur(12px); }
  [data-theme="dark"] .graph-legend-item { color: var(--ink-secondary); font-family: var(--mono); }
  [data-theme="dark"] .graph-legend-dot { box-shadow: 0 0 10px currentColor; }
  [data-theme="dark"] .graph-filters { background: rgba(18, 18, 42, 0.72); border-color: rgba(156, 143, 248, 0.18); backdrop-filter: blur(18px); box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4); }

  /* ── Toast + batch bar ───────────────────────────────────────── */
  [data-theme="dark"] .toast { background: rgba(18, 18, 42, 0.78); border-color: rgba(156, 143, 248, 0.28); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6), 0 0 30px rgba(124, 58, 237, 0.2); backdrop-filter: blur(20px); }
  [data-theme="dark"] .toast.ok { background: rgba(74, 222, 128, 0.12); border-color: rgba(74, 222, 128, 0.4); color: #8ef0a8; }
  [data-theme="dark"] .toast.err { background: rgba(248, 113, 113, 0.1); border-color: rgba(248, 113, 113, 0.4); color: #f9a0a0; }
  [data-theme="dark"] .batch-bar { background: rgba(18, 18, 42, 0.82); border-color: rgba(156, 143, 248, 0.28); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6), 0 0 40px rgba(124, 58, 237, 0.22); backdrop-filter: blur(24px); }

  /* ── Command palette ─────────────────────────────────────────── */
  [data-theme="dark"] .cmdpal-overlay { background: rgba(5, 5, 15, 0.55); backdrop-filter: blur(8px); }
  [data-theme="dark"] .cmdpal-box { background: rgba(18, 18, 42, 0.88); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6), 0 0 60px rgba(124, 58, 237, 0.24); }
  [data-theme="dark"] .cmdpal-item.selected { background: linear-gradient(90deg, rgba(124, 58, 237, 0.35), rgba(40, 211, 242, 0.12)); }
  [data-theme="dark"] .cmdpal-item-name { color: var(--ink); }

  /* ── Section accents (settings) ──────────────────────────────── */
  [data-theme="dark"] .settings-section-findings { border-top: 3px solid var(--cyan); box-shadow: 0 -6px 24px rgba(40, 211, 242, 0.08); }
  [data-theme="dark"] .settings-section-behavior { border-top: 3px solid #8b5cf6; }
  [data-theme="dark"] .settings-section-integrations { border-top: 3px solid var(--accent-solid); }

  /* ── Card header label ───────────────────────────────────────── */
  [data-theme="dark"] .card-header h2 { color: var(--cyan); font-family: var(--mono); letter-spacing: 0.14em; }

  /* ── Review diff ─────────────────────────────────────────────── */
  [data-theme="dark"] .review-diff { background: rgba(156, 143, 248, 0.08); border-color: rgba(156, 143, 248, 0.16); }
  [data-theme="dark"] .review-diff-pane { background: rgba(10, 10, 26, 0.6); }
  [data-theme="dark"] .diff-del { background: rgba(248, 113, 113, 0.18); color: #fca5a5; }
  [data-theme="dark"] .diff-ins { background: rgba(74, 222, 128, 0.18); color: #86efac; }

  /* ── Status LED gets a wider aura ────────────────────────────── */
  [data-theme="dark"] .status-led-ok { background: #4ade80; box-shadow: 0 0 14px rgba(74, 222, 128, 0.7); }
  [data-theme="dark"] .status-led-warn { background: #fbbf24; box-shadow: 0 0 14px rgba(251, 191, 36, 0.7); }
  [data-theme="dark"] .status-led-err { background: #f87171; box-shadow: 0 0 14px rgba(248, 113, 113, 0.7); }

  /* ── Scrollbars ──────────────────────────────────────────────── */
  [data-theme="dark"] ::-webkit-scrollbar { width: 10px; height: 10px; }
  [data-theme="dark"] ::-webkit-scrollbar-track { background: rgba(10, 10, 26, 0.6); }
  [data-theme="dark"] ::-webkit-scrollbar-thumb {
    background: linear-gradient(180deg, rgba(124, 58, 237, 0.55), rgba(40, 211, 242, 0.35));
    border-radius: 6px;
    border: 2px solid rgba(10, 10, 26, 0.8);
  }
  [data-theme="dark"] ::-webkit-scrollbar-thumb:hover { background: linear-gradient(180deg, rgba(124, 58, 237, 0.75), rgba(40, 211, 242, 0.55)); }

  /* ── Selection colour ────────────────────────────────────────── */
  [data-theme="dark"] ::selection { background: rgba(124, 58, 237, 0.55); color: #fff; }

  /* ── Finding detail cards ────────────────────────────────────── */
  [data-theme="dark"] .finding-detail-card { background: rgba(18, 18, 42, 0.65); border-color: rgba(156, 143, 248, 0.16); }
  [data-theme="dark"] .finding-detail-card[open] summary { background: linear-gradient(90deg, rgba(124, 58, 237, 0.2), transparent); }
  [data-theme="dark"] .finding-score-indicator.healthy { background: #4ade80; box-shadow: 0 0 8px rgba(74, 222, 128, 0.8); }
  [data-theme="dark"] .finding-score-indicator.decaying { background: #fbbf24; box-shadow: 0 0 8px rgba(251, 191, 36, 0.8); }
  [data-theme="dark"] .finding-score-indicator.stale { background: #f87171; box-shadow: 0 0 8px rgba(248, 113, 113, 0.8); }

  /* ── kbd chip ────────────────────────────────────────────────── */
  [data-theme="dark"] kbd { background: rgba(10, 10, 26, 0.7); border: 1px solid rgba(156, 143, 248, 0.22); color: var(--ink-secondary); box-shadow: 0 1px 0 rgba(124, 58, 237, 0.18); }

  /* ── Mono numerals ───────────────────────────────────────────── */
  [data-theme="dark"] .project-card-stat strong,
  [data-theme="dark"] .count,
  [data-theme="dark"] .badge-count { font-family: var(--mono); font-variant-numeric: tabular-nums; }

  /* ── Phren pixel mascot for empty states ─────────────────────── */
  /* Data URI = the 24×24 phren sprite (base palette, default idle pose). */
  [data-theme="dark"] .project-detail-empty::before,
  [data-theme="dark"] .reader-empty::before,
  [data-theme="dark"] .cmdpal-empty::before {
    content: "";
    display: block;
    width: 96px;
    height: 96px;
    margin: 0 auto 18px;
    image-rendering: pixelated;
    opacity: 0.92;
    filter: drop-shadow(0 0 16px rgba(124, 58, 237, 0.45));
    animation: phrenBreathe 3.4s ease-in-out infinite;
    background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges"><g fill="rgb(103,226,248)"><rect x="16" y="5" width="1" height="1"/><rect x="18" y="5" width="1" height="1"/></g><g fill="rgb(156,143,248)"><rect x="8" y="7" width="9" height="1"/><rect x="7" y="8" width="11" height="1"/><rect x="6" y="9" width="13" height="1"/><rect x="6" y="10" width="13" height="1"/><rect x="6" y="11" width="13" height="1"/><rect x="6" y="12" width="13" height="1"/></g><g fill="rgb(126,107,245)"><rect x="6" y="13" width="13" height="1"/><rect x="6" y="14" width="13" height="1"/></g><g fill="rgb(107,87,232)"><rect x="7" y="15" width="11" height="1"/></g><g fill="rgb(89,69,197)"><rect x="8" y="16" width="9" height="1"/></g><g fill="rgb(18,18,42)"><rect x="7" y="12" width="1" height="1"/><rect x="11" y="12" width="1" height="1"/><rect x="11" y="15" width="2" height="1"/></g><g fill="rgb(158,161,248)"><rect x="9" y="19" width="2" height="1"/><rect x="12" y="19" width="2" height="1"/></g></svg>');
    background-repeat: no-repeat;
    background-size: contain;
  }
  @keyframes phrenBreathe {
    0%, 100% { transform: scale(1) translateY(0); filter: drop-shadow(0 0 16px rgba(124, 58, 237, 0.45)); }
    50%      { transform: scale(1.03) translateY(-3px); filter: drop-shadow(0 0 24px rgba(124, 58, 237, 0.65)); }
  }
  [data-theme="dark"] .project-detail-empty,
  [data-theme="dark"] .reader-empty,
  [data-theme="dark"] .cmdpal-empty {
    padding-top: 42px !important;
    color: var(--muted);
    font-family: var(--font);
  }

  /* ── Title chromatic hint (very subtle RGB offset) ───────────── */
  [data-theme="dark"] .project-detail-header h2,
  [data-theme="dark"] .reader-title {
    text-shadow:
      -0.5px 0 rgba(124, 58, 237, 0.55),
       0.5px 0 rgba(40, 211, 242, 0.5);
    letter-spacing: -0.01em;
  }

  /* ── Graph canvas breathe ────────────────────────────────────── */
  @keyframes graphCanvasPulse {
    0%, 100% { filter-opacity: 1; }
    50%      { filter-opacity: 1.08; }
  }
`;
