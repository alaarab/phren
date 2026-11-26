import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { PhrenError } from "../phren-core.js";
import { resolveFindingContradiction, retractFinding, supersedeFinding } from "../finding/lifecycle.js";

const PROJECT = "demo";
const day = () => new Date().toISOString().slice(0, 10);

describe("finding lifecycle on archived findings", () => {
  let tmp: { path: string; cleanup: () => void };
  let findingsFile: string;
  let topicFile: string;
  let olderFile: string;

  beforeEach(() => {
    tmp = makeTempDir("finding-lifecycle-archive-");
    const topics = path.join(tmp.path, PROJECT, "reference", "topics");
    fs.mkdirSync(topics, { recursive: true });
    findingsFile = path.join(tmp.path, PROJECT, "FINDINGS.md");
    topicFile = path.join(topics, "retries.md");
    olderFile = path.join(topics, "retries.older.md");
  });

  afterEach(() => tmp.cleanup());

  it("reaches the archives only when FINDINGS.md has no match, by fid or full text, and leaves FINDINGS.md bytes alone", () => {
    // A run of blank lines and no final newline: any FINDINGS.md write would normalise both.
    const findings = "# demo Findings\n\n## 2026-03-12\n\n- Shared text in two tiers <!-- fid:aaaa0001 -->\n\n\n\n- Live only <!-- fid:aaaa0002 -->";
    const topic = "## Archived 2026-02-01\n\n- Shared text in two tiers <!-- fid:bbbb0001 -->\n- Archived finding about retry budgets <!-- fid:bbbb0002 -->\n";
    fs.writeFileSync(findingsFile, findings);
    fs.writeFileSync(topicFile, topic);

    const partial = retractFinding(tmp.path, PROJECT, "finding about retry", "stale");
    expect(partial).toMatchObject({ ok: false, code: PhrenError.NOT_FOUND });

    const archived = retractFinding(tmp.path, PROJECT, "Archived finding about retry budgets", "stale");
    expect(archived).toMatchObject({ ok: true, data: { tier: "topic", file: topicFile, finding: "Archived finding about retry budgets" } });
    expect(fs.readFileSync(findingsFile, "utf8")).toBe(findings);
    expect(fs.readFileSync(topicFile, "utf8")).toBe(topic.replace(
      "- Archived finding about retry budgets <!-- fid:bbbb0002 -->",
      `- Archived finding about retry budgets <!-- fid:bbbb0002 --> <!-- phren:status "retracted" --> <!-- phren:status_updated "${day()}" --> <!-- phren:status_reason "stale" -->`,
    ));

    const shared = retractFinding(tmp.path, PROJECT, "Shared text in two tiers", "stale");
    expect(shared).toMatchObject({ ok: true, data: { tier: "active", file: findingsFile } });
    expect(fs.readFileSync(findingsFile, "utf8")).toContain('- Shared text in two tiers <!-- fid:aaaa0001 --> <!-- phren:status "retracted" -->');
    expect(fs.readFileSync(topicFile, "utf8")).toContain("- Shared text in two tiers <!-- fid:bbbb0001 -->\n");
  });

  it("resolves a contradiction between a FINDINGS.md finding and an .older.md finding on the same line number", () => {
    // Both bullets sit on line 5 of their files, so telling them apart takes the file as well as the line.
    fs.writeFileSync(findingsFile, "# demo Findings\n\n## 2026-03-12\n\n- Retry twice before failing <!-- fid:aaaa0001 -->\n");
    const older = '# retries (older archive)\n\n## Archived 2026-01-01\n\n- Never retry a failed write <!-- fid:cccc0001 --> <!-- conflicts_with: "Retry twice before failing" --> <!-- phren:status "contradicted" -->\n- Untouched neighbour\n';
    fs.writeFileSync(olderFile, older);

    const result = resolveFindingContradiction(tmp.path, PROJECT, "fid:aaaa0001", "Never retry a failed write", "keep_a");
    expect(result).toMatchObject({
      ok: true,
      data: {
        finding_a: { text: "Retry twice before failing", status: "active", tier: "active", file: findingsFile },
        finding_b: { text: "Never retry a failed write", status: "superseded", tier: "older", file: olderFile },
      },
    });
    expect(fs.readFileSync(findingsFile, "utf8")).toBe(
      `# demo Findings\n\n## 2026-03-12\n\n- Retry twice before failing <!-- fid:aaaa0001 --> <!-- phren:status "active" --> <!-- phren:status_updated "${day()}" --> <!-- phren:status_reason "contradiction_resolved_keep_a" --> <!-- phren:status_ref "Never retry a failed write" -->\n`,
    );
    expect(fs.readFileSync(olderFile, "utf8")).toBe(older.replace(
      /^- Never retry.*$/m,
      `- Never retry a failed write <!-- fid:cccc0001 --> <!-- phren:superseded_by "Retry twice before failing" ${day()} --> <!-- phren:status "superseded" --> <!-- phren:status_updated "${day()}" --> <!-- phren:status_reason "contradiction_resolved_keep_a" --> <!-- phren:status_ref "Retry twice before failing" -->`,
    ));
  });

  it("supersedes with a fid: that names a finding in any tier, and refuses one that names nothing", () => {
    const findings = "# demo Findings\n\n## 2026-03-12\n\n- Use direct SQL <!-- fid:aaaa0001 -->\n";
    fs.writeFileSync(findingsFile, findings);
    fs.writeFileSync(topicFile, "- [decision] Use the query builder everywhere <!-- fid:bbbb0001 -->\n");

    expect(supersedeFinding(tmp.path, PROJECT, "fid:aaaa0001", "fid:ffff9999")).toMatchObject({ ok: false, code: PhrenError.NOT_FOUND });
    expect(fs.readFileSync(findingsFile, "utf8")).toBe(findings);

    const result = supersedeFinding(tmp.path, PROJECT, "fid:aaaa0001", "fid:bbbb0001");
    expect(result).toMatchObject({ ok: true, data: { superseded_by: "[decision] Use the query builder everywhere", tier: "active" } });
    expect(fs.readFileSync(findingsFile, "utf8")).toContain('<!-- phren:superseded_by "[decision] Use the query builder everywhere"');
  });
});
