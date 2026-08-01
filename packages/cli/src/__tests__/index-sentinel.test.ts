/**
 * Index freshness sentinel.
 *
 * The sentinel is supposed to let a warm `buildIndex()` skip `globAllFiles()`
 * — the most expensive part of a no-op rebuild. It never once fired: the
 * freshness check scanned `.runtime/` for mtime changes, and
 * `_buildIndexGuarded()` creates `.runtime/index-rebuild.lock` on entry and
 * unlinks it on exit, i.e. *after* the sentinel is written. Every call
 * therefore saw a directory newer than the sentinel it was compared against.
 * `updateRuntimeHealth()` dirties the same directory from the prompt hook.
 *
 * Nothing asserted the fast path worked, so the bug was invisible. These tests
 * pin both halves of the contract:
 *   - it fires when no *content* changed, no matter what churns in `.runtime`;
 *   - it does not fire when anything that feeds the index hash changed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { buildIndex, type SqlJsDatabase } from "../shared/index.js";
import { updateRuntimeHealth } from "../shared/governance.js";
import { runtimeFile } from "../shared.js";

interface IndexEvent {
  event: string;
  cache: string;
  sentinel?: boolean;
}

/** The `build_index` event emitted by the most recent buildIndex() call. */
function lastIndexEvent(phren: string): IndexEvent {
  const file = path.join(phren, ".runtime", "index-events.jsonl");
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]) as IndexEvent;
}

/**
 * Names the watched directories whose mtime moved since the sentinel was
 * sealed. An unexplained miss here means something dirties a directory the
 * scan watches — exactly the failure mode this suite exists to catch — so the
 * assertion should say which one rather than just "expected true".
 */
function sentinelDrift(phren: string): string {
  const file = path.join(phren, ".runtime", "index-sentinel.json");
  if (!fs.existsSync(file)) return "no sentinel file";
  const sentinel = JSON.parse(fs.readFileSync(file, "utf-8")) as { dirs: Record<string, number> };
  const drifted: string[] = [];
  for (const [dir, recorded] of Object.entries(sentinel.dirs)) {
    let now = -1;
    try { now = fs.statSync(dir).mtimeMs; } catch { /* absent */ }
    if (now !== recorded) drifted.push(`${dir} (${recorded} -> ${now})`);
  }
  return drifted.length ? drifted.join(", ") : "no directory drift";
}

function expectSentinelHit(phren: string): void {
  const event = lastIndexEvent(phren);
  let cached = "unreadable";
  try {
    cached = fs.readdirSync(path.join(os.tmpdir(), `phren-fts-${os.userInfo().uid}`)).join(",") || "empty";
  } catch { /* no cache dir */ }
  expect(
    event.sentinel,
    `expected a sentinel fast-path hit; got ${JSON.stringify(event)}; `
      + `drift: ${sentinelDrift(phren)}; fts cache: ${cached}`,
  ).toBe(true);
}

describe("index sentinel fast path", () => {
  let tmp: { path: string; cleanup: () => void };
  let phren: string;
  let db: SqlJsDatabase | null = null;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedDebounce: string | undefined;
  let savedTmpVars: Record<string, string | undefined> = {};
  let homeTmp: { path: string; cleanup: () => void };
  let ftsTmp: { path: string; cleanup: () => void };

  /** Build, then drop the handle so the in-process debounce can't short-circuit. */
  async function rebuild(profile?: string): Promise<void> {
    db?.close();
    db = await buildIndex(phren, profile);
  }

  beforeEach(async () => {
    tmp = makeTempDir("idx-sentinel-");
    phren = tmp.path;

    // The sentinel watches ~/.claude/projects/*/memory (native agent memory is
    // indexed). Point HOME at an empty dir so a live Claude session on the test
    // machine cannot invalidate the sentinel mid-test.
    homeTmp = makeTempDir("idx-sentinel-home-");
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeTmp.path;
    process.env.USERPROFILE = homeTmp.path;

    // The FTS cache lives in os.tmpdir()/phren-fts-<uid> and holds exactly one
    // .db: a full rebuild for a new hash unlinks every other entry. That dir is
    // shared by every test process, so a sibling file's rebuild can evict this
    // store's snapshot and turn a sentinel hit into a cold miss. Give this file
    // its own tmpdir so the assertions measure phren, not the neighbours.
    ftsTmp = makeTempDir("idx-sentinel-fts-");
    savedTmpVars = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TMPDIR = ftsTmp.path;
    process.env.TEMP = ftsTmp.path;
    process.env.TMP = ftsTmp.path;

    // buildIndex() returns the previous handle within a 5s window; disable it so
    // each call in these tests really re-runs the freshness check.
    savedDebounce = process.env.PHREN_INDEX_DEBOUNCE_MS;
    process.env.PHREN_INDEX_DEBOUNCE_MS = "0";

    writeFile(
      path.join(phren, "phren.root.yaml"),
      yaml.dump({ version: 1, installMode: "shared", syncMode: "managed-git" }, { lineWidth: 1000 })
    );
    writeFile(path.join(phren, "myapp", "summary.md"), "# myapp\nA test application.\n");
    writeFile(
      path.join(phren, "myapp", "FINDINGS.md"),
      "# myapp Findings\n\n- Zymurgical pattern: ferment in sealed containers\n"
    );
    writeFile(path.join(phren, "myapp", "reference", "api.md"), "# api\n\n- Quixotic endpoint notes\n");
    // A directory that exists but holds no indexed file yet. A dir-mtime scan
    // derived only from *files already indexed* would not be watching it.
    fs.mkdirSync(path.join(phren, "myapp", "notes"), { recursive: true });

    db = await buildIndex(phren);
    expect(lastIndexEvent(phren).cache).toBe("miss"); // cold build
  });

  afterEach(() => {
    db?.close();
    db = null;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
    if (savedDebounce === undefined) delete process.env.PHREN_INDEX_DEBOUNCE_MS;
    else process.env.PHREN_INDEX_DEBOUNCE_MS = savedDebounce;
    for (const [key, value] of Object.entries(savedTmpVars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    ftsTmp.cleanup();
    homeTmp.cleanup();
    tmp.cleanup();
  });

  // ── the fast path fires ────────────────────────────────────────────────────

  it("takes the fast path when nothing changed", async () => {
    await rebuild();

    expect(lastIndexEvent(phren).cache).toBe("hit");
    expectSentinelHit(phren);
  });

  it("keeps taking the fast path across repeated no-op rebuilds", async () => {
    for (let i = 0; i < 3; i++) {
      await rebuild();
      expectSentinelHit(phren);
    }
  });

  it("still takes the fast path after updateRuntimeHealth dirties .runtime", async () => {
    // The exact sequence the UserPromptSubmit hook runs: stamp runtime health,
    // then load the index. updateRuntimeHealth takes a file lock, so it creates
    // and unlinks .runtime/runtime-health.json.lock — which bumps the mtime of
    // .runtime. That used to force a full glob on every prompt.
    updateRuntimeHealth(phren, { lastPromptAt: new Date().toISOString() });

    await rebuild();

    expectSentinelHit(phren);
  });

  it("still takes the fast path after arbitrary .runtime churn", async () => {
    const churn = runtimeFile(phren, "some-scratch.lock");
    fs.writeFileSync(churn, "1");
    fs.unlinkSync(churn);
    fs.appendFileSync(runtimeFile(phren, "debug.log"), "noise\n");

    await rebuild();

    expectSentinelHit(phren);
  });

  it("serves the same documents on the fast path as on a full build", async () => {
    const before = db!.exec("SELECT path FROM docs ORDER BY path")[0].values.map(String);

    await rebuild();

    expectSentinelHit(phren);
    const after = db!.exec("SELECT path FROM docs ORDER BY path")[0].values.map(String);
    expect(after).toEqual(before);
  });

  // ── the fast path must NOT fire ────────────────────────────────────────────

  it("does not take the fast path after a file is edited in place", async () => {
    // An in-place write leaves every directory mtime untouched — only the
    // file's own mtime moves. The dir scan alone would happily serve stale.
    writeFile(
      path.join(phren, "myapp", "FINDINGS.md"),
      "# myapp Findings\n\n- Zarathustrian insight: async patterns raise throughput\n"
    );

    await rebuild();

    expect(lastIndexEvent(phren).sentinel).not.toBe(true);
    expect(db!.exec("SELECT content FROM docs WHERE content LIKE '%Zarathustrian%'").length).toBeGreaterThan(0);
    expect(db!.exec("SELECT content FROM docs WHERE content LIKE '%Zymurgical%'").length).toBe(0);
  });

  it("does not take the fast path after a file is added", async () => {
    writeFile(path.join(phren, "myapp", "reference", "new.md"), "# new\n\n- Borborygmic note\n");

    await rebuild();

    expect(lastIndexEvent(phren).sentinel).not.toBe(true);
    expect(db!.exec("SELECT content FROM docs WHERE content LIKE '%Borborygmic%'").length).toBeGreaterThan(0);
  });

  it("does not take the fast path after a file is added to a previously empty directory", async () => {
    writeFile(path.join(phren, "myapp", "notes", "scratch.md"), "# scratch\n\n- Peripatetic note\n");

    await rebuild();

    expect(lastIndexEvent(phren).sentinel).not.toBe(true);
    expect(db!.exec("SELECT content FROM docs WHERE content LIKE '%Peripatetic%'").length).toBeGreaterThan(0);
  });

  it("does not take the fast path after a file is deleted", async () => {
    fs.unlinkSync(path.join(phren, "myapp", "reference", "api.md"));

    await rebuild();

    expect(lastIndexEvent(phren).sentinel).not.toBe(true);
    expect(db!.exec("SELECT content FROM docs WHERE content LIKE '%Quixotic%'").length).toBe(0);
  });

  it("does not take the fast path after a new project appears", async () => {
    writeFile(path.join(phren, "other", "summary.md"), "# other\n\n- Sesquipedalian summary\n");

    await rebuild();

    expect(lastIndexEvent(phren).sentinel).not.toBe(true);
    expect(db!.exec("SELECT content FROM docs WHERE content LIKE '%Sesquipedalian%'").length).toBeGreaterThan(0);
  });

  it("does not take the fast path after the index policy changes", async () => {
    // Narrowing the include globs changes which files are eligible, without
    // touching any project directory.
    writeFile(
      path.join(phren, ".config", "index-policy.json"),
      JSON.stringify({ includeGlobs: ["FINDINGS.md"], excludeGlobs: ["**/.git/**"] })
    );

    await rebuild();

    expect(lastIndexEvent(phren).sentinel).not.toBe(true);
    expect(db!.exec("SELECT content FROM docs WHERE content LIKE '%Quixotic%'").length).toBe(0);
  });

  it("does not reuse another profile's sentinel", async () => {
    writeFile(path.join(phren, "profiles", "solo.yaml"), yaml.dump({ projects: ["myapp"] }));
    // Creating profiles/ dirties the phren root, so re-seal first, then confirm
    // the sentinel is genuinely fresh for the no-profile build.
    await rebuild();
    await rebuild();
    expectSentinelHit(phren);

    await rebuild("solo");

    expect(lastIndexEvent(phren).sentinel).not.toBe(true);
  });
});
