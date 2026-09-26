/**
 * Headless (`-p` / `--print`) output for scripts and CI.
 *
 * stdout carries only the requested format; everything else (tool lines in
 * --verbose, compaction notices, warnings) goes to stderr.
 *
 *   text         the final assistant message
 *   json         one result object at the end
 *   stream-json  newline-delimited events as they happen, ending with the
 *                same result object
 *
 * Nobody is present to approve tool calls, so permission prompts are denied
 * (fail closed) and the model is told why; run with `--permissions
 * auto-confirm` or `--yolo` to let it act.
 */
import type { ContentBlock } from "./providers/types.js";
import type { TurnHooks, TurnStopReason } from "./agent-loop/types.js";
import type { CostTracker } from "./cost.js";

export type OutputFormat = "text" | "json" | "stream-json";

export interface HeadlessResult {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_budget" | "error_plan_rejected" | "cancelled" | "error_during_execution";
  is_error: boolean;
  result: string;
  num_turns: number;
  tool_calls: number;
  duration_ms: number;
  session_id: string | null;
  provider: string;
  model: string | null;
  usage: { input_tokens: number; output_tokens: number };
  /** Estimated USD; null when the provider is a flat-rate subscription. */
  total_cost_usd: number | null;
  permission_denials: number;
  error?: string;
}

const SUBTYPE: Record<TurnStopReason, HeadlessResult["subtype"]> = {
  end_turn: "success",
  max_turns: "error_max_turns",
  budget: "error_budget",
  plan_rejected: "error_plan_rejected",
  aborted: "cancelled",
};

export function buildHeadlessResult(opts: {
  text: string;
  stopReason: TurnStopReason | "error";
  turns: number;
  toolCalls: number;
  startedAt: number;
  sessionId: string | null;
  provider: string;
  model: string | null;
  costTracker?: CostTracker | null;
  permissionDenials: number;
  error?: string;
}): HeadlessResult {
  const subtype = opts.stopReason === "error" ? "error_during_execution" : SUBTYPE[opts.stopReason];
  const tracker = opts.costTracker;
  return {
    type: "result",
    subtype,
    is_error: subtype !== "success",
    result: opts.text,
    num_turns: opts.turns,
    tool_calls: opts.toolCalls,
    duration_ms: Date.now() - opts.startedAt,
    session_id: opts.sessionId,
    provider: opts.provider,
    model: opts.model,
    usage: { input_tokens: tracker?.totalInputTokens ?? 0, output_tokens: tracker?.totalOutputTokens ?? 0 },
    total_cost_usd: tracker?.metered ? Number(tracker.totalCost.toFixed(6)) : null,
    permission_denials: opts.permissionDenials,
    ...(opts.error ? { error: opts.error } : {}),
  };
}

/** Exit status for a headless run: 0 only when the task finished normally. */
export function headlessExitCode(result: HeadlessResult): number {
  if (result.subtype === "success") return 0;
  if (result.subtype === "cancelled") return 130;
  return 1;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function resultText(block: ContentBlock): string {
  if (block.type !== "tool_result") return "";
  if (typeof block.content === "string") return block.content;
  return block.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

const MAX_EVENT_OUTPUT = 4000;

/**
 * Turn hooks that keep stdout clean. `write` receives complete stdout lines
 * (stream-json events); text and json formats print once, at the end.
 */
export function createHeadlessHooks(opts: {
  format: OutputFormat;
  verbose: boolean;
  write: (line: string) => void;
  stderr?: (text: string) => void;
}): TurnHooks {
  const stderr = opts.stderr ?? ((t: string) => process.stderr.write(t));
  const emit = (event: Record<string, unknown>) => {
    if (opts.format === "stream-json") opts.write(JSON.stringify(event));
  };
  const toolNames = new Map<string, string>();
  return {
    onTextDelta: () => {},
    onTextBlock: () => {},
    onReasoningDelta: opts.verbose ? (t) => stderr(`\x1b[2m${t}\x1b[0m`) : () => {},
    onStatus: (msg) => stderr(msg),
    onToolStart: (name, input) => {
      if (opts.verbose) stderr(`→ ${name} ${JSON.stringify(input).slice(0, 200)}\n`);
    },
    onToolEnd: (name, _input, output, isError, durationMs) => {
      if (opts.verbose) stderr(`← ${name}${isError ? " (error)" : ""} ${durationMs}ms ${output.split("\n")[0].slice(0, 160)}\n`);
    },
    onAssistantMessage: (content, stopReason) => {
      const text = textOf(content);
      if (text) emit({ type: "assistant", text, stop_reason: stopReason });
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        toolNames.set(block.id, block.name);
        emit({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }
    },
    onToolResults: (results) => {
      for (const block of results) {
        if (block.type !== "tool_result") continue;
        const output = resultText(block);
        emit({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          name: toolNames.get(block.tool_use_id) ?? null,
          is_error: !!block.is_error,
          output: output.length > MAX_EVENT_OUTPUT ? `${output.slice(0, MAX_EVENT_OUTPUT)}… [${output.length} chars]` : output,
        });
      }
    },
    // No one can review a plan: stop after presenting it.
    onPlanApproval: async () => ({ approved: false }),
  };
}

/** Parse --output-format; null for an unknown value. */
export function parseOutputFormat(raw: string | undefined): OutputFormat | null {
  if (raw === "text" || raw === "json" || raw === "stream-json") return raw;
  return null;
}

/** Read the whole of stdin (for `echo task | phren-agent -p`). */
export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}
