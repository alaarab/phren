# Installing cortex

cortex is an MCP server that gives Claude persistent memory across sessions and machines.

## Quickest setup

```bash
npx @alaarab/cortex init
```

This creates `~/.cortex` with starter templates (bundled in the package), registers the current machine, and configures the MCP server in Claude Code and VS Code automatically.

Restart your editor after running it.

## Manual setup

### Claude Code

```bash
claude mcp add cortex -- npx @alaarab/cortex ~/.cortex
```

Or add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["@alaarab/cortex", "~/.cortex"]
    }
  }
}
```

### VS Code / GitHub Copilot

Add to `~/.config/Code/User/mcp.json` (Linux) or `~/Library/Application Support/Code/User/mcp.json` (macOS):

```json
{
  "servers": {
    "cortex": {
      "command": "npx",
      "args": ["@alaarab/cortex", "~/.cortex"]
    }
  }
}
```

## Populating your knowledge base

After installation, cortex needs project knowledge to surface. The starter template at `~/.cortex` includes example projects. Replace them with your own:

```
~/.cortex/
  global/            ← skills and rules that apply everywhere
  my-project/
    summary.md       ← one-paragraph project overview
    CLAUDE.md        ← full session context for this project
    LEARNINGS.md     ← captured knowledge over time
    backlog.md       ← persistent task queue
```

In Claude Code, run `/cortex-init <project-name>` to scaffold a new project entry.

Run `/cortex-learn` at the end of a session to capture what you learned.

## Available MCP tools

- `search_cortex(query)` — full-text search across all project knowledge
- `get_project_summary(project)` — fetch the summary for a specific project
- `list_projects()` — list all projects in your knowledge base
- `get_backlog(project)` — fetch open tasks for a project
- `add_backlog_item(project, title, priority?, context?)` — add a task
- `complete_backlog_item(project, item_number)` — mark a task done
- `update_backlog_item(project, item_number, ...)` — update task details
