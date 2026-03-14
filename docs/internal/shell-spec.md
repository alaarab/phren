# Interactive Phren Shell Spec

## Goal
Ship an interactive `phren` shell that makes task/findings/memory operations fast without replacing markdown as the source of truth.

## Non-goals
- Replace MCP tools or file-based workflows.
- Create a GUI dependency stack.
- Introduce a separate datastore.

## Personas
- Solo engineer managing multiple projects in `~/.phren`.
- Team maintainer triaging memory quality and task hygiene.
- New user validating setup health and machine/profile mappings.

## MVP Scope
- Entry points:
  - `phren` (no args, TTY): interactive shell.
  - `phren shell`: explicit interactive mode.
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
- Review queue triage:
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
- Shell starts with `phren` in terminal and with `phren shell`.
- Keyboard map and command palette are visible in help.
- Selected project persists across views and sessions.
- Task updates in shell are reflected in `tasks.md` and MCP tools.
- Findings and review queue actions mutate markdown safely.
- Health view shows doctor checks + runtime health and remediation actions.
- Test coverage includes navigation, writes, triage, health, stale-state regression.

## Rollout Plan
1. Ship shell as default TTY entrypoint + explicit `phren shell`.
2. Keep MCP mode unchanged for non-interactive execution.
3. Document fallback (`npx phren <phren-path>` for MCP mode and `phren mcp-mode` toggles).
4. Capture user feedback for command ergonomics and pagination.
