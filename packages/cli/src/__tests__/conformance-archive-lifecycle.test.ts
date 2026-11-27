import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveFindingContradiction, retractFinding, supersedeFinding, type ContradictionResolution } from "../finding/lifecycle.js";
import { grantAdmin, makeTempDir, REPO_ROOT } from "../test-helpers.js";

/**
 * Supersede, retract and contradiction resolution on a topic archive bullet
 * and on an .older.md bullet. archive-lifecycle-cases.json names the store,
 * each operation and its expected file; the iOS app holds itself to the same
 * committed bytes. A case may name a `before` fixture for its file when it
 * starts from another state: a resolve starts from a contradicted pair, so its
 * expected bytes also prove the stale conflicts_with and phren:contradicts
 * comments were removed. A resolve changes the two contradicting bullets'
 * lines; every other line stays as it was, including the resolved bullet's
 * cite line, the other bullets, the double blank line in the .older.md fixture
 * and every other file.
 */
const FIXTURES_DIR = path.join(REPO_ROOT, "packages/cli/fixtures/conformance");

interface ArchiveLifecycleCase {
  op: "supersede" | "retract" | "resolve";
  finding: string;
  superseded_by?: string;
  reason?: string;
  finding_b?: string;
  resolution?: ContradictionResolution;
  file: string;
  /** A fixture for `file` that replaces its spec.store entry, for a case that starts from another state. */
  before?: string;
  after: string;
}

const spec = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "archive-lifecycle-cases.json"), "utf8")) as {
  project: string;
  today: string;
  store: Record<string, string>;
  cases: ArchiveLifecycleCase[];
};

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

/**
 * Write the store for one case: spec.store, except that the case's `file`
 * starts from its `before` fixture when it names one. Returns the fixture each
 * file was seeded from, so the byte check compares untouched files to what it
 * actually wrote.
 */
function seedStore(c: ArchiveLifecycleCase): Record<string, string> {
  const seeded: Record<string, string> = {};
  for (const [rel, fixture] of Object.entries(spec.store)) {
    const source = rel === c.file && c.before ? c.before : fixture;
    fs.mkdirSync(path.dirname(path.join(projectDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectDir, rel), readFixture(source));
    seeded[rel] = source;
  }
  return seeded;
}

let tmp: ReturnType<typeof makeTempDir>;
let projectDir: string;

beforeEach(() => {
  tmp = makeTempDir("phren-archive-lifecycle-");
  grantAdmin(tmp.path);
  projectDir = path.join(tmp.path, spec.project);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${spec.today}T12:00:00.000Z`));
});

afterEach(() => {
  vi.useRealTimers();
  tmp.cleanup();
});

describe("archive lifecycle conformance (fixtures/conformance/archive-lifecycle-cases.json)", () => {
  it.each(spec.cases.map((c) => [`${c.op} ${c.file} -> ${c.after}`, c] as const))("%s", (_name, c) => {
    const seeded = seedStore(c);
    const result = c.op === "supersede"
      ? supersedeFinding(tmp.path, spec.project, c.finding, c.superseded_by!)
      : c.op === "retract"
        ? retractFinding(tmp.path, spec.project, c.finding, c.reason!)
        : resolveFindingContradiction(tmp.path, spec.project, c.finding, c.finding_b!, c.resolution!);
    const file = path.join(projectDir, c.file);
    const tier = c.file.endsWith(".older.md") ? "older" : "topic";
    if (c.op === "resolve") {
      expect(result).toMatchObject({
        ok: true,
        data: { resolution: c.resolution, finding_a: { file, tier }, finding_b: { file, tier } },
      });
    } else {
      expect(result).toMatchObject({ ok: true, data: { file, tier } });
    }

    for (const [rel, fixture] of Object.entries(seeded)) {
      expect(fs.readFileSync(path.join(projectDir, rel), "utf8"), rel).toBe(readFixture(rel === c.file ? c.after : fixture));
    }
  });
});
