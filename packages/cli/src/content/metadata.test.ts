import { describe, expect, it } from "vitest";
import {
  addMetadata,
  isArchiveEnd,
  isArchiveStart,
  isCitationLine,
  normalizeFindingText,
  parseAllContradictions,
  parseContradiction,
  parseCreatedDate,
  parseFindingId,
  parseStatus,
  parseStatusField,
  parseSupersedesRef,
  parseSupersession,
  stripAllMetadata,
  stripComments,
  stripLifecycleMetadata,
  stripRelationMetadata,
} from "./metadata.js";

describe("parsing metadata comments", () => {
  it("reads every lifecycle status, quoted or bare, and rejects an unknown value", () => {
    expect(parseStatus('<!-- phren:status "active" -->')).toBe("active");
    expect(parseStatus('<!-- phren:status "superseded" -->')).toBe("superseded");
    expect(parseStatus('<!-- phren:status "contradicted" -->')).toBe("contradicted");
    expect(parseStatus('<!-- phren:status "stale" -->')).toBe("stale");
    expect(parseStatus('<!-- phren:status "invalid_citation" -->')).toBe("invalid_citation");
    expect(parseStatus('<!-- phren:status "retracted" -->')).toBe("retracted");
    expect(parseStatus("<!-- phren:status ACTIVE -->")).toBe("active");
    expect(parseStatus('<!-- phren:status "bogus" -->')).toBeUndefined();
    expect(parseStatus("- a finding with no metadata")).toBeUndefined();
  });

  it("reads quoted and raw status fields, collapsing internal whitespace", () => {
    expect(parseStatusField('<!-- phren:status_updated "2025-01-01" -->', "status_updated")).toBe("2025-01-01");
    expect(parseStatusField('<!-- phren:status_ref "  other   rule  " -->', "status_ref")).toBe("other rule");
    expect(parseStatusField("<!-- phren:status_ref other   rule -->", "status_ref")).toBe("other rule");
    expect(parseStatusField("<!-- phren:status_reason -->", "status_reason")).toBeUndefined();
  });

  it("reads prefixed and legacy supersession, with and without a date", () => {
    expect(parseSupersession('<!-- phren:superseded_by "New approach" 2025-01-01 -->')).toEqual({
      ref: "New approach",
      date: "2025-01-01",
    });
    expect(parseSupersession('<!-- phren:superseded_by "New approach" -->')).toEqual({
      ref: "New approach",
      date: undefined,
    });
    expect(parseSupersession('<!-- superseded_by: "Old approach" -->')).toEqual({
      ref: "Old approach",
      date: undefined,
    });
    expect(parseSupersession("- nothing here")).toBeNull();
  });

  it("reads prefixed and legacy relation refs", () => {
    expect(parseSupersedesRef('<!-- phren:supersedes "Older rule" -->')).toBe("Older rule");
    expect(parseContradiction('<!-- phren:contradicts "Other rule" -->')).toBe("Other rule");
    expect(parseContradiction('<!-- conflicts_with: "Use X" (from project: alpha) -->')).toBe("Use X");
    expect(parseContradiction("<!-- note: keep -->")).toBeNull();
  });

  it("reads several metadata comments on one line, including every contradiction", () => {
    const line =
      '- Pool the connections <!-- fid:a1b2c3d4 --> <!-- created: 2025-02-03 --> ' +
      '<!-- phren:status "contradicted" --> <!-- phren:status_updated "2025-02-04" --> ' +
      '<!-- phren:status_reason "conflicts_with" --> <!-- phren:status_ref "Other rule" --> ' +
      '<!-- phren:contradicts "Other rule" --> <!-- phren:contradicts "Third rule" -->';

    expect(parseFindingId(line)).toBe("a1b2c3d4");
    expect(parseCreatedDate(line)).toBe("2025-02-03");
    expect(parseStatus(line)).toBe("contradicted");
    expect(parseStatusField(line, "status_updated")).toBe("2025-02-04");
    expect(parseStatusField(line, "status_reason")).toBe("conflicts_with");
    expect(parseStatusField(line, "status_ref")).toBe("Other rule");
    expect(parseContradiction(line)).toBe("Other rule");
    expect(parseAllContradictions(line)).toEqual(["Other rule", "Third rule"]);

    expect(parseFindingId("<!-- fid:AB12CD34 -->")).toBe("AB12CD34");
    expect(parseFindingId("<!-- fid:abc123 -->")).toBeUndefined();
    expect(parseCreatedDate("<!-- created: 2025-12-31 -->")).toBe("2025-12-31");
    expect(parseCreatedDate("<!-- created: 31-12-2025 -->")).toBeUndefined();
  });

  it("recognises only a full-line citation and both archive marker styles", () => {
    expect(isCitationLine('  <!-- phren:cite {"file":"a.ts","line":3} -->  ')).toBe(true);
    expect(isCitationLine('Insight <!-- phren:cite {"file":"a.ts"} -->')).toBe(false);
    expect(isCitationLine('<!-- phren:cite {"file":"a.ts"} --> trailing')).toBe(false);
    expect(isCitationLine("<!-- phren:cite not json -->")).toBe(false);

    expect(isArchiveStart("<!-- phren:archive:start -->")).toBe(true);
    expect(isArchiveStart("<details open>")).toBe(true);
    expect(isArchiveStart("- a normal finding")).toBe(false);
    expect(isArchiveEnd("<!-- phren:archive:end -->")).toBe(true);
    expect(isArchiveEnd("</details>")).toBe(true);
    expect(isArchiveEnd("- a normal finding")).toBe(false);
  });
});

describe("stripping metadata comments", () => {
  it("removes lifecycle comments while leaving ids, unknown and malformed comments alone", () => {
    const line =
      '- finding <!-- fid:aaaa1111 --> <!-- phren:status "superseded" --> ' +
      '<!-- phren:status_updated "2025-01-01" --> <!-- phren:status_reason "superseded_by" --> ' +
      '<!-- phren:status_ref "new" --> <!-- note: keep --> <!-- phren:status "bogus" -->';

    expect(stripLifecycleMetadata(line)).toBe(
      '- finding <!-- fid:aaaa1111 --> <!-- note: keep --> <!-- phren:status "bogus" -->',
    );
  });

  it("removes every relation form while leaving unknown comments alone", () => {
    const line =
      '- finding <!-- phren:superseded_by "Old" 2025-01-01 --> <!-- phren:supersedes "New" --> ' +
      '<!-- phren:contradicts "Other" --> <!-- conflicts_with: "Third" (from project: p) --> ' +
      "<!-- note: keep -->";

    expect(stripRelationMetadata(line)).toBe("- finding <!-- note: keep -->");
  });

  it("removes lifecycle and relation comments together, and stripComments removes any comment", () => {
    const line =
      '- finding <!-- phren:status "active" --> <!-- phren:supersedes "Old" --> <!-- note: keep -->';

    expect(stripAllMetadata(line)).toBe("- finding <!-- note: keep -->");
    expect(stripComments("  hello <!-- x --> world <!-- y -->  ")).toBe("hello  world");
  });

  it("normalizes a finding for comparison", () => {
    expect(
      normalizeFindingText(
        '- **Deploy** rule <!-- phren:status "active" --> [confidence 0.8]   Keep  This',
      ),
    ).toBe("**deploy** rule keep this");
  });
});

describe("writing metadata comments", () => {
  it("writes the quoted comment with an optional trailing field and escapes double quotes", () => {
    expect(addMetadata("status", "active")).toBe('<!-- phren:status "active" -->');
    expect(addMetadata("superseded_by", "New approach", "2025-01-01")).toBe(
      '<!-- phren:superseded_by "New approach" 2025-01-01 -->',
    );
    expect(addMetadata("status_ref", 'He said "hi"')).toBe(
      `<!-- phren:status_ref "He said 'hi'" -->`,
    );
  });

  it("writes comments that parse back to the same values", () => {
    const status = addMetadata("status", "superseded");
    const updated = addMetadata("status_updated", "2025-03-04");
    const supersession = addMetadata("superseded_by", "New approach", "2025-03-05");

    expect(status).toBe('<!-- phren:status "superseded" -->');
    expect(updated).toBe('<!-- phren:status_updated "2025-03-04" -->');
    expect(supersession).toBe('<!-- phren:superseded_by "New approach" 2025-03-05 -->');

    expect(parseStatus(status)).toBe("superseded");
    expect(parseStatusField(updated, "status_updated")).toBe("2025-03-04");
    expect(parseSupersession(supersession)).toEqual({ ref: "New approach", date: "2025-03-05" });
  });
});
