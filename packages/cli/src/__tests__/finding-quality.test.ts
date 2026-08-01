import { describe, expect, it } from "vitest";
import { findingQualityReason, isLowValueFinding } from "../content/quality.js";
import { extractToolFindings } from "../cli/session-tool-hook.js";

// Every rejected sample below was captured verbatim in a real store's review.md.

describe("findingQualityReason", () => {
  it("keeps real findings", () => {
    const keepers = [
      "Socket reconnect workaround avoids duplicate token refresh",
      "[pitfall] Order matters: buildIndex must run before queryRows or the FTS table is empty",
      "[decision] Use a per-file lock instead of a global mutex — concurrent writers only ever collide per document",
      'Set the retry budget to 3; the API returns "429" until the window rolls over',
      "Race condition in the connection pool causes an intermittent deadlock under load",
      "Must avoid `mkdir -p` on the skills dir: EACCES on managed installs, use the runtime dir instead",
      "Prefer attempt-based retries over a fixed sleep; the template renderer needs the awaited value",
    ];
    for (const text of keepers) {
      expect(findingQualityReason(text), text).toBeNull();
    }
  });

  it("rejects transient shell/tool failure captures", () => {
    expect(findingQualityReason(
      "[bug] command 'phren doctor --fix 2>&1 | tail' failed: EACCES: permission denied, mkdir '/home/alaarab/emv/.claude/skills'"
    )).toBe("transient_tool_error");
    expect(findingQualityReason("[bug] command 'npm run build' failed: exit status 1")).toBe("transient_tool_error");
    expect(findingQualityReason("[bug] ENOENT: no such file or directory, open '/tmp/x.json'")).toBe("transient_tool_error");
  });

  it("rejects machine-generated diff-scrape templates", () => {
    expect(findingQualityReason(
      '[pitfall] memory-ui-graph-app.ts: error handling added near "const finalize = () => {"'
    )).toBe("diff_scrape_template");
    expect(findingQualityReason(
      '[pattern] policy.ts: validation added near "export function appendReviewQueue("'
    )).toBe("diff_scrape_template");
  });

  it("rejects phren's own prompt text captured as a finding", () => {
    // tools/extract.ts EXTRACT_PROMPT line, matched by the hook's [tag] scraper.
    expect(findingQualityReason("[decision] , [pitfall], [pattern], [tradeoff], [bug], or [architecture]"))
      .toBe("prompt_template_echo");
    expect(findingQualityReason("[pattern] Each finding must be self-contained"))
      .toBe("prompt_template_echo");
  });

  it("rejects non-prose fragments and unbalanced snippets", () => {
    expect(findingQualityReason('[pattern] ");')).toBe("too_short");
    expect(findingQualityReason("[pattern] ${insight}`, {")).toBe("non_prose_fragment");
    expect(findingQualityReason("[pattern] const finalize = (rows) => {")).toBe("non_prose_fragment");
    expect(findingQualityReason("[bug] appendReviewQueue(getPhrenPath(), project,")).toBe("non_prose_fragment");
  });

  it("still rejects the original low-value placeholders", () => {
    expect(findingQualityReason("- fixed stuff")).toBe("too_short");
    expect(findingQualityReason("- wip")).toBe("too_short");
    expect(findingQualityReason("- quick note about the deploy pipeline ordering")).toBe("boilerplate_phrase");
    expect(isLowValueFinding("- misc changes across the repository this week")).toBe(true);
  });

  it("ignores bullet, date, and confidence decoration", () => {
    expect(findingQualityReason("- [2026-05-18] [confidence 0.55] [bug] command 'x' failed: boom"))
      .toBe("transient_tool_error");
    expect(findingQualityReason("- [2026-05-18] Socket reconnect workaround avoids duplicate token refresh"))
      .toBeNull();
  });
});

describe("extractToolFindings quality gate", () => {
  it("drops a transient Bash failure instead of queueing it", () => {
    const candidates = extractToolFindings(
      "Bash",
      { command: "phren doctor --fix 2>&1 | tail" },
      "EACCES: permission denied, mkdir '/home/alaarab/emv/.claude/skills'",
      { is_error: true },
    );
    expect(candidates).toEqual([]);
  });

  it("drops explicit [tag] matches that are phren's own prompt text", () => {
    const candidates = extractToolFindings(
      "Write",
      { file_path: "src/tools/extract.ts", content: "- Prefix each finding with its type in brackets: [decision], [pitfall], [pattern], [tradeoff], [bug], or [architecture]\n" },
      "",
    );
    expect(candidates).toEqual([]);
  });

  it("keeps a genuine explicit finding", () => {
    const candidates = extractToolFindings(
      "Write",
      { file_path: "src/cli/extract.ts", content: "// [pitfall] appendReviewQueue dedups on text, so a drifting confidence prefix defeats it\n" },
      "",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].text).toContain("appendReviewQueue dedups on text");
  });
});
