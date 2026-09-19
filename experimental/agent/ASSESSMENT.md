# Phren agent assessment — 2026-09-19

The agent completed all six small live coding/tool-use scenarios with
`deepseek/deepseek-v4.1-flash` through OpenRouter. This demonstrates basic tool
use and recovery, not broad coding quality or production readiness. A separate
source review found reproducible permission, streaming, and filesystem issues;
regression fixes accompany this assessment.

## Live assessment

The opt-in `scripts/assess.mjs` runs the actual streamed OpenRouter provider,
agent loop, permission registry, and file/search/shell tools in disposable
directories, including a temporary Phren memory store for retrieval. It uses
synthetic data and does not load the user's memory store or MCP servers.
Credentials remain in memory and are not included in reports.
Each case has an eight-turn cap, a 90-second abort deadline, a 4,096-token output
limit per response, and a $0.25 estimated budget. These are harness bounds,
not a provider billing guarantee.

| Scenario | Result | Tool calls | Seconds |
| --- | --- | ---: | ---: |
| Read a JSON file and report its exact values | Pass | 1 | 7.2 |
| Repair a broken sum function and run unchanged tests | Pass | 4 | 7.9 |
| Implement slugify and run unchanged edge-case tests | Pass | 3 | 19.7 |
| Recover from a missing file and find real settings | Pass | 4 | 11.8 |
| Respect a denied write and leave the file unchanged | Pass | 2 | 5.8 |
| Retrieve a policy through real Phren memory search | Pass | 1 | 4.6 |

The initial five-case run passed in 39.4 seconds at an estimated $0.006.
The six-case run on combined main passed in 56.9 seconds, using 38,175 input
and 1,344 output tokens at an estimated $0.0065. No invoice-level
cost reconciliation was performed. The model and tool support were checked
against the [OpenRouter model catalog](https://openrouter.ai/api/v1/models).
An initial harness setup attempt used a noncanonical macOS temporary root and
triggered false boundary denials; it was excluded and the root was canonicalized
before the complete five-case run.

Run after building the package:

```sh
pnpm --filter @phren/cli build
pnpm --filter @phren/agent build
node experimental/agent/scripts/assess.mjs --live --output /tmp/phren-assessment.json
```

The script reads `OPENROUTER_API_KEY`. To reuse an existing opencode API key,
explicitly pass `--opencode-auth /path/to/opencode/auth.json`. It neither copies
that credential into Phren nor changes opencode configuration. `--agent-dist`
selects another compiled agent directory and `--model` selects another
OpenRouter model.

## Findings and fixes

- **Cancellation while awaiting approval:** a late approval could execute a
  tool after the turn was cancelled. Recheck cancellation before mutation.
- **Plan feedback:** rejecting a plan with feedback could enable tools before
  approval of the revised plan. Keep execution gated until approval.
- **Provider streaming errors:** OpenAI-compatible SSE error events could be
  treated as a successful empty answer. Surface the error instead.
- **Automatic verification:** post-edit lint/test commands could run even after
  denied or cancelled edits, outside the normal shell permission path. Only
  verify successful edits and use the permission-aware, cancellable shell tool.
- **Filesystem boundaries:** a new file beneath a symlinked directory could
  escape the project; recursive search could read external symlinks or sensitive
  files. Canonicalize existing ancestors and check every searched file.
- **Search termination:** zero-width multiline regex matches could spin forever.
  Ensure match iteration advances, with a subprocess timeout regression.
- **Portable tests:** the Linux bubblewrap `/tmp` test incorrectly assumed
  macOS `/tmp` was not a symlink. Model the Linux behavior explicitly without
  changing Linux confinement.

The baseline current-workspace build passed; its test run had 538 passing,
one failing (the macOS `/tmp` test), and three skipped live integration tests.
The existing live integration suite is unconditionally skipped and uses Codex,
so it does not validate OpenRouter; this assessment supplies an explicit,
repeatable opt-in route.

After merging all assessment fixes, the current-workspace build and
agent suite passed with 566 tests and three intentionally skipped live Codex
tests. Focused regression tests cover each reproduced issue; the live harness
tests the OpenRouter path separately.

## Limits

This is one model and a small set of synthetic tasks. It does not assess large
repository changes, long-session compaction, agent delegation, interactive TUI
usability, remote MCP OAuth against a live service, image reasoning, or the
iPhone/Herdr bridge. Unit coverage is complementary evidence, not proof these
paths work in production. On macOS the Linux bubblewrap write fence is absent;
the agent's `auto` mode uses application checks and reports that limitation.
