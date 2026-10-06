# Agent provider catalogues

`phren-agent` discovers model metadata with bounded, read-only requests and
stores the result in `~/.phren-agent/model-catalog.json`. The cache lasts 15
minutes. A fresh cache is reported as `cached`; a network failure uses a
previous row as `stale`, and a provider with no usable cache uses the built-in
fallback as `offline`. Fallback rows are never reported as live discovery.

Refresh explicitly with:

```bash
phren-agent models --json --refresh
phren-agent --refresh-models
```

`models --json` is also the catalogue consumed by the Phren Hook. The Ink and
REPL `/model` pickers use the same rows and can select across configured
providers. A project’s provider, model, and selected effort are remembered in
`~/.phren-agent/settings.json`; `--provider`, `--model`, and `--reasoning` (and
their environment variables) win over that saved selection.

Discovery sources are provider-specific: Codex reads `$CODEX_HOME/models_cache.json`
(or `~/.codex`); OpenRouter reads `/api/v1/models`; OpenAI and custom
OpenAI-compatible endpoints read `/v1/models` or `/models`; Anthropic reads
paginated `/v1/models`; DeepSeek reads `/models`; and Ollama reads `/api/tags`.
Context, modalities, pricing, and thinking metadata come from the catalog.
Explicit effort capabilities take precedence; OpenRouter maps its advertised
reasoning control to low/medium/high, and known DeepSeek V4 models use
low/high/max. Native OpenAI IDs can reuse matching installed Codex metadata.
`max` stays distinct from `xhigh`. Codex’s `ultra` is a client orchestration
mode, not an API reasoning effort, so it is not offered by this harness.
Unknown capability fields stay unknown; unsupported explicit effort choices
are rejected before switching models.

API keys use the existing Phren auth profiles and environment variables. The
custom connector uses `PHREN_AGENT_BASE_URL` and `PHREN_AGENT_API_KEY`; an
existing OpenCode connector can use `OPENCODE_BASE_URL` and
`OPENCODE_API_KEY`, including the Go endpoint. Discovery never starts a model
completion and status output only says whether authentication is configured.
Optional connector overrides live in one JSON file, by default
`~/.phren-agent/providers.json` (or `PHREN_AGENT_PROVIDERS_CONFIG`):

```json
{
  "providers": {
    "openai-compat": {
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "EXAMPLE_API_KEY",
      "model": "example-model"
    }
  }
}
```

The endpoint must be HTTP(S) without embedded credentials, query strings, or
fragments. `/provider` and `phren-agent auth status` reuse this connector and
never print keys. Each provider entry can set `baseUrl`, `apiKeyEnv`, `model`,
`opencodeProvider`, and `enabled`. An explicit key environment variable takes
precedence over stored credentials.

Existing OpenCode API keys are read from `$XDG_DATA_HOME/opencode/auth.json`
(default `~/.local/share/opencode/auth.json`). Name another stored connector
with `opencodeProvider`; its `options.baseURL` is read from `OPENCODE_CONFIG`
or `~/.config/opencode/opencode.json` (JSON). An existing `opencode-go` key
automatically enables the Go endpoint when no custom URL is configured.
OpenCode OAuth-only plugins are not interchangeable with API keys; Codex
uses its existing OAuth connector. No credentials are copied to the cache.

Wire formats remain provider-specific: OpenRouter uses `reasoning.effort`,
Native OpenAI GPT-5/6 and o-series use Responses for tools and
`reasoning.effort`; older/custom Chat Completions uses `reasoning_effort`.
Codex Responses uses
`reasoning.effort`, Anthropic uses adaptive `output_config.effort` or a
clamped thinking budget, and DeepSeek maps Phren `medium` to `high` and
`xhigh` to `max`.

The pickers filter as you type and keep the selected row in a scrolling
viewport. Arrow keys change the model and its supported effort; Enter applies
both. Selection is scoped to the checkout root, including when launched from
a subdirectory. Choosing a different provider resets the previous provider's
model and effort defaults.

```bash
phren-agent --provider openai-codex --model gpt-6.1-sol --reasoning medium -i
phren-agent --provider openrouter --model openai/gpt-6.1-sol --reasoning high -i
phren-agent --provider openai-compat --base-url http://localhost:8080/v1 --model local-model -i
```

Catalog refreshes only issue GET requests (five-second timeout, bounded body
and pagination). Tests use recorded catalog rows and mocked inference; no
paid completion is needed to validate these paths.
