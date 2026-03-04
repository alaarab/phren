# /swarm - Deploy a Team

Break the work into pieces. Spawn experimental team agents. Ship it.

## Phase 1: Explore and Plan

Before spawning anything, understand the full picture. Use Explore agents or read files directly.

1. **Map the codebase.** What exists? What patterns are already established? Don't guess - read.
2. **Map the work.** What needs to change? Which files, which packages, which layers?
3. **Find the parallelism.** What can run simultaneously vs what blocks what?
4. **Spot the risks.** Where could agents collide? Where are the tricky parts?
5. **Draft the swarm plan.** Present it to the user for approval before launching anything.

A 2-minute plan saves a 20-minute redo.

## Phase 2: Present and Approve

**Show the user the full plan and let them adjust before you launch.**

Use AskUserQuestion to present the plan with options to modify:
- Which experimental team agents to spawn and their models
- The task breakdown
- Anything they want to change

```
/swarm plan - [what we're building]

What I found:
- [key insight from exploration]
- [architectural decision and why]
- [risk and how we'll handle it]

Proposed experimental team agents:
  Lead:    sonnet  - coordinates, reviews, merges
  Agent 1: sonnet  - [specific task, specific files]
  Agent 2: haiku   - [specific task, specific files]
  Agent 3: sonnet  - [specific task, specific files]

Estimated scope: [N files across M packages]

Want to adjust models, add/remove agents, or change the approach?
```

The user might say "make agent 2 sonnet instead" or "add an agent for tests" or "skip the docs agent." Adjust and confirm before Phase 3.

## Phase 3: Launch

Once approved, spawn experimental team agents on the same thread:

```
1. TeamCreate with a clear name
2. TaskCreate per subtask
   - Detailed descriptions (agents don't share your context)
   - blockedBy for dependencies
3. Spawn experimental team agents:
   - subagent_type: "general-purpose"
   - model: as approved in the plan
   - team_name: links to team
4. Monitor via TaskList
5. Review results as they come in
6. Merge, resolve conflicts
7. Shutdown agents, TeamDelete
```

These are experimental team agents running on the same thread - not background agents, not subagents. They coordinate directly with each other.

## Model Selection

Don't overthink it. Most code is sonnet work.

| Work type | Model | Why |
|-----------|-------|-----|
| Architecture, API design, complex debugging | opus | Needs real judgment |
| Feature implementation, refactoring, review | sonnet | 90% of all work |
| Bulk rename, formatting, grep-and-fix | haiku | Fast and cheap |

**Lead model:** Sonnet unless orchestration itself requires deep reasoning. Most of the time it doesn't.

## Team Sizes

- **2** - one builds, one tests/reviews
- **3** - typical split (frontend + backend + tests)
- **4-5** - multi-framework or cross-cutting changes

## Quality is Everyone's Job

Bake these into every agent's prompt:
- Write like a human. No em dashes, no "robust/seamless/leverage", no filler comments.
- If touching UI, think about the visual feel - not just functionality.
- Run relevant tests before reporting done.
- Summarize what changed so the lead can review fast.

## When NOT to Swarm

One person can handle a 20-line fix. Swarms have coordination cost. Use them when the work genuinely parallelizes.
