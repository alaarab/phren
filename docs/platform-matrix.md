# Platform Validation Matrix

This is the current support and validation matrix for Cortex runtime surfaces.

## Supported platforms

| Platform | Status | Notes |
|---|---|---|
| Linux | primary | Author-local and CI-heavy path. |
| macOS | supported | Same install/init/link/hook model as Linux. |
| Windows | supported with narrower shell ergonomics | Hook wrappers and path handling have focused regression coverage, but raw TTY behavior differs. |

## Validation matrix

| Surface | Linux | macOS | Windows |
|---|---|---|---|
| `cortex init` | expected | expected | expected |
| `cortex add` | expected | expected | expected |
| MCP registration/config writes | expected | expected | expected |
| Hook config writing | expected | expected | expected |
| Wrapper fallback install | expected | expected | expected with platform-specific command wrappers |
| GitHub CLI issue creation / mining | expected | expected | expected with resolved `gh.exe` / `gh.cmd` launch path |
| Web UI | expected | expected | expected |
| Interactive shell raw-mode UX | expected | expected | best-effort; verify before release |

## Existing regression coverage

- `mcp/src/__tests__/hooks-platform.test.ts`
- `mcp/src/__tests__/vector-fallback.test.ts`
- `mcp/src/shared.test.ts`
- `mcp/src/link.test.ts`
- `mcp/src/utils.test.ts`
- `mcp/src/cli-extract.test.ts`

## Known platform-specific constraints

- Windows uses `where.exe`/`cmd /c` in places where POSIX systems use `which` or `sh -c`.
- Temporary-file cleanup and file locking are more likely to race on Windows, so temp-dir cleanup code intentionally tolerates transient failures in tests.
- The interactive shell is designed for POSIX-style raw TTY behavior first; Windows support is functional but should be treated as a validation target, not an assumption.
