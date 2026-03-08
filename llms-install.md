# Installing cortex

cortex is an MCP server that gives Claude persistent context across sessions and machines.

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

## Populating your project store

After installation, cortex needs project data to surface. The starter template at `~/.cortex` includes example projects. Replace them with your own:

```
~/.cortex/
  global/            <- skills and rules that apply everywhere
  my-project/
    summary.md       <- one-paragraph project overview
    CLAUDE.md        <- full session context for this project
    FINDINGS.md      <- captured findings over time
    backlog.md       <- persistent task queue
```

In Claude Code, run `/cortex-init <project-name>` to scaffold a new project entry.

Findings are captured automatically during the session and committed when the session ends.

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
cortex add-finding <project> "..."   # append a finding via CLI
```

## Available MCP tools (29)

**Search and browse:**
- `search_knowledge(query, type?, limit?, project?)`: full-text search across all project data. `type` filter: `claude`, `findings`, `reference`, `summary`, `backlog`, `skill`.
- `get_project_summary(name)`: fetch the summary for a specific project
- `list_projects()`: list all projects in your project store
- `get_findings(project, limit?)`: read recent findings for a project without a search query

**Backlog management:**
- `get_backlog(project?, id?, item?)`: fetch open tasks for a project (or all projects), or a single item by ID or text
- `add_backlog_item(project, item)`: add a task to a project's backlog queue
- `complete_backlog_item(project, item)`: match a task by text and move it to Done
- `complete_backlog_items(project, items[])`: bulk complete multiple items in one call
- `update_backlog_item(project, item, updates)`: update a task's priority, context, or section

**Finding capture:**
- `add_finding(project, finding, citation?)`: append a finding to FINDINGS.md under today's date with optional citation
- `add_findings(project, findings[])`: bulk add multiple findings in one call
- `remove_finding(project, text)`: remove a finding by matching text
- `remove_findings(project, findings[])`: bulk remove multiple findings in one call
- `push_changes(message?)`: commit and push all cortex changes

**Memory quality:**
- `pin_memory(project, memory)`: write canonical/pinned memory that bypasses decay
- `memory_feedback(key, feedback)`: record helpful/reprompt/regression outcomes

**Data management:**
- `export_project(project)`: export project data as portable JSON
- `import_project(data)`: import project from exported JSON
- `manage_project(project, action)`: archive or unarchive a project

**Entity graph:**
- `search_entities(name)`: find entities and related docs by name
- `get_related_docs(entity)`: get docs linked to a named entity
- `read_graph(project?)`: read the entity graph for a project or all projects
- `link_findings(project, finding_text, entity, relation?)`: manually link a finding to an entity
- `cross_project_entities()`: find entities shared across multiple projects

**Session management:**
- `session_start(project?)`: mark session start, returns prior summary + recent findings + active backlog
- `session_end(summary?)`: mark session end, save summary for next session
- `session_context()`: get current session state
