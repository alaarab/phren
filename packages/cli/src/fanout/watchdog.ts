function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export class LoopWatchdog {
  private calls: string[] = [];
  observe(event: Record<string, unknown>): void {
    if (event.type !== "tool_use") return;
    const part = event.part as { tool?: string; state?: { input?: unknown } } | undefined;
    this.calls.push((part?.tool ?? "") + JSON.stringify(canonical(part?.state?.input ?? {})));
    if (this.calls.length > 60) this.calls.shift();
  }
  reason(): string | undefined {
    const distinct = new Set(this.calls).size;
    return this.calls.length === 60 && distinct <= 2 ? `tool loop: last 60 calls had ${distinct} distinct inputs` : undefined;
  }
}
export function stderrRefusal(tail: string): { type: string; pattern: string; message: string } | undefined {
  const matches = [...tail.matchAll(/permission requested:\s*([^\s(]+)\s*\(([^\n]*?)\);\s*auto-rejecting/g)];
  const last = matches.at(-1);
  return last ? { type: last[1], pattern: last[2], message: `blocked: ${last[1]} ${last[2]}` } : undefined;
}
