# Interactive Shell

The cortex shell is a terminal UI for browsing and managing your knowledge base. It launches automatically when you run `cortex` with no arguments in a terminal, or explicitly with `cortex shell`.

```bash
npx @alaarab/cortex shell
```

## Views

The shell has six views. Switch between them with single-key shortcuts or palette commands.

### Projects (`p`)

Lists all indexed projects in the active profile. Each project shows its name, available doc types (CLAUDE.md, LEARNINGS, summary, backlog), and a brief description pulled from summary.md or CLAUDE.md.

The currently selected project is marked with a green dot. Use `:open <project>` to change the active project context, which persists across all views.

### Backlog (`b`)

Shows the selected project's backlog.md parsed into three sections: Active, Queue, and Done. Each item has an auto-generated ID for easy reference in commands.

### Learnings (`l`)

Lists entries from the selected project's LEARNINGS.md with dates and optional citations. Entries are shown with their auto-generated IDs for use with `:learn remove`.

### Memory Queue (`m`)

Shows pending memory items from MEMORY_QUEUE.md. Each item displays its section (Review, Stale, Conflicts), a risk badge, confidence score, and date. Triage items with `:mq approve`, `:mq reject`, or `:mq edit`.

### Machines/Profiles (via `:machines`)

Shows the machines.yaml mapping (hostname to profile) and all profiles with their project lists. Use `:machine map` and `:profile add-project`/`:profile remove-project` to edit these safely without touching YAML directly.

### Health (`h`)

Runs doctor checks and shows results alongside runtime health data: last hook run, last auto-save, last governance run. Offers remediation commands (`:run fix`, `:relink`, `:rerun hooks`, `:update`).

## Navigation

| Key | Action |
|-----|--------|
| `p` | Switch to Projects view |
| `b` | Switch to Backlog view |
| `l` | Switch to Learnings view |
| `m` | Switch to Memory Queue view |
| `h` | Switch to Health view |
| `q` | Quit the shell |
| `/text` | Set a filter (filters items in the current view by text match) |
| `/` | Clear the filter |
| `:` | Enter a palette command |

## Palette Commands

All palette commands start with `:`. You can also type them without the colon prefix.

### Project Context

| Command | Description |
|---------|-------------|
| `:open <project>` | Set the active project context across all views |

### Backlog

| Command | Description |
|---------|-------------|
| `:add <task>` | Add a new item to the backlog Queue section |
| `:complete <id\|match>` | Mark a backlog item as done |
| `:move <id\|match> <active\|queue\|done>` | Move a backlog item between sections |
| `:reprioritize <id\|match> <high\|medium\|low>` | Set an item's priority |
| `:context <id\|match> <text>` | Append or update context on a backlog item |
| `:work next` | Move the top Queue item to Active |
| `:tidy [keep]` | Archive old Done items (default: keep last 30) |

### Learnings

| Command | Description |
|---------|-------------|
| `:learn add <text>` | Append a learning to the selected project |
| `:learn remove <id\|match>` | Remove a learning by ID or text match |

### Memory Queue Triage

| Command | Description |
|---------|-------------|
| `:mq approve <id\|match>` | Approve a queued memory item (promotes to LEARNINGS.md) |
| `:mq reject <id\|match>` | Reject a queued memory item (removes it) |
| `:mq edit <id\|match> <text>` | Edit a queued memory item's text |

### Infrastructure

| Command | Description |
|---------|-------------|
| `:machine map <hostname> <profile>` | Map a machine hostname to a profile |
| `:profile add-project <profile> <project>` | Add a project to a profile |
| `:profile remove-project <profile> <project>` | Remove a project from a profile |
| `:run fix` | Run `doctor --fix` to self-heal configuration |
| `:relink` | Rerun `cortex link` to rebuild symlinks and hooks |
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

The shell saves its state (current view, selected project, filter, page, rows per page) to `.governance/shell-state.json`. This means your view and project selection are preserved between shell sessions. Use `:reset` to clear saved state.

## Filtering

Type `/` followed by text to filter the current view. The filter applies as a case-insensitive substring match against item content. Type `/` alone to clear the filter. Filters reset the page to 1.
