import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { McpContext } from "../tools/types.js";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { register } from "../tools/finding.js";

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

function seedProject(phrenPath: string, project = "demo") {
  const dir = path.join(phrenPath, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.md"), "# demo\n");
}

function writeFindings(phrenPath: string, lines: string[]) {
  const file = path.join(phrenPath, "demo", "FINDINGS.md");
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
      phrenPath: tmp.path,
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
    expect(content).toContain('<!-- phren:status "superseded" -->');
    expect(content).toContain('<!-- phren:superseded_by "New retry strategy"');
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
    expect(content).toContain('<!-- phren:status "retracted" -->');
    expect(content).toContain('<!-- phren:status_reason "security policy updated" -->');
  });

  it("rejects archived findings for lifecycle mutations", async () => {
    writeFindings(tmp.path, [
      "- Active finding <!-- fid:1111aaaa -->",
      "",
      "<!-- phren:archive:start -->",
      "## Archived 2026-03-01",
      "",
      "- Archived finding <!-- fid:deadbeef -->",
      "<!-- phren:archive:end -->",
    ]);

    const res = parseResult(await server.call("supersede_finding", {
      project: "demo",
      finding_text: "fid:deadbeef",
      superseded_by: "Replacement",
    }));

    expect(res.ok).toBe(false);
    expect(res.error).toContain("archived and read-only");

    const content = fs.readFileSync(path.join(tmp.path, "demo", "FINDINGS.md"), "utf8");
    expect(content).toContain("- Archived finding <!-- fid:deadbeef -->");
    expect(content).not.toContain("Replacement");
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
    expect(content).toContain('<!-- phren:status_reason "contradiction_resolved_keep_a" -->');
  });

  it("get_contradictions covers every tier and preserves selectors and metadata", async () => {
    writeFindings(tmp.path, [
      '- Contradicted item <!-- fid:abcd1234 --> <!-- phren:status "contradicted" --> <!-- phren:status_reason "conflicts_with" --> <!-- phren:status_ref "Other item" -->',
      "- Active item <!-- fid:ffff0000 -->",
    ]);
    const topics = path.join(tmp.path, "demo", "reference", "topics");
    fs.mkdirSync(topics, { recursive: true });
    for (const [name, fid] of [["rules.md", "aaaabbbb"], ["rules.older.md", "ccccdddd"]]) {
      fs.writeFileSync(path.join(topics, name), `## 2026-02-01\n\n- Archived contradiction <!-- fid:${fid} --> <!-- phren:status "contradicted" --> <!-- phren:status_reason "conflicts_with" --> <!-- phren:status_ref "Replacement" -->\n- Ordinary archive bullet\n`);
    }

    const res = parseResult(await server.call("get_contradictions", { project: "demo" }));
    expect(res.ok).toBe(true);
    expect(res.data.contradictions).toHaveLength(3);
    expect(res.data.contradictions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "L1", stableId: "abcd1234", date: "2026-03-12", tier: "active", file: path.join(tmp.path, "demo", "FINDINGS.md"), status_reason: "conflicts_with", status_ref: "Other item" }),
      expect.objectContaining({ id: "L1", stableId: "aaaabbbb", date: "2026-02-01", tier: "topic", file: path.join(topics, "rules.md"), status_reason: "conflicts_with", status_ref: "Replacement" }),
      expect.objectContaining({ stableId: "ccccdddd", tier: "older", file: path.join(topics, "rules.older.md") }),
    ]));
    for (const selector of ["fid:CCCCDDDD", "Archived contradiction", "archived"]) {
      const filtered = parseResult(await server.call("get_contradictions", { project: "demo", finding_text: selector }));
      expect(filtered.data.contradictions).toHaveLength(selector.startsWith("fid:") ? 1 : 2);
    }
    fs.mkdirSync(path.join(tmp.path, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(tmp.path, "profiles", "test.yaml"), "projects:\n  - demo\n");
    const all = parseResult(await server.call("get_contradictions", {}));
    expect(all.data.contradictions).toHaveLength(3);
  });
});
