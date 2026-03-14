import * as fs from "fs";
import * as path from "path";
import { runtimeDir } from "./shared.js";

interface TelemetryConfig {
  enabled: boolean;
  enabledAt?: string;
}

interface UsageStats {
  toolCalls: Record<string, number>;
  cliCommands: Record<string, number>;
  errors: number;
  sessions: number;
  lastActive: string;
}

interface TelemetryData {
  config: TelemetryConfig;
  stats: UsageStats;
}

// In-memory buffers keyed by phrenPath to batch disk writes
// Keeping per-path buffers avoids silently losing events when the active path changes.
const buffers = new Map<string, TelemetryData>();
const pendingCounts = new Map<string, number>();
const FLUSH_THRESHOLD = 10;

function telemetryPath(phrenPath: string): string {
  return path.join(runtimeDir(phrenPath), "telemetry.json");
}

function loadFromDisk(phrenPath: string): TelemetryData {
  const file = telemetryPath(phrenPath);
  const defaults: TelemetryData = {
    config: { enabled: false },
    stats: { toolCalls: {}, cliCommands: {}, errors: 0, sessions: 0, lastActive: "" },
  };
  if (!fs.existsSync(file)) return defaults;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      config: { ...defaults.config, ...raw.config },
      stats: { ...defaults.stats, ...raw.stats },
    };
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] telemetry loadFromDisk: ${err instanceof Error ? err.message : String(err)}\n`);
    return defaults;
  }
}

function loadTelemetry(phrenPath: string): TelemetryData {
  const cached = buffers.get(phrenPath);
  if (cached) return cached;
  const data = loadFromDisk(phrenPath);
  buffers.set(phrenPath, data);
  return data;
}

function saveTelemetry(phrenPath: string, data: TelemetryData): void {
  buffers.set(phrenPath, data);
  const pending = (pendingCounts.get(phrenPath) ?? 0) + 1;
  pendingCounts.set(phrenPath, pending);
  if (pending >= FLUSH_THRESHOLD) {
    flushTelemetryForPath(phrenPath);
  }
}

function flushTelemetryForPath(phrenPath: string): void {
  const data = buffers.get(phrenPath);
  const pending = pendingCounts.get(phrenPath) ?? 0;
  if (!data || pending === 0) return;
  const file = telemetryPath(phrenPath);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] telemetry flush: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  pendingCounts.set(phrenPath, 0);
}

export function flushTelemetry(): void {
  for (const phrenPath of buffers.keys()) {
    flushTelemetryForPath(phrenPath);
  }
}

// Register flush on process exit
let exitHookRegistered = false;
function ensureExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on("exit", () => flushTelemetry());
}

export function isTelemetryEnabled(phrenPath: string): boolean {
  return loadTelemetry(phrenPath).config.enabled;
}

export function setTelemetryEnabled(phrenPath: string, enabled: boolean): void {
  const data = loadTelemetry(phrenPath);
  data.config.enabled = enabled;
  if (enabled && !data.config.enabledAt) {
    data.config.enabledAt = new Date().toISOString();
  }
  // Config changes flush immediately
  buffers.set(phrenPath, data);
  pendingCounts.set(phrenPath, 1);
  flushTelemetryForPath(phrenPath);
}

export function trackToolCall(phrenPath: string, toolName: string): void {
  const data = loadTelemetry(phrenPath);
  if (!data.config.enabled) return;
  ensureExitHook();
  data.stats.toolCalls[toolName] = (data.stats.toolCalls[toolName] || 0) + 1;
  data.stats.lastActive = new Date().toISOString();
  saveTelemetry(phrenPath, data);
}

export function trackCliCommand(phrenPath: string, command: string): void {
  const data = loadTelemetry(phrenPath);
  if (!data.config.enabled) return;
  ensureExitHook();
  data.stats.cliCommands[command] = (data.stats.cliCommands[command] || 0) + 1;
  data.stats.lastActive = new Date().toISOString();
  saveTelemetry(phrenPath, data);
}

export function trackError(phrenPath: string): void {
  const data = loadTelemetry(phrenPath);
  if (!data.config.enabled) return;
  ensureExitHook();
  data.stats.errors += 1;
  saveTelemetry(phrenPath, data);
}

export function trackSession(phrenPath: string): void {
  const data = loadTelemetry(phrenPath);
  if (!data.config.enabled) return;
  ensureExitHook();
  data.stats.sessions += 1;
  data.stats.lastActive = new Date().toISOString();
  saveTelemetry(phrenPath, data);
}

export function getTelemetrySummary(phrenPath: string): string {
  const data = loadTelemetry(phrenPath);
  if (!data.config.enabled) return "Telemetry: disabled (opt in with 'phren config telemetry on')";

  const topTools = Object.entries(data.stats.toolCalls)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name, count]) => `  ${name}: ${count}`)
    .join("\n");

  const topCli = Object.entries(data.stats.cliCommands)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name, count]) => `  ${name}: ${count}`)
    .join("\n");

  const lines = [
    `Telemetry: enabled (since ${data.config.enabledAt || "unknown"})`,
    `Sessions: ${data.stats.sessions}`,
    `Errors: ${data.stats.errors}`,
    `Last active: ${data.stats.lastActive || "never"}`,
  ];
  if (topTools) lines.push("Top tools:", topTools);
  if (topCli) lines.push("Top CLI commands:", topCli);
  return lines.join("\n");
}

export function resetTelemetry(phrenPath: string): void {
  const data = loadTelemetry(phrenPath);
  data.stats = { toolCalls: {}, cliCommands: {}, errors: 0, sessions: 0, lastActive: "" };
  // Reset flushes immediately
  buffers.set(phrenPath, data);
  pendingCounts.set(phrenPath, 1);
  flushTelemetryForPath(phrenPath);
}

// Reset internal buffer state (for testing)
export function _resetBuffer(): void {
  buffers.clear();
  pendingCounts.clear();
}
