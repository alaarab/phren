# Team Stores Architecture — RFC v2

Incorporates feedback from GPT-5.4 architectural review.

## Problem

Phren is currently single-store. One `~/.phren` per user. Federation exists but is read-only.
Users want:

1. **Personal + team stores** — personal findings stay private, team findings are shared
2. **Multiple team stores** — e.g., one for "arc team", one for "company-wide"
3. **Multi-user attribution** — who added what, when, from which machine
4. **Shared git repo** — team members push/pull the same store
5. **Project routing** — a project's findings go to the right store automatically

## Current State

| Capability | Status | Notes |
|-----------|--------|-------|
| Single primary store | ✅ | `~/.phren` or `$PHREN_PATH` |
| Federation read-only | ✅ | `PHREN_FEDERATION_PATHS` — search across stores, no writes |
| Actor provenance | ✅ | `PHREN_ACTOR`, machine, tool, model tracked per finding |
| RBAC | ✅ | admins/contributors/readers per store and per project |
| Profiles | ✅ | Machine→profile mapping, project filtering |
| Git sync | ✅ | Stop hook: commit + push, pull with markdown merge |
| Scope isolation | ✅ | Memory scopes (researcher/builder/shared) |
| Conflict resolution | ✅ | Auto-merge for FINDINGS.md and tasks.md |

## Design Principles (from review)

1. **Store-qualified identity everywhere** — `store/project` not bare `project`
2. **Single source of truth for routing** — registry owns it, not project files
3. **Read path first, write path later** — don't ship ambiguity into the core model
4. **Append-only for team writes** — monolithic markdown mutation won't scale
5. **Explicit promotion, not silent routing** — `promote personal → team` instead of auto-routing
6. **Immutable store IDs** — store names are mutable config; use UUIDs for provenance

## Phase 1: Store Registry + Read Path

### Store Registry

```yaml
# ~/.phren/stores.yaml
stores:
  - id: "a1b2c3d4"              # Immutable UUID (generated on create/add)
    name: personal
    path: ~/.phren
    role: primary                # Read + write, default target
    sync: managed-git

  - id: "e5f6g7h8"
    name: arc-team
    path: ~/.phren-stores/arc-team
    role: team                   # Read-only in phase 1, write in phase 2
    remote: git@github.com:qualus/phren-arc.git
    sync: managed-git

  - id: "i9j0k1l2"
    name: company
    path: ~/.phren-stores/company
    role: readonly               # Always read-only
    remote: git@github.com:qualus/phren-company.git
    sync: pull-only
```

### Store Roles

| Role | Read | Write | Git Sync | Use Case |
|------|------|-------|----------|----------|
| `primary` | ✅ | ✅ | ✅ | Personal store — default write target |
| `team` | ✅ | phase 2 | ✅ | Shared team store |
| `readonly` | ✅ | ❌ | pull only | Reference store |

### Store-Qualified Identity

All tools switch from bare `project` to `store/project`:

```
# Before (ambiguous with multi-store)
get_findings(project: "arc")

# After (unambiguous)
get_findings(project: "arc")           # Resolves via registry (single match → use it)
get_findings(project: "arc-team/arc")  # Explicit store-qualified
```

Resolution when bare `project` is used:
1. Search all readable stores for a project named `project`
2. If exactly one match → use it
3. If multiple matches → return error listing stores: "arc exists in personal, arc-team. Use store/project to disambiguate."

Internal IDs use immutable store ID: `e5f6g7h8/arc` (not store name).

### Search Across Stores

Replace federation with store-aware search:

```
search_knowledge(query, project?)
  ├─ Load store registry
  ├─ For each store with read access:
  │   ├─ Build/cache FTS5 index (one per store)
  │   └─ Search with query
  ├─ Merge results, tag with store name + store ID
  ├─ Apply profile filtering (if active)
  └─ Return with provenance (no cross-store dedup)
```

`PHREN_FEDERATION_PATHS` becomes a legacy alias — auto-mapped to `readonly` store entries.

### CLI Commands (Phase 1)

```bash
# Join an existing team store (read-only access)
npx @phren/cli store add arc-team \
  --remote git@github.com:qualus/phren-arc.git

# List stores and their status
npx @phren/cli store list

# Remove a store (local only)
npx @phren/cli store remove arc-team

# Pull all stores
npx @phren/cli store sync
```

### MCP Tool Changes (Phase 1 — read path only)

| Tool | Change |
|------|--------|
| `search_knowledge` | Search all readable stores, tag results with store |
| `list_projects` | Aggregate across stores, prefix with store name |
| `get_project_summary` | Accept `store/project` format |
| `get_findings` | Accept `store/project`, read from correct store |
| `get_memory_detail` | ID includes store provenance |
| `health_check` | Report per-store sync status |
| `session_start` | Pull all stores |

New tools:
| Tool | Purpose |
|------|---------|
| `store_list` | List registered stores and status |

All write tools continue to target primary store only in phase 1.

### Store Discovery

Team stores include a bootstrap file committed to their repo:

```yaml
# .phren-team.yaml (in the team store repo root)
name: arc-team
description: "Arc platform team knowledge"
default_role: team
```

When `phren store add --remote <url>` clones, it reads this file to populate the registry entry.

## Phase 2: Explicit Team Writes

### Promotion Model (not auto-routing)

```bash
# Promote a finding from personal to team store
phren promote "finding text..." --to arc-team

# Add finding directly to team store
phren finding add arc-team/arc "Always validate JWT expiry..."
```

MCP tool:
```
add_finding(project: "arc-team/arc", finding: "...")  # Explicit store target
add_finding(project: "arc", finding: "...")            # Goes to primary (default)
```

### Append-Only Journal for Team Stores

Team stores do NOT use monolithic `FINDINGS.md` for writes. Instead:

```
arc-team/
├── arc/
│   ├── FINDINGS.md              # Materialized view (generated, read-only)
│   ├── journal/                 # Append-only entries (one file per actor/day)
│   │   ├── 2026-03-24-ala.md
│   │   ├── 2026-03-24-edward.md
│   │   └── 2026-03-25-ala.md
│   └── tasks.md                 # Keep as-is (lower contention)
```

Journal files are append-only — no conflicts possible. `FINDINGS.md` is regenerated from journal entries periodically (consolidation compacts them).

**Why this works with git:**
- Git handles many small appended files well
- No rebase storms — each actor writes their own file
- Merge is trivial — just include both sides
- `FINDINGS.md` is a generated artifact, not a source of truth

### Write Routing (Phase 2)

Single source of truth: **the store registry** owns project→store mapping.

```yaml
# ~/.phren/stores.yaml
stores:
  - id: "e5f6g7h8"
    name: arc-team
    path: ~/.phren-stores/arc-team
    role: team
    remote: git@github.com:qualus/phren-arc.git
    projects:               # Registry is the ONLY routing source
      - arc
      - arc-api
      - arc-ui
```

No `store:` field in `phren.project.yaml` — avoids dual-source drift.

```typescript
function resolveWriteStore(project: string): StoreEntry {
  // 1. If store-qualified ("arc-team/arc"), use explicit store
  const [storeName, projectName] = parseStoreQualified(project);
  if (storeName) return registry.get(storeName);

  // 2. Check registry project claims
  for (const store of registry.stores) {
    if (store.projects?.includes(project)) return store;
  }

  // 3. Default to primary
  return registry.primary;
}
```

### Git Sync Per Store

Stop hook iterates stores:

```
Stop Hook
├─ For each store where role == primary:
│   ├─ git add -A && commit && push (current behavior)
├─ For each store where role == team:
│   ├─ git add journal/ only (append-only files)
│   ├─ git commit -m "phren: $PHREN_ACTOR findings"
│   └─ git pull --rebase && git push
├─ For each store where role == readonly:
│   └─ git pull only
└─ Update health.json per store
```

### Provenance in Findings

```markdown
- [pattern] Always validate JWT expiry before refresh
  <!-- phren:cite {"created_at":"2026-03-24","actor":"edward","machine":"ED-LAPTOP","tool":"claude","store_id":"e5f6g7h8"} -->
```

Uses immutable `store_id`, not mutable store name.

## Phase 3: Team Features

### Skills in Team Stores

Team stores can have `skills/` directories. Resolution order:
1. Personal store skills (highest priority — local overrides win)
2. Team store skills (read-only, inherited)
3. Global skills

No mirroring/copying — skills are loaded from their source store at runtime.

### Consolidation

- **Per-store only** for mutations — each store consolidates independently
- **Cross-store advisory** — `phren maintain consolidate --cross-store` produces promotion candidates but doesn't auto-mutate

### Cross-Store Finding Dedup

- **Never dedupe on write** — show both with store provenance
- **Explicit promote** — `phren promote "finding" --to team-store` moves a personal finding to team
- **Advisory at search time** — flag near-duplicates across stores in search results

### RBAC Reality Check

Client-side RBAC is **policy, not security**. For real enforcement:
- Team stores should use git branch protections
- Optional: merge bot that validates provenance before accepting pushes
- RBAC remains useful as a UX guard against accidental writes to wrong store

## Migration Path

1. **No breaking changes** — existing single-store setups work as-is
2. `stores.yaml` is optional — if missing, current behavior (single primary store)
3. `PHREN_FEDERATION_PATHS` still works — auto-mapped to `readonly` store entries
4. `phren init` unchanged — creates primary store
5. `phren store add` is the new entry point for team stores
6. Bare `project` names continue to work when unambiguous

## Build Order

1. **Store registry** — `stores.yaml` parsing, store ID generation, CLI `store add/list/remove`
2. **Store-qualified IDs** — `store/project` parsing in all tool input handlers
3. **Multi-store read path** — per-store FTS5 indexes, search across stores with provenance
4. **Per-store sync** — pull all stores on session start, health reporting per store
5. **Explicit team writes** — `--store` flag, `promote` command, journal append format
6. **Journal materialization** — generate `FINDINGS.md` from journal entries
7. **Team features** — cross-store skills, advisory dedup, consolidation

## Non-Project Data Ownership

| Data | Lives in | Shared across stores? |
|------|----------|----------------------|
| Sessions (`.sessions/`) | Primary store only | No |
| Runtime (`.runtime/`) | Primary store only | No |
| Profiles (`profiles/`) | Primary store only | No |
| Machines (`machines.yaml`) | Primary store only | No |
| Store registry (`stores.yaml`) | Primary store only | No |
| Review queue | Per-store, per-project | No |
| Truths/pinned memory | Per-store | No |
| Reference docs | Per-store, per-project | No |
| Skills | Per-store (with inheritance) | Read-only from team |
| Config/policies | Per-store (team store can set team-wide policy) | No |
| Hooks | Primary store only | No |
