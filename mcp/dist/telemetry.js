import * as fs from "fs";
import * as path from "path";
import { runtimeDir } from "./shared.js";
// In-memory buffers keyed by phrenPath to batch disk writes
// Keeping per-path buffers avoids silently losing events when the active path changes.
const buffers = new Map();
const pendingCounts = new Map();
const FLUSH_THRESHOLD = 10;
function telemetryPath(phrenPath) {
    return path.join(runtimeDir(phrenPath), "telemetry.json");
}
function loadFromDisk(phrenPath) {
    const file = telemetryPath(phrenPath);
    const defaults = {
        config: { enabled: false },
        stats: { toolCalls: {}, cliCommands: {}, errors: 0, sessions: 0, lastActive: "" },
    };
    if (!fs.existsSync(file))
        return defaults;
    try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        return {
            config: { ...defaults.config, ...raw.config },
            stats: { ...defaults.stats, ...raw.stats },
        };
    }
    catch (err) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
            process.stderr.write(`[phren] telemetry loadFromDisk: ${err instanceof Error ? err.message : String(err)}\n`);
        return defaults;
    }
}
function loadTelemetry(phrenPath) {
    const cached = buffers.get(phrenPath);
    if (cached)
        return cached;
    const data = loadFromDisk(phrenPath);
    buffers.set(phrenPath, data);
    return data;
}
function saveTelemetry(phrenPath, data) {
    buffers.set(phrenPath, data);
    const pending = (pendingCounts.get(phrenPath) ?? 0) + 1;
    pendingCounts.set(phrenPath, pending);
    if (pending >= FLUSH_THRESHOLD) {
        flushTelemetryForPath(phrenPath);
    }
}
function flushTelemetryForPath(phrenPath) {
    const data = buffers.get(phrenPath);
    const pending = pendingCounts.get(phrenPath) ?? 0;
    if (!data || pending === 0)
        return;
    const file = telemetryPath(phrenPath);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    }
    catch (err) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
            process.stderr.write(`[phren] telemetry flush: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    pendingCounts.set(phrenPath, 0);
}
export function flushTelemetry() {
    for (const phrenPath of buffers.keys()) {
        flushTelemetryForPath(phrenPath);
    }
}
// Register flush on process exit
let exitHookRegistered = false;
function ensureExitHook() {
    if (exitHookRegistered)
        return;
    exitHookRegistered = true;
    process.on("exit", () => flushTelemetry());
}
export function isTelemetryEnabled(phrenPath) {
    return loadTelemetry(phrenPath).config.enabled;
}
export function setTelemetryEnabled(phrenPath, enabled) {
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
export function trackToolCall(phrenPath, toolName) {
    const data = loadTelemetry(phrenPath);
    if (!data.config.enabled)
        return;
    ensureExitHook();
    data.stats.toolCalls[toolName] = (data.stats.toolCalls[toolName] || 0) + 1;
    data.stats.lastActive = new Date().toISOString();
    saveTelemetry(phrenPath, data);
}
export function trackCliCommand(phrenPath, command) {
    const data = loadTelemetry(phrenPath);
    if (!data.config.enabled)
        return;
    ensureExitHook();
    data.stats.cliCommands[command] = (data.stats.cliCommands[command] || 0) + 1;
    data.stats.lastActive = new Date().toISOString();
    saveTelemetry(phrenPath, data);
}
export function trackError(phrenPath) {
    const data = loadTelemetry(phrenPath);
    if (!data.config.enabled)
        return;
    ensureExitHook();
    data.stats.errors += 1;
    saveTelemetry(phrenPath, data);
}
export function trackSession(phrenPath) {
    const data = loadTelemetry(phrenPath);
    if (!data.config.enabled)
        return;
    ensureExitHook();
    data.stats.sessions += 1;
    data.stats.lastActive = new Date().toISOString();
    saveTelemetry(phrenPath, data);
}
export function getTelemetrySummary(phrenPath) {
    const data = loadTelemetry(phrenPath);
    if (!data.config.enabled)
        return "Telemetry: disabled (opt in with 'phren config telemetry on')";
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
    if (topTools)
        lines.push("Top tools:", topTools);
    if (topCli)
        lines.push("Top CLI commands:", topCli);
    return lines.join("\n");
}
export function resetTelemetry(phrenPath) {
    const data = loadTelemetry(phrenPath);
    data.stats = { toolCalls: {}, cliCommands: {}, errors: 0, sessions: 0, lastActive: "" };
    // Reset flushes immediately
    buffers.set(phrenPath, data);
    pendingCounts.set(phrenPath, 1);
    flushTelemetryForPath(phrenPath);
}
// Reset internal buffer state (for testing)
export function _resetBuffer() {
    buffers.clear();
    pendingCounts.clear();
}
