import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTestPhrenRoot, writeFile } from "../test-helpers.js";
import { budgetDoctorCheck, collectStoreHealth, recordStoreHealth } from "./store-health.js";
import { qualityMarkers } from "../shared.js";

let scratch: string;
let primary: string;
const now = new Date("2026-11-25T12:00:00.000Z");

beforeEach(() => {
  fs.mkdirSync(".scratch", { recursive: true });
  scratch = fs.mkdtempSync(path.resolve(".scratch/store-health-"));
  primary = path.join(scratch, "personal");
  fs.mkdirSync(primary);
  initTestPhrenRoot(primary);
  vi.stubEnv("PHREN_PATH", primary);
  vi.stubEnv("PHREN_FEDERATION_PATHS", "");
  vi.stubEnv("PHREN_PROFILE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(scratch, { recursive: true, force: true });
});

function put(store: string, file: string, content: string): void {
  writeFile(path.join(store, file), content);
}

function citation(fields: Record<string, string> = {}): string {
  return `  <!-- phren:cite ${JSON.stringify({ created_at: now.toISOString(), ...fields })} -->`;
}

function attachTeam(legacy = false): string {
  const team = path.join(scratch, "team");
  fs.mkdirSync(team);
  initTestPhrenRoot(team);
  const personalEntry = { id: "aaaaaaaa", name: "personal", path: primary, role: "primary", sync: "managed-git" };
  const teamEntry = { id: "bbbbbbbb", name: "team", path: team, role: "team", sync: "managed-git", projects: ["proj"] };
  put(primary, "stores.yaml", JSON.stringify({ version: 1, stores: legacy ? [personalEntry, teamEntry] : [personalEntry] }));
  if (!legacy) put(primary, ".runtime/attached-stores.yaml", JSON.stringify({ version: 1, stores: [teamEntry] }));
  put(team, "proj/FINDINGS.md", "- Repeat me <!-- fid:11111111 -->\n");
  put(team, "excluded/FINDINGS.md", "- Outside subscription\n");
  return team;
}

function recordedLines(): Array<Record<string, unknown>> {
  return fs.readFileSync(path.join(primary, ".runtime/store-health.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}

describe("store health collection", () => {
  it("counts physical tiers, lifecycle states, extra duplicates, citation coverage, tasks and review across subscribed stores", () => {
    const team = attachTeam();
    put(primary, "proj/FINDINGS.md", [
      "# Findings", "## 2026-11-25",
      "- Repeat me <!-- fid:11111111 -->", citation(),
      "- repeat   ME [confidence 0.7] <!-- fid:22222222 -->", citation({ file: "src/a.ts", commit: "abc", symbol: "run" }),
      '- Legacy retired <!-- fid:33333333 --> <!-- superseded_by: "replacement" -->', citation({ commit: "def" }),
      '- Conflicting <!-- conflicts_with: "other rule" -->', citation({ symbol: "thing" }),
      '- Stale <!-- fid:44444444 --> <!-- phren:status "stale" -->',
      '- Invalid <!-- fid:55555555 --> <!-- phren:status "invalid_citation" -->',
      "- Missing id and broken citation", "  <!-- phren:cite {broken} -->",
      '<!-- phren:archive:start -->',
      '- Retracted <!-- fid:66666666 --> <!-- phren:status "retracted" -->',
      '<!-- phren:archive:end -->',
    ].join("\n"));
    put(primary, "proj/reference/topics/rules.md", [
      "<!-- phren:now:start -->", "## Now", "- Generated summary", "<!-- phren:now:end -->",
      "## Archived 2026-10-01", "### A heading, not a bullet", "A paragraph, not a bullet",
      "- REPEAT me <!-- fid:11111111 -->", citation({ file: "src/b.ts" }),
      '- Archived unique <!-- fid:77777777 --> <!-- phren:status "contradicted" -->',
    ].join("\n"));
    put(primary, "proj/reference/topics/orphan.older.md", "- repeat me <!-- fid:11111111 -->\n- Older unique\n");
    put(primary, "proj/reference/topics/ignored.txt", "- Not a topic\n");
    put(primary, "other/FINDINGS.md", "- Repeat me <!-- fid:11111111 -->\n");
    put(primary, "proj/tasks.md", "# Tasks\n## Active\n- Working\n- Also working\n## Queue\n- Later\n## Done\n- Finished\n- Also finished\n");
    put(primary, "proj/review.md", "# Review\n## Review\n- Review me\n## Stale\n- Old\n## Conflicts\n- Conflict\n");
    const result = collectStoreHealth(primary, now, "test-computer");
    expect(result.at).toBe("2026-11-25T12:00:00.000Z");
    expect(result.computer).toBe("test-computer");
    expect(result.stores.map(store => [store.name, store.path])).toEqual([["personal", "."], ["team", "../team"]]);
    const project = result.stores[0].projects.find(row => row.project === "proj");
    expect(project).toEqual({
      project: "proj", activeFindings: 8, archivedBullets: 2, olderBullets: 2,
      retiredBullets: 2, contradictedBullets: 2, bulletsWithoutFid: 3,
      duplicateFids: 2, duplicateTexts: 3,
      citations: { none: 7, timestampOnly: 1, withFile: 2, withCommit: 2, withSymbol: 2, withRemote: 0 },
      checkableCitations: { any: 0, withFile: 0 },
      openTasks: 3, doneTasks: 2, reviewEntries: 3,
    });
    expect(result.stores[0].citationCoverage).toBe(0);
    expect(result.stores[0].totals).toEqual({
      activeFindings: 9, archivedBullets: 2, olderBullets: 2,
      retiredBullets: 2, contradictedBullets: 2, bulletsWithoutFid: 3,
      duplicateFids: 2, duplicateTexts: 3,
      citations: { none: 8, timestampOnly: 1, withFile: 2, withCommit: 2, withSymbol: 2, withRemote: 0 },
      checkableCitations: { any: 0, withFile: 0 },
      openTasks: 3, doneTasks: 2, reviewEntries: 3,
    });
    expect(result.stores[1].projects).toEqual([{
      project: "proj", activeFindings: 1, archivedBullets: 0, olderBullets: 0,
      retiredBullets: 0, contradictedBullets: 0, bulletsWithoutFid: 0,
      duplicateFids: 0, duplicateTexts: 0,
      citations: { none: 1, timestampOnly: 0, withFile: 0, withCommit: 0, withSymbol: 0, withRemote: 0 },
      checkableCitations: { any: 0, withFile: 0 },
      openTasks: 0, doneTasks: 0, reviewEntries: 0,
    }]);
    expect(fs.existsSync(path.join(team, ".runtime"))).toBe(false);
    expect(result.recall).toBeNull();
  });

  it("reads a moved primary and legacy attachments without migrating or writing either store", () => {
    const team = attachTeam(true);
    put(primary, "proj/FINDINGS.md", "- Local finding\n");
    const registry = JSON.parse(fs.readFileSync(path.join(primary, "stores.yaml"), "utf8"));
    registry.stores[0].path = path.join(scratch, "old-primary-location");
    put(primary, "stores.yaml", JSON.stringify(registry));
    const result = collectStoreHealth(primary, now, "test-computer");
    expect(result.stores.map(store => [store.path, store.totals.activeFindings])).toEqual([[".", 1], ["../team", 1]]);
    expect(fs.existsSync(path.join(primary, ".runtime"))).toBe(false);
    expect(fs.existsSync(path.join(team, ".runtime"))).toBe(false);
  });

  it("reports the share of active findings whose citation this computer checked to a decided state", () => {
    const remote = { remote: "github.com/acme/widgets", commit: "abc1234" };
    put(primary, "proj/FINDINGS.md", [
      "# Findings", "## 2026-11-25",
      "- Checked valid <!-- fid:aaaa0001 -->", citation({ ...remote, file: "src/a.ts" }),
      "- Checked broken <!-- fid:aaaa0002 -->", citation({ ...remote, file: "src/gone.ts" }),
      "- Anchored to a commit <!-- fid:aaaa0003 -->", citation(remote),
      "- No clone of the repo here <!-- fid:aaaa0004 -->", citation({ ...remote, file: "src/b.ts" }),
      "- Bare timestamp <!-- fid:aaaa0005 -->", citation(),
    ].join("\n"));
    put(primary, "proj/reference/topics/old.md", "## Archived 2026-10-01\n- Archived and checked <!-- fid:aaaa0006 -->\n" + citation({ ...remote, file: "src/c.ts" }) + "\n");
    put(primary, ".runtime/citation-states.json", JSON.stringify({
      "fid:aaaa0001": { state: "valid", checkedAt: now.toISOString() },
      "fid:aaaa0002": { state: "broken", checkedAt: now.toISOString() },
      "fid:aaaa0003": { state: "valid", checkedAt: now.toISOString() },
      "fid:aaaa0004": { state: "unverifiable", checkedAt: now.toISOString() },
      "fid:aaaa0006": { state: "valid", checkedAt: now.toISOString() },
    }));
    const store = collectStoreHealth(primary, now, "test-computer").stores[0];
    expect(store.totals.checkableCitations).toEqual({ any: 3, withFile: 2 });
    expect(store.totals.citations.withRemote).toBe(5);
    expect(store.citationCoverage).toBe(0.6);
  });

  it("measures primary logical file bytes recursively without following symlinks", () => {
    put(primary, ".runtime/cache/nested/a", "abc");
    put(primary, ".runtime/cache/b", "é");
    put(primary, ".runtime/log.jsonl", "1234\n");
    put(primary, "outside/large", "outside runtime");
    fs.symlinkSync(path.join(primary, "outside"), path.join(primary, ".runtime/external"), "dir");
    fs.symlinkSync(path.join(primary, ".runtime/cache"), path.join(primary, ".runtime/cache/cycle"), "dir");
    expect(collectStoreHealth(primary, now, "test-computer").runtimeBytes).toEqual({ cache: 5, external: 0, "log.jsonl": 5 });
  });

  it("aggregates only valid trace rows in the last 24 hours and tolerates torn or malformed data", () => {
    const recent = "2026-11-25T11:00:00.000Z";
    const trace = [
      { at: recent, injected: [{ path: "a" }, { path: "b" }], suppressedRepeats: 3 },
      { at: recent, abstained: "below-floor", injected: [], suppressedRepeats: 1 },
      { at: recent, abstained: "below-floor" },
      { at: "2026-11-24T12:00:00.000Z", abstained: "no-candidates" },
      { at: recent, skipped: "machine-prompt" },
      { at: recent, skipped: "no-keywords" },
      { at: recent, injected: "wrong", abstained: 5, suppressedRepeats: -7, taskCapturePaused: { open: 3, budget: 2 } },
      { at: "2026-11-24T11:59:59.999Z", injected: [{}], suppressedRepeats: 10 },
      { at: "2026-11-25T12:00:00.001Z", abstained: "future" },
      { at: "invalid" }, null, [], { other: "missing date" },
    ].map(row => JSON.stringify(row));
    put(primary, ".runtime/recall-trace.jsonl", trace.join("\n") + '\n{"at":');
    expect(collectStoreHealth(primary, now, "test-computer").recall).toEqual({
      prompts: 7, injected: 1, abstained: 3, skipped: 2, suppressedRepeats: 4, taskCapturePaused: 1,
      byAbstainReason: { "below-floor": 2, "no-candidates": 1 }, clankerIds: { injected: 0, opened: 0 },
    });
    put(primary, ".runtime/recall-trace.jsonl", "");
    expect(collectStoreHealth(primary, now, "test-computer").recall).toEqual({
      prompts: 0, injected: 0, abstained: 0, skipped: 0, suppressedRepeats: 0, taskCapturePaused: 0, byAbstainReason: {},
      clankerIds: { injected: 0, opened: 0 },
    });
  });

  it("counts clanker ids injected in the last 24 hours and the ones the same session opened afterwards", () => {
    const row = (id?: string) => ({ path: "app/FINDINGS.md", key: "k", type: "findings", ...(id ? { id } : {}) });
    const trace = [
      { at: "2026-11-25T10:00:00.000Z", session: "s1", injected: [row("fid:aaaa1111"), row("mem:app/summary.md"), row()] },
      { at: "2026-11-25T10:05:00.000Z", session: "s1", injected: [row("fid:aaaa1111")] },
      { at: "2026-11-25T10:00:00.000Z", session: "s2", injected: [row("fid:aaaa1111"), row("fid:bbbb2222")] },
      { at: "2026-11-25T10:00:00.000Z", injected: [row("fid:cccc3333")] },
      { at: "2026-11-24T10:00:00.000Z", session: "s1", injected: [row("fid:dddd4444")] },
    ];
    const opens = [
      { at: "2026-11-25T10:01:00.000Z", session: "s1", id: "fid:aaaa1111" },
      { at: "2026-11-25T09:00:00.000Z", session: "s2", id: "fid:bbbb2222" },
      { at: "2026-11-25T10:01:00.000Z", session: "s3", id: "fid:aaaa1111" },
      { at: "2026-11-25T10:01:00.000Z", session: "s1", id: "fid:dddd4444" },
    ];
    put(primary, ".runtime/recall-trace.jsonl", trace.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    expect(collectStoreHealth(primary, now, "test-computer").recall?.clankerIds).toEqual({ injected: 4, opened: 0 });
    put(primary, ".runtime/memory-detail-opens.jsonl", opens.map(entry => JSON.stringify(entry)).join("\n") + '\n{"at":');
    // s1's fid opened after its first injection; s2's fid was opened only before it was injected.
    expect(collectStoreHealth(primary, now, "test-computer").recall?.clankerIds).toEqual({ injected: 4, opened: 1 });
  });

  it("returns zero totals and null recall for an empty store without creating runtime state", () => {
    const result = collectStoreHealth(primary, now, "test-computer");
    expect(result).toEqual({
      at: "2026-11-25T12:00:00.000Z", computer: "test-computer",
      stores: [{ name: "personal", path: ".", projects: [], totals: {
        activeFindings: 0, archivedBullets: 0, olderBullets: 0, retiredBullets: 0,
        contradictedBullets: 0, bulletsWithoutFid: 0, duplicateFids: 0, duplicateTexts: 0,
        citations: { none: 0, timestampOnly: 0, withFile: 0, withCommit: 0, withSymbol: 0, withRemote: 0 },
        checkableCitations: { any: 0, withFile: 0 },
        openTasks: 0, doneTasks: 0, reviewEntries: 0,
      }, citationCoverage: 0 }], runtimeBytes: {},
      runtimeClasses: { codeIndexes: 0, fanoutArchive: 0, fanouts: 0, sessions: 0, packages: 0, logs: 0, other: 0 },
      budgets: { over: [] }, recall: null,
    });
    expect(fs.existsSync(path.join(primary, ".runtime"))).toBe(false);
  });
});

describe("budgets in the health line", () => {
  it("groups runtime bytes by class and marks each component over its budget with what that stops", () => {
    put(primary, ".config/retention-policy.json", JSON.stringify({ schemaVersion: 1, budgets: { openTasks: 2, reviewEntries: 2, runtimeMB: 1, fanoutArchiveMB: 0 } }));
    put(primary, "proj/tasks.md", "# Tasks\n## Active\n- One\n## Queue\n- Two\n- Three\n## Done\n- Old\n");
    put(primary, "proj/review.md", "# Review\n## Review\n- A\n- B\n## Stale\n- C\n");
    // Past the 150 default, so only an explicit 0 keeps it off the list.
    put(primary, "calm/tasks.md", `# Tasks\n## Queue\n${Array.from({ length: 160 }, (_, i) => `- Item ${i}`).join("\n")}\n`);
    put(primary, "calm/phren.project.yaml", "config:\n  retentionPolicy:\n    budgets:\n      openTasks: 0\n");
    put(primary, "busy/tasks.md", "# Tasks\n## Queue\n- One\n- Two\n- Three\n");
    put(primary, "busy/phren.project.yaml", "config:\n  retentionPolicy:\n    budgets:\n      openTasks: 5\n");
    put(primary, ".runtime/code/proj.sqlite", "x".repeat(1_100_000));
    put(primary, ".runtime/agent-fanouts-archive/job-1/events.jsonl", "y".repeat(100));
    put(primary, ".runtime/agent-fanouts/job-2/events.jsonl", "y".repeat(10));
    put(primary, ".runtime/sessions/a.jsonl", "s");
    put(primary, ".runtime/packages/p.json", "pp");
    put(primary, ".runtime/debug.log", "z");
    put(primary, ".runtime/lookup-events.jsonl", "zz");
    put(primary, ".runtime/embeddings.json", "e");
    const result = collectStoreHealth(primary, now, "test-computer");
    expect(result.runtimeClasses).toEqual({ codeIndexes: 1_100_000, fanoutArchive: 100, fanouts: 10, sessions: 1, packages: 2, logs: 3, other: 1 });
    expect(result.budgets.over).toEqual([
      { component: "openTasks", store: "personal", project: "proj", value: 3, budget: 2, effect: "the prompt hook files no new tasks" },
      { component: "reviewEntries", store: "personal", project: "proj", value: 3, budget: 2, effect: "machine-generated entries are not queued" },
      { component: "runtimeBytes", value: 1_100_117, budget: 1_048_576, effect: "reported only" },
    ]);
  });

  it("flags the fanout archive past its ceiling, pruned only once runtime age-out is on and past its week", () => {
    put(primary, ".config/retention-policy.json", JSON.stringify({ schemaVersion: 1, budgets: { fanoutArchiveMB: 0.0001 } }));
    put(primary, ".runtime/agent-fanouts-archive/job-1/events.jsonl", "y".repeat(200));
    const row = { component: "fanoutArchiveBytes", value: 200, budget: 105 };
    expect(collectStoreHealth(primary, now, "test-computer").budgets.over).toEqual([
      { ...row, effect: "reported only until runtime age-out is on" },
    ]);
    put(primary, ".config/retention-policy.json", JSON.stringify({ schemaVersion: 1, budgets: { fanoutArchiveMB: 0.0001, runtimeAgeOut: true } }));
    put(primary, ".runtime/runtime-age-out.json", JSON.stringify({ enabledSince: "2026-11-01T00:00:00.000Z", ready: true }));
    expect(collectStoreHealth(primary, now, "test-computer").budgets.over).toEqual([
      { ...row, effect: "the archive sweep deletes the oldest finished folders" },
    ]);
  });

  it("gives doctor a warn-only line from the latest health record", () => {
    expect(budgetDoctorCheck(primary)).toEqual({ name: "budgets", ok: true, detail: "no store health recorded yet" });
    put(primary, ".config/retention-policy.json", JSON.stringify({ schemaVersion: 1, budgets: { openTasks: 1 } }));
    put(primary, "proj/tasks.md", "# Tasks\n## Queue\n- One\n- Two\n");
    recordStoreHealth(primary, now, "test-computer");
    expect(budgetDoctorCheck(primary)).toEqual({
      name: "budgets", ok: true,
      detail: "over budget on 2026-11-25: personal/proj open tasks 2 of 1 (the prompt hook files no new tasks)",
    });
    put(primary, "proj/tasks.md", "# Tasks\n## Queue\n- One\n");
    recordStoreHealth(primary, new Date(now.getTime() + 86_400_000), "test-computer");
    expect(budgetDoctorCheck(primary)).toEqual({ name: "budgets", ok: true, detail: "within budget on 2026-11-26" });
  });
});

describe("runtime age-out", () => {
  const day = 86_400_000;
  const exists = (file: string) => fs.existsSync(path.join(primary, file));
  const lastLine = () => JSON.parse(fs.readFileSync(path.join(primary, ".runtime/store-health.jsonl"), "utf8").trim().split("\n").at(-1)!) as Record<string, unknown>;
  const old = new Date(now.getTime() - 40 * day);
  const enable = () => put(primary, ".config/retention-policy.json", JSON.stringify({ schemaVersion: 1, budgets: { runtimeAgeOut: true } }));
  // A week of earlier daily report lines and an opt-in this computer saw `since` days ago.
  const pastWeek = (since: number, lines = 7) => {
    put(primary, ".runtime/store-health.jsonl", Array.from({ length: lines }, (_, i) =>
      JSON.stringify({ at: new Date(now.getTime() - (lines - i) * day).toISOString(), runtimeClasses: {} })).join("\n") + "\n");
    put(primary, ".runtime/runtime-age-out.json", JSON.stringify({ enabledSince: new Date(now.getTime() - since * day).toISOString(), ready: false }));
  };
  // A code index as the indexer leaves it: a sqlite file whose meta table records the checkout it was built from.
  const codeIndex = (name: string, repoRoot: string | null, at = old, file = path.join(primary, ".runtime/code", `${name}.sqlite`)) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    if (repoRoot) db.prepare("INSERT INTO meta (key, value) VALUES ('repo_root', ?)").run(repoRoot);
    db.close();
    fs.utimesSync(file, at, at);
    return fs.statSync(file).size;
  };
  const checkout = (dir: string, gitFile = false) => {
    fs.mkdirSync(dir, { recursive: true });
    if (gitFile) fs.writeFileSync(path.join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    else fs.mkdirSync(path.join(dir, ".git"));
    return dir;
  };
  const archived = (name: string, manifest: Record<string, unknown>) => put(primary, `.runtime/agent-fanouts-archive/${name}/manifest.json`, JSON.stringify(manifest));

  it("removes a code index only when the checkout it recorded is gone, and nothing it cannot read or does not own", () => {
    put(primary, "forked/FINDINGS.md", "- Forked\n");
    put(primary, "forked/phren.project.yaml", "remote: github.com/acme/upstream\n");
    // A store project whose clone's origin is a fork, at a path no checkout search would find.
    const forkBytes = codeIndex("forked", checkout(path.join(scratch, "odd", "place", "fork-clone")));
    // A project no store has, indexed from its own folder (a git worktree has a .git file).
    codeIndex("outside-store", checkout(path.join(scratch, "elsewhere", "worktree"), true));
    const goneBytes = codeIndex("gone", path.join(scratch, "deleted-checkout"));
    fs.mkdirSync(path.join(scratch, "not-git"));
    const notGitBytes = codeIndex("not-git", path.join(scratch, "not-git"));
    codeIndex("no-meta", null);
    put(primary, ".runtime/code/corrupt.sqlite", "not a database");
    fs.utimesSync(path.join(primary, ".runtime/code/corrupt.sqlite"), old, old);
    codeIndex("locked", path.join(scratch, "deleted-checkout"));
    put(primary, ".runtime/code/locked.sqlite.lock", "123");
    codeIndex("fresh", path.join(scratch, "deleted-checkout"), new Date(now.getTime() - day));
    const outsideIndex = path.join(scratch, "outside", "linked.sqlite");
    codeIndex("linked", path.join(scratch, "deleted-checkout"), old, outsideIndex);
    fs.symlinkSync(outsideIndex, path.join(primary, ".runtime/code/linked.sqlite"), "file");
    archived("job-old", { status: "completed", finishedAt: old.toISOString() });
    archived("job-new", { status: "failed", finishedAt: now.toISOString() });
    archived("job-unfinished", { status: "running", finishedAt: old.toISOString() });
    fs.mkdirSync(path.join(scratch, "outside", "job-link"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "outside", "job-link", "manifest.json"), JSON.stringify({ status: "completed", finishedAt: old.toISOString() }));
    fs.symlinkSync(path.join(scratch, "outside", "job-link"), path.join(primary, ".runtime/agent-fanouts-archive/job-link"), "dir");
    const jobBytes = fs.statSync(path.join(primary, ".runtime/agent-fanouts-archive/job-old/manifest.json")).size;
    enable();
    pastWeek(8);

    expect(recordStoreHealth(primary, now, "test-computer")).toBe(true);
    expect(lastLine().runtimeAgeOut).toEqual({
      enabled: true, days: 30, enabledDays: 8, reportLines: 7, acted: true,
      candidates: { codeIndexes: { count: 2, bytes: goneBytes + notGitBytes }, fanoutArchive: { count: 1, bytes: jobBytes } },
    });
    for (const removed of [".runtime/code/gone.sqlite", ".runtime/code/not-git.sqlite", ".runtime/agent-fanouts-archive/job-old"]) expect(exists(removed)).toBe(false);
    for (const kept of ["forked", "outside-store", "no-meta", "corrupt", "locked", "fresh", "linked"]) expect(exists(`.runtime/code/${kept}.sqlite`)).toBe(true);
    for (const kept of ["job-new", "job-unfinished", "job-link"]) expect(exists(`.runtime/agent-fanouts-archive/${kept}`)).toBe(true);
    expect(fs.existsSync(outsideIndex)).toBe(true);
    expect(fs.existsSync(path.join(scratch, "outside", "job-link", "manifest.json"))).toBe(true);
    expect(exists("forked/FINDINGS.md")).toBe(true);
    expect(forkBytes).toBeGreaterThan(0);
  });

  it("reports while off and counts the week from when this computer first saw it on", () => {
    const bytes = codeIndex("gone", path.join(scratch, "deleted-checkout"));
    const candidates = { codeIndexes: { count: 1, bytes }, fanoutArchive: { count: 0, bytes: 0 } };
    pastWeek(0, 10);
    fs.rmSync(path.join(primary, ".runtime/runtime-age-out.json"));
    expect(recordStoreHealth(primary, now, "test-computer")).toBe(true);
    expect(lastLine().runtimeAgeOut).toEqual({ enabled: false, days: 30, enabledDays: null, reportLines: 10, acted: false, candidates });
    expect(exists(".runtime/runtime-age-out.json")).toBe(false);

    // Ten earlier report lines do not skip the week: it starts when this computer first sees age-out on.
    enable();
    expect(recordStoreHealth(primary, new Date(now.getTime() + day), "test-computer")).toBe(true);
    expect(lastLine().runtimeAgeOut).toMatchObject({ enabled: true, enabledDays: 0, acted: false });
    expect(recordStoreHealth(primary, new Date(now.getTime() + 7 * day), "test-computer")).toBe(true);
    expect(lastLine().runtimeAgeOut).toMatchObject({ enabledDays: 6, acted: false });
    expect(exists(".runtime/code/gone.sqlite")).toBe(true);
    expect(recordStoreHealth(primary, new Date(now.getTime() + 8 * day), "test-computer")).toBe(true);
    expect(lastLine().runtimeAgeOut).toMatchObject({ enabledDays: 7, acted: true });
    expect(exists(".runtime/code/gone.sqlite")).toBe(false);

    // Turning it off forgets the opt-in, so turning it on again waits another week.
    put(primary, ".config/retention-policy.json", JSON.stringify({ schemaVersion: 1, budgets: { runtimeAgeOut: false } }));
    recordStoreHealth(primary, new Date(now.getTime() + 9 * day), "test-computer");
    expect(exists(".runtime/runtime-age-out.json")).toBe(false);
  });

  it("needs seven readable daily lines, skipping torn lines and dates it cannot read", () => {
    codeIndex("gone", path.join(scratch, "deleted-checkout"));
    enable();
    put(primary, ".runtime/runtime-age-out.json", JSON.stringify({ enabledSince: new Date(now.getTime() - 30 * day).toISOString(), ready: false }));
    put(primary, ".runtime/store-health.jsonl", [
      ...Array.from({ length: 3 }, (_, i) => JSON.stringify({ at: new Date(now.getTime() - (i + 1) * day).toISOString(), runtimeClasses: {} })),
      ...Array.from({ length: 4 }, () => JSON.stringify({ at: "not a date", runtimeClasses: {} })),
      JSON.stringify({ at: new Date(now.getTime() - 5 * day).toISOString() }),
      '{"at":',
    ].join("\n") + "\n");
    expect(recordStoreHealth(primary, now, "test-computer")).toBe(true);
    expect(lastLine().runtimeAgeOut).toMatchObject({ enabledDays: 30, reportLines: 3, acted: false });
    expect(exists(".runtime/code/gone.sqlite")).toBe(true);

    fs.rmSync(path.join(primary, ".runtime/store-health.jsonl"));
    fs.writeFileSync(path.join(primary, ".runtime/runtime-age-out.json"), "{torn");
    expect(recordStoreHealth(primary, new Date(now.getTime() + day), "test-computer")).toBe(true);
    expect(lastLine().runtimeAgeOut).toMatchObject({ enabledDays: 0, reportLines: 0, acted: false });
    expect(exists(".runtime/code/gone.sqlite")).toBe(true);
  });
});

describe("daily store health log", () => {
  it("leaves maintenance successful and releases its lock when health recording fails", async () => {
    fs.mkdirSync(path.join(primary, ".runtime/store-health.jsonl"), { recursive: true });
    const { handleBackgroundMaintenance } = await import("../cli/govern.js");
    const markers = qualityMarkers(primary);
    await expect(handleBackgroundMaintenance()).resolves.toBeUndefined();
    expect(fs.existsSync(markers.done)).toBe(true);
    expect(fs.existsSync(markers.lock)).toBe(false);
    expect(fs.existsSync(path.join(primary, ".runtime/store-health.jsonl.lock"))).toBe(false);
  });

  it("records once per local calendar day across UTC midnight, survives a torn tail, and writes only primary runtime", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const team = attachTeam();
    const first = new Date("2026-11-24T23:30:00.000Z");
    expect(recordStoreHealth(primary, first, "test-computer")).toBe(true);
    const file = path.join(primary, ".runtime/store-health.jsonl");
    const original = fs.readFileSync(file, "utf8");
    expect(recordStoreHealth(primary, new Date("2026-11-25T07:59:00.000Z"), "test-computer")).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    fs.appendFileSync(file, '{"at":\n');
    expect(recordStoreHealth(primary, new Date("2026-11-25T07:59:00.000Z"), "test-computer")).toBe(false);
    put(primary, ".runtime/store-health.jsonl", original);
    expect(recordStoreHealth(primary, new Date("2026-11-25T08:01:00.000Z"), "test-computer")).toBe(true);
    expect(recordedLines().map(row => row.at)).toEqual([first.toISOString(), "2026-11-25T08:01:00.000Z"]);
    expect(fs.existsSync(path.join(team, ".runtime"))).toBe(false);
    expect(fs.existsSync(file + ".lock")).toBe(false);
  });

  it("keeps the newest 400 lines when the next daily sample is recorded", () => {
    const previous = Array.from({ length: 400 }, (_, index) => JSON.stringify({ at: new Date(Date.UTC(2025, 0, 1 + index)).toISOString(), index }));
    put(primary, ".runtime/store-health.jsonl", previous.join("\n") + "\n");
    expect(recordStoreHealth(primary, now, "test-computer")).toBe(true);
    const rows = recordedLines();
    expect(rows).toHaveLength(400);
    expect(rows[0]).toEqual({ at: "2025-01-02T00:00:00.000Z", index: 1 });
    expect(rows[398]).toEqual({ at: "2026-02-04T00:00:00.000Z", index: 399 });
    expect(rows[399]).toMatchObject({ at: now.toISOString(), computer: "test-computer", recall: null });
    expect(recordStoreHealth(primary, now, "test-computer")).toBe(false);
    expect(recordedLines()).toHaveLength(400);
  });
});
