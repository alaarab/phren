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
claude mcp add cortex -- npx -y @alaarab/cortex ~/.cortex
```

Or add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["-y", "@alaarab/cortex", "~/.cortex"]
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
      "args": ["-y", "@alaarab/cortex", "~/.cortex"]
    }
  }
}
```

## Populating your knowledge base

After installation, cortex needs project knowledge to surface. The starter template at `~/.cortex` includes example projects. Replace them with your own:

```
~/.cortex/
  global/            <- skills and rules that apply everywhere
  my-project/
    summary.md       <- one-paragraph project overview
    CLAUDE.md        <- full session context for this project
    LEARNINGS.md     <- captured knowledge over time
    backlog.md       <- persistent task queue
```

In Claude Code, run `/cortex-init <project-name>` to scaffold a new project entry.

Run `/cortex-update` at the end of a session to capture what you learned.

## Hooks (auto-inject, v1.7.0+)

Running `npx @alaarab/cortex init` also registers Claude Code hooks:

- **UserPromptSubmit**: Injects relevant cortex context into every prompt automatically
- **Stop**: Auto-commits and pushes cortex changes when a session ends

## CLI subcommands

```bash
cortex search "query"                # FTS5 search with synonym expansion
cortex hook-prompt                   # stdin JSON -> context block (used by hooks)
cortex hook-context                  # project context for cwd (used after compaction)
cortex add-learning <project> "..."  # append a learning via CLI
```

## Available MCP tools

- `search_cortex(query, type?, limit?)`: full-text search across all project knowledge. `type` filter: `claude`, `learnings`, `knowledge`, `summary`, `backlog`, `skill`.
- `get_project_summary(name)`: fetch the summary for a specific project
- `list_projects()`: list all projects in your knowledge base
- `get_backlog(project?)`: fetch open tasks for a project (or all projects)
- `add_backlog_item(project, item)`: add a task to a project's backlog queue
- `complete_backlog_item(project, item)`: match a task by text and move it to Done
- `update_backlog_item(project, item, updates)`: update a task's priority, context, or section
- `add_learning(project, insight)`: append a learning to LEARNINGS.md under today's date
- `remove_learning(project, text)`: remove a learning by matching text
- `save_learnings(message?)`: commit and push all cortex changes
