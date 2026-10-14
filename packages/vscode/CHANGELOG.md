# Changelog

The VS Code extension versions separately from `@phren/cli`; the CLI's own
changelog is at the repository root. The Marketplace listing shows this file.

## [0.7.2] - unreleased

- A healthy third MCP replacement can initialize and restore the reconnect budget; retries are exhausted only after the final attempt fails.

## [0.7.1] - 2026-10-13

### Fixed

- The fragment graph no longer fails with "Cannot read properties of undefined (reading 'size')" when the store sends a partial graph (a missing node, edge or topic list): it fills the gaps and shows what it has, or the empty state.
- A missing or unlaunchable `node` / MCP server no longer raises an unhandled stream error in the extension host when the extension writes to the dead process. Once every reconnect fails, the error names the cause and points to Phren: Show Log.
- Stores with more than 50 projects show all of them (the project list was read one page only), and a project with thousands of findings loads up to 1,000 of them instead of the first 200.
- The fragment graph loads projects four at a time, so a store with dozens of projects no longer drops some of them to request timeouts, and it builds reference nodes without a quadratic scan.
- Windows paths: findings saved from the editor cite repo-relative files with forward slashes (drive letters in any case, spaces, wsl$ and wsl.localhost folders); the graph labels reference docs with backslash paths by file name; workspace folders match tracked projects regardless of drive-letter case or trailing slashes.
- Multi-root workspaces: the active project is found from any open folder, not only the first, and a file inside nested workspace folders is cited against the innermost one.

## [0.7.0] - 2026-10-13

### Fixed

- The fragment graph no longer fails with "Cannot read properties of undefined (reading 'size')" when there is nothing to draw. It shows "No memory to show yet" with the reason (no projects in the store, a failed project list, or every project failing to load) and what to do next.
- One project that fails to load no longer blanks the whole graph; it is logged and the rest still show.
- The status bar no longer sits on "loading" when phren cannot be reached at start-up. It reads "Phren: not connected" with the reason and recovers on its own.
- Task counts on project rows use phren's own per-project counts, so large projects are not undercounted.
- "Phren: Uninstall Phren" said it would remove config and hooks, then deleted the whole store. The prompt now names the store path and its project and finding counts, the button reads "Delete store and uninstall", and the command is titled "Phren: Uninstall Phren and Delete Store".

### Added

- "Phren: Show Log" opens the Phren output: the paths the extension uses, the server's errors, reconnects and every failed call. Start-up problems name what is missing and where the extension looked, including the WSL or Remote side.
- A Truths section under each project lists its pinned truths.
- Project rows show their open tasks ("3 active · 5 queued").
- "Phren: Search Memory for Selection" in the editor menu searches memory for the selection or the word under the cursor.
- "Phren: Add Finding" with a selection saves the file and line as the finding's citation.
- Sections that fail to load say why instead of looking empty.

### Changed

- Requires VS Code 1.140 or later (was 1.120). The extension builds against the current VS Code API types (`@types/vscode` 1.140.0) and packages with `@vscode/vsce` 4.
- Setup notices (phren not found, entry point missing) no longer hold up activation and offer "Show Log".
- The VSIX no longer ships source, tests, scripts, `.turbo/` or source maps (47 files, was 91).
- Marketplace metadata describes the memory layer for AI coding agents, and the extension declares `extensionKind: workspace`, since it runs phren and reads the store on the workspace side (WSL and Remote).
- The README is rewritten around the real features: requirements, the Explorer and Activity views, commands, WSL and Remote, and troubleshooting.

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
