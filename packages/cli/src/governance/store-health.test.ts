import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTestPhrenRoot, writeFile } from "../test-helpers.js";
import { collectStoreHealth, recordStoreHealth } from "./store-health.js";
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
      citations: { none: 7, timestampOnly: 1, withFile: 2, withCommit: 2, withSymbol: 2 },
      openTasks: 3, doneTasks: 2, reviewEntries: 3,
    });
    expect(result.stores[0].totals).toEqual({
      activeFindings: 9, archivedBullets: 2, olderBullets: 2,
      retiredBullets: 2, contradictedBullets: 2, bulletsWithoutFid: 3,
      duplicateFids: 2, duplicateTexts: 3,
      citations: { none: 8, timestampOnly: 1, withFile: 2, withCommit: 2, withSymbol: 2 },
      openTasks: 3, doneTasks: 2, reviewEntries: 3,
    });
    expect(result.stores[1].projects).toEqual([{
      project: "proj", activeFindings: 1, archivedBullets: 0, olderBullets: 0,
      retiredBullets: 0, contradictedBullets: 0, bulletsWithoutFid: 0,
      duplicateFids: 0, duplicateTexts: 0,
      citations: { none: 1, timestampOnly: 0, withFile: 0, withCommit: 0, withSymbol: 0 },
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
      { at: recent, injected: "wrong", abstained: 5, suppressedRepeats: -7 },
      { at: "2026-11-24T11:59:59.999Z", injected: [{}], suppressedRepeats: 10 },
      { at: "2026-11-25T12:00:00.001Z", abstained: "future" },
      { at: "invalid" }, null, [], { other: "missing date" },
    ].map(row => JSON.stringify(row));
    put(primary, ".runtime/recall-trace.jsonl", trace.join("\n") + '\n{"at":');
    expect(collectStoreHealth(primary, now, "test-computer").recall).toEqual({
      prompts: 7, injected: 1, abstained: 3, skipped: 2, suppressedRepeats: 4,
      byAbstainReason: { "below-floor": 2, "no-candidates": 1 },
    });
    put(primary, ".runtime/recall-trace.jsonl", "");
    expect(collectStoreHealth(primary, now, "test-computer").recall).toEqual({
      prompts: 0, injected: 0, abstained: 0, skipped: 0, suppressedRepeats: 0, byAbstainReason: {},
    });
  });

  it("returns zero totals and null recall for an empty store without creating runtime state", () => {
    const result = collectStoreHealth(primary, now, "test-computer");
    expect(result).toEqual({
      at: "2026-11-25T12:00:00.000Z", computer: "test-computer",
      stores: [{ name: "personal", path: ".", projects: [], totals: {
        activeFindings: 0, archivedBullets: 0, olderBullets: 0, retiredBullets: 0,
        contradictedBullets: 0, bulletsWithoutFid: 0, duplicateFids: 0, duplicateTexts: 0,
        citations: { none: 0, timestampOnly: 0, withFile: 0, withCommit: 0, withSymbol: 0 },
        openTasks: 0, doneTasks: 0, reviewEntries: 0,
      } }], runtimeBytes: {}, recall: null,
    });
    expect(fs.existsSync(path.join(primary, ".runtime"))).toBe(false);
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
