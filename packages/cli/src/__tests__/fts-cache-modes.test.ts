/**
 * The FTS snapshot cache is a SQLite export of the *entire* indexed store —
 * the full text of every finding, note, task and reference doc — written into
 * os.tmpdir(). It was landing as an 0644 file inside an 0755 directory:
 *
 *   drwxr-xr-x  $TMPDIR/phren-fts-<uid>
 *   -rw-r--r--  $TMPDIR/phren-fts-<uid>/<storeKey>/<hash>.db
 *
 * On macOS os.tmpdir() is a per-user /var/folders/…/T at 0700, which is the
 * only thing that made that survivable. On Linux and WSL os.tmpdir() is /tmp
 * (mode 1777, world-readable), so every local account could read the whole
 * knowledge base. phren ships cross-platform on npm.
 *
 * A 0700 cache root closes it: POSIX denies traversal, so nothing underneath
 * is reachable regardless of its own mode. These tests assert the mode that
 * actually lands on disk rather than the argument passed to mkdirSync, since
 * mkdirSync's mode is masked by umask and is a no-op on an existing directory.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { ensureFtsCacheRootPrivate, ftsCacheRoot } from "../phren-paths.js";
import { buildIndex, type SqlJsDatabase } from "../shared/index.js";

const posixOnly = process.platform === "win32" ? it.skip : it;

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

describe("FTS snapshot cache permissions", () => {
  let tmp: { path: string; cleanup: () => void };
  let homeTmp: { path: string; cleanup: () => void };
  let ftsTmp: { path: string; cleanup: () => void };
  let db: SqlJsDatabase | null = null;
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = makeTempDir("fts-modes-");
    homeTmp = makeTempDir("fts-modes-home-");
    ftsTmp = makeTempDir("fts-modes-tmp-");
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
    writeFile(path.join(tmp.path, "myapp", "FINDINGS.md"), "# myapp\n\n- Zymurgical note about brewing\n");
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

  posixOnly("creates the cache root at 0700", () => {
    const root = ensureFtsCacheRootPrivate();
    expect(mode(root)).toBe(0o700);
  });

  posixOnly("repairs an already-shipped 0755 cache root", () => {
    const root = ftsCacheRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.chmodSync(root, 0o755);
    expect(mode(root)).toBe(0o755);

    ensureFtsCacheRootPrivate();
    expect(mode(root)).toBe(0o700);
  });

  posixOnly("a 0700 root survives a permissive umask", () => {
    const prior = process.umask(0o000);
    try {
      const root = ensureFtsCacheRootPrivate();
      expect(mode(root)).toBe(0o700);
    } finally {
      process.umask(prior);
    }
  });

  posixOnly("the hardened root is the directory a real index build writes into", async () => {
    // The drift guard. phren-paths.ts defines the cache root; shared/index.ts
    // still has its own private copy of that path. If the two ever disagree,
    // hardening one would silently protect nothing — so build a real index and
    // check the snapshot actually landed under the root we hardened.
    const root = ensureFtsCacheRootPrivate();

    db = await buildIndex(tmp.path);
    expect(db.exec("SELECT 1 FROM docs WHERE content LIKE '%Zymurgical%'").length).toBeGreaterThan(0);

    expect(fs.existsSync(root)).toBe(true);
    const snapshots: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const storeDir = path.join(root, entry.name);
      for (const f of fs.readdirSync(storeDir)) {
        if (f.endsWith(".db")) snapshots.push(path.join(storeDir, f));
      }
    }
    expect(snapshots.length).toBeGreaterThan(0);

    // The root still denies traversal to everyone else, which is what makes
    // the snapshot's own mode unreachable.
    expect(mode(root) & 0o077).toBe(0);
  });

  posixOnly("hardening the root does not widen os.tmpdir() itself", () => {
    const before = mode(os.tmpdir());
    ensureFtsCacheRootPrivate();
    expect(mode(os.tmpdir())).toBe(before);
  });

  it("ftsCacheRoot is per-user and lives under os.tmpdir()", () => {
    const root = ftsCacheRoot();
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^phren-fts-/);
  });
});
