import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIndex, type SqlJsDatabase } from "../shared/index.js";
import { queryDocRows } from "../index-query.js";
import { applyTrustFilter } from "../shared/retrieval.js";
import { citationGitCallCount } from "../content/citation.js";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import { runPromptPipeline } from "./pipeline.js";

// The index strips citation comments from findings, so this goes through a real index and the prompt pipeline.
describe("recorded citation states on the indexed prompt path", () => {
  let tmp: { path: string; cleanup: () => void };
  let db: SqlJsDatabase;
  const today = new Date().toISOString().slice(0, 10);
  const cite = (fields: Record<string, string>) => `  <!-- phren:cite ${JSON.stringify({ created_at: new Date().toISOString(), remote: "github.com/acme/widgets", commit: "0123456789abcdef0123456789abcdef01234567", ...fields })} -->`;

  beforeAll(async () => {
    tmp = makeTempDir("recall-citation-states-");
    initTestPhrenRoot(tmp.path);
    fs.mkdirSync(path.join(tmp.path, "widgets"), { recursive: true });
    fs.writeFileSync(path.join(tmp.path, "widgets", "FINDINGS.md"), [
      "# widgets Findings", "", `## ${today}`, "",
      `- The quokka exporter writes zebrafish manifests nightly <!-- fid:feed0001 --> <!-- created: ${today} -->`, cite({ file: "src/quokka.ts" }),
      `- The quokka exporter skips zebrafish archives on weekends <!-- fid:feed0002 --> <!-- created: ${today} -->`, cite({ file: "src/zebra.ts" }),
      "",
    ].join("\n"));
    fs.mkdirSync(path.join(tmp.path, ".runtime"), { recursive: true });
    fs.writeFileSync(path.join(tmp.path, ".runtime", "citation-states.json"), JSON.stringify({
      "fid:feed0002": { state: "broken", checkedAt: new Date().toISOString() },
    }));
    db = await buildIndex(tmp.path);
  });
  afterAll(() => tmp?.cleanup());

  it("drops an indexed finding this computer's sweep recorded as broken and keeps its unchecked neighbour", async () => {
    const gitBefore = citationGitCallCount();
    const result = await runPromptPipeline({ prompt: "quokka exporter zebrafish", phrenPath: tmp.path, db, detectedProject: "widgets" });
    expect(citationGitCallCount() - gitBefore).toBe(0);
    // The trust-filtered document the snippet is cut from, citations restored.
    const filtered = result.selectedRows.map(row => row.doc.content).join("\n");
    expect(filtered).toContain("writes zebrafish manifests nightly");
    expect(filtered).toContain('"file":"src/quokka.ts"');
    expect(filtered).not.toContain("skips zebrafish archives");
    expect(result.selected.map(row => row.snippet).join("\n")).not.toContain("skips zebrafish archives");
  });

  it("reports the recorded broken citation as a conflict for the indexed row", () => {
    const rows = queryDocRows(db, "SELECT project, filename, type, content, path FROM docs WHERE project = ? AND filename = ?", ["widgets", "FINDINGS.md"]) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].content).not.toContain("phren:cite");
    const result = applyTrustFilter(rows, 120, 0, {}, tmp.path);
    expect(result.queueItems).toEqual([{ project: "widgets", section: "Conflicts", items: [expect.stringContaining("skips zebrafish archives")] }]);
    expect(result.rows[0].content).toContain('"file":"src/quokka.ts"');
  });
});
