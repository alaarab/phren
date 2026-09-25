# Docs Map (Start Here)

Whitepaper deliverables are now intentionally minimal:

- `docs/whitepaper.tex` (source)
- `docs/whitepaper.pdf` (compiled report)
- Docs-site PDF link: `https://alaarab.github.io/phren/whitepaper.pdf`

To rebuild the PDF locally, use `tectonic` rather than `pdflatex`:

```bash
tectonic docs/whitepaper.tex --outdir docs
```

## Other docs in this folder

- `docs/architecture.md`: Data flow diagrams for hooks, MCP server, FTS5 index, and memory governance.
- `docs/architecture-team-stores.md`: Team-store and multi-store architecture notes.
- `docs/llms-install.md`: Installation guide, MCP setup, hooks and memory governance pipeline.
- `docs/environment.md`: Full reference for all environment variables with types and defaults.
- `docs/governance.md`: Governance model, review flows, and access controls.
- `docs/ide-setup.md`: IDE and editor integration setup notes.
- `docs/performance.md`: Retrieval and indexing performance notes.
- `docs/shell.md`: Interactive shell user guide: views, keyboard shortcuts, palette commands, the terminal Graph view, the splash.
- `docs/graph-viewer.md`: The 3D memory viewer: web UI, VS Code and iPhone navigation, node dossiers, selection camera, review and bulk actions.
- `docs/code-index.md`: Local code indexing, what changed, scoped browsing, most used, and notes remembered and sent to agents.
- `docs/conductor.md`: Conductor launch, verified computers, dispatch, hand-off, standing grants and Siri controls.
- `docs/fanout.md`: Worker selection, manifests, permission failures, phone visibility and archive retention.
- `docs/schedules.md`: Scheduled prompts, run history and local reminders.
- `docs/api-reference.md`: MCP tools and Hook routes, including Code notes, model catalogues, file reads and live previews.
- `docs/footprint.md`: Files phren writes and external files Hook reads, including Claude Code's cached model catalogue.
- `docs/agent.md`: The experimental `phren-agent` coding agent (unpublished; lives in `experimental/agent/`).
- `docs/claude-code-plugin.md`: Installing phren as a Claude Code plugin, and how that differs from `phren init`.
- `docs/phren-hook.md`: Install and maintain the independent computer helper for the iPhone app.
- Screenshots used by the site and README: `shell-*.png` (terminal), `webui-graph.png` (the memory viewer, shared by the web UI and VS Code), `splash.gif`.
- `docs/feature-flags.md`: Feature flag reference (`PHREN_FEATURE_*` env vars).
- `docs/faq.md`: Common setup and workflow questions.
