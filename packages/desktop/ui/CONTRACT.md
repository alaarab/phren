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

# Changes and editor (phase 1b)

Owner direction 2026-10-09: "look at Codex and VS Code, mixed, but based more on
Phren." So: Phren's phone Changes and Code screens are the base (looks, words,
row shapes); VS Code supplies the desktop layout (file tree, editor tabs, side by
side diff, ⌘P, ⌘S, dirty dots); Codex supplies review beside the conversation
(comment on a line, send it to the agent working there).

## Workbench (owned by the shell, app.js)

The right panel `#side` is the workbench: a segment control at its top with
**Changes · Files · Terminal** (pill segments, raised background, selected
segment in --accent text on --card). Opening a session's chat also scopes the
workbench to that session. A drag handle on its left edge resizes it (280 px to
75 % of the window), and a maximize button lets it cover the chat.

Each pane module gets a container element and a context:

```js
ctx = {
  computer,          // the Computer name
  child,             // OverviewChild; child.target is the session target
  openFile(path, { line, diff }),  // switch to Files and open path (diff: true opens the diff view)
  showChanges(),     // switch to Changes
  ask(text),         // put text in that session's chat composer (Codex-style review)
}
```

`ui/api.js` (exists): `hookPost(computer, route, body)`, `hookGet(computer, route, query)`,
`targetQuery(target)`, `readRepoFile(computer, target, path) → {text, version, total}`.
Errors are `Error` with `.status`, `.code` and `.body` (the Hook's JSON).

## Hook routes these panes use (all take the session `target`)

- `POST /v1/git/status {target}` → `{branch, upstream, ahead, behind, staged, unstaged, untracked,
  additions, deletions, totalFiles, files:[{path, status:"M"|"A"|"D"|"R"|"?", staged, additions, deletions, binary}], repository}`.
  A file staged and also changed again appears twice (staged true and false).
- `POST /v1/diff {target, paths:[]}` → `{files:[{path, status, sections:[{id, kind:"staged"|"unstaged", binary, patch, truncated}]}]}`
  (`patch` is unified diff text; untracked files have no sections; read them whole).
- `POST /v1/git/stage|unstage|discard {target, paths:[...], expectedRepository}`; stage also takes `confirmBulk`.
- `POST /v1/git/commit {target, message, expectedRepository}`; `POST /v1/git/push {target, expectedRepository}`
  (a 409 whose `error.body.defaultBranch` is set means pushing the default branch: ask with a Phren dialog, then resend with `confirmDefault: true`).
- `POST /v1/git/log {target, limit}` → `{commits:[{sha, short, subject, author, date, refs, parents}]}` (History).
- `POST /v1/git/tree {target, path}` → `{path, entries:[{name, path, kind:"dir"|"file", fileCount?}]}` one directory.
- `GET /v1/files/range` via `readRepoFile`.
- `POST /v1/files/write {target, path, content, version}` → `{path, version, size}`; 409 code
  "file-changed" when the file moved since `version`; omit `version` only to create a new file
  (409 code "file-exists" if it exists). Only Hooks advertising `capabilities.fileWrite` have it;
  others answer 404: show "Update Phren on <computer> to save files here."

## Look additions (Phren phone Changes screen)

- Title row: "Uncommitted changes" (or History, Branches) with a ▾ that opens the section menu,
  and a quiet line under it in mono --muted: "main · 3 files +12 −3".
- Section headers: small caps `STAGED` / `CHANGES` followed by a count pill (raised, radius 999, 11 px).
- File row (40 px): a 24 px status tile (radius 6, tinted background: M and A green rgba(138,200,172,.16)
  with --done letter, D rgba(239,152,152,.16) --danger, ? --muted on raised, R --link), file name in mono
  --text, its folder below in --muted 12 px, then `+n` in --done and `−n` in --danger, right aligned.
  Hover reveals row actions as small icon buttons: open file, stage (+) or unstage (−), discard (↺).
- Diff rows: mono 12.5 px, line-number gutter in --dim, added rows rgba(138,200,172,.14) with the changed
  words rgba(138,200,172,.32), removed rows rgba(239,152,152,.14) / .32, hunk header `@@ -2,3 +2,3 @@`
  in --accent on a hairline rule. Syntax colour is not required in the list diff.
- Footer: commit message field (sunken, radius 12) + "✓ Commit" button (--accent-solid at 0.35 when
  disabled, full when enabled) + "↑ Push N" pill when ahead > 0. "Stage all" replaces Commit when nothing is staged.
- Words: "Changes", "Files", "Uncommitted changes", "Working tree clean", never "symbol" or "SCM".

# Code index and search (phase 1c)

## Which project's index

The code index is per project, not per checkout. Resolve once per session:
`GET /v1/projects/repos` → `{repos:[{directory, name, registered}]}`; the project is the
`name` of the entry whose `directory` equals the Changes status `repository` (from
`POST /v1/git/status`) and whose `registered` is true. Then `GET /v1/code/status?project=<name>`
must answer 200 with `available: true`; otherwise the index is off for this session (no
error UI beyond a quiet "No code index for <name>" note where the feature would be).
All index paths are repository-relative, the same as editor paths.

## Code index routes (GET, query `project=<name>`)

- `/v1/code/file-references?path=<file>` → `{references:[{line, kind, name, symbol:"file::Name", file, targetLine, targetKind}]}`:
  every resolved use in that file (no columns: match by line and the word's text).
- `/v1/code/definition?name=<Name | file::Type.member>` → `{definition:{symbol:{name, kind, file, line, endLine, signature, doc, uses}, candidates, findings:[...]}}`.
- `/v1/code/references?name=<…>&limit=200` → `{references:{symbol, groups:[{file, references:[{line, kind}]}], total}}`.
- `/v1/code/outline?path=<file>` → `{entries:[{name, kind, line, endLine, signature, children:[…]}]}`.
- `/v1/code/search?q=<text>&limit=50` → `{symbols:[{name, kind, file, line, signature, doc}]}`.
Words in the UI: function, type, variable, method, class; never "symbol".

## Find in files

`POST /v1/files/search {target, query, regex?, caseSensitive?, wholeWord?, include?: string[], limit?}`
→ `{matches:[{file, lines:[{line, column, text, offset?}]}], files, total, truncated}`.
`column` is 1-based in the full line; `text` is at most 300 chars starting at `offset` (0 when absent).
Errors: 400 code "search-invalid-regex", 413 code "search-too-broad". Hooks without
`capabilities.fileSearch` answer 404: show "Update Phren on <computer> to search here."
- `POST /v1/files/list {target}` → `{files: [path…], total, truncated}`: every tracked and untracked
  (not ignored) file, for ⌘P. Same `fileSearch` capability; on 404 fall back to the paths already loaded.

# VS Code extensions (phase 1d)

Owner decision 2026-10-09: VS Code extensions through monaco-vscode-api, keeping
Phren's own UI. The editor host (`packages/desktop-editor`, built by Vite to
`ui/editor-host/`) runs VS Code's editor services and a web-worker extension host.

What runs: declarative contributions of any extension (themes, icon themes,
grammars, language configurations, snippets) and the code of **web extensions**
(manifest `browser` entry). Extensions with only a Node `main` contribute their
declarative parts; their code needs a Node extension host, which is not built yet.

## Daemon (src/extensions.ts, routes in src/server.ts)

Installed extensions live in `<config>/phren/desktop-extensions/<publisher>.<name>/`
(`<config>` = `$XDG_CONFIG_HOME` or `~/.config`), holding the unzipped `extension/`
folder of the VSIX plus `phren.json` `{id, version, installedAt, enabled, source: "open-vsx"}`.

- `GET /api/extensions` → `{extensions:[{id, version, displayName, description, publisher, enabled, kind:"web"|"declarative"|"node", icon?: url, manifest, files:[relative paths]}]}`
  `kind`: "web" when the manifest has `browser`; "node" when it has `main` but no `browser`;
  else "declarative". `files` lists every file under `extension/` (posix, relative, max 5000).
  `icon` is `/extension-files/<id>/<manifest.icon>` when set.
- `GET /api/extensions/search?q=<text>` → proxies `https://open-vsx.org/api/-/search?query=<q>&size=30`
  and returns `{extensions:[{namespace, name, version, displayName, description, downloadCount, icon}]}`.
- `POST /api/extensions/install {namespace, name}` → fetch `https://open-vsx.org/api/<ns>/<name>/latest`,
  download `files.download` (max 60 MB), verify it against `files.sha256` (hex in the body),
  unzip with fflate, keep only `extension/**` (reject absolute paths, `..`, symlinks), write to a temp
  dir and rename into place (replacing an older version). Returns the installed entry.
- `DELETE /api/extensions/<id>`; `POST /api/extensions/<id>/enable {enabled}`.
- `GET /extension-files/<id>/<path>` → a file from that extension's `extension/` folder (no traversal).
Ids match `/^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9-]*$/`.

## UI (ui/extensions.js)

`openExtensions(el, ctx)` → `{ close() }`, the workbench's Extensions segment, Phren style:
a search field ("Search Open VSX"), INSTALLED and RESULTS sections. A row: 32 px icon (or a
letter tile), display name in --text, publisher in --muted, description one line, a kind chip
("Runs here" for web in --done, "Themes and grammars" for declarative in --muted, "Needs a Node host" for node
in --waiting), and Install / Uninstall / Enable / Disable buttons. After any change call
`window.PhrenEditorHost?.reloadExtensions?.()` if present and show "Reload the window to finish" when it returns false.
A "Color theme" select at the top lists every contributed theme from installed + built-in
(`PhrenEditorHost.themes()` → [{id, label}]) and applies it with `PhrenEditorHost.setTheme(id)`.

Implementation notes (verified 2026-10-09): `registerCustomProvider` must run before
`initialize`; the worker URLs use the literal `new Worker(new URL(...))` pattern with
a stand-in Worker class so Vite bundles them; `files.sha256` from Open VSX is a URL to
the digest file; the extension host frame runs on `{{uuid}}.localhost` and loads its
worker from the page origin, so the UI is served as `localhost` (its CSP allows
`http://localhost:*`, not 127.0.0.1); `/editor-host/*` and `/extension-files/*` are
public, read-only and served without the cookie.
