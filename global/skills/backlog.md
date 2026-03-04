# /backlog - Project Task Queue

Persistent backlog per project. Tasks survive across sessions. The orchestrator stays lean - add, prioritize, delegate. Worker agents pick up items and run the pipeline.

## Where backlogs live

```
~/cortex/<project>/backlog.md
```

Each project gets its own file. If it doesn't exist yet, create it.

## Format

```md
# <project> backlog

## Active
Tasks currently being worked on.

- [ ] #12 Short description of the task `[priority]`
  Context: why this matters, what files are involved, any gotchas

## Queue
Next up. Ordered by priority - top item gets picked first.

- [ ] #13 Task description `[high]`
- [ ] #14 Task description `[medium]`
- [ ] #15 Task description `[low]`

## Done
Completed items. Keep recent ones for context, archive old ones.

- [x] #11 What was done (v2.5.7)
- [x] #10 What was done (v2.5.6)
```

Priorities: `[critical]`, `[high]`, `[medium]`, `[low]`

IDs are just incrementing numbers per project. Keep them simple.

## Commands

### View the backlog
Read the project's backlog.md. Show active items, then the queue. Skip done items unless asked.

### Add a task
Append to the Queue section with the next ID. Include enough context that a worker agent could pick it up cold.

### Prioritize
Reorder the Queue section. Move items up or down based on what the user says.

### Clean up
Mark done items, remove stale ones, update context on items that shifted.

### Work the backlog
This is where it connects to the pipeline. Two modes:

**Single item:** Pick the top queue item, move it to Active, and run the full pipeline on it (code, test, humanize, done). When finished, move to Done.

**Swarm mode:** Spin up team agents (using /swarm pattern) and assign backlog items to them. The orchestrator stays lean - it just monitors, adds new items that come up, and reassigns if someone gets stuck.

```
"work the myapp backlog"        -> single item, full pipeline
"swarm the myapp backlog"       -> team agents, parallel execution
"add X to the myapp backlog"    -> append to queue
"show me the myapp backlog"     -> display current state
```

## Worker agent flow

When a worker picks up a backlog item:

1. Read the task context from backlog.md
2. Do the work (implementation, fix, whatever the task says)
3. Run the project's pipeline (/verify, /testing, /humanize, /done as needed)
4. Message the orchestrator with results
5. Orchestrator marks it done and moves to the next item

If the worker realizes the task is bigger than expected, it messages back instead of going rogue. The orchestrator decides whether to split it into subtasks or deploy more agents.

## Starting a project backlog

If a project doesn't have a backlog yet:
1. Create `~/cortex/<project>/backlog.md`
2. Scan the project for known pain points, TODOs, open issues
3. Populate the initial queue
4. Link it from the project's CLAUDE.md if useful
