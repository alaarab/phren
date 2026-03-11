# Interactive Cortex Shell Spec

## Goal
Ship an interactive `cortex` shell that makes task/findings/memory operations fast without replacing markdown as the source of truth.

## Non-goals
- Replace MCP tools or file-based workflows.
- Create a GUI dependency stack.
- Introduce a separate datastore.

## Personas
- Solo engineer managing multiple projects in `~/.cortex`.
- Team maintainer triaging memory quality and task hygiene.
- New user validating setup health and machine/profile mappings.

## MVP Scope
- Entry points:
  - `cortex` (no args, TTY): interactive shell.
  - `cortex shell`: explicit interactive mode.
- Views:
  - `Projects`, `Task`, `Findings`, `Review Queue`, `Skills`, `Hooks`, `Machines/Profiles`, `Health`.
- Command model:
  - `:command` palette for actions.
  - `q` to quit.
  - global shortcuts: `p b l m h / :`.
- Task writes:
  - add, move, complete, reprioritize, context edit.
  - helpers: `work next`, `tidy`.
- Findings writes:
  - add and remove.
- Memory queue triage:
  - approve, reject, edit.
- Health actions:
  - `run fix`, `relink`, `rerun hooks`, `update`.
- Session persistence:
  - `.runtime/shell-state.json`.

## Architecture Contract
- `mcp/src/shell.ts`: runtime loop, render pipeline, input dispatch.
- `mcp/src/data-access.ts`: shared readers/writers for task, findings, queue, machines/profiles, shell state.
- Existing MCP task/findings/machine/profile tools call the same data-access paths.

## Acceptance Criteria
- Shell starts with `cortex` in terminal and with `cortex shell`.
- Keyboard map and command palette are visible in help.
- Selected project persists across views and sessions.
- Task updates in shell are reflected in `tasks.md` and MCP tools.
- Findings and memory queue actions mutate markdown safely.
- Health view shows doctor checks + runtime health and remediation actions.
- Test coverage includes navigation, writes, triage, health, stale-state regression.

## Rollout Plan
1. Ship shell as default TTY entrypoint + explicit `cortex shell`.
2. Keep MCP mode unchanged for non-interactive execution.
3. Document fallback (`npx cortex <cortex-path>` for MCP mode and `cortex mcp-mode` toggles).
4. Capture user feedback for command ergonomics and pagination.
