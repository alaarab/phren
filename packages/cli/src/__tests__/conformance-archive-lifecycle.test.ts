import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { retractFinding, supersedeFinding } from "../finding/lifecycle.js";
import { grantAdmin, makeTempDir, REPO_ROOT } from "../test-helpers.js";

/**
 * Supersede and retract on a topic archive bullet and on an .older.md bullet.
 * archive-lifecycle-cases.json names the store, each operation and its
 * expected file; the iOS app holds itself to the same committed bytes. Only
 * the target bullet's line changes: its cite line, the other bullets, the
 * double blank line in the .older.md fixture and every other file stay as they
 * were.
 */
const FIXTURES_DIR = path.join(REPO_ROOT, "packages/cli/fixtures/conformance");

interface ArchiveLifecycleCase {
  op: "supersede" | "retract";
  finding: string;
  superseded_by?: string;
  reason?: string;
  file: string;
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

let tmp: ReturnType<typeof makeTempDir>;
let projectDir: string;

beforeEach(() => {
  tmp = makeTempDir("phren-archive-lifecycle-");
  grantAdmin(tmp.path);
  projectDir = path.join(tmp.path, spec.project);
  for (const [rel, fixture] of Object.entries(spec.store)) {
    fs.mkdirSync(path.dirname(path.join(projectDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectDir, rel), readFixture(fixture));
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${spec.today}T12:00:00.000Z`));
});

afterEach(() => {
  vi.useRealTimers();
  tmp.cleanup();
});

describe("archive lifecycle conformance (fixtures/conformance/archive-lifecycle-cases.json)", () => {
  it.each(spec.cases.map((c) => [`${c.op} ${c.file} -> ${c.after}`, c] as const))("%s", (_name, c) => {
    const result = c.op === "supersede"
      ? supersedeFinding(tmp.path, spec.project, c.finding, c.superseded_by!)
      : retractFinding(tmp.path, spec.project, c.finding, c.reason!);
    expect(result).toMatchObject({ ok: true, data: { file: path.join(projectDir, c.file), tier: c.file.endsWith(".older.md") ? "older" : "topic" } });

    for (const [rel, fixture] of Object.entries(spec.store)) {
      expect(fs.readFileSync(path.join(projectDir, rel), "utf8"), rel).toBe(readFixture(rel === c.file ? c.after : fixture));
    }
  });
});
