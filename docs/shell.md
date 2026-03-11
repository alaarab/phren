# Interactive Shell

The cortex shell is a terminal UI for browsing and managing your project store. It launches automatically when you run `cortex` with no arguments in a terminal, or explicitly with `cortex shell`.

```bash
cortex shell
```

## Views

The shell has eight views. Switch between them with single-key shortcuts or palette commands.

### Projects (`p`)

Projects is the shell landing screen. It opens as a dashboard first, then lists all indexed projects in the active profile underneath.

The dashboard shows profile-wide counts for projects, active task, queued task, findings, review queue, sync state, and intro mode. The project list below that includes per-project workload counts so you can stay global until you actually want to open a project.

The currently selected project is marked with a green dot. Use `↵` or `:open <project>` to change the active project context, which persists across all views.

### Task (`b`)

Shows the selected project's `tasks.md` file parsed into three sections: Active, Queue, and Done. Each item has an auto-generated ID for easy reference in commands.

### Findings (`l`)

Lists entries from the selected project's FINDINGS.md with dates and optional citations. Entries are shown with their auto-generated IDs for use with `:find remove`.

### Review Queue (`m`)

Shows pending review items from `MEMORY_QUEUE.md`. Each item displays its section (Review, Stale, Conflicts), a risk badge, confidence score, and date. Triage items with `:mq approve`, `:mq reject`, or `:mq edit`.

### Skills (`s`)

Shows installed global and project-local skills and lets you inspect what is available in the current context.

Skills now have first-class lifecycle state:
- enabled skills are active and participate in linking/discovery
- disabled skills stay on disk but are excluded from active use
- remove is still separate and destructive

### Hooks (`k`)

Shows lifecycle hook status and custom hook configuration for the active setup.

### Machines/Profiles (via `:machines`)

Shows the machines.yaml mapping (hostname to profile) and all profiles with their project lists. Use `:machine map` and `:profile add-project`/`:profile remove-project` to edit these safely without touching YAML directly.

### Health (`h`)

Runs doctor checks and shows results alongside runtime health data: last hook run, last auto-save, last governance run. Offers remediation commands (`:run fix`, `:relink`, `:rerun hooks`, `:update`).

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

### Review Queue Triage

| Command | Description |
|---------|-------------|
| `:mq approve <id\|match>` | Approve a queued memory item (promotes to FINDINGS.md) |
| `:mq reject <id\|match>` | Reject a queued memory item (removes it) |
| `:mq edit <id\|match> <text>` | Edit a queued memory item's text |

### Infrastructure

| Command | Description |
|---------|-------------|
| `:machine map <hostname> <profile>` | Map a machine hostname to a profile |
| `:profile add-project <profile> <project>` | Add a project to a profile |
| `:profile remove-project <profile> <project>` | Remove a project from a profile |
| `:run fix` | Run `doctor --fix` to self-heal configuration |
| `:relink` | Refresh generated links, context files, and hook wiring |
| `:rerun hooks` | Execute lifecycle hooks now (session-start + stop) |
| `:update` | Update cortex to the latest version |
| `:reset` | Reset shell state to defaults |

### Pagination

| Command | Description |
|---------|-------------|
| `:page next` | Go to the next page |
| `:page prev` | Go to the previous page |
| `:page <n>` | Jump to page number n |
| `:per-page <n>` | Set rows per page (1 to 200) |
| `:help` | Show the full keyboard map and command list |

## State Persistence

The shell saves its state (selected project, filter, page, rows per page, intro mode, and last-seen intro version) to `.runtime/shell-state.json`. This means your context and intro preference are preserved between shell sessions. Use `:reset` to clear saved state.

## Filtering

Type `/` followed by text to filter the current view. The filter applies as a case-insensitive substring match against item content. Type `/` alone to clear the filter. Filters reset the page to 1.
