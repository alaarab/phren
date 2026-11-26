import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIndex, type SqlJsDatabase } from "../shared/index.js";
import { queryDocRows } from "../index-query.js";
import { applyTrustFilter } from "../shared/retrieval.js";
import { citationGitCallCount } from "../content/citation.js";
import { sweepCitationStates } from "../content/citation-states.js";
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

// No fid: the state is keyed by the bullet's text, which the index rewrites (it drops `created`, turns `source` into `[from:…]`).
describe("a finding without a fid keeps its recorded state through the index", () => {
  let tmp: { path: string; cleanup: () => void };
  let db: SqlJsDatabase;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    tmp = makeTempDir("recall-citation-nofid-");
    const repo = path.join(tmp.path, "checkout");
    const store = path.join(tmp.path, "store");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "src", "zebra.ts"), "zebra\n");
    git("add", "-A");
    git("commit", "-qm", "add zebra.ts");
    const commit = git("rev-parse", "HEAD");
    git("rm", "-q", "src/zebra.ts");
    git("commit", "-qm", "drop zebra.ts");
    git("remote", "add", "origin", "https://github.com/acme/widgets.git");
    fs.mkdirSync(path.join(store, "widgets"), { recursive: true });
    initTestPhrenRoot(store);
    fs.writeFileSync(path.join(store, "widgets", "phren.project.yaml"), `sourcePath: ${repo}\n`);
    const cite = `  <!-- phren:cite ${JSON.stringify({ created_at: new Date().toISOString(), remote: "github.com/acme/widgets", file: "src/zebra.ts", commit })} -->`;
    fs.writeFileSync(path.join(store, "widgets", "FINDINGS.md"), [
      "# widgets Findings", "", `## ${today}`, "",
      `- The quokka exporter skips zebrafish archives on weekends <!-- created: ${today} -->`, cite,
      `- The quokka importer drops zebrafish manifests on holidays <!-- created: ${today} --> <!-- source:agent machine:laptop actor:tester -->`, cite,
      "- The quokka exporter writes zebrafish reports nightly",
      "",
    ].join("\n"));
    const sweep = sweepCitationStates(store, [{ storePath: store, project: "widgets" }]);
    expect(Object.values(sweep.states).map(entry => entry.state)).toEqual(["broken", "broken"]);
    db = await buildIndex(store);
  });
  afterAll(() => tmp?.cleanup());

  it("drops both broken findings on the prompt path and reports them as conflicts", async () => {
    const store = path.join(tmp.path, "store");
    const result = await runPromptPipeline({ prompt: "quokka zebrafish", phrenPath: store, db, detectedProject: "widgets" });
    const filtered = result.selectedRows.map(row => row.doc.content).join("\n");
    expect(filtered).toContain("writes zebrafish reports nightly");
    expect(filtered).not.toContain("skips zebrafish archives");
    expect(filtered).not.toContain("drops zebrafish manifests");
    const rows = queryDocRows(db, "SELECT project, filename, type, content, path FROM docs WHERE project = ? AND filename = ?", ["widgets", "FINDINGS.md"]) ?? [];
    const conflicts = applyTrustFilter(rows, 120, 0, {}, store).queueItems.filter(item => item.section === "Conflicts").flatMap(item => item.items);
    expect(conflicts).toEqual([expect.stringContaining("skips zebrafish archives"), expect.stringContaining("drops zebrafish manifests")]);
  });
});

// A legacy citation names the repo by its path on the writing computer. Here that repo is on this computer, so a live check would start git.
describe("legacy repo citations on the indexed prompt path", () => {
  let tmp: { path: string; cleanup: () => void };
  let db: SqlJsDatabase;
  let store: string;
  const today = new Date().toISOString().slice(0, 10);
  const injected = async () => {
    const result = await runPromptPipeline({ prompt: "quokka exporter zebrafish", phrenPath: store, db, detectedProject: "widgets" });
    return result.selectedRows.map(row => row.doc.content).join("\n");
  };

  beforeAll(async () => {
    tmp = makeTempDir("recall-citation-legacy-");
    const repo = path.join(tmp.path, "checkout");
    store = path.join(tmp.path, "store");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "src", "quokka.ts"), "quokka\nexport\n");
    fs.writeFileSync(path.join(repo, "src", "zebra.ts"), "zebra\n");
    fs.writeFileSync(path.join(repo, "src", "heron.ts"), "heron\n");
    git("add", "-A");
    git("commit", "-qm", "first");
    const commit = git("rev-parse", "HEAD");
    git("rm", "-q", "src/zebra.ts");
    fs.writeFileSync(path.join(repo, "src", "heron.ts"), "heron changed\n");
    git("commit", "-qam", "drop zebra.ts, change heron.ts");
    const cite = (fields: Record<string, unknown>) => `  <!-- phren:cite ${JSON.stringify({ created_at: new Date().toISOString(), ...fields })} -->`;
    const legacy = (file: string, line: number) => cite({ repo, file, line, commit });
    fs.mkdirSync(path.join(store, "widgets"), { recursive: true });
    initTestPhrenRoot(store);
    const findings = path.join(store, "widgets", "FINDINGS.md");
    fs.writeFileSync(findings, [
      "# widgets Findings", "", `## ${today}`, "",
      "- The quokka exporter writes zebrafish manifests nightly <!-- fid:feed0101 -->", legacy("src/quokka.ts", 1),
      "- The quokka exporter skips zebrafish archives on weekends <!-- fid:feed0102 -->", legacy("src/zebra.ts", 1),
      "- The quokka exporter retries zebrafish uploads twice <!-- fid:feed0103 -->", legacy("src/heron.ts", 1),
      "- The quokka exporter compresses zebrafish logs <!-- fid:feed0105 -->", cite({}),
      "- The quokka exporter signs zebrafish bundles <!-- fid:feed0106 -->",
      "",
    ].join("\n"));
    const sweep = sweepCitationStates(store, [{ storePath: store, project: "widgets" }]);
    expect(Object.fromEntries(Object.entries(sweep.states).map(([key, entry]) => [key, entry.state]))).toEqual({
      "fid:feed0101": "valid", "fid:feed0102": "broken", "fid:feed0103": "drifted",
    });
    // Written after the sweep, so no state is recorded for it.
    fs.appendFileSync(findings, `- The quokka exporter batches zebrafish reports hourly <!-- fid:feed0104 -->\n${legacy("src/quokka.ts", 2)}\n`);
    db = await buildIndex(store);
  });
  afterAll(() => tmp?.cleanup());

  it("drops the finding the sweep recorded broken, reports it as a conflict and starts no git", async () => {
    const gitBefore = citationGitCallCount();
    const filtered = await injected();
    expect(citationGitCallCount() - gitBefore).toBe(0);
    expect(filtered).not.toContain("skips zebrafish archives");
    for (const kept of ["writes zebrafish manifests", "retries zebrafish uploads", "batches zebrafish reports", "compresses zebrafish logs", "signs zebrafish bundles"]) {
      expect(filtered).toContain(kept);
    }
    const rows = queryDocRows(db, "SELECT project, filename, type, content, path FROM docs WHERE project = ? AND filename = ?", ["widgets", "FINDINGS.md"]) ?? [];
    const conflicts = applyTrustFilter(rows, 120, 0, {}, store).queueItems.filter(item => item.section === "Conflicts").flatMap(item => item.items);
    expect(conflicts).toEqual([expect.stringContaining("skips zebrafish archives")]);
  });

  it("does not count a cited finding as uncited: at 0.9 confidence only valid and unrecorded citations pass", async () => {
    // Fresh findings: cited 1.0, uncited or a bare created_at 0.8, drifted 0.7.
    const policy = path.join(store, ".config", "retention-policy.json");
    fs.writeFileSync(policy, JSON.stringify({ minInjectConfidence: 0.9 }));
    try {
      const filtered = await injected();
      expect(filtered).toContain("writes zebrafish manifests");
      expect(filtered).toContain("batches zebrafish reports");
      for (const dropped of ["skips zebrafish archives", "retries zebrafish uploads", "compresses zebrafish logs", "signs zebrafish bundles"]) {
        expect(filtered).not.toContain(dropped);
      }
    } finally {
      fs.rmSync(policy, { force: true });
    }
  });
});
