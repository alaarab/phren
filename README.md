<div align="center">
<br>
<img src="icon.svg" width="112" alt="cortex logo" />
<br><br>

# cortex

**A file-backed memory system for coding agents.**

[![MIT License](https://img.shields.io/badge/license-MIT-2C3E50?style=flat&labelColor=101414)](LICENSE)
[![npm](https://img.shields.io/npm/v/@alaarab/cortex?style=flat&labelColor=101414&color=2B8A7D)](https://www.npmjs.com/package/@alaarab/cortex)
[![Docs](https://img.shields.io/badge/docs-alaarab.github.io%2Fcortex-2B8A7D?style=flat&labelColor=101414)](https://alaarab.github.io/cortex/)

</div>

---

`cortex` keeps long-term engineering memory where it belongs: in your repo-adjacent files, under git, reviewable in diffs.

You get prompt-time context injection, memory capture, governance, and MCP tooling without giving up local control.

## What It Solves

Most teams do not fail because they lack notes. They fail because notes are disconnected from daily execution.

`cortex` closes that loop:
1. Before each prompt, inject relevant context.
2. During work, capture learnings and backlog updates.
3. At session boundaries, self-heal links/hooks and persist memory state.

No hidden database. No black box memory state. Just files you can read and change.

## 60-Second Start

```bash
npx @alaarab/cortex init
```

This sets up:
- `~/.cortex` workspace
- MCP registration for detected tools (Claude Code, VS Code, Cursor, Copilot CLI, Codex)
- lifecycle hooks for retrieval/autosave/self-heal
- machine/profile wiring for multi-machine usage

### MCP On/Off

MCP is **on by default** and recommended.

```bash
npx @alaarab/cortex init --mcp off
```

Toggle later at any time:

```bash
npx @alaarab/cortex mcp-mode status
npx @alaarab/cortex mcp-mode on
npx @alaarab/cortex mcp-mode off
```

`--mcp off` keeps hook-based behavior as a fallback path.

### Daily Commands

```bash
# setup and repair
npx @alaarab/cortex init [--machine <name>] [--profile <name>] [--mcp on|off]
npx @alaarab/cortex link [--machine <name>] [--profile <name>] [--register] [--task debugging|planning|clean] [--all-tools] [--mcp on|off]
npx @alaarab/cortex doctor [--fix]

# retrieval and context hooks
npx @alaarab/cortex search "<query>"
npx @alaarab/cortex hook-prompt
npx @alaarab/cortex hook-context

# memory operations
npx @alaarab/cortex add-learning <project> "<learning>"
npx @alaarab/cortex extract-memories [project]
npx @alaarab/cortex govern-memories [project]
npx @alaarab/cortex prune-memories [project]
npx @alaarab/cortex consolidate-memories [project]
npx @alaarab/cortex quality-feedback --key=<k> --type=helpful|reprompt|regression
npx @alaarab/cortex pin-memory <project> "<memory>"
npx @alaarab/cortex memory-policy [get|set ...]
npx @alaarab/cortex memory-workflow [get|set ...]
npx @alaarab/cortex memory-access [get|set ...]
npx @alaarab/cortex memory-ui [--port=3499]
```

### Prompt Budget Controls

`hook-prompt` enforces a context budget. Tune it with:

```bash
export CORTEX_CONTEXT_TOKEN_BUDGET=420
export CORTEX_CONTEXT_SNIPPET_LINES=5
export CORTEX_CONTEXT_SNIPPET_CHARS=420
```

## MCP Surface

### Retrieval and Discovery
- `search_cortex`
- `get_project_summary`
- `list_projects`
- `list_machines`
- `list_profiles`

### Backlog
- `get_backlog`
- `add_backlog_item`
- `complete_backlog_item`
- `update_backlog_item`

### Memory and Governance
- `add_learning`
- `remove_learning`
- `save_learnings`
- `pin_memory`
- `govern_memories`
- `prune_memories`
- `consolidate_memories`
- `memory_policy`
- `memory_workflow`
- `memory_access`
- `memory_feedback`

## Filesystem Contract

Each project is plain markdown:

| File | Purpose |
|---|---|
| `summary.md` | quick project card |
| `CLAUDE.md` | operating conventions and context |
| `KNOWLEDGE.md` | deeper reference material |
| `LEARNINGS.md` | date-stamped lessons with citations |
| `backlog.md` | active/queue/done flow |
| `CANONICAL_MEMORIES.md` | pinned high-signal memory |
| `MEMORY_QUEUE.md` | queued review items |

Governance state:
- `.governance/access-control.json`
- `.governance/memory-policy.json`
- `.governance/memory-workflow-policy.json`
- `.governance/install-preferences.json`
- `.governance/memory-scores.json`
- `.governance/memory-usage.log`
- `.governance/canonical-locks.json`

## Multi-Machine Profiles

`machines.yaml` maps machines to profiles:

```yaml
work-desktop: work
home-laptop: personal
```

Profiles define visible projects:

```yaml
name: personal
projects:
  - global
  - my-api
  - my-frontend
```

`cortex link` applies profile-scoped projects, symlinks, hooks, context, and memory pointers.

## Agent Compatibility

| Agent | Context Hooks | Auto-save | MCP |
|---|:---:|:---:|:---:|
| Claude Code | ✓ | ✓ | ✓ |
| GitHub Copilot CLI | ✓ | ✓ | ✓ (best-effort auto-config) |
| Cursor | ✓ | ✓ | ✓ (best-effort auto-config) |
| OpenAI Codex | ✓ | ✓ | ✓ (best-effort auto-config) |
| VS Code | - | - | ✓ |

MCP auto-config uses detected user paths; hook fallback remains available.

## Enterprise TLS / WSL Notes

If your network uses TLS inspection (for example Zscaler), expose the CA cert to Node:

```bash
export SSL_CERT_FILE="/usr/local/share/ca-certificates/zscaler.crt"
export NODE_EXTRA_CA_CERTS="/usr/local/share/ca-certificates/zscaler.crt"
```

In WSL, run install/build/test via interactive shell so `nvm` and profile exports load.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).  
If you’re changing behavior, keep README/docs and `mcp/src/index.ts` command/tool docs in sync.

---

MIT License. Built by [Ala Arab](https://github.com/alaarab).
