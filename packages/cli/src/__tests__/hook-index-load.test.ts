/**
 * loadIndexForHook() — the index loader on the UserPromptSubmit path.
 *
 * The prompt hook used to `await buildIndex()` inline, so a store whose content
 * had changed since the last build froze the user's prompt for the length of a
 * full rebuild. Measured on this machine by pointing the hook back at
 * buildIndex(): 1.25s median on a 390-file store and 11.0s median (16.0s worst)
 * on a 1886-file store, versus 339ms / 391ms serving the existing snapshot and
 * rebuilding detached.
 *
 * Stale-but-instant is the right trade for prompt injection, but only with
 * these guarantees, which nothing asserted before:
 *   - a cold start with no snapshot at all still blocks, rather than injecting
 *     an empty context;
 *   - a stale serve schedules exactly one detached rebuild, deduped by the
 *     rebuild lock, so concurrent prompts cannot stampede;
 *   - the staleness is recorded, so a missing just-written finding is
 *     explainable rather than mysterious.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { buildIndex, loadIndexForHook, type SqlJsDatabase } from "../shared/index.js";
import { runtimeFile } from "../shared.js";

interface IndexEvent {
  event: string;
  cache: string;
  rebuildScheduled?: boolean;
}

function indexEvents(phren: string): IndexEvent[] {
  const file = path.join(phren, ".runtime", "index-events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as IndexEvent);
}

function lastEvent(phren: string): IndexEvent {
  const events = indexEvents(phren);
  return events[events.length - 1];
}

function docCount(db: SqlJsDatabase): number {
  return (db.exec("SELECT COUNT(*) FROM docs")?.[0]?.values?.[0]?.[0] as number) ?? 0;
}

function contains(db: SqlJsDatabase, needle: string): boolean {
  return db.exec(`SELECT 1 FROM docs WHERE content LIKE '%${needle}%'`).length > 0;
}

/** Poll for the detached child's marker, which proves a rebuild was launched. */
async function waitForSpawnMarker(marker: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(marker)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe("loadIndexForHook", () => {
  let tmp: { path: string; cleanup: () => void };
  let homeTmp: { path: string; cleanup: () => void };
  let ftsTmp: { path: string; cleanup: () => void };
  let phren: string;
  let db: SqlJsDatabase | null = null;
  let spawnMarker: string;
  let savedEnv: Record<string, string | undefined> = {};
  let savedArgv1: string;

  beforeEach(() => {
    tmp = makeTempDir("hook-index-");
    homeTmp = makeTempDir("hook-index-home-");
    // Private FTS cache dir: the shared os.tmpdir()/phren-fts-<uid> keeps a
    // single .db and any sibling test's rebuild evicts it, which would show up
    // here as a spurious cold start.
    ftsTmp = makeTempDir("hook-index-fts-");
    phren = tmp.path;

    savedEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      PHREN_INDEX_DEBOUNCE_MS: process.env.PHREN_INDEX_DEBOUNCE_MS,
      PHREN_SPAWN_MARKER: process.env.PHREN_SPAWN_MARKER,
    };
    process.env.HOME = homeTmp.path;
    process.env.USERPROFILE = homeTmp.path;
    process.env.TMPDIR = ftsTmp.path;
    process.env.TEMP = ftsTmp.path;
    process.env.TMP = ftsTmp.path;
    process.env.PHREN_INDEX_DEBOUNCE_MS = "0";

    // The detached rebuild is spawned as `node <process.argv[1]>
    // background-reindex`, and only when argv[1] looks like a phren entry
    // point. Point it at a stub that records the launch instead of running a
    // real reindex, so the scheduling decision is observable and cheap.
    spawnMarker = path.join(tmp.path, "spawned.log");
    process.env.PHREN_SPAWN_MARKER = spawnMarker;
    const stub = path.join(tmp.path, "fake-cli", "index.cjs");
    fs.mkdirSync(path.dirname(stub), { recursive: true });
    fs.writeFileSync(
      stub,
      "require('fs').appendFileSync(process.env.PHREN_SPAWN_MARKER, process.argv[2] + '\\n');\n"
    );
    savedArgv1 = process.argv[1];
    process.argv[1] = stub;

    writeFile(
      path.join(phren, "phren.root.yaml"),
      yaml.dump({ version: 1, installMode: "shared", syncMode: "managed-git" }, { lineWidth: 1000 })
    );
    writeFile(path.join(phren, "myapp", "summary.md"), "# myapp\nA test application.\n");
    writeFile(
      path.join(phren, "myapp", "FINDINGS.md"),
      "# myapp Findings\n\n- Zymurgical pattern: ferment in sealed containers\n"
    );
  });

  afterEach(() => {
    db?.close();
    db = null;
    process.argv[1] = savedArgv1;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    ftsTmp.cleanup();
    homeTmp.cleanup();
    tmp.cleanup();
  });

  it("blocks and builds on a cold start rather than serving an empty index", async () => {
    // No snapshot exists yet — the very first prompt must still get content.
    db = await loadIndexForHook(phren);

    expect(docCount(db)).toBeGreaterThan(0);
    expect(contains(db, "Zymurgical")).toBe(true);
    expect(lastEvent(phren).cache).toBe("miss"); // a real build, not a stale serve
    expect(fs.existsSync(spawnMarker)).toBe(false);
  });

  it("serves the cached snapshot and schedules nothing when nothing changed", async () => {
    (await buildIndex(phren)).close();

    db = await loadIndexForHook(phren);

    expect(contains(db, "Zymurgical")).toBe(true);
    expect(lastEvent(phren).cache).toBe("hit");
    expect(fs.existsSync(spawnMarker)).toBe(false);
  });

  it("serves the stale snapshot and schedules a detached rebuild after a write", async () => {
    (await buildIndex(phren)).close();
    writeFile(
      path.join(phren, "myapp", "FINDINGS.md"),
      "# myapp Findings\n\n- Zarathustrian insight: async patterns raise throughput\n"
    );

    db = await loadIndexForHook(phren);

    // Documented trade: this prompt sees the pre-write snapshot. The detached
    // rebuild makes the *next* prompt current.
    expect(contains(db, "Zymurgical")).toBe(true);
    expect(contains(db, "Zarathustrian")).toBe(false);

    const event = lastEvent(phren);
    expect(event.cache).toBe("stale");
    expect(event.rebuildScheduled).toBe(true);
    expect(await waitForSpawnMarker(spawnMarker)).toBe(true);
    expect(fs.readFileSync(spawnMarker, "utf-8").trim()).toBe("background-reindex");
  });

  it("does not stampede: a held rebuild lock suppresses further spawns", async () => {
    (await buildIndex(phren)).close();
    writeFile(path.join(phren, "myapp", "FINDINGS.md"), "# myapp Findings\n\n- Borborygmic note\n");
    // A rebuild is already in flight (this is exactly what withFileLock leaves
    // on disk while buildIndex runs).
    fs.writeFileSync(runtimeFile(phren, "index-rebuild") + ".lock", String(process.pid));

    db = await loadIndexForHook(phren);

    expect(lastEvent(phren).rebuildScheduled).toBe(false);
    expect(fs.existsSync(spawnMarker)).toBe(false);
    // Still answers the prompt from the snapshot instead of waiting on the lock.
    expect(contains(db, "Zymurgical")).toBe(true);
  });

  it("picks up the new content once the rebuild has run", async () => {
    (await buildIndex(phren)).close();
    writeFile(
      path.join(phren, "myapp", "FINDINGS.md"),
      "# myapp Findings\n\n- Zarathustrian insight: async patterns raise throughput\n"
    );

    // Prompt 1 serves stale...
    const stale = await loadIndexForHook(phren);
    expect(contains(stale, "Zarathustrian")).toBe(false);
    stale.close();

    // ...the detached rebuild is what a real background-reindex would do...
    (await buildIndex(phren)).close();

    // ...and prompt 2 is current again, with no further rebuild scheduled.
    db = await loadIndexForHook(phren);
    expect(contains(db, "Zarathustrian")).toBe(true);
    expect(lastEvent(phren).cache).toBe("hit");
  });

  it("does not spawn a rebuild when argv[1] is not a phren entry point", async () => {
    // Hooks invoked through a wrapper script must not spawn `node <wrapper>`.
    process.argv[1] = path.join(tmp.path, "fake-cli", "not-an-entry.sh");
    (await buildIndex(phren)).close();
    writeFile(path.join(phren, "myapp", "FINDINGS.md"), "# myapp Findings\n\n- Peripatetic note\n");

    db = await loadIndexForHook(phren);

    expect(lastEvent(phren).cache).toBe("stale");
    expect(lastEvent(phren).rebuildScheduled).toBe(false);
    expect(fs.existsSync(spawnMarker)).toBe(false);
  });

  it("does not schedule a rebuild on every prompt when a team store is registered", async () => {
    // buildIndex() resolves non-primary stores before globbing; the hook did
    // not, so a team-store user's hook hash could never equal the one
    // buildIndex sealed. Every prompt then looked stale and spawned a reindex
    // that changed nothing — a rebuild per prompt regardless of writes.
    const team = makeTempDir("hook-index-team-");
    try {
      writeFile(
        path.join(team.path, "phren.root.yaml"),
        yaml.dump({ version: 1, installMode: "shared", syncMode: "managed-git" }, { lineWidth: 1000 })
      );
      writeFile(path.join(team.path, "teamproj", "FINDINGS.md"), "# team\n\n- Sesquipedalian team note\n");
      writeFile(
        path.join(phren, "stores.yaml"),
        yaml.dump({
          version: 1,
          stores: [
            { id: "aaa11111", name: "personal", path: phren, role: "primary", sync: "managed-git" },
            { id: "bbb22222", name: "team", path: team.path, role: "team", sync: "pull-only" },
          ],
        })
      );

      (await buildIndex(phren)).close();

      db = await loadIndexForHook(phren);

      expect(contains(db, "Sesquipedalian")).toBe(true); // team content is indexed
      expect(lastEvent(phren).cache).toBe("hit");
      expect(fs.existsSync(spawnMarker)).toBe(false);
    } finally {
      team.cleanup();
    }
  });

  it("stores each snapshot under a per-store subdirectory of the cache root", async () => {
    db = await loadIndexForHook(phren);

    const root = path.join(os.tmpdir(), `phren-fts-${os.userInfo().uid}`);
    expect(root.startsWith(ftsTmp.path)).toBe(true); // the isolated TMPDIR is in effect
    // No .db may sit flat in the root: a flat file is unattributable to a store
    // and is exactly what the stale-serve fallback used to mis-serve.
    const rootEntries = fs.readdirSync(root, { withFileTypes: true });
    expect(rootEntries.filter((e) => e.isFile() && e.name.endsWith(".db"))).toEqual([]);
    const storeDirs = rootEntries.filter((e) => e.isDirectory());
    expect(storeDirs).toHaveLength(1);
    expect(fs.readdirSync(path.join(root, storeDirs[0].name)).some((f) => f.endsWith(".db"))).toBe(true);
  });
});

/**
 * Cross-store contamination.
 *
 * The FTS cache root is per-user, and snapshots inside it are named by a
 * *content* hash. The stale-serve fallback picked the newest .db in that root
 * without checking which store wrote it, so with two stores configured — the
 * personal + `role: team` setup phren documents — a hash miss in store B could
 * hand store B's prompt an index built entirely from store A's knowledge.
 */
describe("loadIndexForHook store isolation", () => {
  let storeA: { path: string; cleanup: () => void };
  let storeB: { path: string; cleanup: () => void };
  let homeTmp: { path: string; cleanup: () => void };
  let ftsTmp: { path: string; cleanup: () => void };
  let db: SqlJsDatabase | null = null;
  let savedEnv: Record<string, string | undefined> = {};

  function makeStore(prefix: string, project: string, marker: string) {
    const store = makeTempDir(prefix);
    writeFile(
      path.join(store.path, "phren.root.yaml"),
      yaml.dump({ version: 1, installMode: "shared", syncMode: "managed-git" }, { lineWidth: 1000 })
    );
    writeFile(path.join(store.path, project, "FINDINGS.md"), `# ${project}\n\n- ${marker} note\n`);
    return store;
  }

  beforeEach(() => {
    homeTmp = makeTempDir("store-iso-home-");
    ftsTmp = makeTempDir("store-iso-fts-");
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

    storeA = makeStore("store-a-", "alpha", "Zymurgical");
    storeB = makeStore("store-b-", "bravo", "Borborygmic");
  });

  afterEach(() => {
    db?.close();
    db = null;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    storeA.cleanup();
    storeB.cleanup();
    ftsTmp.cleanup();
    homeTmp.cleanup();
  });

  it("never serves store A's snapshot to store B", async () => {
    (await buildIndex(storeA.path)).close();

    db = await loadIndexForHook(storeB.path);

    expect(contains(db, "Borborygmic")).toBe(true);
    expect(contains(db, "Zymurgical")).toBe(false);
  });

  it("treats a store with no snapshot of its own as a cold start, not a stale serve", async () => {
    (await buildIndex(storeA.path)).close();

    db = await loadIndexForHook(storeB.path);

    // "miss" = it really built B. "stale" would mean it served someone's cache.
    expect(lastEvent(storeB.path).cache).toBe("miss");
    expect(docCount(db)).toBeGreaterThan(0);
  });

  it("returns an empty snapshot rather than a neighbour's while B's rebuild lock is held", async () => {
    // This is the other entry into the stale-cache scan: buildIndex() bails to
    // loadIndexSnapshotOrEmpty() when a rebuild is already in flight.
    (await buildIndex(storeA.path)).close();
    fs.writeFileSync(runtimeFile(storeB.path, "index-rebuild") + ".lock", String(process.pid));

    db = await buildIndex(storeB.path);

    expect(contains(db, "Zymurgical")).toBe(false);
  });

  it("still serves store B its own older snapshot after a write", async () => {
    // The legitimate stale path must survive the isolation fix.
    (await buildIndex(storeB.path)).close();
    (await buildIndex(storeA.path)).close(); // a neighbour rebuild must not evict B
    writeFile(path.join(storeB.path, "bravo", "FINDINGS.md"), "# bravo\n\n- Peripatetic note\n");

    db = await loadIndexForHook(storeB.path);

    expect(lastEvent(storeB.path).cache).toBe("stale");
    expect(contains(db, "Borborygmic")).toBe(true);  // B's own previous snapshot
    expect(contains(db, "Zymurgical")).toBe(false);  // never A's
  });
});
