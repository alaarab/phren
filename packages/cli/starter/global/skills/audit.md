---
name: audit
description: Full codebase audit. Dead code, security, dependencies, performance, optimization. Not a diff review, scans everything.
---
# /audit - Full Codebase Audit

Unlike `/simplify` (which reviews your last diff), this scans the entire codebase. Run it when you want to clean house.

## What It Does

Launch 5 parallel agents. Each one scans the full codebase for a different class of problem. When they're done, aggregate findings and fix what's fixable.

## Phase 1: Discover the Codebase

Before launching agents, understand the project:

```
1. Read package.json (or pyproject.toml, Cargo.toml, go.mod, whatever applies)
2. Find the source directories (src/, lib/, app/, etc.)
3. Count files by extension to understand the stack
4. Check for existing lint/test configs
```

Pass this context to every agent so they know where to look.

## Phase 2: Launch 5 Agents in Parallel

Use the Agent tool to launch all five concurrently in a single message. Give each agent the project context from Phase 1.

### Agent 1: Dead Code & Unused Exports

Find code that exists but isn't used:

1. **Unused exports.** For every `export` in the codebase, check if it's imported anywhere. Flag exports that are only used in their own file or not used at all. Exclude entry points and public API surfaces.
2. **Unused dependencies.** Cross-reference `package.json` dependencies against actual imports in source files. Flag packages that are installed but never imported. Check devDependencies too. Are test utilities actually used in tests?
3. **Dead functions.** Functions defined but never called. Methods on classes that nothing invokes. Event handlers registered but for events that are never emitted.
4. **Orphan files.** Files that nothing imports. Test files for source files that no longer exist. Config files for tools that aren't in the project.
5. **Feature flags that resolved.** Environment variable checks where one branch is clearly dead. TODO/FIXME/HACK comments older than 6 months.
6. **Stale type definitions.** Interfaces or types that nothing references. Generic type parameters that are always the same concrete type.

### Agent 2: Security Scan

Look for vulnerabilities in the actual code (not just `npm audit`):

1. **Injection vectors.** Shell commands built from user input without sanitization. SQL queries with string concatenation. HTML built from unescaped variables. Regex built from user input (ReDoS).
2. **Path traversal.** Any file operation where the path comes from user input or external data without validation. Check for `../` normalization and symlink following.
3. **Secret exposure.** Hardcoded API keys, tokens, passwords. Environment variables logged or included in error messages. Secrets in URLs or query parameters.
4. **Insecure defaults.** TLS verification disabled. CORS set to `*`. Cookies without secure/httponly/samesite flags. Debug modes that shouldn't ship.
5. **Dependency vulnerabilities.** Run `npm audit` (or equivalent). Check for known CVEs. Flag dependencies that haven't been updated in 12+ months.
6. **Auth and access control.** Endpoints or functions that should check permissions but don't. Token validation that's incomplete. Rate limiting gaps.
7. **SSRF and network.** Outbound requests where the URL comes from user input. Webhook/callback URLs that aren't validated against internal networks.

### Agent 3: Performance & Efficiency

Find code that wastes time or resources:

1. **Startup cost.** What runs at import/require time? Top-level await, synchronous file reads, heavy initialization that could be lazy.
2. **N+1 patterns.** Loops that make a network/disk/DB call per iteration instead of batching.
3. **Redundant computation.** The same value computed multiple times in a hot path. Missing memoization where inputs rarely change. Expensive operations inside loops that could be hoisted.
4. **Blocking operations.** Synchronous file I/O on async paths. `JSON.parse` on large payloads without streaming. CPU-heavy work on the event loop.
5. **Unbounded growth.** Caches without eviction. Arrays that grow without limits. Event listeners that are added but never removed. Intervals that are set but never cleared.
6. **Over-fetching.** Loading entire files when you need one field. Importing a whole library for one function. Reading all records when filtering for a subset.
7. **Missed parallelism.** Sequential `await` calls that are independent and could use `Promise.all`. File operations that could be batched.

### Agent 4: Code Quality & Simplification

Find code that's more complicated than it needs to be:

1. **Abstraction debt.** Functions over 80 lines. Files over 500 lines. Classes that do too many things. Deeply nested conditionals (3+ levels).
2. **Copy-paste code.** Near-duplicate blocks across files. Similar switch/case statements that should share logic. Functions that differ by one parameter.
3. **Unnecessary indirection.** Wrapper functions that add nothing. Abstract classes with one implementation. Factory patterns for objects that are only created once.
4. **Type complexity.** Union types with 5+ members. Generic types nested 3+ levels deep. Type assertions (`as`) that could be avoided with better typing.
5. **Error handling.** Empty catch blocks. Catch-and-rethrow without adding context. Inconsistent error types across similar operations.
6. **Naming.** Boolean variables that don't read as questions. Functions whose names don't describe what they return. Abbreviations that only the author understands.
7. **Stale patterns.** Callbacks where promises/async would be cleaner. Manual iteration where array methods would work. Hand-rolled utilities where the language or a dependency provides it.

### Agent 5: Dependency Health

Audit the dependency tree:

1. **Outdated packages.** Run `npm outdated` (or equivalent). Flag major version bumps that are available. Note any breaking changes.
2. **Heavy dependencies.** Check bundle/install size. Flag packages over 1MB that could be replaced with lighter alternatives or native APIs.
3. **Duplicate functionality.** Multiple packages that do the same thing (e.g., both `lodash` and `underscore`, or `axios` and `node-fetch`).
4. **License issues.** Check for GPL or other copyleft licenses in a non-GPL project. Flag any "unknown" licenses.
5. **Abandoned packages.** Dependencies with no commits in 2+ years, or archived repos.
6. **Phantom dependencies.** Imports that resolve only because a parent dependency installs them (not in your own package.json).

## Phase 3: Triage and Fix

Wait for all agents. Then:

1. **Deduplicate.** Multiple agents may flag the same issue from different angles. Merge them.
2. **Prioritize.** Security issues first. Then dead code (easy wins). Then performance. Then quality.
3. **Fix directly.** Don't just report. Fix what you can. For things that need the user's input (like removing a dependency that might be used in a way you can't see), ask.
4. **Summarize.** Report what was found, what was fixed, and what needs the user's decision.

## Options

The user can scope the audit:

- `/audit`: full audit, all 5 agents
- `/audit security`: just the security agent
- `/audit dead-code`: just dead code detection
- `/audit performance`: just performance
- `/audit deps`: just dependency health
- `/audit quality`: just code quality
