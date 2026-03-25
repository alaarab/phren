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
- `docs/llms-install.md`: Installation guide, all 52 MCP tools, hooks, and memory governance pipeline.
- `docs/environment.md`: Full reference for all environment variables with types and defaults.
- `docs/governance.md`: Governance model, review flows, and access controls.
- `docs/ide-setup.md`: IDE and editor integration setup notes.
- `docs/performance.md`: Retrieval and indexing performance notes.
- `docs/shell.md`: Interactive shell user guide: views, keyboard shortcuts, palette commands.
- `docs/feature-flags.md`: Feature flag reference (`PHREN_FEATURE_*` env vars).
- `docs/faq.md`: Common setup and workflow questions.
