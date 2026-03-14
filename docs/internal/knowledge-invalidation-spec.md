# Knowledge Invalidation Specification

Version: 0.1
Last updated: 2026-03-10

## Problem

Today Phren only has partial invalidation semantics:

- `add_finding` can attach `<!-- conflicts_with: "..." -->` when a new finding appears to contradict an older one.
- `supersedes` can annotate an older finding with `<!-- superseded_by: ... -->`.
- `search_knowledge` strips superseded lines from returned snippets.
- governance can separately flag stale or invalid-citation findings for review.

That is enough to avoid some obviously wrong retrieval, but it is not a first-class lifecycle model. Users cannot reliably answer:

- what is the current truth for this fragment?
- which finding replaced an older one?
- whether two findings are unresolved contradictions or both conditionally true?
- why a result is hidden, demoted, or shown as historical?

The current model is also too implicit for UI and archive flows. Hidden HTML comments and silent filtering do not make contradictions understandable.

## Goals

- Make finding status explicit and queryable.
- Preserve markdown as the source of truth.
- Keep backward compatibility with existing `conflicts_with` and `superseded_by` annotations.
- Default retrieval to active findings while keeping history accessible.
- Add a human resolution flow for contradictions instead of pretending the system can always infer truth automatically.
- Preserve status/history through consolidation into `reference/`.

## Non-goals

- Fully automatic truth resolution without human confirmation.
- Replacing markdown with a database-only representation.
- Deleting historical findings when they become obsolete.
- Solving citation staleness and semantic contradiction with the exact same mechanism, even if they share a UI surface.

## Current Behavior

### Write path

- `mcp/src/content-learning.ts` adds `conflicts_with` annotations when a conflict is detected.
- `mcp/src/content-learning.ts` marks older findings with `superseded_by` when `supersedes` is provided.
- `mcp/src/content-dedup.ts` can also add cross-project conflict annotations when semantic conflict detection is enabled.
- `mcp/src/mcp-finding.ts` exposes only lightweight conflict data in the MCP response.

### Retrieval path

- `mcp/src/mcp-search.ts` filters superseded lines out of result content.
- Contradicted findings are not modeled as a separate retrieval class.
- Historical findings do not carry an explicit status badge or explanation in search results.

### Governance and UI

- stale and invalid-citation issues can be queued for review.
- contradiction handling is mostly metadata, not a visible lifecycle.
- web-ui and extension surfaces do not present “current truth vs history” as a first-class concept.

## Proposed Lifecycle Model

Every finding keeps its existing `fid` and gains a normalized lifecycle status:

- `active`: current best-known finding.
- `superseded`: replaced by a newer finding.
- `contradicted`: there is an unresolved semantic clash with another finding.
- `stale`: aged past policy thresholds and needs confirmation.
- `invalid_citation`: supporting citation drifted or no longer validates.
- `retracted`: explicitly withdrawn as wrong or unsafe.

Status metadata stays in markdown comments so files remain portable and mergeable.

### Canonical metadata

Each finding should support these inline metadata comments:

- `<!-- status: active|superseded|contradicted|stale|invalid_citation|retracted -->`
- `<!-- status_updated: YYYY-MM-DD -->`
- `<!-- status_reason: <enum-or-short-text> -->`
- `<!-- status_ref: fid:abcd1234 | review:M3 | citation:path#L10 -->`

Existing comments remain valid compatibility inputs:

- `<!-- superseded_by: ... -->` maps to `status=superseded`.
- `<!-- conflicts_with: "..." -->` maps to `status=contradicted` only when unresolved.

During migration, Phren should write both the old compatibility comments and the new normalized status fields. Retrieval should read either format.

## State Transitions

Allowed transitions:

- `active -> superseded`
- `active -> contradicted`
- `active -> stale`
- `active -> invalid_citation`
- `active -> retracted`
- `contradicted -> active`
- `contradicted -> superseded`
- `contradicted -> retracted`
- `stale -> active`
- `stale -> retracted`
- `invalid_citation -> active`
- `invalid_citation -> retracted`

Rules:

- `superseded` requires a `status_ref` pointing at the newer finding.
- `contradicted` should point at the conflicting finding or review item.
- `retracted` requires an explicit human action.
- `stale` and `invalid_citation` come from governance signals, not contradiction detection.

## Write Flow

### Add finding

When a new finding clashes with an older one, Phren should create a pending resolution instead of only appending a hidden comment.

Expected outcomes:

1. `Keep both`: both findings stay `active` or become conditionally scoped later.
2. `Supersede old`: old finding becomes `superseded`, new finding stays `active`.
3. `Contradiction unresolved`: both findings become `contradicted` until reviewed.
4. `Retract old`: old finding becomes `retracted`.

### New MCP surface

Add a lifecycle mutation tool rather than forcing users to patch markdown manually:

- `update_finding_status(project, finding_id, status, reason, ref?)`

This is the core action behind web-ui, shell, and VS Code controls.

## Retrieval Behavior

Default behavior should change from “strip a few superseded lines” to lifecycle-aware ranking:

- rank `active` findings first.
- demote `contradicted`, `stale`, and `invalid_citation`.
- hide `superseded` and `retracted` by default.
- allow explicit history opt-in.

### Search API changes

`search_knowledge` should gain:

- `status`: optional filter (`active`, `historical`, `all`).
- `include_history`: convenience flag for UI clients.

When a historical result is returned, the payload should explain why:

- `status`
- `statusReason`
- `statusRef`

`get_findings` should also return lifecycle metadata so clients do not have to parse HTML comments themselves.

## UI and Product Surface

### Web UI

Add a dedicated invalidation surface:

- finding badges for lifecycle status.
- “Why not active?” detail panel.
- contradiction resolution actions: `Supersede`, `Keep both`, `Mark contradicted`, `Retract`.
- a separate unresolved-contradictions queue instead of burying these in generic review noise.

### Fragment view

For a fragment or topic, show two lanes:

- `Current truth`
- `History`

History should render as a timeline with reason links:

- finding created
- contradicted
- superseded
- retracted

### VS Code

Reuse the same lifecycle metadata:

- badges in finding detail
- quick actions to resolve contradictions
- history view for a finding or fragment

## Archive and Consolidation

Consolidation must not erase lifecycle state.

Requirements:

- archived/reference docs preserve lifecycle metadata comments.
- archived search results can still explain why an item is historical.
- topic docs should not flatten all inactive findings into an undifferentiated pile.

If a finding is archived after being superseded or retracted, that status must remain visible in the archived copy.

## Rollout Plan

### Phase 1: Data model and parser

- add normalized lifecycle metadata reader/writer.
- backfill `status` from existing `superseded_by` and `conflicts_with`.
- add tests for mixed old/new metadata.

### Phase 2: Mutation and retrieval

- add `update_finding_status`.
- extend `get_findings` and `search_knowledge` with lifecycle fields and filters.
- change ranking and default filtering to prefer active findings.

### Phase 3: UI resolution

- add web-ui badges, history details, and contradiction resolution actions.
- add VS Code finding lifecycle actions.
- add shell affordances for resolving contradictions without manual file edits.

### Phase 4: Archive/history integrity

- preserve lifecycle metadata through consolidation and topic docs.
- expose current-truth vs history views in reference surfaces.

## Acceptance Criteria

- a superseded finding is visibly historical in every product surface.
- a contradicted finding is discoverable as unresolved, not silently mixed with active truth.
- users can resolve contradictions without editing markdown comments manually.
- retrieval defaults to active findings and explains historical results when included.
- archived findings preserve lifecycle metadata after consolidation.
- existing markdown with only `superseded_by` and `conflicts_with` still works.

## Open Questions

- whether `contradicted` should mark both findings immediately or only the older one plus a review item.
- whether `status_reason` should stay short-text or be a stricter enum.
- whether stale and invalid-citation states should live in the same queue as contradictions or share only the renderer.
