// ── LLM config ───────────────────────────────────────────────────────────────

const EXPENSIVE_MODEL_RE = /opus|sonnet|gpt-4(?!o-mini)/i;
const DEFAULT_LLM_MODEL = "gpt-4o-mini / claude-haiku-4-5-20251001";

function printSemanticCostNotice(model?: string): void {
  const effectiveModel = model || process.env.PHREN_LLM_MODEL || DEFAULT_LLM_MODEL;
  console.log(`  Note: Each semantic check is ~80 input + ~5 output tokens (one call per 'maybe' pair, cached 24h).`);
  console.log(`  Current model: ${effectiveModel}`);
  if (model && EXPENSIVE_MODEL_RE.test(model)) {
    console.log(`  Warning: This model is 20x more expensive than Haiku for yes/no checks.`);
    console.log(`  Consider: PHREN_LLM_MODEL=claude-haiku-4-5-20251001`);
  }
}

function llmConfigSnapshot() {
  return {
    model: process.env.PHREN_LLM_MODEL || null,
    endpoint: process.env.PHREN_LLM_ENDPOINT || null,
    keySet: Boolean(process.env.PHREN_LLM_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY),
    note: `Set via environment variables. Each semantic check: ~80 input + ~5 output tokens. Default model: ${DEFAULT_LLM_MODEL}.`,
  };
}

export function handleConfigLlm(args: string[]) {
  const action = args[0];

  if (!action || action === "get") {
    const snapshot = llmConfigSnapshot();
    console.log(JSON.stringify(snapshot, null, 2));
    const model = process.env.PHREN_LLM_MODEL;
    if (model && EXPENSIVE_MODEL_RE.test(model)) {
      process.stderr.write(`\nWarning: PHREN_LLM_MODEL=${model} is expensive for yes/no semantic checks.\n`);
      process.stderr.write(`Consider: PHREN_LLM_MODEL=claude-haiku-4-5-20251001\n`);
    }
    return;
  }

  if (action === "set") {
    const key = args[1];
    const value = args[2];
    if (!key || !value) {
      console.error("Usage: phren config llm set model <name>");
      console.error("       phren config llm set endpoint <url>");
      console.error("       phren config llm set key <api-key>");
      process.exit(1);
    }
    const envMap: Record<string, string> = {
      model: "PHREN_LLM_MODEL",
      endpoint: "PHREN_LLM_ENDPOINT",
      key: "PHREN_LLM_KEY",
    };
    const envVar = envMap[key];
    if (!envVar) {
      console.error(`Unknown setting "${key}". Valid: model, endpoint, key`);
      process.exit(1);
    }
    console.log(`Set ${envVar}=${value} in your shell or ~/.phren/.env`);
    if (key === "model") {
      printSemanticCostNotice(value);
    }
    return;
  }

  console.error("Usage: phren config llm [get|set model <name>|set endpoint <url>|set key <api-key>]");
  process.exit(1);
}
