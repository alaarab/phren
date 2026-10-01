import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { capMcpOutput, loadDefaultMcpConfig } from "../mcp-client.js";
import { parseArgs } from "../config.js";

describe("default MCP config", () => {
  const dirs: string[] = [];
  const tmp = (prefix: string) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function setup() {
    const home = tmp("mcp-home-");
    const project = tmp("mcp-proj-");
    fs.mkdirSync(path.join(home, ".phren-agent"));
    fs.writeFileSync(path.join(home, ".phren-agent", "mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } }));
    fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { db: { command: "db-server", args: ["--ro"] } } }));
    fs.mkdirSync(path.join(project, ".phren-agent"));
    fs.writeFileSync(path.join(project, ".phren-agent", "mcp.json"), JSON.stringify({ web: { type: "http", url: "https://mcp.example.com" } }));
    return { home, project };
  }

  it("loads the user's servers always, and the project's only when it is trusted", () => {
    const { home, project } = setup();
    const untrusted = loadDefaultMcpConfig(project, { home, trusted: false });
    expect(Object.keys(untrusted.servers)).toEqual(["docs"]);
    expect(untrusted.untrusted.map((u) => [path.basename(u.file), u.names])).toEqual([[".mcp.json", ["db"]], ["mcp.json", ["web"]]]);

    const trusted = loadDefaultMcpConfig(project, { home, trusted: true });
    expect(Object.keys(trusted.servers).sort()).toEqual(["db", "docs", "web"]);
    expect(trusted.servers.db).toMatchObject({ command: "db-server", args: ["--ro"] });
    expect(trusted.untrusted).toEqual([]);
  });

  it("finds nothing where there is nothing", () => {
    const empty = loadDefaultMcpConfig(tmp("mcp-empty-"), { home: tmp("mcp-nohome-"), trusted: false });
    expect(empty).toEqual({ servers: {}, untrusted: [] });
  });

  it("parses the flags", () => {
    const args = parseArgs(["--trust-project-mcp", "--strict-mcp-config", "task"]);
    expect(args.trustProjectMcp).toBe(true);
    expect(args.strictMcpConfig).toBe(true);
  });
});

describe("MCP output cap", () => {
  it("keeps short output and cuts long output with a note", () => {
    expect(capMcpOutput("short", 10)).toBe("short");
    const cut = capMcpOutput("x".repeat(50), 10);
    expect(cut.startsWith("x".repeat(10))).toBe(true);
    expect(cut).toContain("MCP output truncated: 50 chars, showing the first 10");
  });
});
