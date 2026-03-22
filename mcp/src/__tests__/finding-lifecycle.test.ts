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
} from "../finding/lifecycle.js";

const PROJECT = "demo";

function seedProject(phrenPath: string): string {
  const dir = path.join(phrenPath, PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.md"), "# demo\n");
  return dir;
}

function findingsPath(phrenPath: string): string {
  return path.join(phrenPath, PROJECT, "FINDINGS.md");
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
      '- Prefer pooled DB connections <!-- created: 2026-03-10 --> <!-- phren:status "superseded" --> <!-- phren:status_reason "new benchmark" --> <!-- phren:status_ref "Use pgBouncer" -->';

    const parsed = parseFindingLifecycle(line);
    expect(parsed.status).toBe("superseded");
    expect(parsed.status_updated).toBe("2026-03-10");
    expect(parsed.status_reason).toBe("new benchmark");
    expect(parsed.status_ref).toBe("Use pgBouncer");
  });

  it("parses legacy superseded_by and conflicts_with comments", () => {
    const superseded = '- Old approach <!-- phren:superseded_by "New approach" 2026-03-11 -->';
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

    expect(comments).toContain('phren:status "retracted"');
    expect(comments).toContain('phren:status_updated "2026-03-12"');
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
    expect(content).toContain('<!-- phren:superseded_by "Use query builder"');
    expect(content).toContain('<!-- phren:status "superseded" -->');
    expect(content).toContain('<!-- phren:status_reason "superseded_by" -->');
  });

  it("refuses to mutate archived findings", () => {
    fs.writeFileSync(
      findingsPath(tmp.path),
      [
        "# demo Findings",
        "",
        "## 2026-03-12",
        "",
        "- Active finding <!-- fid:aaaabbbb -->",
        "",
        "<!-- phren:archive:start -->",
        "## Archived 2026-03-01",
        "",
        "- Archived finding <!-- fid:deadbeef -->",
        "<!-- phren:archive:end -->",
        "",
      ].join("\n"),
    );

    const supersede = supersedeFinding(tmp.path, PROJECT, "fid:deadbeef", "replacement");
    expect(supersede.ok).toBe(false);
    if (!supersede.ok) expect(supersede.code).toBe("VALIDATION_ERROR");

    const retract = retractFinding(tmp.path, PROJECT, "fid:deadbeef", "bad history");
    expect(retract.ok).toBe(false);
    if (!retract.ok) expect(retract.code).toBe("VALIDATION_ERROR");

    const contradiction = resolveFindingContradiction(
      tmp.path,
      PROJECT,
      "fid:aaaabbbb",
      "fid:deadbeef",
      "keep_a",
    );
    expect(contradiction.ok).toBe(false);
    if (!contradiction.ok) expect(contradiction.code).toBe("VALIDATION_ERROR");

    const content = fs.readFileSync(findingsPath(tmp.path), "utf8");
    expect(content).toContain("- Archived finding <!-- fid:deadbeef -->");
    expect(content).not.toContain("phren:superseded_by");
    expect(content).not.toContain('phren:status "retracted"');
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
    expect(content).toContain('<!-- phren:status "retracted" -->');
    expect(content).toContain('<!-- phren:status_reason "rotation policy changed" -->');
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
    expect(content).toContain('<!-- phren:status_reason "contradiction_resolved_keep_b" -->');
    expect(content).toContain('<!-- phren:superseded_by "Never use Redis pubsub at scale"');
  });
});
