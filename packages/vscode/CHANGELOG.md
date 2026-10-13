# Changelog

The VS Code extension versions separately from `@phren/cli`; the CLI's own
changelog is at the repository root. The Marketplace listing shows this file.

## [Unreleased]

### Fixed

- "Phren: Uninstall Phren" said it would remove config and hooks, then deleted the whole store. The prompt now names the store path and its project and finding counts, the button reads "Delete store and uninstall", and the command is titled "Phren: Uninstall Phren and Delete Store".
- The changelog said the extension requires VS Code 1.138 while the manifest and types were already on 1.140.

### Changed

- Requires VS Code 1.140 or later (was 1.120). The extension builds against the current VS Code API types (`@types/vscode` 1.140.0) and packages with `@vscode/vsce` 4.
- The VSIX no longer ships source, tests, scripts, `.turbo/`, `node_modules/` or source maps: a new `.vscodeignore` leaves only `out/`, `media/` and the manifest files vsce always includes.
- Marketplace metadata now describes the memory layer for AI coding agents (AI category, keywords, gallery banner) and declares `extensionKind: workspace`, since the extension spawns node and reads the store on the workspace side (WSL and Remote).
- The README is rewritten around the real feature set: requirements, a tour of the Explorer and Activity views and the commands, a WSL and Remote section, and troubleshooting.

### Added

- Troubleshooting docs for "Phren: Show Log" (the "Phren" output channel), `phren doctor`, and the empty-graph message.

## [0.6.3] - 2026-09-05

### Fixed

- The extension calls phren's MCP tools by their full names, which the CLI's
  default `core` tool profile (new in `@phren/cli` 0.2.0) no longer exposes, so
  every sidebar action failed against a 0.2.x phren. The extension now starts
  its server in the `full` profile. A test in the CLI package holds the two in
  step from now on.

## [0.6.2] - 2026-07-20

Accumulated 3D graph work, project notes, and live memory lookups in the
sidebar. See the repository's commit history for detail; this file starts here.
