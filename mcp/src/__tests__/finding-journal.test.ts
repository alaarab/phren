import { beforeEach, afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { appendFindingJournal, compactFindingJournals } from "../finding/journal.js";

describe("finding journal", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("finding-journal-");
    grantAdmin(tmp.path);
    fs.mkdirSync(path.join(tmp.path, "demo"), { recursive: true });
    fs.writeFileSync(path.join(tmp.path, "demo", "summary.md"), "# demo\n");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("appends accepted findings to per-session journal files", () => {
    const result = appendFindingJournal(tmp.path, "demo", "[pattern] Retry Redis connections after socket reset", {
      sessionId: "sess-123",
    });
    expect(result.ok).toBe(true);
    const journalPath = path.join(tmp.path, ".runtime", "finding-journal", "demo", "sess-123.jsonl");
    expect(fs.existsSync(journalPath)).toBe(true);
    expect(fs.readFileSync(journalPath, "utf8")).toContain("Retry Redis connections");
  });

  it("compacts journal entries into FINDINGS.md and clears claimed files", () => {
    appendFindingJournal(tmp.path, "demo", "[pattern] Retry Redis connections after socket reset", { sessionId: "sess-abc" });
    appendFindingJournal(tmp.path, "demo", "[decision] Use SQLite WAL mode for local concurrent reads", { sessionId: "sess-abc" });

    const compacted = compactFindingJournals(tmp.path, "demo");
    expect(compacted.filesProcessed).toBe(1);
    expect(compacted.entriesProcessed).toBe(2);
    expect(compacted.added).toBe(2);

    const findingsPath = path.join(tmp.path, "demo", "FINDINGS.md");
    expect(fs.existsSync(findingsPath)).toBe(true);
    const findings = fs.readFileSync(findingsPath, "utf8");
    expect(findings).toContain("Retry Redis connections");
    expect(findings).toContain("SQLite WAL mode");

    const journalDir = path.join(tmp.path, ".runtime", "finding-journal", "demo");
    expect(fs.readdirSync(journalDir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(0);
  });

  it("counts duplicate journal entries as skipped during compaction", () => {
    appendFindingJournal(tmp.path, "demo", "[pattern] Retry Redis connections after socket reset", { sessionId: "sess-dup-a" });
    appendFindingJournal(tmp.path, "demo", "[pattern] Retry Redis connections after socket reset", { sessionId: "sess-dup-b" });

    const compacted = compactFindingJournals(tmp.path, "demo");
    expect(compacted.entriesProcessed).toBe(2);
    expect(compacted.added).toBe(1);
    expect(compacted.skipped).toBe(1);
  });
});
