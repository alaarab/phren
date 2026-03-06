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

Learnings are captured automatically during the session and committed when the session ends.

## Hooks (auto-inject, v1.7.0+)

Running `npx @alaarab/cortex init` also registers Claude Code hooks:

- **UserPromptSubmit**: Injects relevant cortex context into every prompt automatically
- **Stop**: Auto-commits and pushes cortex changes after every response
- **SessionStart**: Pulls latest cortex changes and injects project context

## CLI subcommands

```bash
cortex search "query"                # FTS5 search with synonym expansion
cortex hook-prompt                   # stdin JSON -> context block (used by hooks)
cortex hook-context                  # project context for cwd (used after compaction)
cortex add-learning <project> "..."  # append a learning via CLI
```

## Available MCP tools (19)

**Search and browse:**
- `search_knowledge(query, type?, limit?, project?)`: full-text search across all project knowledge. `type` filter: `claude`, `learnings`, `knowledge`, `summary`, `backlog`, `skill`.
- `get_project_summary(name)`: fetch the summary for a specific project
- `list_projects()`: list all projects in your knowledge base
- `get_learnings(project, limit?)`: read recent learnings for a project without a search query

**Backlog management:**
- `get_backlog(project?, id?, item?)`: fetch open tasks for a project (or all projects), or a single item by ID or text
- `add_backlog_item(project, item)`: add a task to a project's backlog queue
- `complete_backlog_item(project, item)`: match a task by text and move it to Done
- `complete_backlog_items(project, items[])`: bulk complete multiple items in one call
- `update_backlog_item(project, item, updates)`: update a task's priority, context, or section

**Learning capture:**
- `add_learning(project, learning, citation?)`: append a learning to LEARNINGS.md under today's date with optional citation
- `add_learnings(project, learnings[])`: bulk add multiple learnings in one call
- `remove_learning(project, text)`: remove a learning by matching text
- `remove_learnings(project, learnings[])`: bulk remove multiple learnings in one call
- `push_changes(message?)`: commit and push all cortex changes

**Memory quality:**
- `pin_memory(project, memory)`: write canonical/pinned memory that bypasses decay
- `memory_feedback(key, feedback)`: record helpful/reprompt/regression outcomes

**Data management:**
- `export_project(project)`: export project data as portable JSON
- `import_project(data)`: import project from exported JSON
- `manage_project(project, action)`: archive or unarchive a project
