# Shell Information Architecture

## Top-level Sections
- `Projects`
- `Task`
- `Findings`
- `Review Queue`
- `Skills`
- `Hooks`
- `Machines/Profiles`
- `Health`

## Primary State
- `view`: current section.
- `project`: selected project context shared by all project-scoped views.
- `filter`: global view filter.
- `page`, `perPage`: pagination for large lists.

## State Transitions
- `Projects -> *`: `:open <project>` establishes selected project then transition by shortcut/palette.
- `* -> Task/Findings/Review Queue`: retains selected project and filter.
- `* -> Health`: refreshable health dashboard with remediation commands.
- `reset`: clears persisted shell state and rehydrates defaults.

## Keyboard Map
- Navigation:
  - `p` projects
  - `b` task
  - `l` findings
  - `m` review queue
  - `s` skills
  - `k` hooks
  - `h` health
  - `q` quit
- Search/filter:
  - `/text` set filter
  - `/` with empty text clears filter
- Commands:
  - `:...` command palette

## Empty / Error / Loading States
- Empty:
  - no projects
  - no task items in section
  - no findings
  - no review queue entries
- Error:
  - invalid project/profile names
  - missing files (`tasks.md`, `FINDINGS.md`, `machines.yaml`)
  - command parse/argument failures
- Loading:
  - synchronous rendering with short status feedback in footer
  - health view caches doctor snapshot briefly to avoid noisy reruns

## View Notes
- `Projects`: list projects, doc badges, summary snippet; `:open` pins project context.
- `Task`: `Active | Queue | Done` read board with IDs, paging/filtering, and writes.
- `Findings`: browse by date + citation line visibility; write/remove commands.
- `Review Queue`: triage with risk/confidence indicators and audit-backed actions.
- `Machines/Profiles`: inspect mappings and safe edit workflows with backup files.
- `Health`: doctor checks + runtime lifecycle stats + remediation commands.
