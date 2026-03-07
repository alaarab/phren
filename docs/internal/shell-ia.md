# Shell Information Architecture

## Top-level Sections
- `Projects`
- `Backlog`
- `Findings`
- `Memory Queue`
- `Machines/Profiles`
- `Health`

## Primary State
- `view`: current section.
- `project`: selected project context shared by all project-scoped views.
- `filter`: global view filter.
- `page`, `perPage`: pagination for large lists.

## State Transitions
- `Projects -> *`: `:open <project>` establishes selected project then transition by shortcut/palette.
- `* -> Backlog/Findings/Memory Queue`: retains selected project and filter.
- `* -> Health`: refreshable health dashboard with remediation commands.
- `reset`: clears persisted shell state and rehydrates defaults.

## Keyboard Map
- Navigation:
  - `p` projects
  - `b` backlog
  - `l` findings
  - `m` memory queue
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
  - no backlog items in section
  - no findings
  - no memory queue entries
- Error:
  - invalid project/profile names
  - missing files (`backlog.md`, `FINDINGS.md`, `machines.yaml`)
  - command parse/argument failures
- Loading:
  - synchronous rendering with short status feedback in footer
  - health view caches doctor snapshot briefly to avoid noisy reruns

## View Notes
- `Projects`: list projects, doc badges, summary snippet; `:open` pins project context.
- `Backlog`: `Active | Queue | Done` read board with IDs, paging/filtering, and writes.
- `Findings`: browse by date + citation line visibility; write/remove commands.
- `Memory Queue`: triage with risk/confidence indicators and audit-backed actions.
- `Machines/Profiles`: inspect mappings and safe edit workflows with backup files.
- `Health`: doctor checks + runtime lifecycle stats + remediation commands.
