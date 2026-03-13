import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import {
  buildLifecycleComments,
  parseFindingLifecycle,
  retractFinding,
  resolveFindingContradiction,
  stripLifecycleComments,
  supersedeFinding,
} from "../finding-lifecycle.js";

const PROJECT = "demo";

function seedProject(cortexPath: string): string {
  const dir = path.join(cortexPath, PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.md"), "# demo\n");
  return dir;
}

function findingsPath(cortexPath: string): string {
  return path.join(cortexPath, PROJECT, "FINDINGS.md");
}

describe("finding-lifecycle", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("finding-lifecycle-");
    seedProject(tmp.path);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("parses lifecycle status from modern comments and falls back status_updated to created date", () => {
    const line =
      '- Prefer pooled DB connections <!-- created: 2026-03-10 --> <!-- cortex:status "superseded" --> <!-- cortex:status_reason "new benchmark" --> <!-- cortex:status_ref "Use pgBouncer" -->';

    const parsed = parseFindingLifecycle(line);
    expect(parsed.status).toBe("superseded");
    expect(parsed.status_updated).toBe("2026-03-10");
    expect(parsed.status_reason).toBe("new benchmark");
    expect(parsed.status_ref).toBe("Use pgBouncer");
  });

  it("parses legacy superseded_by and conflicts_with comments", () => {
    const superseded = '- Old approach <!-- cortex:superseded_by "New approach" 2026-03-11 -->';
    const conflict = '- A config <!-- conflicts_with: "B config" -->';

    const supersededParsed = parseFindingLifecycle(superseded);
    const conflictParsed = parseFindingLifecycle(conflict);

    expect(supersededParsed.status).toBe("superseded");
    expect(supersededParsed.status_reason).toBe("superseded_by");
    expect(supersededParsed.status_ref).toBe("New approach");
    expect(supersededParsed.status_updated).toBe("2026-03-11");

    expect(conflictParsed.status).toBe("contradicted");
    expect(conflictParsed.status_reason).toBe("conflicts_with");
    expect(conflictParsed.status_ref).toBe("B config");
  });

  it("builds and strips lifecycle comments", () => {
    const comments = buildLifecycleComments({
      status: "retracted",
      status_updated: "2026-03-12",
      status_reason: "bad data",
      status_ref: "Issue #9",
    });

    const line = `- Finding text ${comments}`;
    const stripped = stripLifecycleComments(line);

    expect(comments).toContain('cortex:status "retracted"');
    expect(comments).toContain('cortex:status_updated "2026-03-12"');
    expect(stripped).toBe("- Finding text");
  });

  it("supersedeFinding writes superseded lifecycle metadata", () => {
    fs.writeFileSync(
      findingsPath(tmp.path),
      [
        "# demo Findings",
        "",
        "## 2026-03-12",
        "",
        "- Use direct SQL queries <!-- fid:aaaabbbb -->",
        "- Use query builder <!-- fid:ccccdddd -->",
        "",
      ].join("\n"),
    );

    const result = supersedeFinding(tmp.path, PROJECT, "fid:aaaabbbb", "Use query builder");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("superseded");

    const content = fs.readFileSync(findingsPath(tmp.path), "utf8");
    expect(content).toContain('<!-- cortex:superseded_by "Use query builder"');
    expect(content).toContain('<!-- cortex:status "superseded" -->');
    expect(content).toContain('<!-- cortex:status_reason "superseded_by" -->');
  });

  it("retractFinding writes retracted lifecycle metadata", () => {
    fs.writeFileSync(
      findingsPath(tmp.path),
      [
        "# demo Findings",
        "",
        "## 2026-03-12",
        "",
        "- Cache JWT keys forever <!-- fid:eeeeffff -->",
        "",
      ].join("\n"),
    );

    const result = retractFinding(tmp.path, PROJECT, "fid:eeeeffff", "rotation policy changed");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("retracted");

    const content = fs.readFileSync(findingsPath(tmp.path), "utf8");
    expect(content).toContain('<!-- cortex:status "retracted" -->');
    expect(content).toContain('<!-- cortex:status_reason "rotation policy changed" -->');
  });

  it("resolveFindingContradiction updates statuses based on resolution", () => {
    fs.writeFileSync(
      findingsPath(tmp.path),
      [
        "# demo Findings",
        "",
        "## 2026-03-12",
        "",
        "- Always use Redis pubsub <!-- fid:1111aaaa -->",
        "- Never use Redis pubsub at scale <!-- fid:2222bbbb -->",
        "",
      ].join("\n"),
    );

    const result = resolveFindingContradiction(
      tmp.path,
      PROJECT,
      "fid:1111aaaa",
      "fid:2222bbbb",
      "keep_b",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.finding_a.status).toBe("superseded");
    expect(result.data.finding_b.status).toBe("active");

    const content = fs.readFileSync(findingsPath(tmp.path), "utf8");
    expect(content).toContain('<!-- cortex:status_reason "contradiction_resolved_keep_b" -->');
    expect(content).toContain('<!-- cortex:superseded_by "Never use Redis pubsub at scale"');
  });
});
