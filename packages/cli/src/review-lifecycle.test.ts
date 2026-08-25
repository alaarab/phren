/**
 * Review-queue lifecycle: what approve and reject actually do to the store.
 *
 * These cover the defect where 94% of queue items on a real store did not exist
 * in FINDINGS.md, which made approve a silent discard and reject a no-op that
 * claimed success. Each case pins one reality a queue line can point at.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  approveQueueItem,
  approveQueueItemDetailed,
  rejectQueueItem,
  rejectQueueItemDetailed,
  readReviewQueue,
  readFindings,
  FINDINGS_FILENAME,
} from "./data/access.js";
import { appendReviewQueue } from "./shared/governance.js";
import { buildQueueProvenanceMeta } from "./cli/extract.js";
import { applyTrustFilter, isInjectableDocType, selectSnippets } from "./shared/retrieval.js";
import { classifyFile } from "./shared/index.js";
import { PhrenError } from "./shared.js";
import { grantAdmin, makeTempDir } from "./test-helpers.js";

const PROJECT = "testproject";
const TODAY = new Date().toISOString().slice(0, 10);

let tmpDir: string;
let projectDir: string;
let cleanup: () => void;

beforeEach(() => {
  ({ path: tmpDir, cleanup } = makeTempDir("phren-review-lifecycle-"));
  projectDir = path.join(tmpDir, PROJECT);
  fs.mkdirSync(projectDir, { recursive: true });
  grantAdmin(tmpDir);
});

afterEach(() => {
  cleanup();
});

function writeQueue(lines: string[]): void {
  fs.writeFileSync(
    path.join(projectDir, "review.md"),
    ["# testproject Review Queue", "", "## Review", "", ...lines, "", "## Stale", "", "## Conflicts", ""].join("\n"),
  );
}

function readQueueFile(): string {
  return fs.readFileSync(path.join(projectDir, "review.md"), "utf8");
}

function writeFindings(bullets: string[]): void {
  fs.writeFileSync(
    path.join(projectDir, FINDINGS_FILENAME),
    ["# testproject Findings", "", `## ${TODAY}`, "", ...bullets, ""].join("\n"),
  );
}

function findingsContent(): string {
  const file = path.join(projectDir, FINDINGS_FILENAME);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function writeTopicDoc(slug: string, bullets: string[]): string {
  const file = path.join(projectDir, "reference", "topics", `${slug}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [`# testproject — ${slug}`, "", "## Archived 2026-02-01", "", ...bullets, ""].join("\n"));
  return file;
}

// ── approve ──────────────────────────────────────────────────────────────────

describe("approveQueueItem: promotion", () => {
  it("promotes an extracted candidate that was never added to FINDINGS.md", () => {
    const line = `- [2026-03-01] [confidence 0.62] Retries must be idempotent or the queue double-charges (source commit abc12345)`;
    writeQueue([line]);
    expect(fs.existsSync(path.join(projectDir, FINDINGS_FILENAME))).toBe(false);

    const result = approveQueueItemDetailed(tmpDir, PROJECT, line);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe("promoted");

    const findings = readFindings(tmpDir, PROJECT);
    expect(findings.ok).toBe(true);
    if (!findings.ok) return;
    expect(findings.data).toHaveLength(1);
    expect(findings.data[0].text).toContain("Retries must be idempotent");

    // ...and it leaves the queue.
    expect(readQueueFile()).not.toContain("Retries must be idempotent");
  });

  it("strips the confidence marker so it never pollutes FINDINGS.md", () => {
    const line = `- [2026-03-01] [confidence 0.62] Retries must be idempotent or the queue double-charges`;
    writeQueue([line]);

    approveQueueItem(tmpDir, PROJECT, line);
    expect(findingsContent()).not.toContain("confidence 0.62");
  });

  it("gives a promoted finding a fid and full add-path metadata", () => {
    const line = `- [2026-03-01] Connection pools must be sized below the database max_connections`;
    writeQueue([line]);

    expect(approveQueueItem(tmpDir, PROJECT, line).ok).toBe(true);

    const content = findingsContent();
    expect(content).toMatch(/<!--\s*fid:[a-f0-9]{8}\s*-->/);
    expect(content).toContain("<!-- created:");
    expect(content).toContain("phren:cite");

    const findings = readFindings(tmpDir, PROJECT);
    if (!findings.ok) return;
    expect(findings.data[0].stableId).toMatch(/^[a-f0-9]{8}$/);
    expect(findings.data[0].status).toBe("active");
  });

  it("preserves the entry's type tag and records its queue date", () => {
    const line = `- [2026-03-01] [gotcha] The migration runner ignores files that sort before the last applied stamp`;
    writeQueue([line]);

    expect(approveQueueItem(tmpDir, PROJECT, line).ok).toBe(true);

    const content = findingsContent();
    expect(content).toContain("[gotcha]");
    expect(content).toContain(`<!-- phren:queued "2026-03-01" -->`);
  });

  it("carries the queued source-commit provenance onto the promoted finding", () => {
    const meta = buildQueueProvenanceMeta({
      source: "extract",
      sessionId: "sess-42",
      repo: "/repos/api",
      commit: "abc1234def5678",
    });
    const line = `- [${TODAY}] [confidence 0.6] Sessions must be revoked on password change ${meta}`;
    writeQueue([line]);

    expect(approveQueueItem(tmpDir, PROJECT, line).ok).toBe(true);

    const content = findingsContent();
    expect(content).toContain(`"commit":"abc1234def5678"`);
    expect(content).toContain(`"repo":"/repos/api"`);
    expect(content).toContain("<!-- source:extract session:sess-42 -->");
    // The metadata comments must not survive as visible finding text.
    const findings = readFindings(tmpDir, PROJECT);
    if (!findings.ok) return;
    expect(findings.data[0].text).toBe("Sessions must be revoked on password change");
  });

  it("promoted findings participate in dedup like any other finding", () => {
    const first = `- [${TODAY}] Feature flags must default to off in production`;
    writeQueue([first]);
    expect(approveQueueItem(tmpDir, PROJECT, first).ok).toBe(true);

    // Same text queued again (e.g. re-extracted from a different commit) must not
    // produce a second copy.
    const second = `- [${TODAY}] [confidence 0.55] Feature flags must default to off in production`;
    writeQueue([second]);
    const result = approveQueueItemDetailed(tmpDir, PROJECT, second);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe("already_present");

    const findings = readFindings(tmpDir, PROJECT);
    if (!findings.ok) return;
    expect(findings.data.filter((f) => f.text.includes("Feature flags must default to off"))).toHaveLength(1);
  });
});

describe("approveQueueItem: item already in FINDINGS.md", () => {
  it("keeps the existing finding and does not duplicate it", () => {
    writeFindings([`- Always validate webhook signatures before parsing the body <!-- fid:aaaabbbb -->`]);
    const line = `- [2026-03-01] Always validate webhook signatures before parsing the body`;
    writeQueue([line]);

    const result = approveQueueItemDetailed(tmpDir, PROJECT, line);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe("already_present");

    const findings = readFindings(tmpDir, PROJECT);
    if (!findings.ok) return;
    expect(findings.data).toHaveLength(1);
    // Untouched: same fid, no rewritten bullet.
    expect(findings.data[0].stableId).toBe("aaaabbbb");
    expect(readQueueFile()).not.toContain("Always validate webhook signatures");
  });

  it("matches a finding that carries a type tag the queue entry lacked", () => {
    writeFindings([`- [pattern] Always validate webhook signatures before parsing the body <!-- fid:aaaabbbb -->`]);
    const line = `- [2026-03-01] Always validate webhook signatures before parsing the body`;
    writeQueue([line]);

    const result = approveQueueItemDetailed(tmpDir, PROJECT, line);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe("already_present");

    const findings = readFindings(tmpDir, PROJECT);
    if (!findings.ok) return;
    expect(findings.data).toHaveLength(1);
  });
});

describe("approveQueueItem: item already archived", () => {
  it("dequeues without touching reference/topics", () => {
    const topicFile = writeTopicDoc("general", [
      `- Postgres advisory locks are per-session, not per-transaction <!-- fid:ccccdddd -->`,
    ]);
    const before = fs.readFileSync(topicFile, "utf8");
    const line = `- [2026-03-01] Postgres advisory locks are per-session, not per-transaction`;
    writeQueue([line]);

    const result = approveQueueItemDetailed(tmpDir, PROJECT, line);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe("already_archived");
    expect(result.data.message).toContain("archived");

    expect(fs.readFileSync(topicFile, "utf8")).toBe(before);
    // Not resurrected into FINDINGS.md either — it is already live for retrieval.
    expect(fs.existsSync(path.join(projectDir, FINDINGS_FILENAME))).toBe(false);

    const queue = readReviewQueue(tmpDir, PROJECT);
    if (!queue.ok) return;
    expect(queue.data).toHaveLength(0);
  });
});

describe("approveQueueItem: failure modes", () => {
  it("reports NOT_FOUND for a line that is not in the queue", () => {
    writeQueue([`- [2026-03-01] something else`]);
    const result = approveQueueItem(tmpDir, PROJECT, "- [2026-03-01] not queued");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PhrenError.NOT_FOUND);
  });

  it("leaves the queue line in place when promotion fails", () => {
    // A finding that trips the secret scanner cannot be written, so the item must
    // stay queued rather than being silently dropped.
    const token = `ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`;
    const line = `- [${TODAY}] The deploy job still authenticates with ${token} and must be rotated`;
    writeQueue([line]);

    const result = approveQueueItem(tmpDir, PROJECT, line);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PhrenError.VALIDATION_ERROR);
    expect(readQueueFile()).toContain(token);
  });
});

// ── reject ───────────────────────────────────────────────────────────────────

describe("rejectQueueItem: live findings", () => {
  it("removes the finding from FINDINGS.md and dequeues", () => {
    writeFindings([
      `- Always validate webhook signatures before parsing the body`,
      `- Keep the retry budget below the upstream timeout`,
    ]);
    const line = `- [2026-03-01] Always validate webhook signatures before parsing the body`;
    writeQueue([line]);

    const result = rejectQueueItemDetailed(tmpDir, PROJECT, line);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe("removed");

    const findings = readFindings(tmpDir, PROJECT);
    if (!findings.ok) return;
    expect(findings.data).toHaveLength(1);
    expect(findings.data[0].text).toContain("retry budget");
    expect(readQueueFile()).not.toContain("Always validate webhook signatures");
  });
});

describe("rejectQueueItem: archived content", () => {
  it("removes the finding from reference/topics where auto-archive moved it", () => {
    const topicFile = writeTopicDoc("database", [
      `- Postgres advisory locks are per-session, not per-transaction <!-- fid:ccccdddd -->`,
      `- Vacuum does not reclaim space held by an open transaction`,
    ]);
    const line = `- [2026-03-01] Postgres advisory locks are per-session, not per-transaction`;
    writeQueue([line]);

    const result = rejectQueueItemDetailed(tmpDir, PROJECT, line);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe("removed_from_archive");

    const after = fs.readFileSync(topicFile, "utf8");
    expect(after).not.toContain("advisory locks");
    // Neighbouring archived content is untouched.
    expect(after).toContain("Vacuum does not reclaim space");
    expect(readQueueFile()).not.toContain("advisory locks");
  });

  it("removes the archived bullet's citation line with it", () => {
    const topicFile = writeTopicDoc("database", [
      `- Postgres advisory locks are per-session, not per-transaction`,
      `  <!-- phren:cite {"created_at":"2026-01-01T00:00:00.000Z"} -->`,
    ]);
    const line = `- [2026-03-01] Postgres advisory locks are per-session, not per-transaction`;
    writeQueue([line]);

    expect(rejectQueueItem(tmpDir, PROJECT, line).ok).toBe(true);
    expect(fs.readFileSync(topicFile, "utf8")).not.toContain("phren:cite");
  });
});

describe("rejectQueueItem: nothing to remove", () => {
  it("discards an extracted candidate that was never written anywhere, and says so", () => {
    const line = `- [2026-03-01] [confidence 0.51] Cache warmers should run after migrations, not before`;
    writeQueue([line]);

    const result = rejectQueueItemDetailed(tmpDir, PROJECT, line);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe("discarded");
    expect(result.data.message).toContain("never added");
    // No weasel wording about what "may have" happened.
    expect(result.data.message).not.toContain("may have");

    expect(readQueueFile()).not.toContain("Cache warmers");
  });
});

describe("rejectQueueItem: fails loudly instead of lying", () => {
  it("refuses when the content sits in a read-only FINDINGS.md archive block", () => {
    fs.writeFileSync(
      path.join(projectDir, FINDINGS_FILENAME),
      [
        "# testproject Findings",
        "",
        `## ${TODAY}`,
        "",
        "- A live finding",
        "",
        "<!-- phren:archive:start -->",
        "## Archived 2026-01-01",
        "",
        "- Retry storms are caused by unjittered exponential backoff",
        "<!-- phren:archive:end -->",
        "",
      ].join("\n"),
    );
    const line = `- [2026-03-01] Retry storms are caused by unjittered exponential backoff`;
    writeQueue([line]);

    const result = rejectQueueItem(tmpDir, PROJECT, line);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PhrenError.VALIDATION_ERROR);

    // Content survives — and so does the queue line, so the user can still act.
    expect(findingsContent()).toContain("Retry storms");
    expect(readQueueFile()).toContain("Retry storms");
  });

  it("refuses when several different archived bullets match", () => {
    writeTopicDoc("general", [
      `- Retry storms are caused by unjittered exponential backoff in the client`,
      `- Retry storms are caused by unjittered exponential backoff in the gateway`,
    ]);
    const line = `- [2026-03-01] Retry storms are caused by unjittered exponential backoff`;
    writeQueue([line]);

    const result = rejectQueueItem(tmpDir, PROJECT, line);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PhrenError.AMBIGUOUS_MATCH);
    expect(readQueueFile()).toContain("Retry storms");
  });

  it("refuses when the match lives in a reference file phren does not auto-manage", () => {
    const handWritten = path.join(projectDir, "reference", "architecture.md");
    fs.mkdirSync(path.dirname(handWritten), { recursive: true });
    fs.writeFileSync(handWritten, "# Architecture\n\n- The gateway terminates TLS for every internal service\n");
    const line = `- [2026-03-01] The gateway terminates TLS for every internal service`;
    writeQueue([line]);

    const result = rejectQueueItem(tmpDir, PROJECT, line);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(PhrenError.VALIDATION_ERROR);
      expect(result.error).toContain("architecture.md");
    }
    expect(fs.readFileSync(handWritten, "utf8")).toContain("terminates TLS");
    expect(readQueueFile()).toContain("terminates TLS");
  });

  it("removes duplicate archived bullets with identical content without complaining", () => {
    const topicFile = writeTopicDoc("general", [
      `- Retry storms are caused by unjittered exponential backoff`,
      `- Retry storms are caused by unjittered exponential backoff`,
    ]);
    const line = `- [2026-03-01] Retry storms are caused by unjittered exponential backoff`;
    writeQueue([line]);

    const result = rejectQueueItemDetailed(tmpDir, PROJECT, line);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe("removed_from_archive");
    // One copy removed per rejection; the queue item is gone either way.
    expect(fs.readFileSync(topicFile, "utf8").match(/Retry storms/g)).toHaveLength(1);
  });
});

// ── round trip ───────────────────────────────────────────────────────────────

describe("approve and reject are no longer the same operation", () => {
  it("diverge on an extracted candidate that is not in FINDINGS.md", () => {
    const line = `- [${TODAY}] [confidence 0.6] Batch writes must be chunked below the statement size limit`;

    writeQueue([line]);
    expect(approveQueueItem(tmpDir, PROJECT, line).ok).toBe(true);
    const afterApprove = readFindings(tmpDir, PROJECT);
    expect(afterApprove.ok && afterApprove.data.length).toBe(1);

    // Reset and take the other branch.
    fs.rmSync(path.join(projectDir, FINDINGS_FILENAME));
    writeQueue([line]);
    expect(rejectQueueItem(tmpDir, PROJECT, line).ok).toBe(true);
    expect(fs.existsSync(path.join(projectDir, FINDINGS_FILENAME))).toBe(false);
  });
});

// ── queue write path ─────────────────────────────────────────────────────────

describe("appendReviewQueue metadata", () => {
  it("appends comment metadata to the queue line and keeps it out of the display text", () => {
    const meta = buildQueueProvenanceMeta({ source: "extract", repo: "/repos/api", commit: "abc1234" });
    const added = appendReviewQueue(tmpDir, PROJECT, "Review", [{ text: "Some candidate insight", meta }]);
    expect(added.ok && added.data).toBe(1);

    expect(readQueueFile()).toContain(`"commit":"abc1234"`);
    const queue = readReviewQueue(tmpDir, PROJECT);
    if (!queue.ok) return;
    expect(queue.data[0].text).toBe("Some candidate insight");
  });

  it("drops metadata that is not comments-only", () => {
    const added = appendReviewQueue(tmpDir, PROJECT, "Review", [
      { text: "Some candidate insight", meta: `<script>alert(1)</script>` },
    ]);
    expect(added.ok && added.data).toBe(1);
    expect(readQueueFile()).not.toContain("<script>");
  });

  it("dedups against the same text queued without metadata", () => {
    expect(appendReviewQueue(tmpDir, PROJECT, "Review", ["Some candidate insight"]).ok).toBe(true);
    const again = appendReviewQueue(tmpDir, PROJECT, "Review", [
      { text: "Some candidate insight", meta: buildQueueProvenanceMeta({ source: "extract", commit: "abc1234" }) },
    ]);
    expect(again.ok && again.data).toBe(0);

    const queue = readReviewQueue(tmpDir, PROJECT);
    if (!queue.ok) return;
    expect(queue.data).toHaveLength(1);
  });

  it("still accepts plain string entries", () => {
    const added = appendReviewQueue(tmpDir, PROJECT, "Stale", ["- An older finding", "Another one"]);
    expect(added.ok && added.data).toBe(2);
    const queue = readReviewQueue(tmpDir, PROJECT);
    if (!queue.ok) return;
    expect(queue.data.every((item) => item.section === "Stale")).toBe(true);
  });
});

describe("buildQueueProvenanceMeta", () => {
  it("emits source and citation comments only", () => {
    const meta = buildQueueProvenanceMeta({
      source: "extract",
      sessionId: "s1",
      repo: "/repos/api",
      commit: "deadbeef",
      file: "src/x.ts",
      capturedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(meta).toContain("<!-- source:extract session:s1 -->");
    expect(meta).toContain(`"repo":"/repos/api"`);
    expect(meta).toContain(`"commit":"deadbeef"`);
    expect(meta).toContain(`"file":"src/x.ts"`);
    expect(meta.replace(/<!--(?:(?!-->)[\s\S])*?-->/g, "").trim()).toBe("");
  });

  it("returns an empty string when there is nothing to record", () => {
    expect(buildQueueProvenanceMeta({})).toBe("");
  });
});

// ── injectability ────────────────────────────────────────────────────────────

describe("review-queue content is never injected", () => {
  const queueRow = {
    project: PROJECT,
    filename: "review.md",
    type: "review-queue",
    content: [
      "# testproject Review Queue",
      "",
      "## Review",
      "",
      "- [2026-03-01] [confidence 0.4] Unreviewed claim about authentication tokens",
      "",
    ].join("\n"),
    path: "/testproject/review.md",
  };

  it("applyTrustFilter drops review-queue rows", () => {
    const rows = [
      queueRow,
      { project: PROJECT, filename: "summary.md", type: "summary", content: "authentication overview", path: "/s" },
    ];
    const result = applyTrustFilter(rows, 365, 0.0, { enabled: false });
    expect(result.rows.map((r) => r.type)).toEqual(["summary"]);
  });

  it("applyTrustFilter still drops notes rows", () => {
    const rows = [
      { project: PROJECT, filename: "scratch.md", type: "notes", content: "personal note", path: "/n" },
    ];
    expect(applyTrustFilter(rows, 365, 0.0, { enabled: false }).rows).toHaveLength(0);
  });

  it("selectSnippets refuses review-queue rows even if they reach it", () => {
    const { selected } = selectSnippets([queueRow], "authentication tokens", 2000, 10, 2000);
    expect(selected).toHaveLength(0);
  });

  it("stays indexed as review-queue, so explicit search can still reach it", () => {
    // Deliberate split: reachable when a caller asks for it by name, never pushed.
    expect(classifyFile("review.md", `${PROJECT}/review.md`)).toBe("review-queue");
    expect(isInjectableDocType("review-queue")).toBe(false);
    expect(isInjectableDocType("notes")).toBe(false);
    expect(isInjectableDocType("findings")).toBe(true);
  });

  it("does not block ordinary findings", () => {
    const findingsRow = {
      project: PROJECT,
      filename: FINDINGS_FILENAME,
      type: "findings",
      content: `# testproject Findings\n\n## ${TODAY}\n\n- Authentication tokens must be rotated on privilege change\n`,
      path: "/f",
    };
    const filtered = applyTrustFilter([findingsRow], 365, 0.0, { enabled: false });
    expect(filtered.rows).toHaveLength(1);
    const { selected } = selectSnippets(filtered.rows, "authentication tokens", 2000, 10, 2000);
    expect(selected).toHaveLength(1);
  });
});
