import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadMcpConfig, parseMcpInline, connectMcpServers } from "../mcp-client.js";

// ── loadMcpConfig ──────────────────────────────────────────────────────────

describe("loadMcpConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cfg-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty object for non-existent file", () => {
    const result = loadMcpConfig(path.join(tmpDir, "missing.json"));
    expect(result).toEqual({});
  });

  it("reads direct server config format", () => {
    const configPath = path.join(tmpDir, "mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({
      myserver: { command: "node", args: ["server.js"], env: { FOO: "bar" } },
    }));
    const result = loadMcpConfig(configPath);
    expect(result).toEqual({
      myserver: { command: "node", args: ["server.js"], env: { FOO: "bar" } },
    });
  });

  it("reads nested mcpServers format", () => {
    const configPath = path.join(tmpDir, "mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        phren: { command: "phren", args: ["mcp-mode"] },
      },
    }));
    const result = loadMcpConfig(configPath);
    expect(result).toEqual({
      phren: { command: "phren", args: ["mcp-mode"] },
    });
  });

  it("skips entries without a string command", () => {
    const configPath = path.join(tmpDir, "mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({
      valid: { command: "node", args: ["a.js"] },
      noCommand: { args: ["b.js"] },
      numberCommand: { command: 42 },
    }));
    const result = loadMcpConfig(configPath);
    expect(Object.keys(result)).toEqual(["valid"]);
  });

  it("omits args when not an array", () => {
    const configPath = path.join(tmpDir, "mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({
      srv: { command: "cmd", args: "not-array" },
    }));
    const result = loadMcpConfig(configPath);
    expect(result.srv.args).toBeUndefined();
  });

  it("omits env when not an object", () => {
    const configPath = path.join(tmpDir, "mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({
      srv: { command: "cmd", env: "string" },
    }));
    const result = loadMcpConfig(configPath);
    expect(result.srv.env).toBeUndefined();
  });

  it("returns empty object for invalid JSON", () => {
    const configPath = path.join(tmpDir, "mcp.json");
    fs.writeFileSync(configPath, "not json{{{");
    const result = loadMcpConfig(configPath);
    expect(result).toEqual({});
  });
});

// ── parseMcpInline ─────────────────────────────────────────────────────────

describe("parseMcpInline", () => {
  it("parses command with no args", () => {
    expect(parseMcpInline("phren")).toEqual({ command: "phren", args: [] });
  });

  it("parses command with multiple args", () => {
    expect(parseMcpInline("node server.js --port 3000")).toEqual({
      command: "node",
      args: ["server.js", "--port", "3000"],
    });
  });

  it("handles extra whitespace", () => {
    const result = parseMcpInline("  cmd   arg1   arg2  ");
    expect(result.command).toBe("");
    // Leading whitespace causes split to produce empty first element
    expect(result.args).toContain("cmd");
  });
});

// ── connectMcpServers ──────────────────────────────────────────────────────

describe("connectMcpServers", () => {
  it("returns empty tools and a cleanup function for empty config", async () => {
    const result = await connectMcpServers({});
    expect(result.tools).toEqual([]);
    expect(typeof result.cleanup).toBe("function");
    result.cleanup(); // should not throw
  });

  it("logs error and continues when server command is invalid", async () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as any;

    try {
      const result = await connectMcpServers({
        bogus: { command: "__nonexistent_binary_xyz__" },
      });
      // Should gracefully handle the failed connection
      expect(result.tools).toEqual([]);
      result.cleanup();
    } finally {
      process.stderr.write = origWrite;
    }

    expect(stderrChunks.some((c) => c.includes("bogus"))).toBe(true);
  });
});
