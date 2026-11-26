import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { buildCitationComment, checkFindingCitation, citationGitCallCount, type FindingCitation } from "./citation.js";
import { applyTrustFilter } from "../shared/retrieval.js";
import { checkedOutCommit, checkoutForRemote, citationRemote, projectCheckout } from "./citation-checkouts.js";

const REMOTE = "github.com/acme/widgets";

describe("citationRemote", () => {
  it("names a clone URL by host and path, without credentials, user name, port or .git", () => {
    for (const url of [
      "https://github.com/acme/widgets.git",
      "https://x-access-token:not-a-real-token@github.com/acme/widgets",
      "http://someone@GitHub.com/acme/widgets/",
      "ssh://git@github.com:2222/acme/widgets.git",
      "git@github.com:acme/widgets.git",
      "git://github.com/acme/widgets",
    ]) expect(citationRemote(url)).toBe(REMOTE);
    expect(citationRemote("https://gitlab.example.com/Group/sub/App.git")).toBe("gitlab.example.com/Group/sub/App");
  });

  it("is undefined for a local path or anything else that is not a clone URL", () => {
    for (const url of ["/srv/git/widgets.git", "file:///srv/git/widgets.git", "../widgets", "C:\\repos\\widgets", "C:/repos/widgets", ""]) {
      expect(citationRemote(url)).toBeUndefined();
    }
  });
});

// One repo cloned twice: `writer` stands for the computer that wrote the citation, `here` for this one.
describe("a citation written on another computer", () => {
  let root: { path: string; cleanup: () => void };
  let store: string;
  let writer: string;
  let here: string;
  let first: string;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
  const cite = (extra: Partial<FindingCitation>): FindingCitation => ({ created_at: "2026-11-01T00:00:00.000Z", remote: REMOTE, ...extra });
  const check = (citation: FindingCitation) => checkFindingCitation(citation, { phrenPath: store });
  const clone = (name: string, remote = `https://github.com/acme/widgets.git`) => {
    const dir = path.join(root.path, "projects", name);
    git(root.path, "clone", "-q", writer, dir);
    git(dir, "remote", "set-url", "origin", remote);
    return dir;
  };

  beforeEach(() => {
    root = makeTempDir("phren-portable-cite-");
    vi.stubEnv("HOME", path.join(root.path, "home"));
    vi.stubEnv("PROJECTS_DIR", path.join(root.path, "projects"));
    store = path.join(root.path, "store");
    writer = path.join(root.path, "writer", "widgets");
    fs.mkdirSync(writer, { recursive: true });
    git(writer, "init", "-q");
    writeFile(path.join(writer, "src", "a.ts"), "one\ntwo\nthree\n");
    git(writer, "add", "-A");
    git(writer, "commit", "-qm", "first");
    first = git(writer, "rev-parse", "HEAD");
    fs.mkdirSync(path.join(store, "widgets"), { recursive: true });
    here = clone("widgets");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    root.cleanup();
  });

  it("resolves its remote to this computer's clone and checks the file there", () => {
    expect(checkoutForRemote(store, REMOTE)).toBe(here);
    expect(check(cite({ commit: first, file: "src/a.ts", line: 2 }))).toBe("valid");
    expect(check(cite({ commit: first }))).toBe("valid");
  });

  it("is drifted when the cited line changed in this clone since the cited commit", () => {
    fs.writeFileSync(path.join(here, "src", "a.ts"), "one\nTWO\nthree\n");
    git(here, "commit", "-qam", "second");
    expect(check(cite({ commit: first, file: "src/a.ts", line: 2 }))).toBe("drifted");
  });

  it("is broken only when the file was in the cited commit and is gone from this clone's history since", () => {
    git(here, "rm", "-q", "src/a.ts");
    git(here, "commit", "-qm", "drop a.ts");
    expect(check(cite({ commit: first, file: "src/a.ts", line: 2 }))).toBe("broken");
    // A file the writer had not committed yet proves nothing by being absent.
    expect(check(cite({ commit: first, file: "src/new.ts" }))).toBe("unverifiable");
  });

  it("is unverifiable, never broken, when this clone does not have the cited commit yet", () => {
    writeFile(path.join(writer, "src", "b.ts"), "bee\n");
    git(writer, "add", "-A");
    git(writer, "commit", "-qm", "add b.ts");
    expect(check(cite({ commit: git(writer, "rev-parse", "HEAD"), file: "src/b.ts", line: 1 }))).toBe("unverifiable");
  });

  it("is unverifiable, never broken, when the cited commit is fetched but another branch is checked out", () => {
    writeFile(path.join(writer, "src", "b.ts"), "bee\n");
    git(writer, "add", "-A");
    git(writer, "commit", "-qm", "add b.ts");
    const second = git(writer, "rev-parse", "HEAD");
    git(here, "fetch", "-q", writer, "HEAD");
    git(here, "checkout", "-q", "-b", "old", first);
    expect(check(cite({ commit: second, file: "src/b.ts", line: 1 }))).toBe("unverifiable");
  });

  it("is unverifiable, not drifted, when the cited commit is fetched but not in this clone's history", () => {
    fs.writeFileSync(path.join(writer, "src", "a.ts"), "one\nTWO\nthree\n");
    git(writer, "commit", "-qam", "second");
    const second = git(writer, "rev-parse", "HEAD");
    git(here, "fetch", "-q", writer, "HEAD");
    expect(check(cite({ commit: second, file: "src/a.ts", line: 2 }))).toBe("unverifiable");
  });

  it("checks history again after this clone moves to another commit", () => {
    writeFile(path.join(here, "src", "new.ts"), "new\n");
    git(here, "add", "-A");
    git(here, "commit", "-qm", "add new.ts");
    const added = git(here, "rev-parse", "HEAD");
    git(here, "rm", "-q", "src/new.ts");
    git(here, "commit", "-qm", "drop new.ts");
    expect(check(cite({ commit: added, file: "src/new.ts" }))).toBe("broken");
    git(here, "checkout", "-q", first);
    expect(check(cite({ commit: added, file: "src/new.ts" }))).toBe("unverifiable");
  });

  it("is unverifiable when no clone here has that remote, or no store is given to look in", () => {
    expect(check(cite({ remote: "github.com/acme/elsewhere", commit: first, file: "src/gone.ts" }))).toBe("unverifiable");
    expect(checkFindingCitation(cite({ commit: first, file: "src/a.ts" }))).toBe("unverifiable");
  });

  it("matches a remote whatever the case of its path", () => {
    expect(checkoutForRemote(store, "github.com/Acme/Widgets")).toBe(here);
  });

  it("never uses a same-named folder whose origin is another remote", () => {
    fs.rmSync(here, { recursive: true, force: true });
    clone("widgets", "git@github.com:someone-else/widgets.git");
    expect(checkoutForRemote(store, REMOTE)).toBeUndefined();
    expect(check(cite({ commit: first, file: "src/a.ts", line: 2 }))).toBe("unverifiable");
  });

  it("finds a clone through the project's registered folder", () => {
    const registered = path.join(root.path, "elsewhere", "w");
    fs.mkdirSync(path.dirname(registered));
    fs.renameSync(here, registered);
    writeFile(path.join(store, "widgets", "phren.project.yaml"), `sourcePath: ${registered}\n`);
    expect(projectCheckout(store, "widgets")).toBe(registered);
    expect(checkoutForRemote(store, REMOTE)).toBe(registered);
    expect(check(cite({ commit: first, file: "src/a.ts", line: 2 }))).toBe("valid");
  });

  it("relocates another computer's repo path to a same-named checkout only for the sweep, and only when it has the commit", () => {
    const old: FindingCitation = { created_at: "2026-11-01T00:00:00.000Z", repo: "/Users/someone-else/Projects/widgets", commit: first, file: "/Users/someone-else/Projects/widgets/src/a.ts", line: 2 };
    expect(check(old)).toBe("unverifiable");
    expect(checkFindingCitation(old, { phrenPath: store, relocate: true })).toBe("valid");
    git(here, "rm", "-q", "src/a.ts");
    git(here, "commit", "-qm", "drop a.ts");
    expect(checkFindingCitation(old, { phrenPath: store, relocate: true })).toBe("broken");
    const unknownCommit = { ...old, commit: "0123456789abcdef0123456789abcdef01234567" };
    expect(checkFindingCitation(unknownCommit, { phrenPath: store, relocate: true })).toBe("unverifiable");
    const noCommit = { ...old, commit: undefined };
    expect(checkFindingCitation(noCommit, { phrenPath: store, relocate: true })).toBe("unverifiable");
  });

  it("finds a monorepo clone through a project registered at a folder inside it", () => {
    const mono = path.join(root.path, "elsewhere", "mono");
    fs.mkdirSync(path.dirname(mono));
    fs.renameSync(here, mono);
    fs.mkdirSync(path.join(mono, "packages", "frontend"), { recursive: true });
    writeFile(path.join(store, "widgets", "phren.project.yaml"), `sourcePath: ${path.join(mono, "packages", "frontend")}\n`);
    expect(projectCheckout(store, "widgets")).toBe(mono);
    expect(checkoutForRemote(store, REMOTE)).toBe(mono);
  });

  it("follows a loose symbolic ref before packed refs, so a stale packed commit never stands in for HEAD", () => {
    const base = git(here, "symbolic-ref", "--short", "HEAD");
    git(here, "checkout", "-q", "-b", "alias");
    writeFile(path.join(here, "src", "new.ts"), "new\n");
    git(here, "add", "-A");
    git(here, "commit", "-qm", "add new.ts");
    const added = git(here, "rev-parse", "HEAD");
    git(here, "rm", "-q", "src/new.ts");
    git(here, "commit", "-qm", "drop new.ts");
    git(here, "checkout", "-q", base);
    git(here, "pack-refs", "--all");
    fs.writeFileSync(path.join(here, ".git", "refs", "heads", "alias"), `ref: refs/heads/${base}\n`);
    fs.writeFileSync(path.join(here, ".git", "HEAD"), "ref: refs/heads/alias\n");
    expect(git(here, "rev-parse", "HEAD")).toBe(first);
    expect(checkedOutCommit(here)).toBe(first);
    expect(check(cite({ commit: added, file: "src/new.ts" }))).toBe("unverifiable");
  });

  it("never walks up from a registered folder that is gone to the repo around it", () => {
    const outer = path.join(root.path, "outer");
    fs.mkdirSync(outer);
    git(outer, "init", "-q");
    fs.rmSync(here, { recursive: true, force: true });
    writeFile(path.join(store, "widgets", "phren.project.yaml"), `sourcePath: ${path.join(outer, "vendor", "old-project")}\n`);
    expect(projectCheckout(store, "widgets")).toBeUndefined();
  });

  it("costs the prompt hook no git process or folder scan: a remote citation takes the state this computer's sweep recorded", () => {
    // Store projects with clones, and a user git config whose include would make every candidate ask git.
    writeFile(path.join(root.path, "home", ".gitconfig"), "[include]\n\tpath = extra.gitconfig\n");
    for (let i = 0; i < 12; i++) {
      clone(`p${i}`, `https://github.com/acme/p${i}.git`);
      fs.mkdirSync(path.join(store, `p${i}`));
    }
    git(here, "rm", "-q", "src/a.ts");
    git(here, "commit", "-qm", "drop a.ts");
    const today = new Date().toISOString().slice(0, 10);
    const findings = path.join(store, "widgets", "FINDINGS.md");
    const content = ["# Findings", "", `## ${today}`, "",
      "- No clone of this repo here <!-- fid:feed0001 -->", `  ${buildCitationComment(cite({ remote: "github.com/acme/missing", commit: first, file: "src/a.ts", line: 2 }))}`,
      "- Recorded broken by the sweep <!-- fid:feed0002 -->", `  ${buildCitationComment(cite({ commit: first, file: "src/a.ts", line: 2 }))}`,
      "- Not swept yet <!-- fid:feed0003 -->", `  ${buildCitationComment(cite({ commit: first, file: "src/a.ts", line: 1 }))}`,
      ""].join("\n");
    writeFile(findings, content);
    writeFile(path.join(store, ".runtime", "citation-states.json"), JSON.stringify({ "fid:feed0002": { state: "broken", checkedAt: new Date().toISOString() } }));
    const before = citationGitCallCount();
    const result = applyTrustFilter([{ project: "widgets", filename: "FINDINGS.md", type: "findings", content, path: findings }], 120, 0, {}, store);
    expect(citationGitCallCount() - before).toBe(0);
    expect(result.rows[0].content).toContain("No clone of this repo here");
    expect(result.rows[0].content).toContain("Not swept yet");
    expect(result.rows[0].content).not.toContain("Recorded broken by the sweep");
    // The daily sweep, which may run git, reaches the same verdict on its own.
    expect(check(cite({ commit: first, file: "src/a.ts", line: 2 }))).toBe("broken");
  });
});
