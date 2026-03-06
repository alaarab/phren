import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  isTelemetryEnabled,
  setTelemetryEnabled,
  trackToolCall,
  trackCliCommand,
  trackError,
  trackSession,
  getTelemetrySummary,
  resetTelemetry,
  flushTelemetry,
  _resetBuffer,
} from "./telemetry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-telemetry-test-"));
  _resetBuffer();
});

afterEach(() => {
  _resetBuffer();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("telemetry", () => {
  it("defaults to disabled", () => {
    expect(isTelemetryEnabled(tmpDir)).toBe(false);
  });

  it("can be enabled and disabled", () => {
    setTelemetryEnabled(tmpDir, true);
    expect(isTelemetryEnabled(tmpDir)).toBe(true);

    setTelemetryEnabled(tmpDir, false);
    expect(isTelemetryEnabled(tmpDir)).toBe(false);
  });

  it("stores telemetry in .runtime/ not .governance/", () => {
    setTelemetryEnabled(tmpDir, true);
    const runtimePath = path.join(tmpDir, ".runtime", "telemetry.json");
    const legacyPath = path.join(tmpDir, ".governance", "telemetry.json");
    expect(fs.existsSync(runtimePath)).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("migrates legacy .governance/telemetry.json to .runtime/", () => {
    const legacyDir = path.join(tmpDir, ".governance");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyData = {
      config: { enabled: true, enabledAt: "2025-01-01T00:00:00.000Z" },
      stats: { toolCalls: { search_knowledge: 5 }, cliCommands: {}, errors: 0, sessions: 2, lastActive: "" },
    };
    fs.writeFileSync(path.join(legacyDir, "telemetry.json"), JSON.stringify(legacyData));

    expect(isTelemetryEnabled(tmpDir)).toBe(true);
    const summary = getTelemetrySummary(tmpDir);
    expect(summary).toContain("search_knowledge: 5");
    expect(summary).toContain("Sessions: 2");
  });

  it("records enabledAt timestamp on first enable", () => {
    setTelemetryEnabled(tmpDir, true);
    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".runtime", "telemetry.json"), "utf8")
    );
    expect(data.config.enabledAt).toBeTruthy();
    expect(new Date(data.config.enabledAt).getTime()).toBeGreaterThan(0);
  });

  it("does not track when disabled", () => {
    trackToolCall(tmpDir, "search_knowledge");
    trackCliCommand(tmpDir, "search");
    trackError(tmpDir);
    trackSession(tmpDir);
    flushTelemetry();

    const file = path.join(tmpDir, ".runtime", "telemetry.json");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("buffers events and flushes after threshold", () => {
    setTelemetryEnabled(tmpDir, true);
    const file = path.join(tmpDir, ".runtime", "telemetry.json");

    // Track 9 events (under threshold of 10)
    for (let i = 0; i < 9; i++) {
      trackToolCall(tmpDir, "buffered_tool");
    }
    // Read disk: should still have old data (from setTelemetryEnabled flush)
    const beforeFlush = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(beforeFlush.stats.toolCalls.buffered_tool).toBeUndefined();

    // 10th event triggers auto-flush
    trackToolCall(tmpDir, "buffered_tool");
    const afterFlush = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(afterFlush.stats.toolCalls.buffered_tool).toBe(10);
  });

  it("flushTelemetry writes buffer to disk", () => {
    setTelemetryEnabled(tmpDir, true);
    trackToolCall(tmpDir, "manual_flush");
    flushTelemetry();

    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".runtime", "telemetry.json"), "utf8")
    );
    expect(data.stats.toolCalls.manual_flush).toBe(1);
  });

  it("tracks tool calls when enabled", () => {
    setTelemetryEnabled(tmpDir, true);
    trackToolCall(tmpDir, "search_knowledge");
    trackToolCall(tmpDir, "search_knowledge");
    trackToolCall(tmpDir, "add_learning");
    flushTelemetry();

    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".runtime", "telemetry.json"), "utf8")
    );
    expect(data.stats.toolCalls.search_knowledge).toBe(2);
    expect(data.stats.toolCalls.add_learning).toBe(1);
  });

  it("tracks CLI commands when enabled", () => {
    setTelemetryEnabled(tmpDir, true);
    trackCliCommand(tmpDir, "search");
    trackCliCommand(tmpDir, "doctor");
    trackCliCommand(tmpDir, "search");
    flushTelemetry();

    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".runtime", "telemetry.json"), "utf8")
    );
    expect(data.stats.cliCommands.search).toBe(2);
    expect(data.stats.cliCommands.doctor).toBe(1);
  });

  it("tracks errors when enabled", () => {
    setTelemetryEnabled(tmpDir, true);
    trackError(tmpDir);
    trackError(tmpDir);
    flushTelemetry();

    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".runtime", "telemetry.json"), "utf8")
    );
    expect(data.stats.errors).toBe(2);
  });

  it("tracks sessions and updates lastActive", () => {
    setTelemetryEnabled(tmpDir, true);
    trackSession(tmpDir);
    trackSession(tmpDir);
    trackSession(tmpDir);
    flushTelemetry();

    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".runtime", "telemetry.json"), "utf8")
    );
    expect(data.stats.sessions).toBe(3);
    expect(data.stats.lastActive).toBeTruthy();
  });

  it("resets stats without changing config", () => {
    setTelemetryEnabled(tmpDir, true);
    trackToolCall(tmpDir, "search_knowledge");
    trackSession(tmpDir);
    trackError(tmpDir);
    flushTelemetry();

    resetTelemetry(tmpDir);

    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".runtime", "telemetry.json"), "utf8")
    );
    expect(data.config.enabled).toBe(true);
    expect(data.stats.toolCalls).toEqual({});
    expect(data.stats.sessions).toBe(0);
    expect(data.stats.errors).toBe(0);
  });

  it("returns disabled summary when off", () => {
    const summary = getTelemetrySummary(tmpDir);
    expect(summary).toContain("disabled");
    expect(summary).toContain("opt in");
  });

  it("returns usage summary when enabled with data", () => {
    setTelemetryEnabled(tmpDir, true);
    trackToolCall(tmpDir, "search_knowledge");
    trackToolCall(tmpDir, "search_knowledge");
    trackCliCommand(tmpDir, "doctor");
    trackSession(tmpDir);

    const summary = getTelemetrySummary(tmpDir);
    expect(summary).toContain("enabled");
    expect(summary).toContain("Sessions: 1");
    expect(summary).toContain("search_knowledge: 2");
    expect(summary).toContain("doctor: 1");
  });

  it("handles corrupted telemetry file gracefully", () => {
    const runtimeDir = path.join(tmpDir, ".runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "telemetry.json"),
      "not valid json"
    );
    expect(isTelemetryEnabled(tmpDir)).toBe(false);
    expect(getTelemetrySummary(tmpDir)).toContain("disabled");
  });
});
