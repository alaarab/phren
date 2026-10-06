/**
 * Pruning must never evict the store it is about to serve.
 *
 * pruneFtsCacheRoot() runs once per process, *before* the snapshot is read, so
 * if it could delete the live store's directory the prompt would fall through
 * to a blocking cold rebuild — the ~4s stall this work exists to remove. The
 * prune is a one-shot per process, so this lives in its own file: vitest forks
 * per file, and any earlier loadIndexForHook() would have consumed it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import { makeTempDir, writeFile } from "../test-helpers.js";
import {
  __resetFtsCachePruneGuardForTests,
  buildIndex,
  loadIndexForHook,
  type SqlJsDatabase,
} from "../shared/index.js";

describe("FTS cache pruning never evicts the store being served", () => {
  let tmp: { path: string; cleanup: () => void };
  let homeTmp: { path: string; cleanup: () => void };
  let ftsTmp: { path: string; cleanup: () => void };
  let db: SqlJsDatabase | null = null;
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = makeTempDir("fts-keep-");
    homeTmp = makeTempDir("fts-keep-home-");
    ftsTmp = makeTempDir("fts-keep-fts-");
    savedEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      PHREN_INDEX_DEBOUNCE_MS: process.env.PHREN_INDEX_DEBOUNCE_MS,
    };
    process.env.HOME = homeTmp.path;
    process.env.USERPROFILE = homeTmp.path;
    process.env.TMPDIR = ftsTmp.path;
    process.env.TEMP = ftsTmp.path;
    process.env.TMP = ftsTmp.path;
    process.env.PHREN_INDEX_DEBOUNCE_MS = "0";

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

  it("keeps the current store's cache even when it is old and the root is over the cap", async () => {
    // Build once so this store owns a real snapshot, then age its directory past
    // the TTL and bury it under more recently-used stores. Pruning runs before
    // the snapshot is read, so if it could evict the live store the prompt would
    // fall all the way back to a blocking cold rebuild — the 4s stall this whole
    // change exists to remove.
    (await buildIndex(tmp.path)).close();

    const root = path.join(os.tmpdir(), `phren-fts-${os.userInfo().uid}`);
    const storeDirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(storeDirs).toHaveLength(1);
    const mine = path.join(root, storeDirs[0].name);
    const snapshots = fs.readdirSync(mine).filter((f) => f.endsWith(".db"));
    expect(snapshots).toHaveLength(1);

    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(mine, monthAgo, monthAgo);
    // 70 newer neighbours, comfortably past the 64-store cap.
    for (let i = 0; i < 70; i++) {
      const other = path.join(root, `f${String(i).padStart(15, "0")}`);
      fs.mkdirSync(other, { recursive: true });
      fs.writeFileSync(path.join(other, "aaaaaaaa.db"), "neighbour");
    }

    // buildIndex() above already consumed the one-shot prune; re-arm it so the
    // pruning logic actually runs against the aged directory.
    __resetFtsCachePruneGuardForTests();

    db = await loadIndexForHook(tmp.path);

    // Neighbours got pruned, which proves the prune really ran.
    expect(fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).length)
      .toBeLessThan(71);
    expect(fs.existsSync(mine)).toBe(true);
    expect(fs.readdirSync(mine)).toEqual(snapshots); // same snapshot, untouched
    // The decisive assertion: a cache HIT. If pruning had evicted this store,
    // loadIndexForHook would fall through to a blocking cold build, which
    // recreates a directory of the same name with the same content hash — so
    // only the event distinguishes "kept" from "deleted and rebuilt".
    const events = fs.readFileSync(path.join(tmp.path, ".runtime", "index-events.jsonl"), "utf-8")
      .trim().split("\n").map((l) => JSON.parse(l) as { cache: string });
    expect(events[events.length - 1].cache).toBe("hit");
    expect(db.exec("SELECT 1 FROM docs WHERE content LIKE '%Zymurgical%'").length).toBeGreaterThan(0);
  });

});
