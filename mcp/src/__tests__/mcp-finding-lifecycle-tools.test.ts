import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { McpContext } from "../mcp-types.js";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { register } from "../mcp-finding.js";

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

function seedProject(cortexPath: string, project = "demo") {
  const dir = path.join(cortexPath, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.md"), "# demo\n");
}

function writeFindings(cortexPath: string, lines: string[]) {
  const file = path.join(cortexPath, "demo", "FINDINGS.md");
  fs.writeFileSync(file, ["# demo Findings", "", "## 2026-03-12", "", ...lines, ""].join("\n"));
}

describe("mcp-finding lifecycle tools", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmp = makeTempDir("mcp-finding-lifecycle-tools-");
    grantAdmin(tmp.path);
    server = makeMockServer();
    seedProject(tmp.path, "demo");

    const ctx: McpContext = {
      cortexPath: tmp.path,
      profile: "test",
      db: () => { throw new Error("unused"); },
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };

    register(server as any, ctx);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("supersede_finding marks finding as superseded", async () => {
    writeFindings(tmp.path, [
      "- Old retry strategy <!-- fid:aaaabbbb -->",
      "- New retry strategy <!-- fid:ccccdddd -->",
    ]);

    const res = parseResult(await server.call("supersede_finding", {
      project: "demo",
      finding_text: "fid:aaaabbbb",
      superseded_by: "New retry strategy",
    }));

    expect(res.ok).toBe(true);
    expect(res.data.status).toBe("superseded");

    const content = fs.readFileSync(path.join(tmp.path, "demo", "FINDINGS.md"), "utf8");
    expect(content).toContain('<!-- cortex:status "superseded" -->');
    expect(content).toContain('<!-- cortex:superseded_by "New retry strategy"');
  });

  it("retract_finding marks finding as retracted with reason", async () => {
    writeFindings(tmp.path, [
      "- Use static secret in tests <!-- fid:eeeeffff -->",
    ]);

    const res = parseResult(await server.call("retract_finding", {
      project: "demo",
      finding_text: "fid:eeeeffff",
      reason: "security policy updated",
    }));

    expect(res.ok).toBe(true);
    expect(res.data.status).toBe("retracted");
    expect(res.data.reason).toBe("security policy updated");

    const content = fs.readFileSync(path.join(tmp.path, "demo", "FINDINGS.md"), "utf8");
    expect(content).toContain('<!-- cortex:status "retracted" -->');
    expect(content).toContain('<!-- cortex:status_reason "security policy updated" -->');
  });

  it("resolve_contradiction applies requested resolution", async () => {
    writeFindings(tmp.path, [
      "- Always use feature flags <!-- fid:1111aaaa -->",
      "- Never use feature flags <!-- fid:2222bbbb -->",
    ]);

    const res = parseResult(await server.call("resolve_contradiction", {
      project: "demo",
      finding_text: "fid:1111aaaa",
      finding_text_other: "fid:2222bbbb",
      resolution: "keep_a",
    }));

    expect(res.ok).toBe(true);
    expect(res.data.finding_a.status).toBe("active");
    expect(res.data.finding_b.status).toBe("superseded");

    const content = fs.readFileSync(path.join(tmp.path, "demo", "FINDINGS.md"), "utf8");
    expect(content).toContain('<!-- cortex:status_reason "contradiction_resolved_keep_a" -->');
  });

  it("get_contradictions returns contradicted findings", async () => {
    writeFindings(tmp.path, [
      '- Contradicted item <!-- fid:abcd1234 --> <!-- cortex:status "contradicted" --> <!-- cortex:status_reason "conflicts_with" --> <!-- cortex:status_ref "Other item" -->',
      "- Active item <!-- fid:ffff0000 -->",
    ]);

    const res = parseResult(await server.call("get_contradictions", { project: "demo" }));

    expect(res.ok).toBe(true);
    expect(res.data.contradictions).toHaveLength(1);
    expect(res.data.contradictions[0].stableId).toBe("abcd1234");
    expect(res.data.contradictions[0].status_reason).toBe("conflicts_with");
    expect(res.data.contradictions[0].status_ref).toBe("Other item");
  });
});
