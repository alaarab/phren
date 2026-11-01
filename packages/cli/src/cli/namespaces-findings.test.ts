import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FINDINGS = `# demo Findings

## 2026-03-01

- The cache is shared across workers.
- Each worker has its own cache.
`;

const USAGE = [
  "Usage:",
  '  phren finding add <project> "<text>"',
  '  phren finding remove <project> "<text>"',
  '  phren finding supersede <project> "<text>" --by "<newer guidance>"',
  '  phren finding retract <project> "<text>" --reason "<reason>"',
  "  phren finding contradictions [project]",
  '  phren finding resolve <project> "<finding_text>" "<other_text>" <keep_a|keep_b|keep_both|retract_both>',
].join("\n");

const today = () => new Date().toISOString().slice(0, 10);

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

describe("phren finding", () => {
  let root = "";
  let phren = "";
  let findingsPath = "";
  let handleFindingNamespace: (args: string[]) => Promise<void>;
  const originalPhrenPath = process.env.PHREN_PATH;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "phren-finding-"));
    phren = path.join(root, ".phren");
    findingsPath = path.join(phren, "demo", "FINDINGS.md");
    // `global/` is an install marker, so PHREN_PATH resolves to this temp store.
    fs.mkdirSync(path.join(phren, "global"), { recursive: true });
    fs.mkdirSync(path.join(phren, "demo"), { recursive: true });
    process.env.PHREN_PATH = phren;
    // Load after PHREN_PATH points at the temp store, since getPhrenPath caches
    // its first answer for the life of the module.
    ({ handleFindingNamespace } = await import("./namespaces-findings.js"));
  });

  beforeEach(() => {
    fs.writeFileSync(findingsPath, FINDINGS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (originalPhrenPath === undefined) delete process.env.PHREN_PATH;
    else process.env.PHREN_PATH = originalPhrenPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function run(...args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...data) => { out.push(data.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...data) => { err.push(data.join(" ")); });
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new ExitCalled(typeof code === "number" ? code : 0);
    }) as never);
    let code = 0;
    try {
      await handleFindingNamespace(args);
    } catch (error: unknown) {
      if (error instanceof ExitCalled) code = error.code;
      else throw error;
    } finally {
      vi.restoreAllMocks();
    }
    return { out: out.join("\n"), err: err.join("\n"), code };
  }

  const read = () => fs.readFileSync(findingsPath, "utf8");
  const lines = () => read().split("\n");

  it("prints the finding subcommands for help and refuses an unknown one", async () => {
    const help = await run();
    expect(help).toEqual({ out: USAGE, err: "", code: 0 });

    expect(await run("bogus")).toEqual({ out: USAGE, err: "Unknown finding subcommand: bogus", code: 1 });
  });

  it("lists a project's findings with their index, date and text", async () => {
    expect(await run("list", "demo")).toEqual({
      out: [
        "- [L1] 2026-03-01: The cache is shared across workers.",
        "- [L2] 2026-03-01: Each worker has its own cache.",
      ].join("\n"),
      err: "",
      code: 0,
    });
  });

  it("says a project has no findings, and rejects an invalid project name", async () => {
    fs.rmSync(findingsPath);
    expect(await run("list", "demo")).toEqual({ out: 'No findings found for "demo".', err: "", code: 0 });

    expect(await run("list", "Bad Name")).toEqual({
      out: "",
      err: 'Project name "Bad Name" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").',
      code: 1,
    });
  });

  it("adds a finding beneath today's heading in FINDINGS.md", async () => {
    const day = today();
    const result = await run("add", "demo", "Caches must be cleared between runs.");

    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toMatch(new RegExp(
      `^Added finding to demo: - Caches must be cleared between runs\\. <!-- fid:[a-z0-9]{8} --> <!-- created: ${day} --> <!-- phren:status "active" --> <!-- phren:status_updated "${day}" --> \\(with citation metadata\\)$`,
    ));
    expect(lines()).toContain(`## ${day}`);
    expect(lines().find(line => line.startsWith("- Caches must be cleared between runs. ")))
      .toMatch(new RegExp(
        `^- Caches must be cleared between runs\\. <!-- fid:[a-z0-9]{8} --> <!-- created: ${day} --> <!-- phren:status "active" --> <!-- phren:status_updated "${day}" -->$`,
      ));
  });

  it("removes the matching finding and leaves the rest of the file", async () => {
    expect(await run("remove", "demo", "The cache is shared")).toEqual({
      out: "Removed from demo: - The cache is shared across workers.",
      err: "",
      code: 0,
    });
    expect(lines()).toEqual(["# demo Findings", "", "## 2026-03-01", "", "- Each worker has its own cache.", ""]);
  });

  it("marks a finding superseded when --by= names the replacement", async () => {
    const day = today();
    expect(await run("supersede", "demo", "The cache is shared across workers.", "--by=Retry twice before failing.")).toEqual({
      out: 'Finding superseded: "The cache is shared across workers." -> "Retry twice before failing."',
      err: "",
      code: 0,
    });
    expect(lines()).toEqual([
      "# demo Findings",
      "",
      "## 2026-03-01",
      "",
      `- The cache is shared across workers. <!-- phren:superseded_by "Retry twice before failing." ${day} --> <!-- phren:status "superseded" --> <!-- phren:status_updated "${day}" --> <!-- phren:status_reason "superseded_by" --> <!-- phren:status_ref "Retry twice before failing." -->`,
      "- Each worker has its own cache.",
      "",
    ]);
  });

  it("refuses supersede without --by and leaves FINDINGS.md untouched", async () => {
    expect(await run("supersede", "demo", "The cache is shared across workers.")).toEqual({
      out: "",
      err: 'Usage: phren finding supersede <project> "<text>" --by "<newer guidance>"',
      code: 1,
    });
    expect(read()).toBe(FINDINGS);
  });

  it("retracts a finding with --reason and records the reason", async () => {
    const day = today();
    expect(await run("retract", "demo", "Each worker has its own cache.", "--reason", "stale docs")).toEqual({
      out: 'Finding retracted: "Each worker has its own cache." (reason: stale docs)',
      err: "",
      code: 0,
    });
    expect(lines()).toEqual([
      "# demo Findings",
      "",
      "## 2026-03-01",
      "",
      "- The cache is shared across workers.",
      `- Each worker has its own cache. <!-- phren:status "retracted" --> <!-- phren:status_updated "${day}" --> <!-- phren:status_reason "stale docs" -->`,
      "",
    ]);
  });

  it("lists unresolved contradictions, or says there are none", async () => {
    fs.writeFileSync(findingsPath, `# demo Findings

## 2026-03-01

- The cache is shared across workers. <!-- phren:status "contradicted" --> <!-- phren:status_ref "Each worker has its own cache." -->
- Each worker has its own cache.
`);

    expect(await run("contradictions", "demo")).toEqual({
      out: [
        "1 unresolved contradiction(s):",
        "",
        "[demo] 2026-03-01  L1",
        "  The cache is shared across workers.",
        "  contradicts: Each worker has its own cache.",
        "",
      ].join("\n"),
      err: "",
      code: 0,
    });

    fs.writeFileSync(findingsPath, FINDINGS);
    expect(await run("contradictions", "demo")).toEqual({ out: "No unresolved contradictions found.", err: "", code: 0 });
  });

  it("rejects an unknown resolution, then applies keep_a to both findings", async () => {
    const day = today();
    expect(await run("resolve", "demo", "The cache is shared across workers.", "Each worker has its own cache.", "keep_bothish")).toEqual({
      out: "",
      err: 'Invalid resolution "keep_bothish". Valid values: keep_a, keep_b, keep_both, retract_both',
      code: 1,
    });
    expect(read()).toBe(FINDINGS);

    expect(await run("resolve", "demo", "The cache is shared across workers.", "Each worker has its own cache.", "keep_a")).toEqual({
      out: [
        'Resolved contradiction in "demo" with "keep_a".',
        "  finding_a: The cache is shared across workers. → active",
        "  finding_b: Each worker has its own cache. → superseded",
      ].join("\n"),
      err: "",
      code: 0,
    });
    expect(lines()).toEqual([
      "# demo Findings",
      "",
      "## 2026-03-01",
      "",
      `- The cache is shared across workers. <!-- phren:status "active" --> <!-- phren:status_updated "${day}" --> <!-- phren:status_reason "contradiction_resolved_keep_a" --> <!-- phren:status_ref "Each worker has its own cache." -->`,
      `- Each worker has its own cache. <!-- phren:superseded_by "The cache is shared across workers." ${day} --> <!-- phren:status "superseded" --> <!-- phren:status_updated "${day}" --> <!-- phren:status_reason "contradiction_resolved_keep_a" --> <!-- phren:status_ref "The cache is shared across workers." -->`,
      "",
    ]);
  });
});
