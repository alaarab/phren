import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../cli/src/test-helpers.js";
import { indexProject } from "./indexer.js";
import { definition, outline, references, search, usage } from "./query.js";
import { openCodeDatabase, rowsOf } from "./store.js";

const FIXTURES = path.join(__dirname, "__fixtures__");

let tmp: ReturnType<typeof makeTempDir>;
let repo: string;
let store: string;

function git(...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=Fixture Author", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
}

beforeEach(async () => {
  tmp = makeTempDir("code-query-");
  repo = path.join(tmp.path, "repo");
  store = path.join(tmp.path, "store");
  fs.cpSync(FIXTURES, repo, { recursive: true });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixtures");
  await indexProject(store, "fixture", { repoRoot: repo });
});

afterEach(() => {
  tmp.cleanup();
});

describe("code search", () => {
  it("puts an exact name match first", async () => {
    const result = await search(store, "fixture", "add");
    expect(result.available).toBe(true);
    expect(result.value.length).toBeGreaterThan(0);
    expect(result.value[0].name).toBe("add");
    expect(result.value[0].kind).toBe("function");
  });

  it("preserves bm25 scores when scoring matches in one pass", async () => {
    const database = (await openCodeDatabase(store, "fixture", false))!;
    try {
      const fts = '"point"*';
      const reference = rowsOf(database.db, `SELECT s.id,
        (SELECT bm25(symbols_fts) FROM symbols_fts WHERE symbols_fts.rowid = s.id AND symbols_fts MATCH ?)
        FROM symbols s WHERE s.id IN (SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?)`, [fts, fts]);
      const result = await search(store, "fixture", "point");
      expect(reference.length).toBeGreaterThan(0);
      for (const [id, score] of reference) {
        expect(result.value.find(hit => hit.id === id)?.rank).toBe(score);
      }
    } finally { database.close(); }
  });

  it("matches by prefix", async () => {
    const result = await search(store, "fixture", "poi");
    expect(result.value.some(hit => hit.name === "Point")).toBe(true);
    expect(result.value[0].name).toBe("Point");
  });

  it("matches words from a doc comment through FTS5", async () => {
    const result = await search(store, "fixture", "greeting");
    expect(result.value.some(hit => hit.name === "greet")).toBe(true);
    expect(result.value[0].name).not.toBe("greeting");
  });

  it("filters by kind", async () => {
    const result = await search(store, "fixture", "point", "class");
    expect(result.value.length).toBeGreaterThan(0);
    expect(result.value.every(hit => hit.kind === "class")).toBe(true);
  });

  it("reports an absent index instead of failing", async () => {
    const result = await search(store, "absent", "add");
    expect(result.available).toBe(false);
    expect(result.value).toEqual([]);
  });
});

describe("code definition", () => {
  it("resolves a plain name and returns its snippet and last change", async () => {
    const result = await definition(store, "fixture", "add");
    expect(result.available).toBe(true);
    const found = result.value;
    expect(found?.symbol.name).toBe("add");
    expect(found?.symbol.kind).toBe("function");
    expect(found?.symbol.exported).toBe(true);
    expect(found?.snippet).toContain("return a + b;");
    expect(found?.blame?.authorHash).toMatch(/^[0-9a-f]{64}$/);
    expect(found?.blame?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(found?.candidates).toBe(1);
  });

  it("accepts the Foo.bar form", async () => {
    const result = await definition(store, "fixture", "Point.length");
    expect(result.value?.symbol.name).toBe("length");
    expect(result.value?.symbol.parent).toBe("Point");
    expect(result.value?.symbol.kind).toBe("method");
    expect(result.value?.snippet).toContain("Math.sqrt");
  });

  it("accepts the bar() form", async () => {
    const result = await definition(store, "fixture", "greet()");
    expect(result.value?.symbol.name).toBe("greet");
    expect(result.value?.symbol.kind).toBe("function");
  });

  it("returns undefined for an unknown symbol", async () => {
    const result = await definition(store, "fixture", "NoSuchSymbol");
    expect(result.available).toBe(true);
    expect(result.value).toBeUndefined();
  });
});

describe("code references", () => {
  it("groups resolved references by file", async () => {
    const result = await references(store, "fixture", "greet");
    expect(result.available).toBe(true);
    const found = result.value!;
    expect(found.total).toBeGreaterThanOrEqual(3);
    expect(found.groups.length).toBeGreaterThanOrEqual(1);
    const files = found.groups.map(group => group.file);
    expect(new Set(files).size).toBe(files.length);
    for (const group of found.groups) {
      expect(group.references.length).toBeGreaterThan(0);
      for (const ref of group.references) expect(ref.line).toBeGreaterThan(0);
    }
  });

  it("accepts the Foo.bar form", async () => {
    const result = await references(store, "fixture", "Point.length");
    expect(result.value?.symbol.name).toBe("length");
    expect(result.value?.groups.length).toBeGreaterThanOrEqual(1);
  });
});

describe("code outline", () => {
  it("lists a file's symbols in order and nests members under their parent", async () => {
    const result = await outline(store, "fixture", "typescript/app.ts");
    expect(result.available).toBe(true);
    const names = result.value.map(entry => entry.name);
    expect(names).toContain("add");
    expect(names).toContain("Point");
    expect(names.indexOf("add")).toBeLessThan(names.indexOf("Point"));
    const point = result.value.find(entry => entry.name === "Point");
    expect(point?.children.map(child => child.name)).toContain("length");
  });

  it("returns nothing for a file the index does not know", async () => {
    const result = await outline(store, "fixture", "typescript/missing.ts");
    expect(result.available).toBe(true);
    expect(result.value).toEqual([]);
  });
});

describe("code usage", () => {
  it("returns hot and cold symbols in count order", async () => {
    const result = await usage(store, "fixture", 5);
    expect(result.available).toBe(true);
    const { top, bottom } = result.value;
    expect(top.length).toBeGreaterThan(0);
    expect(bottom.length).toBeGreaterThan(0);
    for (let i = 1; i < top.length; i++) expect(top[i - 1].uses).toBeGreaterThanOrEqual(top[i].uses);
    for (let i = 1; i < bottom.length; i++) expect(bottom[i - 1].uses).toBeLessThanOrEqual(bottom[i].uses);
  });

  it("prefers exported non-variable symbols for a common name and counts candidates", async () => {
    fs.writeFileSync(
      path.join(repo, "typescript", "noise.ts"),
      [
        'import { add } from "./app";',
        "",
        "const length = 3;",
        "const z = add(1, 2);",
        "const buttons = 0;",
        "",
        "export function loop(): number {",
        "  return z + z + add(z, z) + z + z + buttons + length;",
        "}",
        "",
        "function hidden(): number {",
        "  return buttons + length;",
        "}",
        "",
      ].join("\n"),
    );
    // The index walks `git ls-files`, so a new file must be tracked first.
    git("add", "-A");
    await indexProject(store, "fixture", { repoRoot: repo });

    const found = await definition(store, "fixture", "length");
    expect(found.value?.candidates).toBeGreaterThan(1);
    expect(found.value?.symbol.kind).not.toBe("variable");
    expect(found.value?.symbol.exported).toBe(true);
    expect(found.value?.symbol.file).toBe("typescript/app.ts");

    const result = await usage(store, "fixture", 20);
    expect(result.value.top.some(entry => entry.name === "z" && entry.kind === "variable")).toBe(false);
    expect(result.value.top.every(entry => entry.kind !== "variable")).toBe(true);
    expect(result.value.bottom.some(entry => entry.name === "z")).toBe(false);
  });
});

it("does not resolve a member in a different container", async () => {
  expect((await definition(store, "fixture", "Missing.length")).value).toBeUndefined();
});

it("searches dollar-prefixed identifiers without FTS syntax errors", async () => {
  fs.appendFileSync(path.join(repo, "typescript/util.ts"), "\nexport function $helper() { return 1; }\n");
  await indexProject(store, "fixture", { repoRoot: repo });
  expect((await search(store, "fixture", "$helper")).value[0]?.name).toBe("$helper");
});

describe("recent index observations", () => {
  it("retains unchanged symbols across reindex and advances body edits", async () => {
    const { recentSymbols } = await import("./query.js");
    const before = (await recentSymbols(store, "fixture", "typescript", 100)).value;
    const original = before.find(row => row.name === "add")!;
    const unchanged = before.find(row => row.name === "Point")!;
    expect(original.indexedAt).toBeGreaterThan(0);
    const file = path.join(repo, original.file);
    const content = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, content.replace("return a + b", "return a + b + 1"));
    await indexProject(store, "fixture", { repoRoot: repo });
    const after = (await recentSymbols(store, "fixture", "typescript", 100)).value;
    expect(after.find(row => row.name === "add")!.indexedAt).toBeGreaterThan(original.indexedAt);
    expect(after.find(row => row.name === "Point")!.indexedAt).toBe(unchanged.indexedAt);
    await indexProject(store, "fixture", { repoRoot: repo, full: true });
    expect((await recentSymbols(store, "fixture", "typescript", 100)).value).toEqual(after);
  });
});
