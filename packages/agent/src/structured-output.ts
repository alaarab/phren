/**
 * `--json-schema`: a headless run that ends with a JSON value matching the
 * caller's schema, in the result's `structured_output`, as Claude Code's
 * option does.
 *
 * Provider-agnostic: once the task is done, one more request (the session's
 * history, the same tools so Anthropic accepts the tool history, no new tool
 * calls asked for) tells the model to answer with JSON only. The answer is
 * parsed and validated; on a mismatch the model gets the validation errors
 * and tries again, twice at most. The exchange stays out of the session log.
 */
import * as fs from "fs";
import { Ajv, type ValidateFunction } from "ajv";
import type { AgentToolDef, LlmMessage, LlmProvider } from "./providers/types.js";
import { recordTokenUsage, type CostTracker } from "./cost.js";

const MAX_ATTEMPTS = 3;

/** Read `--json-schema`: inline JSON, or a path to a JSON file. Throws a user-facing error. */
export function loadJsonSchema(raw: string): { schema: Record<string, unknown>; validate: ValidateFunction } {
  const text = raw.trim().startsWith("{") ? raw : (() => {
    try {
      return fs.readFileSync(raw, "utf-8");
    } catch {
      throw new Error(`--json-schema: "${raw}" is neither a JSON object nor a readable file.`);
    }
  })();
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch (err) {
    throw new Error(`--json-schema is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("--json-schema must be a JSON Schema object.");
  try {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema as Record<string, unknown>);
    return { schema: schema as Record<string, unknown>, validate };
  } catch (err) {
    throw new Error(`--json-schema is not a usable JSON Schema: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The JSON in a model's reply: the whole reply, or the first fenced block. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  return JSON.parse((fenced ? fenced[1] : text).trim());
}

function instruction(schema: Record<string, unknown>): string {
  return [
    "The task is done. Now reply with ONLY a JSON value that matches this JSON Schema: no prose, no code fence, no tool calls.",
    "",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}

export async function produceStructuredOutput(
  provider: LlmProvider,
  systemPrompt: string,
  messages: LlmMessage[],
  tools: AgentToolDef[],
  json: { schema: Record<string, unknown>; validate: ValidateFunction },
  opts: { costTracker?: CostTracker | null; signal?: AbortSignal } = {},
): Promise<{ value: unknown } | { error: string }> {
  const exchange: LlmMessage[] = [...messages, { role: "user", content: instruction(json.schema) }];
  let problem = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) return { error: "cancelled" };
    const response = await provider.chat(systemPrompt, exchange, tools, opts.signal);
    if (response.usage && opts.costTracker) recordTokenUsage(opts.costTracker, response.usage);
    const text = response.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    let value: unknown;
    try {
      value = extractJson(text);
    } catch (err) {
      problem = `not JSON (${err instanceof Error ? err.message : String(err)})`;
    }
    if (!problem) {
      if (json.validate(value)) return { value };
      problem = (json.validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ");
    }
    exchange.push(
      { role: "assistant", content: text || "(no text)" },
      { role: "user", content: `That doesn't match the schema: ${problem}. Reply again with only the JSON value.` },
    );
    if (attempt < MAX_ATTEMPTS - 1) problem = "";
  }
  return { error: `no valid structured output after ${MAX_ATTEMPTS} attempts: ${problem}` };
}
