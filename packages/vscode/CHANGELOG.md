# Changelog

The VS Code extension versions separately from `@phren/cli`; the CLI's own
changelog is at the repository root. The Marketplace listing shows this file.

## [Unreleased]

### Changed

- Requires VS Code 1.138 or later (was 1.120). The extension builds against the current VS Code API types (`@types/vscode` 1.138.0) and packages with `@vscode/vsce` 4.

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
