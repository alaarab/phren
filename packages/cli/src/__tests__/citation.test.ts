import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { makeTempDir } from "../test-helpers.js";
import {
  buildCitationComment,
  checkFindingCitation,
  validateFindingCitation,
  parseCitationComment,
  buildSourceComment,
  parseSourceComment,
  isFindingProvenanceSource,
  filterTrustedFindings,
  filterTrustedFindingsDetailed,
  type FindingCitation,
  type FindingProvenance,
} from "../content/citation.js";

// ── isFindingProvenanceSource ──────────────────────────────────────────────

describe("isFindingProvenanceSource", () => {
  it("accepts all valid sources", () => {
    for (const s of ["human", "agent", "hook", "extract", "consolidation", "unknown"]) {
      expect(isFindingProvenanceSource(s)).toBe(true);
    }
    for (const s of ["robot", "", undefined]) {
      expect(isFindingProvenanceSource(s)).toBe(false);
    }
  });
});

// ── buildCitationComment / parseCitationComment ────────────────────────────

describe("citation comment round-trip", () => {
  it("round-trips a full citation", () => {
    const citation: FindingCitation = {
      created_at: "2025-06-01",
      repo: "/tmp/repo",
      file: "src/main.ts",
      line: 42,
      commit: "abc123",
      supersedes: "old pattern",
      task_item: "Fix the login bug",
    };
    const comment = buildCitationComment(citation);
    expect(comment).toContain("phren:cite");
    expect(comment).toContain("2025-06-01");

    const parsed = parseCitationComment(comment);
    expect(parsed).not.toBeNull();
    expect(parsed!.created_at).toBe("2025-06-01");
    expect(parsed!.repo).toBe("/tmp/repo");
    expect(parsed!.file).toBe("src/main.ts");
    expect(parsed!.line).toBe(42);
    expect(parsed!.commit).toBe("abc123");
    expect(parsed!.supersedes).toBe("old pattern");
    expect(parsed!.task_item).toBe("Fix the login bug");

    const minimal = parseCitationComment(buildCitationComment({ created_at: "2025-01-01" }));
    expect(minimal).toEqual({ created_at: "2025-01-01" });
  });
});

describe("parseCitationComment edge cases", () => {
  it("returns null for non-citation lines", () => {
    expect(parseCitationComment("- just a finding")).toBeNull();
    expect(parseCitationComment("<!-- some other comment -->")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseCitationComment("<!-- phren:cite not-json -->")).toBeNull();
    expect(parseCitationComment('<!-- phren:cite [1,2,3] -->')).toBeNull();
    expect(parseCitationComment('<!-- phren:cite "string" -->')).toBeNull();
  });

  it("returns null when created_at is missing", () => {
    expect(parseCitationComment('<!-- phren:cite {"file":"x.ts"} -->')).toBeNull();
  });

  it("ignores non-string repo/file/commit and non-number line", () => {
    const comment = '<!-- phren:cite {"created_at":"2025-01-01","repo":123,"file":true,"commit":null,"line":"notnum"} -->';
    const parsed = parseCitationComment(comment);
    expect(parsed).not.toBeNull();
    expect(parsed!.repo).toBeUndefined();
    expect(parsed!.file).toBeUndefined();
    expect(parsed!.commit).toBeUndefined();
    expect(parsed!.line).toBeUndefined();
  });
});

// ── buildSourceComment / parseSourceComment ────────────────────────────────

describe("source comment round-trip", () => {
  it("round-trips all fields", () => {
    const prov: FindingProvenance = {
      source: "agent",
      machine: "ci-box",
      actor: "bot",
      tool: "cursor",
      model: "claude-3",
      session_id: "s-abc",
      scope: "project",
    };
    const comment = buildSourceComment(prov);
    const parsed = parseSourceComment(`- Finding ${comment}`);
    expect(parsed).toEqual(prov);
  });

  it("returns empty string for empty provenance", () => {
    expect(buildSourceComment({})).toBe("");
  });

  it("parses partial provenance", () => {
    const comment = buildSourceComment({ source: "hook", tool: "copilot" });
    const parsed = parseSourceComment(`- ${comment}`);
    expect(parsed!.source).toBe("hook");
    expect(parsed!.tool).toBe("copilot");
    expect(parsed!.machine).toBeUndefined();
  });

  it("returns null for lines without source comment", () => {
    expect(parseSourceComment("- plain finding")).toBeNull();
    // A source comment with no recognizable fields
    expect(parseSourceComment("<!-- source: -->")).toBeNull();
  });

  it("handles scope with empty string as shared", () => {
    const parsed = parseSourceComment('- Finding <!-- source:agent scope:"" -->');
    expect(parsed).not.toBeNull();
    expect(parsed!.scope).toBe("shared");
  });
});

// ── filterTrustedFindings ──────────────────────────────────────────────────

describe("filterTrustedFindings", () => {
  it("strips archive blocks", () => {
    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# Findings",
      "",
      `## ${today}`,
      "- Active finding",
      "<!-- phren:archive:start -->",
      "- Archived old thing",
      "<!-- phren:archive:end -->",
      "",
    ].join("\n");

    const result = filterTrustedFindings(content, 120);
    expect(result).toContain("Active finding");
    expect(result).not.toContain("Archived old thing");
  });

  it("skips non-bullet lines", () => {
    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# Findings",
      "",
      `## ${today}`,
      "Some random paragraph text",
      "- Actual finding",
      "",
    ].join("\n");

    const result = filterTrustedFindings(content, 120);
    expect(result).toContain("Actual finding");
    expect(result).not.toContain("random paragraph");
  });
});

describe("filterTrustedFindingsDetailed", () => {
  it("reduces confidence for uncited findings", () => {
    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# Findings",
      "",
      `## ${today}`,
      "- Uncited finding",
      "",
    ].join("\n");

    // Uncited findings get *0.8, so with minConfidence=0.9 it should be filtered
    const { content: filtered } = filterTrustedFindingsDetailed(content, {
      ttlDays: 365,
      minConfidence: 0.9,
    });
    expect(filtered).not.toContain("Uncited finding");
  });

  it("uses inline created date when no heading date", () => {
    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# Findings",
      "",
      `- Fresh finding <!-- created: ${today} -->`,
      "",
    ].join("\n");

    const result = filterTrustedFindings(content, 120);
    expect(result).toContain("Fresh finding");
  });

  it("uses citation created_at when no heading or inline date", () => {
    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# Findings",
      "",
      "- Cited finding",
      `<!-- phren:cite {"created_at":"${today}"} -->`,
      "",
    ].join("\n");

    const result = filterTrustedFindings(content, 120);
    expect(result).toContain("Cited finding");
  });

  it("applies type-specific decay for context findings", () => {
    // "context" has maxAgeDays: 30 (contextual facts decay fast), so a
    // 40-day-old context finding should be filtered even though the general
    // TTL below is nowhere close to expiring it.
    // (This used to test "observation", which had a maxAgeDays: 14 row —
    // that tag was dropped from FINDING_TYPE_DECAY because nothing ever
    // produced it; "context" is the tag phren's auto-detector actually
    // writes for this kind of short-lived note.)
    const d = new Date();
    d.setDate(d.getDate() - 40);
    const date = d.toISOString().slice(0, 10);
    const content = [
      "# Findings",
      "",
      `## ${date}`,
      "- [context] Temp debug log was present",
      "",
    ].join("\n");

    const { content: filtered, issues } = filterTrustedFindingsDetailed(content, {
      ttlDays: 365,
    });
    expect(filtered).not.toContain("Temp debug log");
    expect(issues.some((i) => i.reason === "stale")).toBe(true);
  });

  it("decisions never decay below floor", () => {
    // Decisions have maxAgeDays: Infinity and floor 0.6.
    // At 200 days, base confidence is d120=0.45, but decision floor lifts to 0.6.
    // Without citation (*0.8) and unknown source, effective = 0.48.
    // Use minConfidence below that to verify the floor is applied.
    const d = new Date();
    d.setDate(d.getDate() - 200);
    const date = d.toISOString().slice(0, 10);
    const content = [
      "# Findings",
      "",
      `## ${date}`,
      "- [decision] We chose PostgreSQL over MySQL",
      "",
    ].join("\n");

    const { content: filtered } = filterTrustedFindingsDetailed(content, {
      ttlDays: 365,
      minConfidence: 0.4,
    });
    expect(filtered).toContain("chose PostgreSQL");
  });

  it("keeps a long-lived type past the global TTL, and still expires it past its own max age", () => {
    // pattern and pitfall live 365 days and a decision forever; the default TTL is 120.
    const daysAgo = (days: number) => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); };
    const content = (days: number) => [
      "# Findings",
      "",
      `## ${daysAgo(days)}`,
      "- [pattern] Batch the index writes in one transaction",
      "- [decision] We chose PostgreSQL over MySQL",
      "- Untyped note about the build",
      "- Never strip [decision] markers from the export",
      "",
    ].join("\n");

    // Staleness alone: confidence is not what this checks.
    const kept = filterTrustedFindingsDetailed(content(200), { ttlDays: 120, minConfidence: 0 });
    expect(kept.content).toContain("Batch the index writes");
    expect(kept.content).toContain("chose PostgreSQL");
    expect(kept.content).not.toContain("Untyped note");
    // A type named inside the text is not the finding's type.
    expect(kept.content).not.toContain("Never strip");

    const expired = filterTrustedFindingsDetailed(content(400), { ttlDays: 120, minConfidence: 0 });
    expect(expired.content).not.toContain("Batch the index writes");
    expect(expired.content).toContain("chose PostgreSQL");
  });
});

// ── checkFindingCitation ───────────────────────────────────────────────────

describe("checkFindingCitation", () => {
  let repo: { path: string; cleanup: () => void };
  let first: string;
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo.path, encoding: "utf8" }).trim();
  const cite = (extra: Partial<FindingCitation>): FindingCitation => ({ created_at: new Date().toISOString(), repo: repo.path, ...extra });

  beforeEach(() => {
    repo = makeTempDir("phren-cite-states-");
    git("init", "-q");
    fs.writeFileSync(path.join(repo.path, "a.ts"), "one\ntwo\nthree\n");
    git("add", "-A");
    git("commit", "-qm", "first");
    first = git("rev-parse", "HEAD");
  });

  afterEach(() => repo.cleanup());

  it("is valid when the cited line still comes from the cited commit", () => {
    expect(checkFindingCitation(cite({ commit: first, file: "a.ts", line: 2 }))).toBe("valid");
    expect(checkFindingCitation(cite({ commit: first }))).toBe("valid");
  });

  it("is drifted when the cited line changed since the commit or is past the end", () => {
    fs.writeFileSync(path.join(repo.path, "a.ts"), "one\nTWO\nthree\n");
    git("commit", "-qam", "second");
    expect(checkFindingCitation(cite({ commit: first, file: "a.ts", line: 2 }))).toBe("drifted");
    expect(checkFindingCitation(cite({ commit: first, file: "a.ts", line: 99 }))).toBe("drifted");
    expect(validateFindingCitation(cite({ commit: first, file: "a.ts", line: 2 }))).toBe(false);
  });

  it("is broken when the repo does not know the commit or the file is gone", () => {
    expect(checkFindingCitation(cite({ commit: "0123456789abcdef0123456789abcdef01234567", file: "a.ts", line: 1 }))).toBe("broken");
    expect(checkFindingCitation(cite({ commit: first, file: "gone.ts", line: 1 }))).toBe("broken");
    expect(validateFindingCitation(cite({ commit: first, file: "gone.ts" }))).toBe(false);
  });

  it("is unverifiable with nothing to check, a repo this computer lacks, or no git", () => {
    expect(checkFindingCitation({ created_at: "2026-01-01" })).toBe("unverifiable");
    const elsewhere = cite({ repo: "/Users/someone-else/Projects/app", commit: first, file: "a.ts", line: 2 });
    expect(checkFindingCitation(elsewhere)).toBe("unverifiable");
    expect(validateFindingCitation(elsewhere)).toBe(true);
    expect(checkFindingCitation({ created_at: "2026-01-01", file: "/Users/someone-else/notes.ts", line: 1 })).toBe("unverifiable");

    const savedPath = process.env.PATH;
    process.env.PATH = path.join(repo.path, "no-bin");
    try {
      expect(checkFindingCitation(cite({ commit: first, file: "a.ts", line: 2 }))).toBe("unverifiable");
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("trust filter by citation state", () => {
  let repo: { path: string; cleanup: () => void };
  let first: string;
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo.path, encoding: "utf8" }).trim();
  const findings = (citations: Record<string, Partial<FindingCitation>>) => {
    const today = new Date().toISOString().slice(0, 10);
    const lines = ["# Findings", "", `## ${today}`, ""];
    for (const [text, citation] of Object.entries(citations)) {
      lines.push(`- ${text}`, `  ${buildCitationComment({ created_at: new Date().toISOString(), ...citation })}`);
    }
    return lines.join("\n");
  };

  beforeEach(() => {
    repo = makeTempDir("phren-cite-trust-");
    git("init", "-q");
    fs.writeFileSync(path.join(repo.path, "a.ts"), "one\ntwo\nthree\n");
    git("add", "-A");
    git("commit", "-qm", "first");
    first = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo.path, "a.ts"), "one\nTWO\nthree\n");
    git("commit", "-qam", "second");
  });

  afterEach(() => repo.cleanup());

  it("keeps a finding whose repo is not on this computer, and drops only a broken one", () => {
    const content = findings({
      "Retry budget lives in the client wrapper": { repo: "/Users/someone-else/Projects/app", commit: first, file: "a.ts", line: 2 },
      "The old helper file was the entry point": { repo: repo.path, commit: first, file: "gone.ts", line: 1 },
    });
    const result = filterTrustedFindingsDetailed(content, { ttlDays: 120, minConfidence: 0.9 });
    expect(result.content).toContain("Retry budget lives in the client wrapper");
    expect(result.content).not.toContain("The old helper file");
    expect(result.issues).toEqual([expect.objectContaining({ reason: "invalid_citation", bullet: "- The old helper file was the entry point" })]);
  });

  it("lowers a drifted finding's confidence instead of dropping it as invalid", () => {
    const content = findings({ "Line two is where the parser starts": { repo: repo.path, commit: first, file: "a.ts", line: 2 } });
    expect(filterTrustedFindingsDetailed(content, { ttlDays: 120, minConfidence: 0.6 }).content).toContain("Line two is where the parser starts");
    const strict = filterTrustedFindingsDetailed(content, { ttlDays: 120, minConfidence: 0.8 });
    expect(strict.content).not.toContain("Line two is where the parser starts");
    expect(strict.issues.map((issue) => issue.reason)).toEqual(["stale"]);
  });

  it("uses known states instead of checking when given them", () => {
    const content = findings({ "The old helper file was the entry point": { repo: repo.path, commit: first, file: "gone.ts", line: 1 } });
    const result = filterTrustedFindingsDetailed(content, { ttlDays: 120, citationState: () => undefined });
    expect(result.content).toContain("The old helper file");
    expect(result.issues).toEqual([]);
  });
});
