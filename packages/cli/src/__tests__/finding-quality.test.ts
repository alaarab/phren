import { describe, expect, it } from "vitest";
import { findingQualityReason, isLowValueFinding } from "../content/quality.js";
import { extractToolFindings } from "../cli/session-tool-hook.js";

// Synthetic samples cover the shapes of low-value review entries.

describe("findingQualityReason", () => {
  it("keeps real findings", () => {
    const keepers = [
      "Socket retry workaround avoids duplicate sample delivery",
      "[pitfall] Order matters: loadSamples must run before querySamples or the sample table is empty",
      "[decision] Use a per-record lock instead of a shared mutex — concurrent writers only collide on one sample",
      'Set the retry budget to 4; the demo API returns "429" until the sample window expires',
      "Race condition in the sample queue causes an intermittent deadlock during replay",
      "Must avoid `mkdir -p` on the sample dir: EACCES on read-only fixtures, use the cache dir instead",
      "Prefer bounded retries over a fixed sleep; the sample loader needs the resolved result",
    ];
    for (const text of keepers) {
      expect(findingQualityReason(text), text).toBeNull();
    }
  });

  it("rejects transient shell/tool failure captures", () => {
    expect(findingQualityReason(
      "[bug] command 'npm run check 2>&1 | tail' failed: EACCES: permission denied, mkdir '/home/me/demo/.cache/widgets'"
    )).toBe("transient_tool_error");
    expect(findingQualityReason("[bug] command 'npm run build' failed: exit status 1")).toBe("transient_tool_error");
    expect(findingQualityReason("[bug] ENOENT: no such file or directory, open '/tmp/x.json'")).toBe("transient_tool_error");
  });

  it("rejects machine-generated diff-scrape templates", () => {
    expect(findingQualityReason(
      '[pitfall] demo-panel.ts: error handling added near "const finish = () => {"'
    )).toBe("diff_scrape_template");
    expect(findingQualityReason(
      '[pattern] demo-policy.ts: validation added near "export function enqueueSample("'
    )).toBe("diff_scrape_template");
  });

  it("rejects phren's own prompt text captured as a finding", () => {
    // tools/extract.ts EXTRACT_PROMPT line, matched by the hook's [tag] scraper.
    expect(findingQualityReason("[decision] , [pitfall], [pattern], [bug], or [workaround]"))
      .toBe("prompt_template_echo");
    expect(findingQualityReason("[pattern] Each finding must be self-contained"))
      .toBe("prompt_template_echo");
  });

  it("rejects non-prose fragments and unbalanced snippets", () => {
    expect(findingQualityReason('[pattern] ");')).toBe("too_short");
    expect(findingQualityReason("[pattern] ${insight}`, {")).toBe("non_prose_fragment");
    expect(findingQualityReason("[pattern] const finish = (rows) => {")).toBe("non_prose_fragment");
    expect(findingQualityReason("[bug] enqueueSample(getDemoPath(), project,")).toBe("non_prose_fragment");
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
    expect(findingQualityReason("- [2026-05-18] Socket retry workaround avoids duplicate sample delivery"))
      .toBeNull();
  });
});

describe("extractToolFindings quality gate", () => {
  it("drops a transient Bash failure instead of queueing it", () => {
    const candidates = extractToolFindings(
      "Bash",
      { command: "npm run check 2>&1 | tail" },
      "EACCES: permission denied, mkdir '/home/me/demo/.cache/widgets'",
      { is_error: true },
    );
    expect(candidates).toEqual([]);
  });

  it("drops explicit [tag] matches that are phren's own prompt text", () => {
    const candidates = extractToolFindings(
      "Write",
      { file_path: "src/tools/extract.ts", content: "- Prefix each finding with its type in brackets: [decision], [pitfall], [pattern], [bug], or [workaround]\n" },
      "",
    );
    expect(candidates).toEqual([]);
  });

  it("keeps a genuine explicit finding", () => {
    const candidates = extractToolFindings(
      "Write",
      { file_path: "src/cli/extract.ts", content: "// [pitfall] enqueueSample dedups on text, so a changing label prefix defeats it\n" },
      "",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].text).toContain("enqueueSample dedups on text");
  });
});
