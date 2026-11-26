import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { buildCitationComment, type FindingCitation } from "./citation.js";
import { CITATION_STATES_FILE, citationStateKey, sweepCitationStates } from "./citation-states.js";

let store: { path: string; cleanup: () => void };
let repo: { path: string; cleanup: () => void };
let first: string;

const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo.path, encoding: "utf8" }).trim();
const cited = (bullet: string, citation: Partial<FindingCitation>) => `${bullet}\n  ${buildCitationComment({ created_at: "2026-11-01T00:00:00.000Z", ...citation })}\n`;
const statesFile = () => path.join(store.path, ".runtime", CITATION_STATES_FILE);

function markdown(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(store.path, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) files[path.join(entry.parentPath, entry.name)] = fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

beforeEach(() => {
  store = makeTempDir("phren-citation-states-");
  repo = makeTempDir("phren-citation-states-repo-");
  git("init", "-q");
  fs.writeFileSync(path.join(repo.path, "a.ts"), "one\ntwo\nthree\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  first = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo.path, "a.ts"), "one\nTWO\nthree\n");
  git("commit", "-qam", "second");
  const findings = path.join(store.path, "proj", "FINDINGS.md");
  const topics = path.join(store.path, "proj", "reference", "topics");
  writeFile(findings, "# Findings\n\n## 2026-11-01\n\n"
    + cited("- Line one opens the module <!-- fid:abcd1234 -->", { repo: repo.path, commit: first, file: "a.ts", line: 1 })
    + cited("- Line two is where the parser starts", { repo: repo.path, commit: first, file: "a.ts", line: 2 })
    + cited("- A bare timestamp names nothing", {}));
  writeFile(path.join(topics, "api.md"), "# api\n\n" + cited("- Line three closes the module", { repo: repo.path, commit: first, file: "a.ts", line: 3 }));
  writeFile(path.join(topics, "api.older.md"), "# api\n\n" + cited("- The other laptop's checkout had this", { repo: "/Users/someone-else/Projects/app", commit: first, file: "a.ts", line: 1 }));
});

afterEach(() => {
  store.cleanup();
  repo.cleanup();
});

describe("sweepCitationStates", () => {
  it("records every tier's citations machine-locally, resuming where the git budget ran out", () => {
    const findings = path.join(store.path, "proj", "FINDINGS.md");
    const topics = path.join(store.path, "proj", "reference", "topics");
    const keys = {
      one: "fid:abcd1234",
      two: citationStateKey(findings, "- Line two is where the parser starts"),
      three: citationStateKey(path.join(topics, "api.md"), "- Line three closes the module"),
      older: citationStateKey(path.join(topics, "api.older.md"), "- The other laptop's checkout had this"),
    };
    const before = markdown();

    // rev-parse, cat-file and a blame for the first finding, one more blame for the second.
    const firstRun = sweepCitationStates(store.path, [{ storePath: store.path, project: "proj" }], { maxGitCalls: 4 });
    expect(firstRun).toMatchObject({ checked: 2, pending: 2, gitCalls: 4 });
    expect(Object.keys(JSON.parse(fs.readFileSync(statesFile(), "utf8"))).sort()).toEqual([keys.one, keys.two].sort());

    const secondRun = sweepCitationStates(store.path, [{ storePath: store.path, project: "proj" }], { maxGitCalls: 4 });
    expect(secondRun.pending).toBe(0);
    const saved = JSON.parse(fs.readFileSync(statesFile(), "utf8"));
    expect(Object.fromEntries(Object.entries(saved).map(([key, entry]) => [key, (entry as { state: string }).state]))).toEqual({
      [keys.one]: "valid",
      [keys.two]: "drifted",
      [keys.three]: "valid",
      [keys.older]: "unverifiable",
    });
    expect(Number.isFinite(Date.parse(saved[keys.older].checkedAt))).toBe(true);
    expect(markdown()).toEqual(before);
  });

  it("stays bounded: drops entries not checked for a month and keeps the newest 5000", () => {
    const now = Date.now();
    writeFile(statesFile(), JSON.stringify({
      "fid:00000001": { state: "broken", checkedAt: new Date(now - 40 * 86_400_000).toISOString() },
      "fid:00000002": { state: "valid", checkedAt: new Date(now - 2 * 86_400_000).toISOString() },
      "fid:00000003": { state: "not-a-state", checkedAt: new Date(now).toISOString() },
    }));

    const { states } = sweepCitationStates(store.path, [{ storePath: store.path, project: "proj" }], { now });
    expect(states["fid:00000001"]).toBeUndefined();
    expect(states["fid:00000002"].state).toBe("valid");
    expect(states["fid:00000003"]).toBeUndefined();
    expect(Object.keys(states)).toHaveLength(5);

    const crowded = Object.fromEntries(Array.from({ length: 5010 }, (_, i) => [`hash:${i}`, { state: "valid", checkedAt: new Date(now - 86_400_000).toISOString() }]));
    writeFile(statesFile(), JSON.stringify(crowded));
    const bounded = sweepCitationStates(store.path, [{ storePath: store.path, project: "proj" }], { now });
    expect(Object.keys(JSON.parse(fs.readFileSync(statesFile(), "utf8")))).toHaveLength(5000);
    expect(bounded.states["fid:abcd1234"].state).toBe("valid");
  });

  it("checks a citation that names its repo by remote against this computer's clone of it", () => {
    git("remote", "add", "origin", "git@github.com:acme/parser.git");
    writeFile(path.join(store.path, "proj", "phren.project.yaml"), `sourcePath: ${repo.path}\n`);
    const findings = path.join(store.path, "proj", "FINDINGS.md");
    fs.appendFileSync(findings, cited("- Written on the other laptop <!-- fid:feed0001 -->", { remote: "github.com/acme/parser", commit: first, file: "a.ts" })
      + cited("- Cites a file that was never committed <!-- fid:feed0002 -->", { remote: "github.com/acme/parser", commit: first, file: "b.ts" })
      + cited("- Cites a repo this computer has no clone of <!-- fid:feed0003 -->", { remote: "github.com/acme/other", commit: first, file: "a.ts" }));
    const { states } = sweepCitationStates(store.path, [{ storePath: store.path, project: "proj" }], { save: false });
    expect([states["fid:feed0001"]?.state, states["fid:feed0002"]?.state, states["fid:feed0003"]?.state]).toEqual(["valid", "unverifiable", "unverifiable"]);
  });

  it("writes nothing when asked not to save", () => {
    sweepCitationStates(store.path, [{ storePath: store.path, project: "proj" }], { save: false });
    expect(fs.existsSync(statesFile())).toBe(false);
  });
});
