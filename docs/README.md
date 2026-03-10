# Docs Map (Start Here)

Whitepaper deliverables are now intentionally minimal:

- `docs/whitepaper.tex` (source)
- `docs/whitepaper.pdf` (compiled report)
- Docs-site PDF link: `https://alaarab.github.io/cortex/whitepaper.pdf`

To rebuild the PDF locally, use `tectonic` rather than `pdflatex`:

```bash
tectonic docs/whitepaper.tex --outdir docs
```

## Other docs in this folder

- `docs/architecture.md`: Data flow diagrams for hooks, MCP server, FTS5 index, and memory governance.
- `docs/llms-install.md`: Installation guide, all 51 MCP tools, hooks, and memory governance pipeline.
- `docs/environment.md`: Full reference for all environment variables with types and defaults.
- `docs/shell.md`: Interactive shell user guide: views, keyboard shortcuts, palette commands.
- `docs/feature-flags.md`: Feature flag reference (`CORTEX_FEATURE_*` env vars).
- `docs/platform-matrix.md`: Cross-platform validation targets and known platform-specific constraints.
- `docs/error-reporting.md`: Error-reporting policy for user-visible failures, debug-only best-effort paths, and silent cleanup.
- `docs/faq.md`: Common setup and workflow questions.
## Internal design docs (`docs/internal/`)

- `docs/internal/shell-spec.md`: Product/UX contract for the interactive `cortex` shell.
- `docs/internal/shell-ia.md`: Information architecture and navigation/state model.
- `docs/internal/shell-release-hardening.md`: Release checklist and rollback guidance.
