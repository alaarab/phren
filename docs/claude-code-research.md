# Claude Code & Agent SDK: Technical Architecture Report

> Research for phren-agent design. Covers the agent loop, tool system, context management, sub-agents, permissions, hooks, the Claude Agent SDK, and what makes Claude Code best-in-class.

---

## 1. The Agent Loop (TAOR)

Claude Code's core is a **single-threaded master loop** following the Think-Act-Observe-Repeat (TAOR) cycle. The runtime is deliberately minimal (~50 lines of loop logic). All intelligence lives in the model and system prompt.

### Lifecycle

```
User Prompt
  -> Claude evaluates (reason about state)
  -> Tool call(s) requested?
     YES -> SDK executes tools -> results feed back to Claude -> repeat
     NO  -> Final text response -> ResultMessage -> loop ends
```

### Three Phases (Blended)

1. **Gather context** - search files, read code, understand the problem
2. **Take action** - edit files, run commands, make changes
3. **Verify results** - run tests, check output, confirm correctness

These phases are not discrete steps. Claude dynamically chains dozens of actions, course-correcting based on each tool result. The loop continues until Claude produces a response with **no tool calls**, or hits `maxTurns`/`maxBudgetUsd` limits.

### Key Design Decisions

- **Model as CEO**: The model decides next steps; the runtime is deliberately "dumb." No hard-coded orchestration, no predefined exit conditions beyond safety caps.
- **Co-evolution**: The harness deliberately shrinks as models improve. Hard-coded scaffolding (planning steps, explicit error recovery) is deleted with each model release. "If your product gets more complex with each model release, your architecture is wrong."
- **Interruptibility**: Users can interrupt at any point. Claude stops and adjusts its approach based on user input.

### Turns and Messages

A **turn** is one round trip: Claude produces output with tool calls -> SDK executes -> results feed back. Five message types:

| Type | Purpose |
|------|---------|
| `SystemMessage` | Session lifecycle (`init`, `compact_boundary`) |
| `AssistantMessage` | Claude's response each turn (text + tool calls) |
| `UserMessage` | Tool results fed back to Claude |
| `StreamEvent` | Real-time streaming deltas |
| `ResultMessage` | Final output with cost, usage, session ID |

### Adaptable to phren-agent

The loop is simple but powerful. Key pattern: the agent never needs complex state machines. It's just `while (hasTool calls) { execute(); feedBack(); }`. The model handles all routing and decision-making.

---

## 2. Tool System

### Primitive Tools Philosophy

Rather than building hundreds of specialized integrations, Claude Code provides **four capability primitives**:

| Primitive | Tools | Purpose |
|-----------|-------|---------|
| **Read** | `Read`, `Glob`, `Grep` | File inspection and search |
| **Write** | `Edit`, `Write` | File creation and modification |
| **Execute** | `Bash` | Shell access as universal adapter |
| **Connect** | MCP servers, `WebSearch`, `WebFetch` | External services |

Plus orchestration tools: `Agent`, `Skill`, `AskUserQuestion`, `ToolSearch`, `TodoWrite`.

### Why Primitives Win

"Bash acts as the universal adapter, allowing the model to use any tool a human developer would (git, npm, docker)." New capabilities emerge without architectural changes -- the agent just chains existing primitives. This composability is why a small toolset outperforms agents with hundreds of bespoke integrations.

### Tool Definitions

Each tool has:
- **Name**: e.g., `Read`, `Edit`, `Bash`
- **Description**: natural language explaining what it does and when to use it
- **Parameters**: JSON Schema defining inputs
- **Annotations**: metadata like `readOnly` for parallel execution hints

### Parallel Tool Execution

When Claude requests multiple tool calls in a single turn:
- **Read-only tools** (`Read`, `Glob`, `Grep`, read-only MCP tools) run **concurrently**
- **Mutating tools** (`Edit`, `Write`, `Bash`) run **sequentially** to avoid conflicts

### Tool Search (Deferred Loading)

When MCP servers expose 100+ tools, `ToolSearch` loads tool schemas **on demand** instead of preloading all of them into context. Only tool names consume context until Claude actually uses a specific tool. This is critical for MCP-heavy setups.

### Adaptable to phren-agent

Phren already follows this pattern with 54 MCP tools. The key insight: tools should be JSON-in/JSON-out with clear descriptions. The model selects tools based on descriptions alone. Keep tool count manageable or use deferred loading.

---

## 3. Context Management

### Context as a Scarce Resource

Everything accumulates in the context window: system prompt, tool definitions, conversation history, tool inputs, tool outputs, CLAUDE.md, auto memory, loaded skills, and system instructions. Claude Code treats tokens as currency with multi-layered defense.

### What Consumes Context

| Source | When | Impact |
|--------|------|--------|
| System prompt | Every request | Small fixed cost |
| CLAUDE.md | Session start | Full content, prompt-cached |
| Tool definitions | Every request | Each tool adds schema |
| Conversation history | Accumulates | Grows with each turn |
| Skill descriptions | Session start | Short; full content on-demand |

### Automatic Compaction

When context approaches the limit (~50% utilization triggers it):

1. Older tool outputs cleared first
2. Conversation summarized if needed
3. Requests and key code snippets preserved
4. Instructions from early conversation may be lost
5. SDK emits `SystemMessage` with subtype `compact_boundary`

Users can customize compaction:
- **Summarization instructions in CLAUDE.md**: "When summarizing, always preserve: the task objective, modified file paths, test results, and decisions made."
- **`PreCompact` hook**: Archive full transcript before summarization
- **Manual compaction**: `/compact` with focus (e.g., `/compact focus on the API changes`)

### Prompt Caching

Content that stays the same across turns (system prompt, tool definitions, CLAUDE.md) is automatically prompt-cached, reducing cost and latency for repeated prefixes.

### Strategies for Long Sessions

1. **Sub-agents for subtasks**: Fresh context windows; only final summary returns to parent
2. **Selective tools**: Scope sub-agents to minimum tool sets
3. **Watch MCP costs**: Each server adds all tool schemas to every request
4. **Lower effort for routine tasks**: `effort: "low"` for file lookups
5. **Skill on-demand loading**: Full content loads only when invoked

### Adaptable to phren-agent

Phren already implements a version of this with `PHREN_CONTEXT_TOKEN_BUDGET` (550 default) and `PHREN_MAX_INJECT_TOKENS` (2000). The key lesson: context injection must be bounded and ranked. Progressive disclosure (inject index, expand on demand) keeps memory growth and prompt context growth decoupled.

---

## 4. Sub-Agents

### Architecture

Sub-agents are separate agent instances running independent TAOR loops in isolated context windows. Only the final response returns to the parent.

### Benefits

1. **Context isolation**: Intermediate tool calls stay inside sub-agent; parent gets summary only
2. **Parallelization**: Multiple sub-agents run concurrently
3. **Specialized instructions**: Tailored system prompts per sub-agent
4. **Tool restrictions**: Limit sub-agents to specific tool subsets

### Three Built-in Sub-Agents

| Agent | Purpose | Tools |
|-------|---------|-------|
| **Explore** | Read-only codebase discovery | Read, Glob, Grep |
| **Plan** | Codebase research for planning | Read, Glob, Grep |
| **General-purpose** | Any delegated task | Inherited from parent |

### Custom Sub-Agents (Programmatic)

```typescript
agents: {
  "code-reviewer": {
    description: "Expert code reviewer for quality and security reviews.",
    prompt: "Analyze code quality and suggest improvements.",
    tools: ["Read", "Glob", "Grep"],
    model: "sonnet"
  }
}
```

### Custom Sub-Agents (Filesystem)

Define as markdown files in `.claude/agents/`:

```yaml
---
name: code-reviewer
tools: Read, Glob, Grep, Bash
disallowedTools: Write, Edit
model: sonnet
maxTurns: 25
---
```

### What Sub-Agents Inherit

| Receives | Does NOT Receive |
|----------|------------------|
| Own system prompt + Agent tool's prompt | Parent conversation history |
| Project CLAUDE.md | Parent's system prompt |
| Tool definitions (inherited or scoped) | Skills (unless listed) |

### Agent Teams (Experimental)

Unlike sub-agents (parent-child), Agent Teams are **peer processes** coordinating via shared task lists and IPC:

- Separate terminal sessions for each teammate
- Self-claiming mechanism: agents pull next unassigned task when idle
- Shared message passing (bidirectional + broadcast)
- Quality gate hooks (`TeammateIdle`, `TaskCompleted`)
- Enable via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`

### Adaptable to phren-agent

Phren's session system already supports continuity across agents. For phren-agent, the key patterns are:
- Fresh context per sub-agent prevents pollution
- Summary-only return keeps parent context lean
- Tool scoping prevents sub-agents from exceeding their mandate
- Agent Teams model is powerful for swarm-style workloads

---

## 5. Permission System

### Six-Tiered Permission Model

| Mode | Behavior | Trust Level |
|------|----------|-------------|
| `plan` | Read-only, no writes | Lowest |
| `default` | Ask before edits/shell | Standard |
| `acceptEdits` | Auto-approve edits only | Medium |
| `dontAsk` | Auto-approve whitelisted | High |
| `auto` | Background safety checks (research preview) | High |
| `bypassPermissions` | Skip all checks | Maximum |

### Granular Tool Permissions

Three options work together:

1. **`allowedTools`**: Auto-approves listed tools (e.g., `["Read", "Glob", "Grep"]`)
2. **`disallowedTools`**: Blocks listed tools regardless of other settings
3. **`permissionMode`**: Controls what happens to tools not covered by allow/deny

### Pattern-Based Rules

Scope individual tools with glob patterns:
- `Bash(npm:*)` -- allow only npm commands
- `Bash(rm *)` -- match destructive commands for blocking
- `Edit(*.ts)` -- scope edits to TypeScript files
- `mcp__memory__.*` -- match all tools from an MCP server

When a tool is denied, Claude receives a rejection message as the tool result and attempts a different approach.

### Pre-Collection for Background Agents

Permissions can be pre-collected for background sub-agents. If not pre-approved, the tool call simply fails and the agent continues. This is critical for autonomous operation.

### Adaptable to phren-agent

Phren's governance system (RBAC roles: admin, maintainer, contributor, viewer) maps well to this model. For phren-agent, the pattern is: define a permission mode per agent type, pre-approve safe operations, and let the agent gracefully degrade when tools are denied.

---

## 6. Claude Agent SDK

### Overview

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` / `claude-agent-sdk`) embeds Claude Code's autonomous agent loop in custom applications. Available in TypeScript and Python.

### Core API

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find and fix the bug in auth.py",
  options: {
    allowedTools: ["Read", "Edit", "Bash"],
    settingSources: ["project"],  // Load CLAUDE.md, skills, hooks
    maxTurns: 30,
    maxBudgetUsd: 5.0,
    effort: "high",
    model: "claude-opus-4-6",
  }
})) {
  if (message.type === "result") {
    console.log(message.result);
    console.log(`Cost: $${message.total_cost_usd.toFixed(4)}`);
  }
}
```

### Key Differences from Raw API

| Anthropic Client SDK | Claude Agent SDK |
|---------------------|-----------------|
| You implement the tool loop | SDK handles tools autonomously |
| You define tool schemas | Built-in tools included |
| Manual message management | Automatic context + compaction |
| No filesystem access | Full Read/Write/Edit/Bash |

### SDK Options

| Option | What it controls |
|--------|-----------------|
| `allowedTools` | Auto-approved tools |
| `disallowedTools` | Blocked tools |
| `permissionMode` | Default permission behavior |
| `maxTurns` | Max tool-use round trips |
| `maxBudgetUsd` | Max cost before stopping |
| `effort` | Reasoning depth (low/medium/high/max) |
| `model` | Model override |
| `agents` | Custom sub-agent definitions |
| `mcpServers` | MCP server connections |
| `hooks` | Lifecycle callbacks |
| `settingSources` | Load CLAUDE.md, skills, hooks from project |
| `resume` | Continue a previous session |
| `systemPrompt` | Additional system prompt text |

### Custom Tools

Define custom tools as in-process MCP servers:

```python
from claude_agent_sdk import query, ClaudeAgentOptions

async for message in query(
    prompt="Check the weather",
    options=ClaudeAgentOptions(
        mcp_servers={
            "weather": {"command": "python", "args": ["weather_server.py"]}
        }
    ),
):
    ...
```

### Sessions

Session IDs enable resume, continue, and fork patterns:

```typescript
// First query - capture session ID
let sessionId: string;
for await (const msg of query({ prompt: "Read the auth module" })) {
  if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
}

// Resume with full context
for await (const msg of query({
  prompt: "Now find all callers",
  options: { resume: sessionId }
})) { ... }
```

### Adaptable to phren-agent

The SDK is the most direct path to building phren-agent. Key insight: phren already has 54 MCP tools. An agent built with the SDK could use phren as an MCP server, gaining all knowledge operations while the SDK provides the loop, context management, and tool execution.

---

## 7. Hooks System

### Overview

Hooks are deterministic lifecycle callbacks that run **outside** the LLM loop at specific injection points. They receive JSON input via stdin and can block, modify, or provide feedback on actions.

### Complete Hook Events (25 events)

| Event | When | Can Block? |
|-------|------|-----------|
| `SessionStart` | Session begins/resumes | No |
| `SessionEnd` | Session terminates | No |
| `UserPromptSubmit` | User submits prompt | Yes |
| `PreToolUse` | Before tool executes | Yes |
| `PostToolUse` | After tool succeeds | Yes |
| `PostToolUseFailure` | After tool fails | No |
| `PermissionRequest` | Permission dialog appears | Yes |
| `Notification` | Notification sent | No |
| `SubagentStart` | Sub-agent spawned | No |
| `SubagentStop` | Sub-agent finishes | Yes |
| `TaskCreated` | Task created | Yes |
| `TaskCompleted` | Task marked complete | Yes |
| `Stop` | Agent finishes responding | Yes |
| `StopFailure` | Turn ends from API error | No |
| `TeammateIdle` | Team teammate goes idle | Yes |
| `InstructionsLoaded` | CLAUDE.md loaded | No |
| `ConfigChange` | Config file changes | Yes |
| `CwdChanged` | Working directory changes | No |
| `FileChanged` | Watched file changes | No |
| `PreCompact` | Before context compaction | No |
| `PostCompact` | After context compaction | No |
| `WorktreeCreate` | Worktree being created | Yes |
| `WorktreeRemove` | Worktree being removed | No |
| `Elicitation` | MCP server requests user input | Yes |
| `ElicitationResult` | User responds to MCP elicitation | Yes |

### Four Hook Types

| Type | How it runs | Best for |
|------|-----------|----------|
| `command` | Shell script, stdin/stdout | Custom logic, linting |
| `http` | POST to URL | External integrations |
| `prompt` | LLM evaluates | Dynamic validation |
| `agent` | Sub-agent with tools | Complex checks |

### Configuration Format

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "if": "Bash(rm *)",
        "command": ".claude/hooks/block-rm.sh",
        "timeout": 600
      }]
    }]
  }
}
```

### Key Hook Patterns

1. **Context injection**: `UserPromptSubmit` adds phren knowledge before Claude processes the prompt
2. **Auto-capture**: `PostToolUse` captures tool-level continuity hints from interesting file/command activity
3. **Persistence**: `Stop` auto-commits and pushes changes after every response
4. **Session lifecycle**: `SessionStart` creates session records and pulls latest state
5. **Safety gates**: `PreToolUse` blocks destructive commands deterministically

### How Phren Uses Hooks

Phren registers four hooks:

| Hook | Handler | Purpose |
|------|---------|---------|
| `UserPromptSubmit` | `hook-prompt` | FTS5 search, inject relevant context |
| `PostToolUse` | `hook-tool` | Capture continuity hints, queue review candidates |
| `Stop` | `hook-stop` | Git commit/push ~/.phren changes |
| `SessionStart` | `hook-session-start` | Git pull, create session record |

### Determinism Matters

Hooks are **deterministic** -- all matching hooks fire regardless. This replaces non-deterministic LLM decisions for guardrails, linting, and auditing. The philosophy: "Use hooks where behavior must be guaranteed; use the model where flexibility matters."

### Adaptable to phren-agent

Phren already has excellent hook integration. For phren-agent, hooks provide the bridge between the agent loop and phren's knowledge system. The SDK supports all hook events as callbacks, meaning phren-agent can use both file-based hooks (for CLI compatibility) and programmatic hooks (for SDK-based agents).

---

## 8. What Makes Claude Code Best-in-Class

### Five Core Design Pillars

1. **Model-Driven Autonomy**: The model decides next steps, not hard-coded scripts
2. **Context as a Resource**: Auto-compaction, semantic search, sub-agent isolation protect the context window
3. **Layered Memory**: 6 layers load at session start (org policies -> project config -> user prefs -> auto-learned patterns -> session history -> real-time context)
4. **Declarative Extensibility**: Skills, agents, hooks via .md and .json -- not code
5. **Composable Permissions**: Tool-level allow/deny/ask with full spectrum from read-only to bypass

### Specific Winning Decisions

**Primitives over integrations**: Four core tools (Read, Write, Execute, Connect) + Bash as universal adapter outperforms 100 bespoke plugins. New capabilities emerge without architectural changes.

**Thin harness, thick model**: The runtime is deliberately minimal. Intelligence lives in the model and system prompt. This means improvements come from model upgrades, not code changes.

**Deterministic hooks for guardrails**: Hooks replace LLM decisions where behavior must be guaranteed (linting, security, auditing). LLM handles routing and creativity; hooks handle invariants.

**Session-as-branch model**: Sessions are independent with checkpoint/rollback/fork capabilities. Like git branches for conversations.

**Sub-agent isolation**: Each sub-agent gets a fresh context window. Only summaries return to parents. This prevents context pollution and enables parallelism.

**Tool search (deferred loading)**: MCP tool schemas load on demand, not upfront. Only tool names consume context until needed.

**Effort levels**: `low`/`medium`/`high`/`max` trade latency and cost for reasoning depth. Cheap agents for simple tasks, expensive agents for complex ones.

**Auto-compaction with customizable preservation**: When context fills, the system summarizes old turns but preserves what matters. Users can instruct the compactor via CLAUDE.md.

### Systematic Failure Mode Prevention

| Failure Mode | Solution |
|-------------|----------|
| Runaway loops | `maxTurns` cap + model-driven stop |
| Context collapse | Auto-compaction + sub-agent isolation |
| Permission roulette | Tool-level allow/deny/ask with globs |
| Amnesia | 6-layer memory + auto-persistence |
| Monolithic context | Sub-agents + Agent Teams |
| Hard-coded behavior | Declarative skills, agents, hooks |
| Black box | Hooks at every lifecycle event |
| Single-threaded | Sub-agents (sequential) + Teams (parallel) |

### What Competitors Lack

- **Codex CLI** has stronger sandboxing (kernel-level) but coarser control and less programmable governance
- **Cursor/Copilot** have tighter IDE integration but weaker autonomous agent loops
- **Gemini CLI** has larger context windows but produces more subtle logical errors in generated code
- Claude Code uniquely combines: fine-grained permissions, programmatic hooks, declarative extensibility, session continuity, and context efficiency -- all in a single coherent system

---

## 9. Patterns for phren-agent

### Architecture Recommendations

1. **Use the Claude Agent SDK directly**: Build phren-agent as a TypeScript application using `@anthropic-ai/claude-agent-sdk`. This gives you the TAOR loop, context management, and all built-in tools for free.

2. **Phren as MCP server**: The agent uses phren's 54 MCP tools for knowledge operations (search, findings, tasks, sessions) while the SDK provides file/shell/web tools.

3. **Hook integration**: Register phren hooks both as file-based (for CLI users) and as SDK callbacks (for programmatic agents). This ensures phren knowledge injection works regardless of how the agent runs.

4. **Sub-agent model**: Use the SDK's `agents` parameter to define specialized phren agents:
   - `knowledge-researcher`: Read-only, searches phren knowledge base
   - `finding-curator`: Adds/edits/consolidates findings
   - `task-manager`: Manages task lifecycle
   - `session-analyst`: Reviews session history for patterns

5. **Context budget enforcement**: Leverage `PHREN_CONTEXT_TOKEN_BUDGET` and progressive disclosure to keep injected context bounded. The SDK's auto-compaction will handle the rest.

6. **Permission presets**: Define permission profiles for different agent roles:
   - `readonly`: `allowedTools: ["Read", "Glob", "Grep"]` + phren search tools
   - `curator`: adds `Edit`, `Write` + phren mutation tools
   - `autonomous`: adds `Bash` with scoped patterns

7. **Session continuity**: Use the SDK's session resume/fork to maintain phren session state across agent invocations. Map SDK session IDs to phren session IDs for seamless continuity.

### Key Takeaways

- **Simple loop, rich tools**: Don't over-engineer the agent loop. The model handles routing.
- **Context is king**: Every design decision should protect the context window.
- **Deterministic where it matters**: Use hooks for invariants, model for creativity.
- **Isolation for scale**: Sub-agents prevent context pollution and enable parallelism.
- **Declarative extensibility**: Skills and agents as markdown/YAML, not code.
- **Permission spectrum**: Scale trust with user comfort, from read-only to autonomous.

---

## Sources

- [How Claude Code Works](https://code.claude.com/docs/en/how-claude-code-works) -- official architecture docs
- [How the Agent Loop Works](https://platform.claude.com/docs/en/agent-sdk/agent-loop) -- SDK loop reference
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) -- SDK capabilities
- [Hooks Reference](https://code.claude.com/docs/en/hooks) -- complete hooks documentation
- [Subagents in the SDK](https://platform.claude.com/docs/en/agent-sdk/subagents) -- sub-agent patterns
- [Claude Code Architecture (Reverse Engineered)](https://vrungta.substack.com/p/claude-code-architecture-reverse) -- deep technical analysis
- [Codex CLI vs Claude Code 2026](https://blakecrosley.com/blog/codex-vs-claude-code-2026) -- comparative architecture
- [Building Agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk) -- Anthropic engineering blog
- [claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript) -- TypeScript SDK source
- [claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python) -- Python SDK source
