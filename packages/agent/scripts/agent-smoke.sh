#!/usr/bin/env bash
# Live smoke test: one short session per configured provider, exercising a real
# tool call and (where supported) reasoning. Needs real credentials — providers
# without credentials are skipped, not failed.
#
# Usage:
#   ./scripts/agent-smoke.sh                # all providers with credentials
#   ./scripts/agent-smoke.sh anthropic      # one provider
#
# Environment:
#   ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY, or Codex auth via
#   `phren-agent auth login`, or PHREN_OLLAMA_URL for a local model.
set -u

here="$(cd "$(dirname "$0")/.." && pwd)"
bin="$here/dist/bin.js"
task='Run the shell command `echo smoke-ok-77` and then reply with exactly the marker it printed.'

if [[ ! -f "$bin" ]]; then
  echo "Built binary not found at $bin — run 'pnpm build' first." >&2
  exit 1
fi

providers=("$@")
if [[ ${#providers[@]} -eq 0 ]]; then
  providers=(openai-codex openai anthropic openrouter ollama)
fi

has_creds() {
  case "$1" in
    anthropic)   [[ -n "${ANTHROPIC_API_KEY:-}" ]] ;;
    openai)      [[ -n "${OPENAI_API_KEY:-}" ]] ;;
    openrouter)  [[ -n "${OPENROUTER_API_KEY:-}" ]] ;;
    ollama)      [[ -n "${PHREN_OLLAMA_URL:-}" && "${PHREN_OLLAMA_URL:-}" != "off" ]] ;;
    openai-codex) node "$bin" auth status 2>/dev/null | grep -qi "logged in" ;;
    *) return 1 ;;
  esac
}

pass=0; fail=0; skip=0
for provider in "${providers[@]}"; do
  if ! has_creds "$provider"; then
    echo "-- $provider: SKIP (no credentials)"
    skip=$((skip + 1))
    continue
  fi
  echo "-- $provider: running..."
  workdir="$(mktemp -d)"
  out="$workdir/out.log"
  if (cd "$workdir" && timeout 300 node "$bin" --provider "$provider" --yolo --no-subagents --verbose "$task" >"$out" 2>&1) \
     && grep -q "smoke-ok-77" "$out"; then
    echo "-- $provider: PASS"
    pass=$((pass + 1))
  else
    echo "-- $provider: FAIL — last output:"
    tail -20 "$out" | sed 's/^/   /'
    fail=$((fail + 1))
  fi
  rm -rf "$workdir"
done

echo
echo "smoke: $pass passed, $fail failed, $skip skipped"
[[ $fail -eq 0 ]]
