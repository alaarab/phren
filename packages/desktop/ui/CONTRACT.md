# UI contract (phase 0 spike)

Plain browser ES modules, no bundler, no framework. Served by src/server.ts from
this folder; xterm is at `/vendor/xterm/xterm.js` (ESM build `/vendor/xterm/xterm.mjs`),
`/vendor/xterm/xterm.css`, `/vendor/addon-fit/addon-fit.mjs`,
`/vendor/addon-webgl/addon-webgl.mjs`.

Files and owners:
- `index.html`, `theme.css`, `app.js`, `terminal.js`: the shell (layout, data flow, terminal tile).
- `sidebar.js`: the sessions sidebar.
- `chat.js`: the chat pane.

## Exports

```js
// sidebar.js
export function renderSidebar(el, merged, handlers)
//   merged: MergedOverview (src/contract.ts). Re-render fully on every call.
//   handlers.onOpenChat(computerName, child)     // child: OverviewChild with a target
//   handlers.onOpenTerminal(computerName, server) // server: child.target.server or mux.session

// chat.js
export function openChat(el, computerName, child) // returns { close() }

// terminal.js
export function openTerminal(el, computerName, server) // returns { close() }
```

## Server endpoints the UI uses (same origin; the token cookie is already set)

- `WS /api/overview` → `{type:"overview", merged}` frames.
- `WS /hosts/<computer>/v1/transcripts?<target as query>` → Hook frames
  `{type:"backlog"|"append"|"older"|"preview", entries:[{line, raw}], ...}`.
  `raw` is the harness's own JSONL row (Claude: `raw.type` "user"|"assistant",
  `raw.message.content` string or `[{type:"text",text}|{type:"tool_use",name,input}|{type:"tool_result",content}]`;
  Codex: `raw.type` "response_item" with `raw.payload.type` "message" and
  `raw.payload.role`, `raw.payload.content[{type:"input_text"|"output_text", text}]`).
- `WS /hosts/<computer>/v1/status?<target as query>` → `{type:"agentStatus", status, pendingApproval?}` frames.
- `POST /hosts/<computer>/v1/prompt` body `{target, text, deliveryId}` (deliveryId: crypto.randomUUID()).
- `POST /hosts/<computer>/v1/keys` body `{target, keys:["Escape"]}` to stop.
- `POST /hosts/<computer>/v1/approvals/answer` body `{target, actionId, decision:"approve"|"deny"}`.
- `WS /pty?computer=&server=&cols=&rows=` → raw terminal text both ways;
  send `{"type":"resize","cols","rows"}` as JSON text to resize.

## Look (Phren Charcoal; use these CSS variables from theme.css only)

--bg #1E1E1E; --sunken #141618; --surface #282A2C; --card #323437; --raised #3C3F42;
--tool #121416; --text #FFFFFF; --text-2 #ECEDEE; --muted #A4A9B1; --dim #999FA8;
--accent #B994F4; --accent-hover #DCC5FF; --accent-solid #7450A7; --link #C2AAFF;
--working #B994F4; --waiting #E0BC7F; --done #8AC8AC; --danger #EF9898;
--path #7FB6F0; --branch #F0A06E; --border rgba(255,255,255,0.07); --border-strong rgba(255,255,255,0.14);
Spacing 4/8/12/16/20/24 px; radius 10 px cards, 12 options, 18 large, 999px pills;
rows min 36 px (desktop density); transitions 0.18s ease; no decorative animation;
UI font system-ui; transcript and code font "JetBrains Mono", ui-monospace, Menlo, monospace.

Session row (sidebar): a provider glyph letter in a ring colored by status
(working lavender, blocked/waiting amber, idle/done muted), project name (basename of cwd)
in --accent, branch in monospace --muted, computer name, age ("2m"), title below in --text-2,
a 3 px left accent bar for working (--working) and needs-input (--waiting).
Sections in small caps with counts: "NEEDS YOU · 1", "WORKING · 2", "IDLE · 3", then "COMPUTERS"
listing each computer with a state dot (online --done, connecting --muted, offline --danger).
