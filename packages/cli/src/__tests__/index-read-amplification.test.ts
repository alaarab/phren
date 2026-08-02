import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "path";
import * as yaml from "js-yaml";
import { makeTempDir, writeFile } from "../test-helpers.js";

// `vi.spyOn(fs, ...)` cannot redefine properties on an ESM namespace object, so
// the read counter has to be installed as a module mock. It delegates to the
// real implementation — this only observes, it never changes behaviour.
const { readCounts } = vi.hoisted(() => ({ readCounts: new Map<string, number>() }));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    readFileSync: (target: unknown, ...rest: unknown[]) => {
      if (typeof target === "string" && target.endsWith(".md")) {
        readCounts.set(target, (readCounts.get(target) ?? 0) + 1);
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(target, ...rest);
    },
  };
});

const { buildIndex, queryRows } = await import("../shared/index.js");

let cleanups: Array<() => void> = [];

function makeStore(prefix: string, referenceDocs: number): string {
  const tmp = makeTempDir(prefix);
  cleanups.push(tmp.cleanup);
  writeFile(
    path.join(tmp.path, "phren.root.yaml"),
    yaml.dump({ version: 1, installMode: "shared", syncMode: "managed-git" }, { lineWidth: 1000 })
  );
  const projectDir = path.join(tmp.path, "demo");
  writeFile(
    path.join(projectDir, "phren.project.yaml"),
    yaml.dump({ sourcePath: "/home/user/demo" }, { lineWidth: 1000 })
  );
  writeFile(path.join(projectDir, "summary.md"), "# demo\n\nRetrieval cache summary text.\n");
  writeFile(path.join(projectDir, "tasks.md"), "# tasks\n\n- [ ] wire the retrieval cache\n");
  writeFile(path.join(projectDir, "CLAUDE.md"), "# demo\n\nInstructions about the retrieval cache.\n");
  writeFile(
    path.join(projectDir, "FINDINGS.md"),
    "# findings\n\n- `sql.js` caches the retrieval index between rebuilds.\n"
  );
  for (let i = 0; i < referenceDocs; i++) {
    writeFile(
      path.join(projectDir, "reference", `ref-${i}.md`),
      `# ref ${i}\n\nReference notes ${i} about retrieval, caching and index rebuilds.\n`
    );
  }
  return tmp.path;
}

/** Reads of markdown files that live inside `storePath`, keyed by path. */
function storeReadCounts(storePath: string): Map<string, number> {
  const scoped = new Map<string, number>();
  for (const [file, count] of readCounts) {
    if (file.startsWith(storePath + path.sep)) scoped.set(file, count);
  }
  return scoped;
}

beforeEach(() => {
  readCounts.clear();
  cleanups = [];
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

describe("buildIndex file-read amplification", () => {
  it("reads each indexed file once for indexing", async () => {
    const store = makeStore("phren-read-count-", 6);
    const db = await buildIndex(store);
    const counts = storeReadCounts(store);
    const at = (rel: string): number => counts.get(path.join(store, "demo", rel)) ?? 0;

    // One read feeds the content hash, the FTS insert and (for findings files)
    // fragment extraction. These files are not part of the topic corpus, so one
    // read is the whole story.
    expect(at("summary.md")).toBe(1);
    expect(at("tasks.md")).toBe(1);

    // The remaining reads are a single project-wide pass by readProjectTopics()
    // (project-topics.ts), which derives adaptive topics from CLAUDE.md +
    // FINDINGS.md + reference/*.md. It runs once per project per build.
    expect(at("FINDINGS.md")).toBe(2);
    // CLAUDE.md additionally seeds the per-project user-fragment cache.
    expect(at("CLAUDE.md")).toBe(3);
    for (let i = 0; i < 6; i++) {
      expect(at(path.join("reference", `ref-${i}.md`))).toBe(2);
    }

    // 6 reference * 2 + summary 1 + tasks 1 + findings 2 + claude 3
    const totalReads = [...counts.values()].reduce((sum, n) => sum + n, 0);
    expect(totalReads).toBe(19);

    // The batched rebuild still indexes everything it used to. (The index also
    // carries the machine's native agent memory files, so scope the count.)
    const indexedPaths = (queryRows(db, "SELECT path FROM docs", []) ?? [])
      .map((row) => String(row[0]))
      .filter((docPath) => docPath.startsWith(store + path.sep));
    expect(indexedPaths.length).toBe(10);
    expect((queryRows(db, "SELECT source_id FROM entity_links", []) ?? []).length).toBeGreaterThan(0);
    db.close();
  });

  it("does not re-read the project corpus once per reference document", async () => {
    // Topic derivation reads the whole project corpus. When it runs per
    // reference document instead of per project, per-file reads grow with the
    // number of reference docs — 36 reads per file on a 34-reference project.
    const small = makeStore("phren-read-scale-small-", 2);
    const large = makeStore("phren-read-scale-large-", 10);

    const smallDb = await buildIndex(small);
    const smallReads = storeReadCounts(small).get(path.join(small, "demo", "reference", "ref-0.md")) ?? 0;
    smallDb.close();

    const largeDb = await buildIndex(large);
    const largeReads = storeReadCounts(large).get(path.join(large, "demo", "reference", "ref-0.md")) ?? 0;
    largeDb.close();

    expect(smallReads).toBe(2);
    expect(largeReads).toBe(smallReads);
  });
});
