# Phren UX Design Specification

**Status:** Draft v2 (aligned with copy direction)
**Author:** UX Designer (parity team)
**Date:** 2026-03-13

---

## 1. Brand Identity

### 1.1 Name and Etymology

**phren** (lowercase, always). From Greek *phren*, the mind, the seat of thought. One syllable. Starts hard (ph), ends soft (n). Say it once and move on.

### 1.2 Character

Phren is a quiet memory keeper. It does not do the work. It holds the context so you can. Think of a well-organized journal that opens to the right page when you sit down.

**Phren is:**
- Quiet: speaks only when surfacing something relevant
- Steady: always present, never urgent
- Warm but restrained: knowledge at the core, structure around it

**Phren is not:**
- An assistant (it doesn't act, it remembers)
- A chatbot (it doesn't converse, it surfaces)
- A dashboard (it doesn't demand attention, it waits)

### 1.3 Core Vocabulary

| Old (phren) | New (phren) | Why |
|---|---|---|
| phren | phren | Brand rename |
| entity | fragment | Pieces of knowledge that link together, not database objects |
| add to phren | tell phren | Phren is a character you share things with |
| phren search | ask phren | You ask, phren recalls |
| memory store | phren / your phren | It's a mind, not a store |
| stored | held / carried | Phren holds context, it doesn't store data |
| retrieved / injected | surfaced | Phren surfaces what matters |
| finding added | phren will remember this | Confirmation as character voice |
| data persists | fragments accumulate | Living metaphor, not database language |

### 1.5 Verb System

Phren has a specific set of verbs that define how it speaks and how users speak to it. These verbs drive all UI labels, CLI output, and documentation.

**Phren's verbs (what phren does):**
- **remembers**: when phren saves something: "phren will remember this"
- **surfaces**: when phren injects context: "surfaced 3 times this week"
- **holds**: what phren contains: "phren holds 47 fragments"
- **carries**: continuity: "phren carries context forward"
- **noticed**: proactive detection: "phren noticed this is a git project"

**User's verbs (what you do with phren):**
- **tell**: adding knowledge: "tell phren what you learned"
- **ask**: searching: "ask phren about rate limiting"

**Never use:** stores, manages, processes, retrieves, indexes, persists

### 1.4 Wordmark

- Always lowercase: **phren**
- Letterspacing: +0.04em for display sizes, normal for body
- Weight: 500 (medium) for wordmark, not bold. Quiet confidence
- In CLI: plain `phren`, no special formatting on the name itself

---

## 2. The Phren Character

### 2.1 What Phren Looks Like

Phren is a small purple pixel creature — a soft, round brain-like character with a friendly face, stubby legs, and a cyan sparkle. He is geometric, gentle, and simple enough to animate smoothly. He matches the purple/indigo palette of the main icon.

**Visual description:**
- A pixel-art body in soft lavender-purple (#9A8CF8 range)
- Deeper violet shadows for depth (#5040E0 range)
- Dark indigo outlines (#1E2070 range)
- A cyan sparkle/antenna accent (#28D2F2) — his signature detail
- Light periwinkle feet (#9EA0F8 range)

**Size:** 64x64 SVG at full resolution. Scales down to 20px for status bar, 32px for inline UI, 48px for graph explorer.

**File:** `docs/phren-character.svg`

### 2.2 Animation States

Phren is alive. He has four states, each with distinct animation:

| State | When | Animation |
|---|---|---|
| **Idle** | Default, page loaded, waiting | Gentle glow pulse (3s cycle), orbit ring rotates slowly (20s full rotation) |
| **Moving** | Navigating to a fragment in graph | Orb translates smoothly toward target node, trailing glow stretches slightly in the direction of movement |
| **Retrieving** | Clicked a node, loading content | Brighter core pulse (faster, 1.5s), orbit ring speeds up, glow expands |
| **Acknowledging** | Fragment added, action confirmed | Brief bright flash (0.3s), then settle back to idle |

### 2.3 Graph Explorer Integration (Signature Interaction)

This is phren's showcase moment. When the user clicks a fragment node in the knowledge graph:

1. Phren's orb (positioned at center or last location) begins moving toward the clicked node
2. The movement follows a gentle ease-in-out curve (CSS `cubic-bezier(0.4, 0, 0.2, 1)`, ~600ms)
3. A faint warm trail follows him, a line from previous position to current, fading over 1s
4. When he arrives at the node, he enters "retrieving" state (brighter pulse)
5. The detail panel opens with the node's content
6. Phren settles into idle at the node's position

**Implementation approach:**
- Phren is rendered as an absolutely positioned SVG element on the canvas overlay
- His position is tracked in JS state (`phrenX`, `phrenY`)
- Movement uses `requestAnimationFrame` with lerp interpolation for smooth canvas-based animation
- The trail is drawn as a fading polyline on the canvas, cleared after 1s

### 2.4 Where Phren Appears

| Surface | Presence | Size |
|---|---|---|
| **Graph explorer** | Full animated character, moves between nodes | 48px |
| **Web UI header** | Small static orb next to wordmark, pulses on sync | 20px |
| **Web UI empty states** | Idle phren with message below ("Nothing here yet") | 48px |
| **Web UI loading** | Retrieving-state phren while data loads | 32px |
| **VS Code status bar** | Simplified: just the colored dot (purple/green/red), phren-derived | 8px dot |
| **CLI** | Not visual, personality only through text | n/a |
| **Docs site hero** | Large animated phren with orbit ring, idle state | 80px |
| **README** | Static icon (existing icon.svg, not the character) | 100px |

### 2.5 Design Principles for the Character

- **Never cute.** Phren is not a mascot. He's a presence, closer to a firefly than a cartoon.
- **Never in the way.** His animations are subtle. If you're not looking for him, you might not notice. That's fine.
- **Soft, not flashy.** The purple glow should feel gentle, not neon. Opacity stays low on the ambient effects.
- **Purposeful movement.** He only moves when there's a reason: retrieving a fragment, acknowledging an action. No idle wandering.
- **Scale gracefully.** At 20px he's just a glowing dot. At 80px you see the full gradient, orbit ring, and inner highlight. Both should feel like the same character.

---

## 3. Color System

### 2.1 Philosophy

The phren icon tells the story: a purple pixel character (your knowledge keeper) with a cyan sparkle (awareness) on a deep indigo background (the dark space where memory lives). The palette follows the icon.

### 2.2 Palette

#### Core Colors

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--phren-purple` | `#7c3aed` | `#9B8CF8` | Primary accent. Phren's voice. |
| `--phren-purple-dim` | `rgba(124,58,237,.08)` | `rgba(155,140,248,.10)` | Subtle purple backgrounds |
| `--phren-purple-glow` | `rgba(124,58,237,.15)` | `rgba(155,140,248,.18)` | Hover states, focus rings |
| `--phren-violet` | `#5B43F3` | `#6B5DF0` | Highlights, active states |
| `--phren-cyan` | `#28D2F2` | `#28D3F2` | Secondary accent. Sparkle, links. |
| `--phren-cyan-dim` | `rgba(40,210,242,.08)` | `rgba(40,211,242,.10)` | Subtle cyan backgrounds |

#### Surface Colors

| Token | Light | Dark | Notes |
|---|---|---|---|
| `--bg` | `#f9f8f6` | `#0d0e0c` | Warm paper tint, not pure white/black |
| `--surface` | `#ffffff` | `#15160f` | Cards, panels |
| `--surface-raised` | `#fdfcfa` | `#1c1d16` | Elevated surfaces |
| `--surface-sunken` | `#f2f1ed` | `#0a0b08` | Inset areas |
| `--ink` | `#1a1a18` | `#e8e4d9` | Primary text, warm off-white in dark |
| `--ink-secondary` | `#3d3d3a` | `#b5b0a3` | Secondary text |
| `--muted` | `#7a7872` | `#6b6860` | Tertiary text, timestamps |

#### Semantic Colors

| Token | Value | Usage |
|---|---|---|
| `--success` | `#10b981` | Healthy, synced, complete |
| `--warning` | `#eab308` | Standard warning yellow |
| `--danger` | `#c45a4a` | Warmer red, errors |

### 2.3 Graph Visualization Colors

The knowledge graph is phren's signature visual. Fragment nodes use topic-hashed hues (existing behavior), but the reserved type colors shift:

| Node Type | Old Color | New Color | Why |
|---|---|---|---|
| project | `#7c3aed` (purple) | `#7c3aed` (purple) | Projects are central knowledge, matches brand |
| fragment (was entity) | `#06b6d4` (cyan) | `#28D2F2` (cyan) | Fragments use the cyan sparkle accent |
| task-active | `#10b981` (green) | `#10b981` (green) | Keep, universally understood |
| task-queue | `#eab308` (yellow) | `#eab308` (yellow) | Keep, universally understood |
| reference | `#14b8a6` (teal) | `#6b8e7a` (sage) | Quieter, natural tone |

---

## 3. README Layout

### 3.1 Structure

The README should breathe. Progressive disclosure, not a wall of text.

```
[icon]
phren
[one-line tagline]

---

[What phren does, 3 short paragraphs, no bullets]

---

## Getting started
[4-line install + init]
[Scenario table, same as current but reworded]

---

## How it works
[3 paragraphs: before each prompt / after each response / when context resets]
[No "three things happen" preamble, just describe them]

---

## Reference
[<details> blocks, same progressive disclosure pattern as current]
[But each summary line is a question: "What lives in your phren?"]
```

### 3.2 Hero Section

```markdown
<div align="center">
<br>

<img src="icon.svg" width="100" alt="phren" />

<br>

# phren

**[tagline, pending from copy]**

[![npm](badge)](link) [![Docs](badge)](link)

<br>

[2-3 sentence description. Not technical. What phren does for you.]

<br>
</div>
```

Key changes from current:
- Icon slightly smaller (100px vs 120px), quieter
- Single tagline, not subtitle + description
- Fewer badges (drop whitepaper badge for now)
- Description is about the user, not the architecture

### 3.3 Details Block Summaries

Current: "What lives in your phren"
New: "What lives in your phren" (or whatever copy says, keep the question format)

Current: "Memory across your machines"
New: "Phren across machines"

Current: "The MCP server (67 tools)"
New: "The MCP server" (drop the number, it changes and sounds like bragging)

---

## 4. CLI Output Style

### 4.1 Philosophy

Phren's CLI reads like notes in a margin, not a dashboard. Quiet text, purple/cyan highlights only for phren's own contributions (what it surfaced, what it noticed).

### 4.2 ANSI Color Mapping

| Purpose | Current | Phren |
|---|---|---|
| Phren's voice (notices, surfaces) | cyan | purple (`\x1b[35m`) |
| Success/confirmation | green | green (keep) |
| Errors | red | red (keep) |
| Structure/labels | bold white | dim white (`\x1b[2m`) |
| Values/data | cyan | plain white |
| Timestamps/meta | gray | gray (keep) |
| Emphasis | bold | bold (keep) |
| Section dividers | dim `━━━` | dim `--` (thinner, quieter) |

### 4.3 Status Output

**Current:**
```
phren v1.33.4
Path:     ~/.phren
Machine:  work-desktop
Profile:  personal (6 projects)
MCP:      registered for Claude Code
Hooks:    prompt, auto-save, session lifecycle
```

**Phren:**
```
phren v2.0.0
  path     ~/.phren
  machine  work-desktop
  profile  personal -- 6 projects
  mcp      on (Claude Code)
  hooks    prompt, auto-save, session
```

Changes:
- No colons after labels, cleaner scan
- Indented values, not right-aligned
- Parenthetical details instead of separate descriptions
- Double-dash separator for inline grouping

### 4.4 Init Walkthrough

**Current opening:**
```
phren initialized
Path:    ~/.phren
Machine: work-laptop
```

**Phren opening:**
```
phren is ready.

  path     ~/.phren
  machine  work-laptop
  profile  personal -- 6 projects

Your next prompt will already have context.
```

- First line is a quiet statement, not a title
- Closing line is what matters to the user, not what happened technically
- Each question during init should be a single line, not a paragraph of explanation

### 4.5 Shell (Interactive TUI)

The interactive shell keeps the same 7-view navigation but with phren language:

| Key | Current Label | Phren Label |
|---|---|---|
| `p` | Projects | Projects |
| `b` | Tasks | Tasks |
| `l` | Findings | Fragments |
| `m` | Review Queue | Review |
| `s` | Skills | Skills |
| `k` | Hooks | Hooks |
| `h` | Health | Health |

Header line: `phren` (not `phren`) with project name and sync status.

---

## 5. Web UI Dashboard

### 5.1 Overall Feel

Move from "admin dashboard" to "knowledge workspace." The Web UI is where you see phren's understanding of your projects: fragments connecting, patterns forming.

### 5.2 Layout Changes

**Current:** Top nav with tabs (Findings, Tasks, Graph, Skills, Hooks, Health, Settings)

**Phren:** Same tab structure but with revised labels:
- Findings -> Fragments
- Entity Graph -> Fragment Graph (or just "Graph")
- Keep the rest

**Header bar:**
- Left: phren icon (small, 20px) + "phren" wordmark
- Right: project selector + theme toggle + sync indicator

**Sync indicator:** A small purple dot that pulses gently when syncing, solid when synced, hollow when disconnected. Not a badge with text. Just a dot.

### 5.3 Color System Update

Keep the purple/cyan accent palette consistent across surfaces:

```css
:root {
  /* Phren palette */
  --accent: #9B8CF8;
  --accent-hover: #9a7209;
  --accent-dim: rgba(184,134,11,.08);
  --accent-glow: rgba(184,134,11,.15);

  /* Warmer backgrounds */
  --bg: #f9f8f6;
  --surface: #ffffff;
  --ink: #1a1a18;
}

[data-theme="dark"] {
  --accent: #7c3aed;
  --accent-hover: #e09a3a;
  --accent-dim: rgba(212,137,46,.10);
  --accent-glow: rgba(212,137,46,.18);

  --bg: #0d0e0c;
  --surface: #15160f;
  --ink: #e8e4d9;
}
```

### 5.4 Graph Page

The graph is phren's showcase, and the home of his signature interaction (see section 2.3). Changes:
- Rename "entity" to "fragment" everywhere in labels, tooltips, legend
- Project nodes use purple (`#7c3aed`), fragment nodes use cyan (`#28D2F2`)
- Connection lines between fragments use soft indigo tones (`#4040A0`)
- The center glow effect on project nodes mirrors the icon's ember
- **Phren character lives here:** His orb sits at the center of the graph on load, and moves toward nodes when clicked. See section 2.3 for the full interaction spec.
- When phren moves toward a node, the detail panel opens with that node's content. The tooltip during movement reads "retrieving..." in cyan text.

### 5.5 Fragment List (was Findings)

Each fragment card shows:
- Fragment text (primary)
- Project badge + timestamp (secondary)
- Status indicator (active / superseded / retracted) using the semantic colors
- Citation link if present

The cards should feel like index cards or notes, not table rows. Slight border-radius, warm shadow, breathing room.

---

## 6. VS Code Sidebar

### 6.1 Tree View

The VS Code extension shows phren data in a sidebar tree. Structure:

```
PHREN
  > Projects
    > my-api (3 fragments, 2 tasks)
    > my-frontend (7 fragments, 0 tasks)
  > Fragments (recent)
    - Rate limiting needs retry logic
    - Auth middleware stores tokens in...
  > Tasks
    - [high] Fix rate limiter
    - [med] Update docs
  > Review Queue (2)
```

### 6.2 Status Bar

Left side of status bar: `phren` with a colored dot:
- Purple dot: syncing
- Green dot: synced
- No dot: disconnected/inactive
- Red dot: error

Click opens the phren sidebar.

### 6.3 Theme Integration

VS Code has its own theming. Phren's extension should:
- Use `ThemeColor` API for icons (purple accent where possible)
- Not fight the user's theme. Adapt to it
- Use standard VS Code tree view patterns, not custom webviews (for the sidebar)

---

## 7. Docs Site (GitHub Pages)

### 7.1 Current State

The docs site at `docs/index.html` uses the phren icon palette (dark background, purple character, cyan sparkle). This already matches phren's direction.

### 7.2 Changes

- Replace all "phren" with "phren" in text and meta tags
- Replace all "entity" with "fragment"
- The hero section SVG animation should keep the node-graph motif but use "fragment" language
- Color scheme: keep the dark background (`#0A0B09`), warm text (`#E8E4D9`), purple/cyan palette
- Navigation: "phren" wordmark becomes "phren"

### 7.3 New Hero Copy

```
phren
[tagline]

[2 sentences about what phren does. Not technical. Human.]
```

The animated graph in the hero stays. It visually communicates fragments linking together.

---

## 8. Onboarding Flow (Init)

### 8.1 First Run

```
phren

  Phren keeps what your agents learn, across sessions,
  projects, and machines.

  Where should phren keep its memory?
  > ~/.phren (recommended)
    Custom path...

  What's this machine called?
  > work-laptop

  Do you have an existing phren repo to pull from?
  > No, start fresh
    Yes, paste the URL

  phren is ready.
    path     ~/.phren
    machine  work-laptop
    hooks    on
    mcp      on (Claude Code)

  Your next prompt will already have context.
```

### 8.2 Principles

- Each screen is one question, one choice
- Smart defaults (recommended option is pre-selected)
- No jargon in question text ("Where should phren keep its memory?" not "Select phren root directory")
- The closing summary is what changed and what happens next
- Total questions: 3-5 max for first run

### 8.3 Adding a Project

```
  phren noticed this is a git project.
  Would you like phren to remember what happens here?

  > Yes
    Not now

  Who should own the instruction files?
  > phren manages them
    I'll manage them myself
    Detached (separate copies)

  Added: my-api
  Phren will start learning from your next session.
```

---

## 9. Implementation Notes

### 9.1 What Changes in Code

| Area | File(s) | Change |
|---|---|---|
| Web UI colors | `memory-ui-assets.ts` | Keep purple/cyan palette consistent across all views |
| Graph node types | `mcp/browser/memory-ui-graph-app.ts` | Rename `entity` -> `fragment`, update COLORS map |
| CLI status | `status.ts` | New format, phren branding |
| CLI shell | `shell-render.ts`, `shell-view.ts` | Rename labels, adjust color usage |
| Init output | `init.ts` | New messaging style |
| Docs site | `docs/index.html`, `docs/style.css` | Rebrand text + update meta |
| README | `README.md` | Full restructure |
| Icon | `icon.svg` | Keep as-is (already fits phren) |

### 9.2 What Stays

- The icon SVG. It already embodies phren's visual language
- The graph visualization engine, just color/label updates
- The overall UI layout. Sidebar + content pattern works
- The TUI shell structure: 7 views, single-key nav
- Inter as the UI font
- The light/dark theme toggle

### 9.3 Migration Markers

All references to "phren" in user-facing strings become "phren". All references to "entity" in user-facing strings become "fragment". Internal variable names and file structure are handled by the rewording agent. This spec covers the UX layer only.

---

## 10. Open Questions

### Resolved (aligned with copy)

- **Phren's verbs:** remembers, surfaces, holds, carries, noticed. User verbs: tell, ask. (See section 1.5)
- **Error voice:** Phren-as-character for recoverable issues ("phren couldn't sync, check your remote"). Neutral for hard errors ("permission denied: ~/.phren").
- **Fragments:** Used everywhere: UI labels, docs, CLI, graph. Not just a graph concept.
- **Action phrasing:** "Tell phren" for adding. "phren will remember this" for confirmation. "surfaced" for retrieval.

### Still Open (waiting on copy)

1. **Tagline**: need a short (under 6 words) tagline for the README hero. Candidates: "Your project's memory." / "What your agents remember." Waiting on reworder's pick.
2. **Details block summaries**: question format or statement? "What lives in your phren?" vs "Your phren" vs something else.
3. **Empty state**: when phren has nothing to surface, does it say something or stay silent? Proposal: silence in CLI (no output = nothing to say), gentle "nothing yet" in Web UI empty states.
4. **Fragment counter**: should the Web UI header show a growing count ("247 fragments") to reinforce the accumulation metaphor?
