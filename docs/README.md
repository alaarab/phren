# Docs Map (Start Here)

If you only want one file to read, open:

- `docs/long-term-memory-report-combined.md`
- or `docs/long-term-memory-report-combined.html` (same content, browser-friendly)

## What each doc is for

### Whitepaper / report
- `docs/long-term-memory-whitepaper.md`
  The primary narrative paper (argument, methodology, comparison, references).

- `docs/whitepaper-artifacts/*`
  Benchmark protocol + templates used to run and report empirical comparisons.

- `docs/long-term-memory-report-combined.md`
  Combined package: whitepaper + benchmark appendices + CSV schemas in one place.

### Shell docs
- `docs/shell-spec.md`
  Product/UX contract for the interactive `cortex` shell.

- `docs/shell-ia.md`
  Information architecture and navigation/state model.

- `docs/shell-release-hardening.md`
  Release checklist + rollout/rollback guidance.

## README vs docs site vs repo docs
- Root `README.md` is product onboarding and command usage.
- `docs/index.html` is a static site artifact currently in the repo.
- Markdown files in `docs/` are source documents; not all are automatically surfaced by the static site unless linked there.

## Practical recommendation
Use this order:

1. `docs/long-term-memory-report-combined.md`
2. If you want details, jump into `docs/whitepaper-artifacts/*`
3. Use shell docs only if you are reviewing shell implementation/operations
