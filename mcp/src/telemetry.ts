import * as fs from "fs";
import * as path from "path";
import { runtimeFile } from "./shared.js";

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

// In-memory buffer to batch disk writes
let buffer: TelemetryData | null = null;
let bufferPath: string | null = null;
let pendingEvents = 0;
const FLUSH_THRESHOLD = 10;

function telemetryPath(cortexPath: string): string {
  return runtimeFile(cortexPath, "telemetry.json");
}

// Migrate legacy .governance/telemetry.json to .runtime/
function migrateLegacy(cortexPath: string, newPath: string): void {
  const legacyPath = path.join(cortexPath, ".governance", "telemetry.json");
  if (fs.existsSync(legacyPath) && !fs.existsSync(newPath)) {
    try { fs.renameSync(legacyPath, newPath); } catch { /* best effort */ }
  }
}

function loadFromDisk(cortexPath: string): TelemetryData {
  const file = telemetryPath(cortexPath);
  migrateLegacy(cortexPath, file);
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
  } catch {
    return defaults;
  }
}

function loadTelemetry(cortexPath: string): TelemetryData {
  if (buffer && bufferPath === cortexPath) return buffer;
  const data = loadFromDisk(cortexPath);
  buffer = data;
  bufferPath = cortexPath;
  return data;
}

function saveTelemetry(cortexPath: string, data: TelemetryData): void {
  buffer = data;
  bufferPath = cortexPath;
  pendingEvents++;
  if (pendingEvents >= FLUSH_THRESHOLD) {
    flushTelemetry();
  }
}

export function flushTelemetry(): void {
  if (!buffer || !bufferPath || pendingEvents === 0) return;
  const file = telemetryPath(bufferPath);
  try {
    fs.writeFileSync(file, JSON.stringify(buffer, null, 2) + "\n");
  } catch { /* best effort */ }
  pendingEvents = 0;
}

// Register flush on process exit
let exitHookRegistered = false;
function ensureExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on("exit", () => flushTelemetry());
}

export function isTelemetryEnabled(cortexPath: string): boolean {
  return loadTelemetry(cortexPath).config.enabled;
}

export function setTelemetryEnabled(cortexPath: string, enabled: boolean): void {
  const data = loadTelemetry(cortexPath);
  data.config.enabled = enabled;
  if (enabled && !data.config.enabledAt) {
    data.config.enabledAt = new Date().toISOString();
  }
  // Config changes flush immediately
  buffer = data;
  bufferPath = cortexPath;
  pendingEvents = 1;
  flushTelemetry();
}

export function trackToolCall(cortexPath: string, toolName: string): void {
  const data = loadTelemetry(cortexPath);
  if (!data.config.enabled) return;
  ensureExitHook();
  data.stats.toolCalls[toolName] = (data.stats.toolCalls[toolName] || 0) + 1;
  data.stats.lastActive = new Date().toISOString();
  saveTelemetry(cortexPath, data);
}

export function trackCliCommand(cortexPath: string, command: string): void {
  const data = loadTelemetry(cortexPath);
  if (!data.config.enabled) return;
  ensureExitHook();
  data.stats.cliCommands[command] = (data.stats.cliCommands[command] || 0) + 1;
  data.stats.lastActive = new Date().toISOString();
  saveTelemetry(cortexPath, data);
}

export function trackError(cortexPath: string): void {
  const data = loadTelemetry(cortexPath);
  if (!data.config.enabled) return;
  ensureExitHook();
  data.stats.errors += 1;
  saveTelemetry(cortexPath, data);
}

export function trackSession(cortexPath: string): void {
  const data = loadTelemetry(cortexPath);
  if (!data.config.enabled) return;
  ensureExitHook();
  data.stats.sessions += 1;
  data.stats.lastActive = new Date().toISOString();
  saveTelemetry(cortexPath, data);
}

export function getTelemetrySummary(cortexPath: string): string {
  const data = loadTelemetry(cortexPath);
  if (!data.config.enabled) return "Telemetry: disabled (opt in with 'cortex config telemetry on')";

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

export function resetTelemetry(cortexPath: string): void {
  const data = loadTelemetry(cortexPath);
  data.stats = { toolCalls: {}, cliCommands: {}, errors: 0, sessions: 0, lastActive: "" };
  // Reset flushes immediately
  buffer = data;
  bufferPath = cortexPath;
  pendingEvents = 1;
  flushTelemetry();
}

// Reset internal buffer state (for testing)
export function _resetBuffer(): void {
  buffer = null;
  bufferPath = null;
  pendingEvents = 0;
}
