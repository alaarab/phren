# Error Reporting Policy

Cortex uses three explicit error-reporting modes:

## 1. User-visible failure

Use this when the requested operation did not happen or safety would be compromised.

Examples:
- invalid CLI arguments
- write-path validation failures
- auth / CSRF rejection
- project/profile resolution failures
- update/build/verify failures

Behavior:
- return non-zero exit status, structured API error, or explicit HTTP error
- include a concrete remediation message when possible

## 2. Debug-log only best-effort failure

Use this when the operation is opportunistic and safe to skip.

Examples:
- telemetry writes
- stale marker cleanup
- non-critical hook notice files
- background context enrichment
- optional cleanup of stale side files

Behavior:
- keep the primary operation running
- write a debug log only when `CORTEX_DEBUG=1`
- avoid claiming success for the skipped substep in user-facing output

## 3. Explicitly silent cleanup

Use this only for harmless cleanup on shutdown or temp resources where surfacing the failure would add noise without actionable value.

Examples:
- restoring terminal mode during shell shutdown
- deleting temp files that may already be gone
- cleaning temp directories during tests

Behavior:
- no user-visible output
- keep the scope narrow and comment why silence is safe

## Current policy by subsystem

| Subsystem | Default mode |
|---|---|
| CLI command execution | user-visible failure |
| MCP tool writes | user-visible failure |
| Web UI auth / mutation routes | user-visible failure |
| Hook/config opportunistic cleanup | debug-log only best-effort |
| Telemetry / analytics | debug-log only best-effort |
| Terminal restore / temp cleanup | explicitly silent cleanup |

Critical rule: Cortex should not silently discard requested writes. If the user asked for a write and it did not happen, that must be surfaced as a failure.
