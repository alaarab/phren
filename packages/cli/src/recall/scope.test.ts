import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIndex, type SqlJsDatabase } from "../shared/index.js";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import { runPromptPipeline } from "./pipeline.js";

// What a prompt asked inside a project can reach: that project, plus memory every project shares.
describe("recall scope from inside a project", () => {
  let tmp: { path: string; cleanup: () => void };
  let db: SqlJsDatabase;
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(tmp.path, file)), { recursive: true });
    fs.writeFileSync(path.join(tmp.path, file), text);
  };
  const run = (prompt: string) => runPromptPipeline({ prompt, phrenPath: tmp.path, db, detectedProject: "atlas" });

  beforeAll(async () => {
    tmp = makeTempDir("recall-scope-");
    initTestPhrenRoot(tmp.path);
    write("profiles/p.yaml", "name: p\nprojects:\n  - global\n  - atlas\n  - harbor\n");
    write("atlas/FINDINGS.md", "# atlas Findings\n\n- The ledger export retries webhook delivery three times before parking the batch.\n- The operator handbook says parked batches wait for a person.\n");
    write("harbor/FINDINGS.md", "# harbor Findings\n\n- The saxophone tuner caches chart tiles for ten minutes.\n");
    write("global/FINDINGS.md", "# global Findings\n\n- The kettle descaler runs every quarter with citric acid.\n");
    // One long shared file that happens to hold every word of the next question.
    write("global/reference/handbook.md", "# handbook\n\n- Operator handbook: glossary, appendix and index are covered thoroughly everywhere in chapter nine.\n");
    db = await buildIndex(tmp.path, "p");
  });
  afterAll(() => tmp?.cleanup());

  it("reaches global memory from inside a project", async () => {
    const result = await run("how often does the kettle descaler run");
    expect(result.selected.map((s) => `${s.project}/${s.filename}`)).toContain("global/FINDINGS.md");
  });

  it("still searches the project when a shared file matched every keyword", async () => {
    // The project's finding holds two of the ten words: the strict query and the word-overlap tier miss it, the relaxed query finds it.
    const result = await run("operator handbook glossary appendix index chapter nine covered thoroughly everywhere");
    expect(result.candidates.map((c) => `${c.project}/${c.filename}`)).toContain("atlas/FINDINGS.md");
  });
});
