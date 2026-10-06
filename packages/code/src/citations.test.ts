import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantAdmin, makeTempDir } from "../../cli/src/test-helpers.js";
import { parseCitationComment, validateFindingCitation, type FindingCitation } from "../../cli/src/content/citation.js";
import { indexProject } from "./indexer.js";
import { findingsCitingSymbol, symbolCandidates } from "./citations.js";
import { register as registerCode } from "../../cli/src/tools/code.js";
import { register as registerFinding } from "../../cli/src/tools/finding.js";
import type { McpContext } from "../../cli/src/tools/types.js";

const FIXTURES = path.join(__dirname, "__fixtures__");
const PROJECT = "fixture";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

let tmp: ReturnType<typeof makeTempDir>;
let repo: string;
let store: string;
let findingTools: Map<string, ToolHandler>;
let codeTools: Map<string, ToolHandler>;
let ctx: McpContext;

function git(...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=Fixture Author", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
}

function makeServer(tools: Map<string, ToolHandler>): McpServer {
  return {
    registerTool(name: string, _config: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
}

function findingsPath(): string {
  return path.join(store, PROJECT, "FINDINGS.md");
}

function findingsContent(): string {
  return fs.readFileSync(findingsPath(), "utf8");
}

async function addFinding(finding: string, citation?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await findingTools.get("add_finding")!({ project: PROJECT, finding, ...(citation ? { citation } : {}) });
  return JSON.parse(result.content[0].text);
}

async function codeDefinition(symbol: string): Promise<string> {
  const result = await codeTools.get("code_definition")!({ project: PROJECT, symbol });
  return result.content.map(part => part.text).join("\n");
}

/** The citation comment attached to the finding whose bullet contains `needle`. */
function citationFor(needle: string): FindingCitation | null {
  const lines = findingsContent().split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("- ") && lines[i].includes(needle)) {
      return parseCitationComment(lines[i + 1] ?? "");
    }
  }
  return null;
}

beforeEach(async () => {
  tmp = makeTempDir("code-citations-");
  repo = path.join(tmp.path, "repo");
  store = path.join(tmp.path, "store");
  fs.mkdirSync(path.join(store, ".config"), { recursive: true });
  fs.writeFileSync(path.join(store, ".config", "modules.yaml"), "version: 1\nenabled:\n  code: true\n");
  fs.cpSync(FIXTURES, repo, { recursive: true });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixtures");
  await indexProject(store, PROJECT, { repoRoot: repo });
  grantAdmin(store);
  fs.mkdirSync(path.join(store, PROJECT), { recursive: true });
  fs.writeFileSync(path.join(store, PROJECT, "summary.md"), `# ${PROJECT}\n`);

  ctx = {
    phrenPath: store,
    profile: "test",
    db: () => { throw new Error("not needed"); },
    rebuildIndex: async () => {},
    updateFileInIndex: () => {},
    withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
  };
  findingTools = new Map();
  registerFinding(makeServer(findingTools), ctx);
  codeTools = new Map();
  registerCode(makeServer(codeTools), ctx);
});

afterEach(() => {
  tmp.cleanup();
});

describe("symbol candidate extraction", () => {
  it("finds bare, dotted and called names in order", () => {
    expect(symbolCandidates("Point.length feeds measure() and double")).toEqual([
      "Point.length", "feeds", "measure", "and", "double",
    ]);
  });
});

describe("symbol citations on write", () => {
  it("auto-attaches the unique symbol the finding names", async () => {
    const result = await addFinding("measure is called after double");
    expect(result.ok).toBe(true);
    expect(findingsContent()).toContain("measure is called after double");
    const citation = citationFor("measure is called after double");
    expect(citation?.symbol).toBe("measure");
    expect(citation?.symbol_unresolved).toBeUndefined();
  });

  it("auto-attaches a container-qualified method", async () => {
    await addFinding("Point.length returns the distance from the origin");
    expect(citationFor("Point.length returns")?.symbol).toBe("Point.length");
  });

  it("does not attach an ambiguous name", async () => {
    fs.writeFileSync(path.join(repo, "typescript", "noise.ts"), "const length = 3;\nexport function useLength(): number {\n  return length;\n}\n");
    git("add", "-A");
    await indexProject(store, PROJECT, { repoRoot: repo });

    await addFinding("length should be renamed");
    const citation = citationFor("length should be renamed");
    expect(citation).not.toBeNull();
    expect(citation?.symbol).toBeUndefined();
  });

  it("does not attach a name shorter than four characters", async () => {
    await addFinding("add is used twice here");
    expect(citationFor("add is used twice")?.symbol).toBeUndefined();
  });

  it("stores a resolving explicit symbol citation", async () => {
    await addFinding("Notes about the double helper", { name: "double" });
    const citation = citationFor("Notes about the double helper");
    expect(citation?.symbol).toBe("double");
    expect(citation?.symbol_unresolved).toBeUndefined();
    expect(validateFindingCitation(citation!)).toBe(true);
  });

  it("still takes the deprecated citation symbol field until 0.3.1", async () => {
    await addFinding("Older agents cite the double helper", { symbol: "double" });
    const citation = citationFor("Older agents cite the double helper");
    expect(citation?.symbol).toBe("double");
    expect(citation?.name).toBeUndefined();
  });

  it("stores an unresolved explicit symbol citation and marks it", async () => {
    await addFinding("Mentions a symbol the index does not know", { name: "NoSuchSymbol" });
    const citation = citationFor("Mentions a symbol the index");
    expect(citation?.symbol).toBe("NoSuchSymbol");
    expect(citation?.symbol_unresolved).toBe(true);
    expect(validateFindingCitation(citation!)).toBe(false);
  });

  it("stores an explicit symbol without an index to validate against", async () => {
    fs.mkdirSync(path.join(store, "plain"), { recursive: true });
    fs.writeFileSync(path.join(store, "plain", "summary.md"), "# plain\n");
    const result = await findingTools.get("add_finding")!({
      project: "plain",
      finding: "A note about an unindexed project",
      citation: { symbol: "Widget" },
    });
    expect(JSON.parse(result.content[0].text).ok).toBe(true);
    const content = fs.readFileSync(path.join(store, "plain", "FINDINGS.md"), "utf8");
    const lines = content.split("\n");
    const index = lines.findIndex(line => line.startsWith("- ") && line.includes("unindexed project"));
    const citation = parseCitationComment(lines[index + 1] ?? "");
    expect(citation?.symbol).toBe("Widget");
    expect(citation?.symbol_unresolved).toBeUndefined();
  });
});

describe("findings that cite a symbol", () => {
  it("code_definition lists the citing finding after the snippet", async () => {
    await addFinding("measure is called after double");
    const text = await codeDefinition("measure");
    expect(text).toMatch(/Findings\n- \[L\d+\|fid:[a-z0-9]{8}\] measure is called after double/);
    expect(text.indexOf("Findings")).toBeGreaterThan(text.indexOf("return point.length()"));
  });

  it("matches a citation across the Foo.bar and bar() forms", async () => {
    await addFinding("Point.length is the radius", { name: "Point.length" });
    expect(findingsCitingSymbol(store, PROJECT, "length()")).toHaveLength(1);
    expect(findingsCitingSymbol(store, PROJECT, "Point.length")).toHaveLength(1);
    expect(findingsCitingSymbol(store, PROJECT, "double")).toHaveLength(0);
  });
});
