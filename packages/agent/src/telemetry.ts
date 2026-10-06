/** Explicit opt-in OTLP/HTTP traces; only bounded categorical metadata leaves the process. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

type Attribute = string | number | boolean;
type Context = { traceId: string; spanId: string };
type Collector = { url: string; headers: Record<string, string> };
type Queued = { span: Record<string, unknown>; collector: Collector };
const context = new AsyncLocalStorage<Context>();
const queue: Queued[] = [];
let exporting: Promise<void> | undefined;
let exportAbort: AbortController | undefined;
let dropped = 0;
let networkEpoch = 0;
const now = () => (BigInt(Date.now()) * 1_000_000n).toString();
const providers = new Set(["anthropic", "openai", "openai-codex", "openrouter", "openai-compat", "deepseek", "ollama", "replay"]);
const tools = new Set(["read_file", "write_file", "edit_file", "multi_edit", "apply_patch", "shell", "glob", "grep", "web_search", "web_fetch", "lsp_diagnostics", "read_image", "git_status", "git_diff", "git_commit", "update_plan", "task_output", "task_stop", "spawn_agent", "list_agents", "send_message_to_agent"]);
function endpoint(): string | undefined {
  if (process.env.PHREN_AGENT_OTEL !== "1" || process.env.OTEL_SDK_DISABLED === "true") return undefined;
  const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const raw = traces ?? (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces` : undefined);
  if (!raw) return undefined;
  try { const url = new URL(raw); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash ? url.href : undefined; } catch { return undefined; }
}
function attributes(values: Record<string, Attribute>) {
  return Object.entries(values).map(([key, value]) => ({ key, value: typeof value === "number" ? { doubleValue: value } : typeof value === "boolean" ? { boolValue: value } : { stringValue: value } }));
}
function redactedMetadata(values: Record<string, Attribute>): Record<string, Attribute> {
  const safe: Record<string, Attribute> = {};
  if (typeof values["gen_ai.provider.name"] === "string") safe["gen_ai.provider.name"] = providers.has(String(values["gen_ai.provider.name"])) ? values["gen_ai.provider.name"] : "other";
  if (typeof values["tool.name"] === "string") safe["tool.name"] = tools.has(String(values["tool.name"])) ? values["tool.name"] : "external";
  // Model aliases and MCP tool names can contain user/project data. No free
  // form metadata, results, errors, paths or session identifiers are exported.
  return safe;
}
function headers() {
  const result: Record<string, string> = { "Content-Type": "application/json" };
  for (const pair of (process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
    const at = pair.indexOf("="); if (at < 1) continue;
    try { const key = pair.slice(0, at).trim(), value = decodeURIComponent(pair.slice(at + 1).trim()); if (/^[A-Za-z0-9_-]+$/.test(key) && !/[\r\n]/.test(value)) result[key] = value; } catch { /* Invalid optional collector header. */ }
  }
  return result;
}
export function telemetryStats() { return { queued: queue.length, dropped }; }
export function flushTelemetry(enabled = true): Promise<void> {
  const target = endpoint();
  if (!enabled || !target) {
    networkEpoch++;
    dropped += queue.length; queue.length = 0; exportAbort?.abort();
    return exporting ?? Promise.resolve();
  }
  if (exporting) return exporting;
  if (!queue.length) return Promise.resolve();
  // At most four batches per flush; include spans finishing during an
  // export without chasing an active producer forever.
  const controller = new AbortController(); exportAbort = controller;
  exporting = (async () => {
    for (let i = 0; i < 4 && queue.length; i++) {
      const batch = queue.splice(0, 32);
      const selected = batch.filter(item => item.collector.url === target);
      dropped += batch.length - selected.length;
      if (!selected.length) continue;
      if (endpoint() !== target || controller.signal.aborted) { dropped += selected.length; continue; }
      try {
        const response = await fetch(target, {
          method: "POST", redirect: "error", headers: selected[0].collector.headers,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
          body: JSON.stringify({ resourceSpans: [{ resource: { attributes: attributes({ "service.name": "phren-agent" }) }, scopeSpans: [{ scope: { name: "@phren/agent" }, spans: selected.map(item => item.span) }] }] }),
        });
        if (!response.ok) dropped += selected.length;
        await response.body?.cancel();
      } catch { dropped += selected.length; }
    }
  })().finally(() => { exporting = undefined; if (exportAbort === controller) exportAbort = undefined; });
  return exporting;
}
/** Collector settings and redaction are captured before user/provider code runs. */
export async function traceOperation<T>(name: string, metadata: Record<string, Attribute>, fn: () => Promise<T>, enabled = true): Promise<T> {
  const target = endpoint();
  if (!enabled || !target || (name !== "agent.turn" && name !== "agent.tool")) return fn();
  const collector = { url: target, headers: headers() }, safe = redactedMetadata(metadata), epoch = networkEpoch;
  const parent = context.getStore(), traceId = parent?.traceId ?? randomBytes(16).toString("hex"), spanId = randomBytes(8).toString("hex");
  const startTimeUnixNano = now(); let failed = false;
  try { return await context.run({ traceId, spanId }, fn); }
  catch (error) { failed = true; throw error; }
  finally {
    if (epoch !== networkEpoch || endpoint() !== target || queue.length >= 128) dropped++;
    else queue.push({ collector, span: { traceId, spanId, ...(parent ? { parentSpanId: parent.spanId } : {}), name, kind: 1, startTimeUnixNano, endTimeUnixNano: now(), attributes: attributes(safe), status: { code: failed ? 2 : 1 } } });
    if (epoch === networkEpoch) void flushTelemetry();
  }
}
