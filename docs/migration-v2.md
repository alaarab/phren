# Migrating to cortex 2.0

## Before upgrading

Back up your project store:

```bash
cp -r ~/.cortex ~/.cortex-backup-$(date +%Y%m%d)
```

## Breaking changes in 2.0

To be determined. This doc will be updated before the 2.0 release.

Known planned changes:
- Tool renames will follow consistent naming conventions
- Deprecated CLI commands will be removed
- Governance config schema may change (with auto-migration support)

## Auto-migration

Run after upgrading:

```bash
cortex doctor --fix
```

This handles:
- Legacy file locations to `.runtime/` and `.sessions/` subdirectories
- Old hook formats to current lifecycle command format
- Legacy findings to FINDINGS.md entries
- Stale symlinks to refreshed project links

## Manual steps

If auto-migration reports issues, check:

1. Custom hooks in `~/.claude/settings.json` still reference valid cortex commands
2. Any scripts calling cortex CLI use current command names (`cortex search` not `cortex query`)
3. Governance config files in `.governance/` have the expected `schemaVersion` field

Run `cortex maintain migrate governance --dry-run` to preview config schema upgrades before applying them.

## Getting help

Open an issue at https://github.com/alaarab/cortex/issues
