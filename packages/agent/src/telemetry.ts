/** Opt-in OTLP/HTTP JSON traces. Never exports prompts, paths, arguments or responses. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

type Attribute = string | number | boolean;
type Context = { traceId: string; spanId: string };
const context = new AsyncLocalStorage<Context>();
const queue: Record<string, unknown>[] = [];
let exporting: Promise<void> | undefined;
let dropped = 0;
const now = () => (BigInt(Date.now()) * 1_000_000n).toString();
function endpoint(): string | undefined {
  if (process.env.PHREN_AGENT_OTEL !== "1" || process.env.OTEL_SDK_DISABLED === "true") return undefined;
  const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const raw = traces ?? (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces` : undefined);
  if (!raw) return undefined;
  try { const url = new URL(raw); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
function attributes(values: Record<string, Attribute>) {
  return Object.entries(values).map(([key, value]) => ({ key, value: typeof value === "number" ? { doubleValue: value } : typeof value === "boolean" ? { boolValue: value } : { stringValue: value } }));
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
export function flushTelemetry(): Promise<void> {
  if (exporting) return exporting;
  const target = endpoint(); if (!target || !queue.length) return Promise.resolve();
  exporting = (async () => {
    while (queue.length) {
      const spans = queue.splice(0, 32);
      try {
        const response = await fetch(target, { method: "POST", headers: headers(), signal: AbortSignal.timeout(5000), body: JSON.stringify({ resourceSpans: [{ resource: { attributes: attributes({ "service.name": process.env.OTEL_SERVICE_NAME ?? "phren-agent" }) }, scopeSpans: [{ scope: { name: "@phren/agent" }, spans }] }] }) });
        if (!response.ok) dropped += spans.length;
        await response.body?.cancel();
      } catch { dropped += spans.length; }
    }
  })().finally(() => { exporting = undefined; });
  return exporting;
}
/** Only allowlisted, caller-created metadata reaches the collector; failures are nonfatal. */
export async function traceOperation<T>(name: string, metadata: Record<string, Attribute>, fn: () => Promise<T>, enabled = true): Promise<T> {
  if (!enabled || !endpoint()) return fn();
  const parent = context.getStore(), traceId = parent?.traceId ?? randomBytes(16).toString("hex"), spanId = randomBytes(8).toString("hex");
  const startTimeUnixNano = now(); let failed = false;
  try { return await context.run({ traceId, spanId }, fn); }
  catch (error) { failed = true; throw error; }
  finally {
    if (queue.length >= 128) dropped++;
    else queue.push({ traceId, spanId, ...(parent ? { parentSpanId: parent.spanId } : {}), name, kind: 1, startTimeUnixNano, endTimeUnixNano: now(), attributes: attributes(metadata), status: { code: failed ? 2 : 1 } });
    void flushTelemetry();
  }
}
