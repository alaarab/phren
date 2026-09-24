import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../cli/src/test-helpers.js";
import { indexProject, resolveRepoRoot } from "./indexer.js";
import { references } from "./query.js";
import { codeIndexStatus } from "./status.js";
import { codeDatabasePath, getMeta, openCodeDatabase, topSymbolsByUsage } from "./store.js";

const FIXTURES = path.join(__dirname, "__fixtures__");
const AUTHOR = "Fixture Author <fixture@example.com>";

let tmp: ReturnType<typeof makeTempDir>;
let repo: string;
let store: string;

function git(...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "user.name=Fixture Author", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
}

beforeEach(() => {
  tmp = makeTempDir("code-index-");
  repo = path.join(tmp.path, "repo");
  store = path.join(tmp.path, "store");
  fs.cpSync(FIXTURES, repo, { recursive: true });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixtures");
});

afterEach(() => {
  tmp.cleanup();
});

describe("code indexer", () => {
  it("indexes tracked files and reports counts", async () => {
    const result = await indexProject(store, "fixture", { repoRoot: repo });
    expect(result.files).toBe(7);
    expect(result.parsed).toBe(7);
    expect(result.removed).toBe(0);
    expect(result.symbols).toBeGreaterThan(10);
    expect(result.references).toBeGreaterThan(0);
    expect(fs.existsSync(codeDatabasePath(store, "fixture"))).toBe(true);
  });

  it("resolves references to project symbols and computes usage counts", async () => {
    await indexProject(store, "fixture", { repoRoot: repo });
    const database = await openCodeDatabase(store, "fixture", false);
    expect(database).toBeDefined();
    const usage = topSymbolsByUsage(database!.db, 100);
    expect(usage.find(entry => entry.name === "greet")?.uses).toBeGreaterThanOrEqual(3);
    expect(usage.find(entry => entry.name === "add")?.uses).toBeGreaterThanOrEqual(1);
    expect(usage.find(entry => entry.name === "length")?.uses).toBeGreaterThanOrEqual(1);
    database!.close();
  });

  it("stores blame as a hash of the author line, never the name", async () => {
    await indexProject(store, "fixture", { repoRoot: repo });
    const expected = createHash("sha256").update(AUTHOR).digest("hex");
    const database = await openCodeDatabase(store, "fixture", false);
    const rows = database!.db.exec("SELECT author_hash FROM blame")[0]?.values ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row[0] === expected)).toBe(true);
    database!.close();

    const bytes = fs.readFileSync(codeDatabasePath(store, "fixture"));
    expect(bytes.includes(Buffer.from("Fixture Author"))).toBe(false);
    expect(bytes.includes(Buffer.from("fixture@example.com"))).toBe(false);
  });

  it("re-parses only the file whose hash changed", async () => {
    const first = await indexProject(store, "fixture", { repoRoot: repo });
    fs.appendFileSync(
      path.join(repo, "typescript", "util.ts"),
      "\nexport function triple(value: number): number {\n  return add(value, add(value, value));\n}\n",
    );
    const second = await indexProject(store, "fixture", { repoRoot: repo });
    expect(second.parsed).toBe(1);
    expect(second.removed).toBe(0);
    expect(second.files).toBe(7);
    expect(second.symbols).toBe(first.symbols + 1);
  });

  it("deletes rows for files that vanished", async () => {
    await indexProject(store, "fixture", { repoRoot: repo });
    fs.unlinkSync(path.join(repo, "unknown", "notes.custom"));
    const result = await indexProject(store, "fixture", { repoRoot: repo });
    expect(result.removed).toBe(1);
    expect(result.files).toBe(6);
    const status = await codeIndexStatus(store, "fixture");
    expect(status.languages.find(entry => entry.language === "unknown")).toBeUndefined();
  });

  it("re-parses everything on --full", async () => {
    await indexProject(store, "fixture", { repoRoot: repo });
    const full = await indexProject(store, "fixture", { repoRoot: repo, full: true });
    expect(full.parsed).toBe(7);
    expect(full.files).toBe(7);
  });

  it("reports status per language and for a missing index", async () => {
    await indexProject(store, "fixture", { repoRoot: repo });
    const status = await codeIndexStatus(store, "fixture");
    expect(status.available).toBe(true);
    expect(status.files).toBe(7);
    expect(status.lastIndexedAt).not.toBeNull();
    const languages = Object.fromEntries(status.languages.map(entry => [entry.language, entry.files]));
    expect(languages).toMatchObject({ typescript: 2, swift: 2, python: 2, unknown: 1 });
    expect(status.kinds.some(entry => entry.kind === "function" && entry.symbols > 0)).toBe(true);

    const missing = await codeIndexStatus(store, "absent");
    expect(missing.available).toBe(false);
    expect(missing.files).toBe(0);
  });

  it("resolves this machine's checkout when the store's sourcePath is absent", async () => {
    // The store was registered on another computer: its sourcePath names a
    // folder this machine does not have, while the checkout lives under this
    // machine's own project root (PROJECTS_DIR, the way locateProject searches).
    const machineRoot = path.join(tmp.path, "machine-root");
    const checkout = path.join(machineRoot, "fixture");
    fs.mkdirSync(machineRoot, { recursive: true });
    fs.cpSync(repo, checkout, { recursive: true });
    fs.mkdirSync(path.join(store, "fixture"), { recursive: true });
    fs.writeFileSync(path.join(store, "fixture", "phren.project.yaml"), `sourcePath: ${path.join(tmp.path, "absent", "fixture")}\n`);

    const result = await indexProject(store, "fixture", { env: { ...process.env, PROJECTS_DIR: machineRoot } });
    expect(result.repoRoot).toBe(checkout);
    expect(result.files).toBe(7);
    // The index records the checkout it actually used, so definition snippets
    // read from this machine rather than the store's foreign sourcePath.
    const database = await openCodeDatabase(store, "fixture", false);
    expect(getMeta(database!.db, "repo_root")).toBe(checkout);
    database!.close();

    // --repo still overrides the machine resolution.
    expect(resolveRepoRoot(store, "fixture", repo)).toBe(path.resolve(repo));
  });
});

it("refreshes unchanged callers after definitions move, become ambiguous, or disappear", async () => {
  const definition = path.join(repo, "typescript/unique.ts");
  const caller = path.join(repo, "typescript/caller.ts");
  fs.writeFileSync(definition, "export function uniqueCall() { return 1; }\n");
  fs.writeFileSync(caller, "uniqueCall();\n");
  git("add", "-A");
  await indexProject(store, "fixture", { repoRoot: repo });
  const calls = async () => (await references(store, "fixture", "uniqueCall")).value;
  expect((await calls())?.total).toBe(1);
  fs.writeFileSync(definition, "\nexport function uniqueCall() { return 2; }\n");
  expect((await indexProject(store, "fixture", { repoRoot: repo })).parsed).toBe(1);
  expect((await calls())?.total).toBe(1);
  const duplicate = path.join(repo, "typescript/duplicate.ts");
  fs.writeFileSync(duplicate, "export function uniqueCall() { return 3; }\n");
  git("add", "-A");
  await indexProject(store, "fixture", { repoRoot: repo });
  expect((await calls())?.total).toBe(0);
  fs.unlinkSync(duplicate);
  await indexProject(store, "fixture", { repoRoot: repo });
  expect((await calls())?.total).toBe(1);
  fs.writeFileSync(definition, "export function unrelated() { return 4; }\n");
  await indexProject(store, "fixture", { repoRoot: repo });
  expect((await references(store, "fixture", "unrelated")).value?.total).toBe(0);
});
