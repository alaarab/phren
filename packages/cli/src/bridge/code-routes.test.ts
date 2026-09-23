import { saveCodeNote } from "./code-note.js";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../test-helpers.js";
import { indexProject } from "../../../code/src/indexer.js";
import { search } from "../../../code/src/query.js";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { CodeReindexer, CodeRoutes, resolveCodeStore } from "./code-routes.js";
import { capabilitiesForModules, requireRoute } from "./server.js";

const FIXTURES = path.join(__dirname, "../../../code/src/__fixtures__");

let tmp: ReturnType<typeof makeTempDir>;
let repo: string;
let store: string;
let routes: CodeRoutes;

function git(...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=Fixture Author", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
}

function changed(root: string, file: string) {
  return { root, path: file, status: "M", patch: "", added: 1, removed: 0 };
}

async function waitFor(condition: () => Promise<boolean>, timeout = 4_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await condition()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

beforeEach(async () => {
  tmp = makeTempDir("code-routes-");
  repo = path.join(tmp.path, "repo");
  store = path.join(tmp.path, "store");
  fs.cpSync(FIXTURES, repo, { recursive: true });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixtures");
  fs.mkdirSync(path.join(store, "fixture"), { recursive: true });
  fs.writeFileSync(path.join(store, "fixture", "phren.project.yaml"), `sourcePath: ${repo}\n`);
  await indexProject(store, "fixture", { repoRoot: repo });
  routes = new CodeRoutes(store);
});

afterEach(() => {
  tmp.cleanup();
});

describe("code Hook routes", () => {
  it("reports an indexed project's status", async () => {
    const status = await routes.status("fixture");
    expect(status.available).toBe(true);
    expect(status.symbols).toBeGreaterThan(0);
    expect(status.references).toBeGreaterThan(0);
    expect(status.languages.map(entry => entry.language)).toContain("typescript");
  });

  it("searches symbols with the query shape", async () => {
    const result = await routes.search("fixture", "add", null, null);
    expect(result.project).toBe("fixture");
    const hit = result.symbols.find(symbol => symbol.name === "add");
    expect(hit).toBeDefined();
    expect(hit).toMatchObject({ kind: "function", file: expect.stringContaining("typescript/") });
    expect(typeof hit!.line).toBe("number");
    expect(typeof hit!.signature).toBe("string");
    expect(typeof hit!.uses).toBe("number");
  });

  it("returns a file outline in source order", async () => {
    const result = await routes.outline("fixture", "typescript/app.ts");
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.map(entry => entry.name)).toContain("add");
    expect(Array.isArray(result.entries[0].children)).toBe(true);
  });

  it("returns a definition with its snippet and blame", async () => {
    const result = await routes.definition("fixture", "Point");
    expect(result.definition.symbol.name).toBe("Point");
    expect(result.definition.snippet).toContain("Point");
    expect(result.definition.blame?.authorHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("groups references by file", async () => {
    const result = await routes.references("fixture", "add", null);
    expect(result.references.symbol.name).toBe("add");
    expect(result.references.total).toBeGreaterThan(0);
    expect(result.references.groups[0].references[0]).toHaveProperty("line");
  });

  it("returns hot and cold usage", async () => {
    const result = await routes.usage("fixture", null);
    expect(result.usage.hot.length).toBeGreaterThan(0);
    expect(result.usage.cold.length).toBeGreaterThan(0);
  });

  it("404s a project with no index and 400s an invalid name", async () => {
    await expect(routes.status("missing")).rejects.toMatchObject({ status: 404, message: expect.stringContaining("No code index") });
    await expect(routes.search("Bad Name", "x", null, null)).rejects.toThrow();
  });

  it("404s a symbol that is not indexed", async () => {
    await expect(routes.definition("fixture", "NoSuchSymbol")).rejects.toMatchObject({ status: 404 });
  });
});

describe("code module gate", () => {
  const snapshot = (names: string[]) => ({ store: "/store", profile: "work", generation: "test",
    modules: BUILTIN_MODULES.filter(module => names.includes(module.name)), has: (name: string) => names.includes(name) });

  it("advertises the code capability and serves the routes only when the module is on", () => {
    const on = snapshot(["memory", "code"]);
    expect(capabilitiesForModules(on).code).toBe(true);
    expect(() => requireRoute(on, "GET", "/v1/code/status")).not.toThrow();

    const off = snapshot(["memory"]);
    expect(capabilitiesForModules(off).code).toBeUndefined();
    expect(() => requireRoute(off, "GET", "/v1/code/status")).toThrow("phren code needs @phren/code: run phren modules enable code");
  });
});

describe("code re-index on change", () => {
  it("re-indexes a changed file incrementally", async () => {
    const file = path.join(repo, "typescript/util.ts");
    fs.appendFileSync(file, "\nexport function freshlyAdded(): number { return 1; }\n");
    const reindexer = new CodeReindexer({ store, debounceMs: 20, log: () => {} });
    reindexer.record([changed(fs.realpathSync(repo), "typescript/util.ts")]);
    const found = await waitFor(async () => (await search(store, "fixture", "freshlyAdded")).value.length > 0);
    reindexer.close();
    expect(found).toBe(true);
  });

  it("runs a full re-index after a branch switch", async () => {
    const calls: Array<{ full?: boolean }> = [];
    const reindexer = new CodeReindexer({ store, debounceMs: 20, log: () => {},
      index: async (target, project, options) => { calls.push(options ?? {}); return indexProject(target, project, options); } });
    const root = fs.realpathSync(repo);
    reindexer.record([changed(root, "typescript/util.ts")]);
    await waitFor(async () => calls.length === 1);
    expect(calls[0].full).toBe(false);

    git("checkout", "-q", "-b", "another-branch");
    reindexer.record([changed(root, "typescript/util.ts")]);
    await waitFor(async () => calls.length === 2);
    reindexer.close();
    expect(calls[1].full).toBe(true);
  });
});


it("saves a symbol note, exposes it in the dossier and sends the bounded brief", async () => {
  const hit = (await routes.definition("fixture", "Point")).definition.symbol;
  let brief = "";
  const input = { project: "fixture", symbol: "Point", file: hit.file, line: hit.line,
    text: "Point coordinates must remain immutable while calculating distances.", target: { harness: "codex" } };
  const result = await saveCodeNote(store, input, async (_note, text) => { brief = text; return { ok: true }; });
  expect(result.saved).toBe(true);
  expect(brief).toContain(`${hit.file}:${hit.line}`);
  expect(brief).toContain("class Point");
  expect(brief).toContain(input.text);
  expect((await routes.definition("fixture", "Point")).definition.findings[0]).toMatchObject({ symbol: "Point", text: expect.stringContaining(input.text) });
  await expect(saveCodeNote(store, { ...input, line: 10000 })).rejects.toMatchObject({ status: 409 });
  await expect(saveCodeNote(store, { ...input, target: undefined, file: "../escape" })).rejects.toThrow();
});

it("preserves a saved note when agent delivery fails", async () => {
  const hit = (await routes.definition("fixture", "Point")).definition.symbol;
  const result = await saveCodeNote(store, { project: "fixture", symbol: "Point", file: hit.file, line: hit.line,
    text: "Point distance calculations need stable coordinate values throughout the operation.", target: { harness: "codex" } }, async () => { throw new Error("Session went offline"); });
  expect(result).toMatchObject({ saved: true, delivery: { ok: false, message: "Session went offline" } });
});


it("batches file and directory symbol summaries and resolves exact file declarations", async () => {
  const result = await routes.outlineSummary("fixture", JSON.stringify(["typescript", "typescript/app.ts", "typescript/util.ts", "typescript-neighbor", "missing.ts"]));
  const entry = (name: string) => result.entries.find(row => row.path === name)!;
  expect(entry("typescript").symbols).toBe(entry("typescript/app.ts").symbols + entry("typescript/util.ts").symbols);
  expect(entry("typescript/app.ts").symbols).toBeGreaterThan(1);
  expect(entry("typescript/app.ts").kinds.map(row => row.kind)).toContain("method");
  expect(entry("typescript-neighbor").symbols).toBe(0);
  expect(entry("missing.ts").symbols).toBe(0);
  const symbol = entry("typescript/app.ts").symbol!;
  expect((await routes.definition("fixture", symbol)).definition.symbol.file).toBe("typescript/app.ts");
  expect((await routes.references("fixture", symbol, null)).references.symbol.file).toBe("typescript/app.ts");
  await expect(routes.definition("fixture", "wrong.ts::add")).rejects.toMatchObject({ status: 404 });
  for (const paths of [["../escape"], ["/absolute"], ["..\\escape"], [], Array(201).fill("file.ts")]) {
    await expect(routes.outlineSummary("fixture", JSON.stringify(paths))).rejects.toThrow();
  }
  await expect(routes.outlineSummary("fixture", "not json")).rejects.toMatchObject({ status: 400 });
  await expect(routes.outlineSummary("missing", '["file.ts"]')).rejects.toMatchObject({ status: 404 });
});

it("keeps a code note addressed to the originating session", async () => {
  const symbol = (await routes.definition("fixture", "typescript/app.ts::Point")).definition.symbol;
  const session = "aaaaaaaa-1111-4111-8111-111111111111";
  let recipient: unknown;
  const result = await saveCodeNote(store, { project: "fixture", symbol: "typescript/app.ts::Point", file: symbol.file,
    line: symbol.line, text: "Point coordinates must stay stable during distance calculations.", target: { session } },
    async note => { recipient = note.target; return { delivered: true }; });
  expect(result.saved).toBe(true);
  expect(recipient).toEqual({ session });
});

it("selects only registered stores and prevents writes to read-only stores", async () => {
  const team = path.join(tmp.path, "team");
  fs.mkdirSync(team);
  fs.writeFileSync(path.join(store, "stores.yaml"), `version: 1
stores:
  - id: "11223344"
    name: primary
    path: ${store}
    role: primary
    sync: managed-git
  - id: aabbccdd
    name: team
    path: ${team}
    role: readonly
    sync: pull-only
    remote: https://github.com/sam/brain.git
`);
  expect(await resolveCodeStore(store, "sam/brain")).toBe(team);
  await expect(resolveCodeStore(store, "sam/brain", true)).rejects.toMatchObject({ status: 403 });
  await expect(resolveCodeStore(store, "sam/missing")).rejects.toMatchObject({ status: 404 });
  await expect(resolveCodeStore(store, "../escape")).rejects.toThrow();
});

it("pages the whole usage ranking with exact file and family filters", async () => {
  const first = await routes.usagePage("fixture", { limit: "3" });
  expect(first.total).toBeGreaterThan(3);
  expect(first.entries).toHaveLength(3);
  expect(first.maxUses).toBe(first.entries[0].uses);
  const collected = [...first.entries];
  for (let offset = 3; offset < first.total; offset += 3) {
    const page = await routes.usagePage("fixture", { limit: "3", offset: String(offset) });
    expect(page.total).toBe(first.total);
    collected.push(...page.entries);
  }
  expect(new Set(collected.map(row => row.id)).size).toBe(first.total);
  expect(collected.some(row => row.uses === 0)).toBe(true);
  expect(collected.some(row => row.kind === "variable")).toBe(true);
  expect(collected.map(row => row.uses)).toEqual(collected.map(row => row.uses).sort((a, b) => b - a));
  const cold = await routes.usagePage("fixture", { limit: "3", end: "1" });
  expect(cold.entries.map(row => row.id)).toEqual(collected.slice(-3).map(row => row.id));
  expect(cold.offset).toBe(first.total - 3);
  const filtered = await routes.usagePage("fixture", { file: "typescript/app.ts", kind: "types" });
  expect(filtered.entries.length).toBeGreaterThan(0);
  expect(filtered.entries.every(row => row.file === "typescript/app.ts" && ["class", "struct", "enum", "interface", "type"].includes(row.kind))).toBe(true);
  expect((await routes.usagePage("fixture", { file: "missing.ts" })).entries).toEqual([]);
  expect((await routes.usagePage("fixture", { offset: "999999" })).entries).toEqual([]);
  for (const values of [{ offset: "-1" }, { limit: "101" }, { kind: "invalid" }, { file: "../escape" }, { directory: "/absolute" }, { end: "yes" }]) {
    await expect(routes.usagePage("fixture", values)).rejects.toThrow();
  }
  await expect(routes.usagePage("missing")).rejects.toMatchObject({ status: 404 });
});

it("browses only indexed files with descendant symbol and language totals", async () => {
  fs.mkdirSync(path.join(repo, "typescript-neighbor"));
  fs.writeFileSync(path.join(repo, "typescript-neighbor", "empty.ts"), "// No declarations\n");
  fs.mkdirSync(path.join(repo, "src🧠"));
  fs.writeFileSync(path.join(repo, "src🧠", "app.ts"), "export function unicodeThing() { return 1; }\n");
  git("add", "typescript-neighbor/empty.ts", "src🧠/app.ts");
  await routes.reindex("fixture");
  const root = await routes.tree("fixture");
  const typescript = root.entries.find(entry => entry.path === "typescript")!;
  expect(typescript).toMatchObject({ directory: true, languages: ["typescript"] });
  const children = await routes.tree("fixture", "typescript");
  expect(children.entries.every(entry => entry.path.startsWith("typescript/") && !entry.directory)).toBe(true);
  expect(typescript.files).toBe(children.entries.length);
  expect(typescript.symbols).toBe(children.entries.reduce((sum, entry) => sum + entry.symbols, 0));
  expect((await routes.tree("fixture", "typescript-neighbor")).entries[0]).toMatchObject({ symbols: 0, files: 1 });
  expect((await routes.tree("fixture", "type%")).entries).toEqual([]);
  expect((await routes.tree("fixture", "src🧠")).entries[0].path).toBe("src🧠/app.ts");
  expect((await routes.usagePage("fixture", { directory: "src🧠" })).entries[0].name).toBe("unicodeThing");
  for (const directory of ["../escape", "/absolute", "..\\escape", "typescript/"]) await expect(routes.tree("fixture", directory)).rejects.toThrow();
  await expect(routes.tree("missing")).rejects.toMatchObject({ status: 404 });
});

it("scopes search to a literal directory and groups type kinds", async () => {
  expect((await routes.search("fixture", "Point", "types", null, "typescript")).symbols.length).toBeGreaterThan(0);
  const swift = (await routes.search("fixture", "Point", null, null, "swift")).symbols;
  expect(swift.length).toBeGreaterThan(0);
  expect(swift.every(row => row.file.startsWith("swift/"))).toBe(true);
  expect((await routes.search("fixture", "Point", null, null, "type%")).symbols).toEqual([]);
});


it("reports a completed no-change scan separately from symbol recency", async () => {
  const before = await routes.recent("fixture", "typescript");
  const first = await routes.status("fixture");
  const status = await routes.reindex("fixture");
  expect(status.lastIndexedAt).toBeGreaterThan(first.lastIndexedAt!);
  expect((await routes.recent("fixture", "typescript")).entries).toEqual(before.entries);
  expect(before.entries.length).toBeGreaterThan(0);
  expect(before.entries.every(row => row.file.startsWith("typescript/"))).toBe(true);
});

it("lists a file's resolved references with file-qualified declarations", async () => {
  const result = await routes.fileReferences("fixture", "typescript/util.ts");
  expect(result.path).toBe("typescript/util.ts");
  expect(result.references.find(entry => entry.name === "add")).toMatchObject({ symbol: "typescript/app.ts::add", file: "typescript/app.ts" });
  expect((await routes.definition("fixture", result.references[0].symbol)).definition.symbol.file).toBe(result.references[0].file);
  expect((await routes.fileReferences("fixture", "typescript/missing.ts")).references).toEqual([]);
  for (const bad of ["../escape", "/absolute", "a//b", "a\\b", ""]) await expect(routes.fileReferences("fixture", bad)).rejects.toThrow();
  await expect(routes.fileReferences("missing", "file.ts")).rejects.toMatchObject({ status: 404 });
});
