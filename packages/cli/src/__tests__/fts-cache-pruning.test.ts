/**
 * FTS snapshot cache housekeeping.
 *
 * Snapshots live in a per-store subdirectory of os.tmpdir()/phren-fts-<uid> so
 * one store can never be served another's index. That removed the accidental
 * garbage collector the old flat layout had — every full rebuild used to unlink
 * all the *other* stores' snapshots, which is why the root never grew — so the
 * root is now pruned explicitly. Without it, one test-suite run left 524 store
 * directories and 36MB behind.
 *
 * The prune runs once per process, so this lives in its own file: vitest gives
 * each test file a fresh fork, and any earlier loadIndexForHook() call would
 * have already consumed the one-shot.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { buildIndex, loadIndexForHook, type SqlJsDatabase } from "../shared/index.js";

describe("FTS cache root pruning", () => {
  let tmp: { path: string; cleanup: () => void };
  let homeTmp: { path: string; cleanup: () => void };
  let ftsTmp: { path: string; cleanup: () => void };
  let db: SqlJsDatabase | null = null;
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = makeTempDir("fts-prune-");
    homeTmp = makeTempDir("fts-prune-home-");
    ftsTmp = makeTempDir("fts-prune-fts-");
    savedEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.HOME = homeTmp.path;
    process.env.USERPROFILE = homeTmp.path;
    process.env.TMPDIR = ftsTmp.path;
    process.env.TEMP = ftsTmp.path;
    process.env.TMP = ftsTmp.path;

    writeFile(
      path.join(tmp.path, "phren.root.yaml"),
      yaml.dump({ version: 1, installMode: "shared", syncMode: "managed-git" }, { lineWidth: 1000 })
    );
    writeFile(path.join(tmp.path, "myapp", "FINDINGS.md"), "# myapp\n\n- Zymurgical note\n");
  });

  afterEach(() => {
    db?.close();
    db = null;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    ftsTmp.cleanup();
    homeTmp.cleanup();
    tmp.cleanup();
  });

  it("drops abandoned store caches and unattributable legacy snapshots", async () => {
    const root = path.join(os.tmpdir(), `phren-fts-${os.userInfo().uid}`);
    fs.mkdirSync(root, { recursive: true });

    // A store dir nobody has touched in a month.
    const abandoned = path.join(root, "0".repeat(16));
    fs.mkdirSync(abandoned, { recursive: true });
    fs.writeFileSync(path.join(abandoned, "deadbeef.db"), "stale snapshot");
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(abandoned, monthAgo, monthAgo);

    // A pre-0.1.41 snapshot sitting flat in the root: it belongs to no store,
    // so it can only ever be mis-served.
    const legacy = path.join(root, "cafebabe.db");
    fs.writeFileSync(legacy, "legacy snapshot");

    // A store dir that is still in use.
    const recent = path.join(root, "1".repeat(16));
    fs.mkdirSync(recent, { recursive: true });
    fs.writeFileSync(path.join(recent, "feedface.db"), "recent snapshot");

    db = await loadIndexForHook(tmp.path);

    expect(fs.existsSync(abandoned)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    // The caller still got its own index, built from its own store.
    expect(db.exec("SELECT 1 FROM docs WHERE content LIKE '%Zymurgical%'").length).toBeGreaterThan(0);
  });
});
