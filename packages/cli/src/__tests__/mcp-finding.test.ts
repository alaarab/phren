import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin, } from "../test-helpers.js";
import { addFindingsToFile } from "../shared/content.js";
import { removeFinding, } from "../data/access.js";
import { register } from "../tools/finding.js";
import type { McpContext } from "../tools/types.js";

const PROJECT = "myapp";

let tmp: { path: string; cleanup: () => void };

function seedProject(phrenPath: string, project = PROJECT) {
  const dir = path.join(phrenPath, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.md"), `# ${project}\n`);
}

function findingsPath(project = PROJECT) {
  return path.join(tmp.path, project, "FINDINGS.md");
}

const SAMPLE_FINDINGS = `# myapp Findings

## 2026-03-01

- The auth middleware runs before rate limiting, order matters
- SQLite WAL mode is required for concurrent readers

## 2026-02-15

- vitest needs pool: "forks" when testing native addons
`;

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

function makeMockServer() {
  const tools = new Map<string, ToolHandler>();
  return {
    registerTool(name: string, _meta: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    },
    call(name: string, args: Record<string, unknown>) {
      const handler = tools.get(name);
      if (!handler) throw new Error(`Tool "${name}" not registered`);
      return handler(args);
    },
  };
}

function parseResult(res: { content: { type: string; text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  tmp = makeTempDir("mcp-finding-test-");
  grantAdmin(tmp.path);
  seedProject(tmp.path);
});

afterEach(() => {
  delete process.env.PHREN_ACTOR;
  tmp.cleanup();
});

describe("add_finding MCP tool", () => {
  it("accepts a slash-joined device list through the registered tool", async () => {
    const server = makeMockServer();
    const ctx: McpContext = { phrenPath: tmp.path, profile: "", db: () => { throw new Error("unused"); },
      rebuildIndex: async () => {}, updateFileInIndex: () => {}, withWriteQueue: async fn => fn() };
    register(server as any, ctx);
    const finding = "Keep derail/strata/cleave/cleaver/oracle/overtone/tapeworm aligned with the device registry.";
    const result = parseResult(await server.call("add_finding", { project: PROJECT, finding }));
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(findingsPath(), "utf8")).toContain(finding);
  });

  it("rejects a finding over 5000 chars through the registered tool", async () => {
    const server = makeMockServer();
    const ctx: McpContext = { phrenPath: tmp.path, profile: "", db: () => { throw new Error("unused"); },
      rebuildIndex: async () => {}, updateFileInIndex: () => {}, withWriteQueue: async fn => fn() };
    register(server as any, ctx);
    const result = parseResult(await server.call("add_finding", { project: PROJECT, finding: "x".repeat(5001) }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("5000 character limit");
    expect(fs.existsSync(findingsPath())).toBe(false);
  });
});

describe("remove_finding MCP tool", () => {
  it("returns error when FINDINGS.md does not exist", () => {
    const msg = removeFinding(tmp.path, PROJECT, "anything");
    expect(msg.ok).toBe(false);
  });
});

describe("edit_finding MCP tool", () => {
  it("edits a finding in place through the registered MCP tool", async () => {
    fs.writeFileSync(findingsPath(), SAMPLE_FINDINGS);
    const server = makeMockServer();
    const ctx: McpContext = {
      phrenPath: tmp.path,
      profile: "",
      db: () => { throw new Error("unused"); },
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);

    const res = parseResult(await server.call("edit_finding", {
      project: PROJECT,
      old_text: "WAL mode",
      new_text: "SQLite WAL mode prevents reader blocking",
    }));
    expect(res.ok).toBe(true);

    const content = fs.readFileSync(findingsPath(), "utf8");
    expect(content).toContain("SQLite WAL mode prevents reader blocking");
    expect(content).not.toContain("SQLite WAL mode is required for concurrent readers");
  });
});

describe("add_findings bulk MCP tool", () => {
  it("duplicates are skipped within the same batch", () => {
    const findings = [
      "Use retries for transient failures",
      "Use retries for transient failures",
    ];
    const r = addFindingsToFile(tmp.path, PROJECT, findings);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.added).toHaveLength(1);
    expect(r.data.skipped).toHaveLength(1);
  });

  it("duplicates against existing findings are skipped", () => {
    fs.writeFileSync(findingsPath(), SAMPLE_FINDINGS);
    const findings = [
      "SQLite WAL mode is required for concurrent readers",
      "Brand new insight about caching",
    ];
    const r = addFindingsToFile(tmp.path, PROJECT, findings);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.added).toHaveLength(1);
    expect(r.data.skipped).toHaveLength(1);
    expect(r.data.added[0]).toContain("caching");
  });
});
