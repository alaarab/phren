# Interactive Shell

The phren shell is a terminal UI for browsing and managing your project store. It launches automatically when you run `phren` with no arguments in a terminal, or explicitly with `phren shell`.

```bash
phren shell
```

## Opening on a specific view

An outside launcher — a keybinding, a Herdr plugin pane, an editor task — can
deep link into the shell instead of dropping the user on the landing screen:

```bash
phren shell --view tasks --here            # this directory's project, task list
phren shell --view "review queue" --project hub
phren shell --project hub                  # project context, landing screen
```

| Flag | Description |
|------|-------------|
| `--view <view>` | Open on a view. Case-insensitive, and accepts what you'd type: `tasks`, `findings`, `review`, `review-queue`, `skills`, `hooks`, `health`, `profiles`, `graph` (also `map`, `network`). |
| `--live` / `--no-live` | Force the Graph view's watch mode on or off. Default is on. |
| `--project <name>` | Set the active project context for this session. |
| `--here` | Resolve the project from the current directory using the same detection phren's hooks use — a git worktree resolves to the repository it came from. Ignored when `--project` is given. |

Both `--flag value` and `--flag=value` work. A link that can't be resolved
degrades rather than failing: an unknown view, or a per-project view with no
project to show, opens the project list with a note on the message line, so the
user always lands somewhere they can work from.

The Herdr plugin in [`integrations/herdr/`](../integrations/herdr) is built on
these flags.

## Views

The shell has eight views. Switch between them with single-key shortcuts or palette commands.

### Projects (`p`)

Projects is the shell landing screen. It opens as a dashboard first, then lists all indexed projects in the active profile underneath.

The dashboard shows profile-wide counts for projects, active task, queued task, findings, review queue, sync state, and intro mode. The project list below that includes per-project workload counts so you can stay global until you actually want to open a project.

The currently selected project is marked with a green dot. Use `↵` or `:open <project>` to change the active project context, which persists across all views.

### Task (`b`)

Shows the selected project's `tasks.md` file parsed into three sections: Active, Queue, and Done. Each item has an auto-generated ID for easy reference in commands.

Cross-session checkpoint context is reflected through task metadata and lifecycle actions (`:work next`, `:complete`, `:tidy`), so unfinished work can resume cleanly across sessions.

### Findings (`l`)

Lists entries from the selected project's FINDINGS.md with dates and optional citations. Entries are shown with their auto-generated IDs for use with `:find remove`.

Finding lifecycle states (for example superseded/retracted/contradicted) and provenance markers are part of what you inspect here before cleanup or contradiction resolution.

### Review Queue (`m`)

Shows pending review items from `review.md`. Each item displays its section (Review, Stale, Conflicts), a risk badge, confidence score, and date. The shell review queue is read-only and is meant for inspection.

If you move from shell to the browser view (`phren web-ui`), the UI also stays read-only for queue items while still enforcing loopback-only auth and CSRF on the routes that mutate other project data.

### Skills (`s`)

Shows installed global and project-local skills and lets you inspect what is available in the current context.

Skills now have first-class lifecycle state:
- enabled skills are active and participate in linking/discovery
- disabled skills stay on disk but are excluded from active use
- remove is still separate and destructive

Resolution rules shown by shell tooling match runtime behavior:
- project-local scope overrides global scope
- alias/command collisions are flagged and not registered
- generated artifacts: `.claude/skill-manifest.json` and `.claude/skill-commands.json`

### Hooks (`k`)

Shows lifecycle hook status and custom hook configuration for the active setup.

Integration model surfaced in shell:
- Claude: native `SessionStart` / `UserPromptSubmit` / `Stop` hooks
- Copilot/Cursor/Codex: generated hook config + session wrappers

### Machines/Profiles (via `:machines`)

Shows the machines.yaml mapping (hostname to profile) and all profiles with their project lists. Use `:machine map` and `:profile add-project`/`:profile remove-project` to edit these safely without touching YAML directly.

### Health (`h`)

Runs doctor checks and shows results alongside runtime health data: last hook run, last auto-save, last governance run. Offers remediation commands (`:run fix`, `:relink`, `:rerun hooks`, `:update`).

Health data also reflects RBAC identity context (`PHREN_ACTOR` and local/shared access-control files), review queue pressure, and whether telemetry is enabled.

### Graph (`g`)

The knowledge graph — the same picture the 3D memory viewer draws (`phren web-ui`, the VS Code panel) — rendered in the terminal. Projects, findings, tasks, fragments and reference docs are laid out with a force simulation and drawn on a braille canvas, coloured by topic and kind. A details pane sits to the right (or a strip below it on terminals narrower than 100 columns). The layout is deterministic: the same store draws the same map every time.

```bash
phren shell --view graph          # straight into the graph
phren shell --view graph --project hub
```

| Key | Action |
|-----|--------|
| `↑` `↓` `←` `→` | Walk the graph: move to the connected node in that direction (or the nearest node that way when nothing is linked) |
| `↵` | Select the node nearest the centre; on a project, focus it (press again to release) |
| `1`–`9` | Jump to the selected node's n-th neighbour (numbered on the canvas and in the pane) |
| `/` | Search. Matches light up, everything else dims, and the camera flies to the best hit |
| `n` / `N` | Next / previous search hit |
| `f` / `F` | Cycle the filter preset: all → findings → tasks → fragments → aging |
| `[` / `]` | Cycle project focus (all → each project → all) |
| `+` / `-` / `0` | Zoom in / out / fit everything |
| `⇧` + arrows, `H J K L` | Pan |
| `w` | Toggle watch mode (see below) |
| `a` | Toggle the agents overlay (see below) |
| `Tab` | Cycle the highlighted agent, when the overlay is on |
| `r` | Re-lay out (or retry a failed build) |
| `o` | Where to open the 3D viewer |
| `esc` | Clear search, then selection, then project focus, then leave the view |

The graph draws the star everyone knows (project → its findings, tasks, fragments, references) plus two edge kinds the web viewer does not show: fragments that are mentioned by the same documents (cyan), and findings linked by `supersedes` (grey) or `contradicts` (dotted red) lifecycle annotations. The selected node's edges turn amber.

### Editing skills and project instructions

Two keys, in both the Skills and Projects views:

| Key | |
|-----|---|
| `e` | Open the file in `$EDITOR` — your own vim, your config, your plugins |
| `E` | Open it in phren's own modal editor, without leaving the dashboard |

In the Skills view they edit the selected skill's markdown. In the Projects view they edit that project's `CLAUDE.md`, which the store owns and symlinks into the repo and into `.github/copilot-instructions.md` — so one edit reaches every linked checkout.

`$EDITOR` is treated as a command line, not a binary, so values carrying arguments work (`code --wait`, `nvim -u NONE`). The shell releases the terminal while your editor runs and takes it back when you quit.

#### The built-in editor

Deliberately a subset of vim: what you reach for without thinking, and nothing else. An unrecognised key does nothing rather than guessing. For real work, press `e`.

| | |
|---|---|
| Motion | `h j k l`, `w b`, `0 $`, `gg G`, arrows |
| Insert | `i a I A`, `o O`, `esc` to leave |
| Edit | `x`, `dd`, `yy`, `p P`, `u` to undo |
| Search | `/`, then `n` and `N` |
| Commands | `:w`, `:q`, `:wq`, `:q!` |

Saving is careful, because the store is git-backed and other tools read it. A skill whose frontmatter no longer parses is refused with the reason rather than written, since a skill missing its `name` or `description` loads as neither. Writes land atomically, go through the same undo stack `:undo` uses, and refuse to write through a symlink — the mirrors in `~/.claude/skills` point back at the store, and replacing one with a regular file would silently detach it. Changing a skill's frontmatter also rebuilds the skill manifests, since the name and command are baked into them.

#### Watch mode

The graph follows what phren is doing, **including in other terminals on the same machine**. Every memory a search lands on, every memory a hook injects before a prompt, and every finding written is appended to `.runtime/lookup-events.jsonl`; the graph tails that file.

Put the graph in one terminal and an agent in another. As the agent searches, the node it hit pulses cyan with a ring, the camera flies to it, the finding's full text fills the details pane, and the event joins the activity feed with its age, source and snippet. Writes show up the same way, in green, so you watch knowledge being saved as well as read.

The camera yields to you: while you are navigating, incoming events still pulse and feed but do not move the view. It resumes following a few seconds after your last keypress.

Watch mode is on by default in the Graph view. Press `w` to toggle it, or launch with `--no-live` to start with it off (`--live` forces it on).

#### Agents

With `PHREN_FEATURE_AGENTS=1`, the graph also shows the coding agents running on this machine. phren does not run them; it asks whatever does — a Herdr workspace, `phren-agent --multi` — and joins each agent onto a project by the directory it is working in.

Each project with an agent in it gets a marker: green while working, grey when done, red on error, with a count when more than one. The details pane lists them with their status and project. `a` toggles the overlay, `Tab` cycles agents and flies to the one you land on, and `↵` brings that agent to the front in its own host. `esc` releases the highlight before it touches your selection.

Watch mode tells you what your memory is doing; this tells you who is doing it. See [feature-flags.md](feature-flags.md#phren_feature_agents) for providers and how to add your own.

```bash
phren shell --view graph            # watching by default
phren shell --view graph --no-live  # static graph
```

The view rebuilds when the store changes (the shell's 2-second live poll), keeping the previous layout as a warm start so the map shifts rather than scrambling. Colours use truecolor when `COLORTERM` advertises it, 256-colour otherwise. Set `PHREN_ICONS=nerd` to draw node glyphs with Nerd Font icons if your terminal font is a patched one.

## Navigation

| Key | Action |
|-----|--------|
| `p` | Switch to Projects view |
| `b` | Switch to Task view |
| `l` | Switch to Findings view |
| `m` | Switch to Review Queue view |
| `s` | Switch to Skills view |
| `k` | Switch to Hooks view |
| `h` | Switch to Health view |
| `g` | Switch to Graph view |
| `q` | Quit the shell |
| `i` | Cycle intro mode on the Projects dashboard |
| `t` | Toggle enabled/disabled state in Skills view |
| `/text` | Set a filter (filters items in the current view by text match) |
| `/` | Clear the filter |
| `:` | Enter a palette command |

## Palette Commands

All palette commands start with `:`. You can also type them without the colon prefix.

### Project Context

| Command | Description |
|---------|-------------|
| `:open <project>` | Set the active project context across all views |
| `:intro always\|once-per-version\|off` | Tune the startup intro behavior |

### Task

| Command | Description |
|---------|-------------|
| `:add <task>` | Add a new item to the task Queue section |
| `:complete <id\|match>` | Mark a task item as done |
| `:move <id\|match> <active\|queue\|done>` | Move a task item between sections |
| `:reprioritize <id\|match> <high\|medium\|low>` | Set an item's priority |
| `:context <id\|match> <text>` | Append or update context on a task item |
| `:work next` | Move the top Queue item to Active |
| `:tidy [keep]` | Archive old Done items (default: keep last 30) |

### Findings

| Command | Description |
|---------|-------------|
| `:find add <text>` | Append a finding to the selected project |
| `:find remove <id\|match>` | Remove a finding by ID or text match |

### Review Queue

The shell exposes the review queue for inspection only. Queue mutation commands were removed, so use maintenance flows such as `phren maintain prune` or update the underlying findings directly instead.

### Infrastructure

| Command | Description |
|---------|-------------|
| `:machine map <hostname> <profile>` | Map a machine hostname to a profile |
| `:profile add-project <profile> <project>` | Add a project to a profile |
| `:profile remove-project <profile> <project>` | Remove a project from a profile |
| `:run fix` | Run `doctor --fix` to self-heal configuration |
| `:relink` | Refresh generated links, context files, and hook wiring |
| `:rerun hooks` | Execute lifecycle hooks now (session-start + stop) |
| `:update` | Update phren to the latest version |
| `:reset` | Reset shell state to defaults |

### Pagination

| Command | Description |
|---------|-------------|
| `:page next` | Go to the next page |
| `:page prev` | Go to the previous page |
| `:page <n>` | Jump to page number n |
| `:per-page <n>` | Set rows per page (1 to 200) |
| `:help` | Show the full keyboard map and command list |

## Splash

Launching the shell plays a short splash: the phren mascot beside the block-letter wordmark. On the first launch of a new version the wordmark is revealed with a "decrypt" text effect (scrambled block glyphs settle left to right into the letters) and the splash waits for a key; later launches open on the finished wordmark for half a second. A light beam shimmers across the letters while the splash is up. Press `i` on the Projects dashboard to cycle the intro mode between once-per-version, always, and off.

The same splash is exported for other hosts as `@phren/cli/shell/intro` (`playSplash`); `phren-agent -i` uses it before its TUI starts, and `PHREN_INTRO=off` skips it there.

## State Persistence

The shell saves its state (selected project, filter, page, rows per page, intro mode, and last-seen intro version) to `.runtime/shell-state.json`. This means your context and intro preference are preserved between shell sessions. Use `:reset` to clear saved state. A `--view`/`--project` deep link overrides the saved view and project for that launch.

## Filtering

Type `/` followed by text to filter the current view. The filter applies as a case-insensitive substring match against item content. Type `/` alone to clear the filter. Filters reset the page to 1.
