import { describe, expect, it } from "vitest";
import {
  buildSourceComment,
  filterTrustedFindingsDetailed,
  parseSourceComment,
} from "../content/citation.js";

describe("content-citation source provenance", () => {
  it("round-trips source annotation with structured fields", () => {
    const comment = buildSourceComment({
      source: "human",
      machine: "mbp-01",
      actor: "alice",
      tool: "codex",
      model: "gpt-5",
      session_id: "sess-123",
    });

    expect(comment).toBe("<!-- source:human machine:mbp-01 actor:alice tool:codex model:gpt-5 session:sess-123 -->");

    const parsed = parseSourceComment(`- Finding ${comment}`);
    expect(parsed).toEqual({
      source: "human",
      machine: "mbp-01",
      actor: "alice",
      tool: "codex",
      model: "gpt-5",
      session_id: "sess-123",
    });
  });

  it("parses quoted source tokens and legacy aliases", () => {
    const line = '- Finding <!-- source:source:"human" host:"build-box" agent:"assistant" session_id:"s-9" -->';
    const parsed = parseSourceComment(line);

    expect(parsed).toEqual({
      source: "human",
      machine: "build-box",
      actor: "assistant",
      session_id: "s-9",
      tool: undefined,
      model: undefined,
    });
  });

  it("does not boost trust confidence based on source provenance", () => {
    const content = [
      "# demo Findings",
      "",
      "- Unknown source finding <!-- source:unknown -->",
      "- Human source finding <!-- source:human -->",
      "",
    ].join("\n");

    const filtered = filterTrustedFindingsDetailed(content, {
      ttlDays: 3650,
      minConfidence: 0.39,
    });

    // Source-based confidence multiplier was removed; both undated uncited
    // findings get the same confidence and are filtered at this threshold.
    expect(filtered.content).not.toContain("Human source finding");
    expect(filtered.content).not.toContain("Unknown source finding");
    expect(filtered.issues.length).toBeGreaterThanOrEqual(2);
  });
});
