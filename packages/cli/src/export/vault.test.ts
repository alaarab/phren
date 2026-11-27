import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { CORE_SCHEMA, load } from "js-yaml";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatCommand } from "../cli-help.js";
import { lookupCommand } from "../cli-registry.js";
import { importVault } from "../import/vault.js";
import { attachedStoresFilePath, writeStoreRegistry } from "../store-registry.js";
import { initTestPhrenRoot, makeTempDir, writeFile } from "../test-helpers.js";
import { exportVault } from "./vault.js";

vi.mock("fs", async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), linkSync: vi.fn(actual.linkSync) };
});

let tmp: ReturnType<typeof makeTempDir>;
let store: string;
let vault: string;

beforeEach(() => {
  vi.stubEnv("PHREN_FEDERATION_PATHS", "");
  tmp = makeTempDir("phren-vault-");
  store = path.join(tmp.path, "store");
  vault = path.join(tmp.path, "vault");
  initTestPhrenRoot(store);
});

afterEach(() => {
  vi.unstubAllEnvs();
  tmp.cleanup();
});

function attachTeam(team = path.join(tmp.path, "team")): string {
  initTestPhrenRoot(team);
  writeStoreRegistry(store, { version: 1, stores: [
    { id: "aaa11111", name: "personal", path: store, role: "primary", sync: "managed-git" },
    { id: "bbb22222", name: "studio", path: team, role: "team", sync: "managed-git", projects: ["atlas"] },
  ] });
  return team;
}

function linkDirectory(target: string, alias: string, skip: (note: string) => never): void {
  try {
    fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code && ["EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(code)) {
      skip(`Directory links are unavailable on this filesystem (${code}).`);
    }
    throw error;
  }
}

function notes() {
  return fs.readdirSync(vault).flatMap(file => {
    if (!file.endsWith(".md")) return [];
    const text = fs.readFileSync(path.join(vault, file), "utf8");
    const match = /^---\n([\s\S]+?)\n---\n([\s\S]*)$/.exec(text);
    if (!match) return [];
    return [{ file, body: match[2], meta: load(match[1], { schema: CORE_SCHEMA }) as Record<string, unknown> }];
  });
}

function linkTo(file: string) {
  return `[[${file.slice(0, -3)}|`;
}

function manualLinks(root: string, links: Array<[string, string]>): void {
  writeFile(path.join(root, ".runtime", "manual-links.json"), JSON.stringify(links.map(([sourceDoc, entity]) => (
    { sourceDoc, entity, entityType: "fragment", relType: "mentions" }
  ))));
}

it("exports fragments linked from imported reference notes and skips generated notes on re-import", async () => {
  const source = path.join(tmp.path, "source-vault");
  const project = path.join(store, "demo");
  const options = { dryRun: false, prune: false };
  fs.mkdirSync(project);
  writeFile(path.join(source, "Field note.md"), "# Field note\n\n[[Gamma]] and Redis\n");
  writeFile(path.join(store, "other", "reference", "Note.md"), "[[Delta]]\n");
  expect(importVault(source, project, options).added).toBe(1);

  await expect(exportVault(store, vault, ["demo"], false)).resolves.toEqual({ projects: 1, findings: 0, fragments: 1 });
  const exported = notes();
  expect(exported.map(note => note.meta.kind).sort()).toEqual(["fragment", "project"]);
  const fragment = exported.find(note => note.meta.fragment === "gamma")!;
  const demo = exported.find(note => note.meta.project === "demo")!;
  expect(demo.body).toContain(linkTo(fragment.file));
  expect(fragment.body).toContain(linkTo(demo.file));

  const reimport = importVault(vault, project, options);
  expect(reimport).toMatchObject({ added: 0, updated: 0, generated: 2 });
  expect(fs.existsSync(reimport.root)).toBe(false);
});

it("exports all finding tiers, lifecycle links, fragment links, and citations", async () => {
  writeFile(path.join(store, "atlas", "FINDINGS.md"), [
    "# Atlas Findings", "",
    '- [decision] Use `lattice` for paced fanout <!-- fid:aaaa0001 --> <!-- created: 2026-10-01 --> <!-- phren:contradicts "fid:cccc0001" --> <!-- phren:contradicts "fid:eeee0001" -->',
    '  <!-- phren:cite {"created_at":"2026-10-01T00:00:00.000Z","remote":"example.com/team/atlas","file":"src/fanout.ts","line":41,"commit":"1a2b3c4","symbol":"pace"} -->',
    '- [context] Record the window size <!-- fid:aaaa0002 --> <!-- phren:supersedes "fid:cccc0002" --> <!-- fragment: airgap -->', "",
  ].join("\n"));
  writeFile(path.join(store, "atlas/reference/topics", "fanout.md"), [
    "# Fanout", "",
    '- [architecture_v1] Use random delay <!-- fid:bbbb0001 --> <!-- phren:superseded_by "Use `lattice` for paced" 2026-10-02 -->', "",
  ].join("\n"));
  writeFile(path.join(store, "atlas/reference/topics", "fanout.older.md"), [
    "# Early fanout", "",
    '- [pattern] Use `lattice` for unbounded fanout <!-- fid:cccc0001 -->',
    '- Ignore the window size <!-- fid:cccc0002 --> <!-- phren:status "retracted" -->',
    "- Record the original pacing interval", "",
  ].join("\n"));
  writeFile(path.join(store, "atlas/reference", "glossary.md"), "# Glossary\n");
  manualLinks(store, [["atlas/reference/glossary.md", "windglass"], ["atlas/reference/topics/fanout.older.md", "lattice"]]);

  await expect(exportVault(store, vault, [], false)).resolves.toMatchObject({ projects: 1, findings: 6 });
  const exported = notes();
  const current = exported.find(note => note.meta.fid === "aaaa0001")!;
  const old = exported.find(note => note.meta.fid === "bbbb0001")!;
  const opposite = exported.find(note => note.meta.fid === "cccc0001")!;
  const retracted = exported.find(note => note.meta.fid === "cccc0002")!;
  const window = exported.find(note => note.meta.fid === "aaaa0002")!;
  const project = exported.find(note => note.meta.kind === "project")!;
  const glossary = exported.find(note => note.meta.fragment === "windglass")!;
  const annotated = exported.find(note => note.meta.fragment === "airgap")!;
  const lattice = exported.find(note => note.meta.fragment === "lattice")!;

  expect(current.meta).toMatchObject({ phren: "generated", kind: "finding", project: "atlas", type: "decision", status: "contradicted", created: "2026-10-01" });
  expect(old.meta).toMatchObject({ type: "architecture_v1", status: "superseded", status_updated: "2026-10-02" });
  expect(retracted.meta.status).toBe("retracted");
  expect(exported.some(note => note.meta.kind === "finding" && note.meta.fid === null && note.body.includes("original pacing interval"))).toBe(true);
  expect(current.body).toContain(`supersedes ${linkTo(old.file)}`);
  expect(old.body).toContain(`superseded_by ${linkTo(current.file)}`);
  expect(current.body).toContain(`contradicts ${linkTo(opposite.file)}`);
  expect(current.body).toMatch(/contradicts ` fid:eeee0001 `/);
  expect(opposite.body).toContain(`contradicts ${linkTo(current.file)}`);
  expect(window.body).toContain(`supersedes ${linkTo(retracted.file)}`);
  expect(current.body).toContain(linkTo(lattice.file));
  expect(old.body).not.toContain(linkTo(lattice.file));
  expect(window.body).not.toContain(linkTo(lattice.file));
  expect(window.body).toContain(linkTo(annotated.file));
  expect(annotated.body).toContain(linkTo(window.file));
  expect(lattice.body).toContain(linkTo(opposite.file));
  expect(current.body).toContain(linkTo(project.file));
  expect(project.body).toContain(linkTo(current.file));
  expect(project.body).toContain(linkTo(glossary.file));
  expect(glossary.body).toContain(linkTo(project.file));
  expect(current.body).toMatch(/## Citation[\s\S]*example\.com\/team\/atlas[\s\S]*src\/fanout\.ts[\s\S]*41[\s\S]*1a2b3c4[\s\S]*pace/);
});

it("rejects destinations inside or containing stores and destinations inside the checkout", async ({ skip }) => {
  const teamParent = path.join(tmp.path, "teams");
  const team = attachTeam(path.join(teamParent, "team"));
  const alias = path.join(tmp.path, "alias");
  linkDirectory(team, alias, skip);
  const parentAlias = path.join(tmp.path, "ancestor-alias");
  linkDirectory(teamParent, parentAlias, skip);
  const relativeStore = path.relative(process.cwd(), path.join(store, "nested", "vault"));
  for (const target of [store, relativeStore, path.join(team, "vault"), path.join(alias, "nested", "vault"), tmp.path, teamParent, parentAlias]) {
    await expect(exportVault(store, target, [], false)).rejects.toThrow(/outside the Phren store/);
  }
  const checkoutAlias = path.join(tmp.path, "checkout-alias");
  linkDirectory(process.cwd(), checkoutAlias, skip);
  const checkoutFolder = `./vault-rejection-${path.basename(tmp.path)}`;
  for (const target of [checkoutFolder, path.join(checkoutAlias, checkoutFolder)]) {
    await expect(exportVault(store, target, [], false)).rejects.toThrow(/outside the source checkout/);
    expect(fs.existsSync(target)).toBe(false);
  }
  expect(fs.existsSync(path.join(store, "nested"))).toBe(false);
  expect(fs.existsSync(path.join(team, "vault"))).toBe(false);
  expect(fs.existsSync(path.join(team, "nested"))).toBe(false);
});

it("rejects a destination alias that contains a registered store symlink", async ({ skip }) => {
  const physicalTeam = path.join(tmp.path, "physical-team");
  initTestPhrenRoot(physicalTeam);
  fs.mkdirSync(vault);
  const registeredParent = path.join(tmp.path, "registered-parent");
  linkDirectory(vault, registeredParent, skip);
  linkDirectory(physicalTeam, path.join(vault, "team"), skip);
  attachTeam(path.join(registeredParent, "team"));
  const destinationAlias = path.join(tmp.path, "destination-alias");
  linkDirectory(vault, destinationAlias, skip);

  await expect(exportVault(store, destinationAlias, [], false)).rejects.toThrow(/outside the Phren store/);
  expect(fs.readdirSync(vault)).toEqual(["team"]);
});

it.each(["malformed", "not a file"] as const)("refuses an export when the attachment registry is %s", async problem => {
  const team = attachTeam();
  const registry = attachedStoresFilePath(store);
  if (problem === "malformed") writeFile(registry, "version: 1\nstores: [\n");
  else {
    fs.unlinkSync(registry);
    fs.mkdirSync(registry);
  }
  const destination = path.join(team, "vault");
  await expect(exportVault(store, destination, [], false)).rejects.toThrow(/store registry could not be fully read/);
  expect(fs.existsSync(destination)).toBe(false);
});

it.each([{ projects: [true] }, { projects: ["atlas", true] }, { projects: "atlas" }, { projects: ["../atlas"] }])(
  "refuses an export with an invalid raw subscription $projects", async ({ projects }) => {
    const team = attachTeam();
    writeFile(path.join(team, "hidden", "FINDINGS.md"), "- Keep this project out of the export <!-- fid:aaaa0001 -->\n");
    const registry = attachedStoresFilePath(store);
    const data = load(fs.readFileSync(registry, "utf8"), { schema: CORE_SCHEMA }) as { stores: Array<{ projects: unknown }> };
    data.stores[0].projects = projects;
    writeFile(registry, JSON.stringify(data));
    await expect(exportVault(store, vault, [], false)).rejects.toThrow(/invalid project subscription/);
    expect(fs.existsSync(vault)).toBe(false);
  },
);

it("skips non-regular findings and a topic directory alias outside the selected project", async () => {
  const atlas = path.join(store, "atlas");
  fs.mkdirSync(path.join(atlas, "FINDINGS.md"), { recursive: true });
  const outside = path.join(store, "other", "reference");
  writeFile(path.join(outside, "topics", "private.md"), "- A finding from another project <!-- fid:bbbb0001 -->\n");
  const reference = path.join(atlas, "reference");
  fs.symlinkSync(outside, reference, "junction");
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(exportVault(store, vault, ["atlas"], false)).resolves.toEqual({ projects: 1, findings: 0, fragments: 0 });
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("expected a regular file"));
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("outside the selected project"));
    expect(notes().map(note => note.meta.kind)).toEqual(["project"]);
  } finally { warnings.mockRestore(); }
});

it.skipIf(process.platform === "win32")("checks active, topic, and older finding files against their own project's canonical path", async () => {
  const atlas = path.join(store, "atlas");
  const privateFindings = path.join(store, "other", "FINDINGS.md");
  writeFile(privateFindings, "- A finding from another project <!-- fid:bbbb0001 -->\n");
  writeFile(path.join(atlas, "reference/topics", "inside.older.md"), "- A finding inside this project <!-- fid:aaaa0001 -->\n");
  const paths = ["FINDINGS.md", "reference/topics/linked.md", "reference/topics/linked.older.md"].map(file => path.join(atlas, file));
  for (const file of paths) fs.symlinkSync(privateFindings, file, "file");
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(exportVault(store, vault, ["atlas"], false)).resolves.toEqual({ projects: 1, findings: 1, fragments: 0 });
    expect(notes().filter(note => note.meta.kind === "finding").map(note => note.meta.fid)).toEqual(["aaaa0001"]);
    for (const file of paths) expect(warnings).toHaveBeenCalledWith(expect.stringContaining(`${file} (outside the selected project)`));
  } finally { warnings.mockRestore(); }
});

it("uses portable collision-free names and honors repeated project filters and dry-run through the CLI", async () => {
  const team = attachTeam();
  writeFile(path.join(store, "atlas", "FINDINGS.md"), "- Use `sprout/a` or `sprout-a` <!-- fid:aaaa0001 -->\n");
  writeFile(path.join(team, "atlas", "FINDINGS.md"), '- Check `lapis` when sprout-a is offline <!-- fid:aaaa0001 --> <!-- conflicts_with: "Check the red gate" (from project: south) -->\n');
  writeFile(path.join(team, "hidden", "FINDINGS.md"), "- A project outside the subscription <!-- fid:bbbb0001 -->\n");
  writeFile(path.join(store, "north", "summary.md"), "# North\n");
  writeFile(path.join(store, "south", "FINDINGS.md"), "- Check the red gate <!-- fid:cccc0001 -->\n");
  writeFile(path.join(team, "atlas/reference", "shared.md"), "# Shared reference\n");
  manualLinks(store, [["atlas/FINDINGS.md", "legacyambiguous"], ["atlas/reference/shared.md", "legacyteam"]]);
  const home = path.join(tmp.path, "home");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("PHREN_FEATURE_NATIVE_MEMORY", "on");
  writeFile(path.join(home, ".claude/projects/native/memory/MEMORY-atlas.md"), "- Use `nativeweave`\n");

  await expect(exportVault(store, vault, [], false)).resolves.toEqual({ projects: 4, findings: 3, fragments: 4 });
  const exported = notes();
  const fragments = exported.filter(note => note.meta.kind === "fragment");
  expect(fragments.map(note => note.meta.fragment).sort()).toEqual(["lapis", "legacyteam", "sprout-a", "sprout/a"]);
  expect(fragments.every(note => /^[a-z0-9_-]+\.md$/.test(note.file))).toBe(true);
  const personal = exported.find(note => note.meta.fid === "aaaa0001" && note.meta.project === "atlas")!;
  const shared = exported.find(note => note.meta.fid === "aaaa0001" && note.meta.project === "studio/atlas")!;
  const south = exported.find(note => note.meta.fid === "cccc0001")!;
  expect(personal.file).not.toBe(shared.file);
  expect(shared.body).toContain(linkTo(fragments.find(note => note.meta.fragment === "lapis")!.file));
  expect(shared.body).not.toContain("[[fragment-sprout");
  const teamProject = exported.find(note => note.meta.kind === "project" && note.meta.project === "studio/atlas")!;
  expect(teamProject.body).toContain(linkTo(fragments.find(note => note.meta.fragment === "legacyteam")!.file));
  expect(shared.body).toContain(`contradicts ${linkTo(south.file)}`);
  expect(south.body).toContain(`contradicts ${linkTo(shared.file)}`);
  await expect(exportVault(store, vault, ["atlas"], true)).rejects.toThrow(/personal\/atlas or studio\/atlas/);
  await expect(exportVault(store, vault, ["hidden"], true)).rejects.toThrow(/was not found/);

  const preview = path.join(tmp.path, "preview");
  const command = lookupCommand("export")!;
  const ctx = { phrenPath: () => store, profile: () => "restricted-profile" };
  const args = ["vault", preview, "--project", "north", "--project", "personal/atlas", "--project", "north"];
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(formatCommand("export")).toContain("phren export vault <dir> [[--project <name>]... [--dry-run] | --force-unlock]");
    await expect(command.run([...args, "--dry-run"], ctx)).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith("Would export 2 projects, 1 finding, and 3 fragments.");
    expect(fs.existsSync(preview)).toBe(false);
    await expect(command.run(["vault", vault, ...args.slice(2)], ctx)).resolves.toBe(0);
    expect(notes().filter(note => note.meta.kind === "project").map(note => note.meta.project).sort()).toEqual(["atlas", "north"]);
    expect(notes().filter(note => note.meta.kind === "fragment").map(note => note.meta.fragment).sort()).toEqual(["legacyambiguous", "sprout-a", "sprout/a"]);
  } finally {
    log.mockRestore();
  }
});

it("prefers exact lifecycle references and links only unique truncated references", async () => {
  writeFile(path.join(store, "atlas", "FINDINGS.md"), [
    "- Run sync <!-- fid:aaaa0001 -->",
    "- Run sync after lunch <!-- fid:aaaa0002 -->",
    '- Queue the sync <!-- fid:aaaa0003 --> <!-- phren:supersedes "Run sync" -->',
    '- Inspect the summary <!-- fid:aaaa0004 --> <!-- phren:contradicts "Run sync after" -->',
    '- Inspect the alternatives <!-- fid:aaaa0005 --> <!-- phren:contradicts "Run" -->', "",
  ].join("\n"));
  await exportVault(store, vault, [], false);
  const byFid = new Map(notes().filter(note => note.meta.kind === "finding").map(note => [note.meta.fid, note]));
  const short = linkTo(byFid.get("aaaa0001")!.file);
  const long = linkTo(byFid.get("aaaa0002")!.file);
  expect(byFid.get("aaaa0003")!.body).toContain(`supersedes ${short}`);
  expect(byFid.get("aaaa0003")!.body).not.toContain(long);
  expect(byFid.get("aaaa0004")!.body).toContain(`contradicts ${long}`);
  expect(byFid.get("aaaa0005")!.body).toContain("contradicts ` Run `");
});

it("uses generated note targets for source wikilinks and renders unresolved targets literally", async () => {
  writeFile(path.join(store, "atlas", "FINDINGS.md"), [
    "- Use `lattice` for fanout <!-- fid:aaaa0001 -->",
    "- See [[project-atlas|our project]], [[project-atlas#findings|list]], [[project-atlas#Missing]], ![[fragment-lattice.md]], [[#Fragments|here]], [[Deployment.md]], [[Guides/Deployment.md|Guide]], [[fragment-deployment.md|exact]] and ![[Diagram]] <!-- fid:aaaa0002 --> <!-- fragment: lattice -->", "",
  ].join("\n"));
  await exportVault(store, vault, [], false);
  const exported = notes();
  const documents = new Map(exported.map(note => [note.file, note.body]));
  const { body, file } = exported.find(note => note.meta.fid === "aaaa0002")!;
  expect(body).toContain("[[project-atlas|our project]]");
  expect(body).toContain("[[project-atlas#Findings|list]]");
  expect(body).toContain(`[[${file.slice(0, -3)}#Fragments|here]]`);
  expect(body).toContain("\\[\\[project-atlas#Missing\\]\\]");
  expect(body).toContain("![[fragment-lattice|lattice]]");
  expect(body).toContain("[[fragment-deployment|deployment]]");
  expect(body).toContain("[[fragment-deployment|Guide]]");
  expect(body).toContain("[[fragment-deployment|exact]]");
  expect(body).toContain("!\\[\\[Diagram\\]\\]");
  for (const note of exported) for (const [, target, heading] of note.body.matchAll(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]/g)) {
    const linked = documents.get(`${target}.md`);
    expect(linked).toBeDefined();
    if (heading) expect(linked!.split("\n")).toContain(`## ${heading}`);
  }
});

it("regenerates identical bytes, updates notes in place, and removes only stale generated notes", async () => {
  const source = path.join(store, "atlas", "FINDINGS.md");
  writeFile(source, "- Remove this <!-- fid:aaaa0001 -->\n- Replace this <!-- fid:aaaa0002 -->\n- Keep this <!-- fid:aaaa0003 -->\n");
  writeFile(path.join(vault, "PROJECT-ATLAS.MD"), "My atlas\n");
  writeFile(path.join(vault, ".obsidian", "workspace.json"), "{}\n");
  const snapshot = () => Object.fromEntries(fs.readdirSync(vault, { withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => [entry.name, fs.readFileSync(path.join(vault, entry.name), "utf8")]));

  await exportVault(store, vault, [], false);
  const first = snapshot();
  await exportVault(store, vault, [], false);
  expect(snapshot()).toEqual(first);
  const original = notes();
  const stale = original.find(note => note.meta.fid === "aaaa0001")!.file;
  const replaced = original.find(note => note.meta.fid === "aaaa0002")!.file;
  const kept = original.find(note => note.meta.fid === "aaaa0003")!.file;

  const replacement = "---\nphren: generated\n---\n\nMy replacement note\n";
  writeFile(path.join(vault, replaced), replacement);
  writeFile(source, "- Updated finding <!-- fid:aaaa0003 -->\n");
  await exportVault(store, vault, [], false);
  const regenerated = snapshot();
  expect(regenerated[stale]).toBeUndefined();
  expect(regenerated[kept]).toContain("Updated finding");
  expect(regenerated[replaced]).toBe(replacement);
  expect(regenerated["PROJECT-ATLAS.MD"]).toBe("My atlas\n");
  expect(fs.readFileSync(path.join(vault, ".obsidian", "workspace.json"), "utf8")).toBe("{}\n");
});

it("recovers pending notes only when their contents match the recorded hash", async () => {
  const source = path.join(store, "atlas", "FINDINGS.md");
  writeFile(source, "- Planned finding <!-- fid:aaaa0001 -->\n- Written finding <!-- fid:aaaa0002 -->\n");
  await exportVault(store, vault, [], false);
  const planned = notes().find(note => note.meta.fid === "aaaa0001")!.file;
  const written = notes().find(note => note.meta.fid === "aaaa0002")!.file;
  const manifest = path.join(vault, ".phren-vault.json");
  const { files } = JSON.parse(fs.readFileSync(manifest, "utf8"));
  writeFile(manifest, JSON.stringify({ version: 1, files: {}, pending: files }));
  const unrelated = "---\nphren: generated\n---\n\nA user's file at the pending path\n";
  writeFile(path.join(vault, planned), unrelated);
  writeFile(source, "- The planned finding now needs an update <!-- fid:aaaa0001 -->\n");

  await exportVault(store, vault, [], false);
  expect(fs.readFileSync(path.join(vault, planned), "utf8")).toBe(unrelated);
  expect(fs.existsSync(path.join(vault, written))).toBe(false);
  const updated = notes().find(note => note.meta.fid === "aaaa0001")!;
  expect(updated.file).not.toBe(planned);
  expect(updated.body).toContain("needs an update");
  const saved = JSON.parse(fs.readFileSync(manifest, "utf8"));
  expect(saved.pending).toBeUndefined();
  expect(saved.files[planned]).toBeUndefined();
  expect(saved.files[updated.file]).toBe(createHash("sha256").update(fs.readFileSync(path.join(vault, updated.file))).digest("hex"));
});

it("preserves an unrelated lock filename even after the usual stale-lock age", async () => {
  const lock = path.join(vault, ".phren-vault.json.lock");
  const content = "A user placed this file here\n";
  writeFile(lock, content);
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);
  await expect(exportVault(store, vault, [], false)).rejects.toThrow(/Vault lock filename conflict/);
  const command = lookupCommand("export")!;
  await expect(command.run(["vault", vault, "--force-unlock"], { phrenPath: () => store, profile: () => "" }))
    .rejects.toThrow(/Vault lock filename conflict/);
  expect(fs.readFileSync(lock, "utf8")).toBe(content);
  expect(fs.readdirSync(vault)).toEqual([path.basename(lock)]);
});

it("reports the lock owner and releases a stopped export only through explicit CLI recovery", async () => {
  const lock = path.join(vault, ".phren-vault.json.lock");
  const owner = JSON.stringify({ kind: "phren-vault-export", version: 1, pid: 2147483647, host: "review-computer",
    createdAt: "2026-01-01T00:00:00.000Z", nonce: "12345678-aaaa-4bbb-8ccc-123456789abc" });
  writeFile(lock, owner);
  await expect(exportVault(store, vault, [], false)).rejects.toThrow(/PID 2147483647 on review-computer since 2026-01-01T00:00:00.000Z.*--force-unlock/);
  expect(fs.readFileSync(lock, "utf8")).toBe(owner);

  const command = lookupCommand("export")!;
  const ctx = { phrenPath: () => store, profile: () => "" };
  await expect(command.run(["vault", vault, "--force-unlock", "--dry-run"], ctx)).rejects.toThrow(/by itself/);
  expect(fs.readFileSync(lock, "utf8")).toBe(owner);
  await expect(command.run(["vault", vault, "--force-unlock"], ctx)).resolves.toBe(0);
  expect(fs.readdirSync(vault)).toEqual([]);
  await expect(exportVault(store, vault, [], false)).resolves.toEqual({ projects: 0, findings: 0, fragments: 0 });
  expect(fs.existsSync(lock)).toBe(false);
});

it.each(["lock", "finding"] as const)("keeps a partial %s write off the final filename and retries cleanly", async kind => {
  writeFile(path.join(store, "atlas", "FINDINGS.md"), "- A finding to publish <!-- fid:aaaa0001 -->\n");
  const actual = await vi.importActual<typeof fs>("fs");
  const write = vi.mocked(fs.writeFileSync);
  const marker = kind === "lock" ? '"kind":"phren-vault-export"' : 'kind: "finding"';
  write.mockImplementation((file, data, options) => {
    if (typeof data === "string" && data.includes(marker)) {
      actual.writeFileSync(file, data.slice(0, 15), options);
      throw new Error("simulated short write");
    }
    return actual.writeFileSync(file, data, options);
  });
  try {
    await expect(exportVault(store, vault, [], false)).rejects.toThrow(/simulated short write/);
  } finally { write.mockImplementation(actual.writeFileSync); }
  expect(fs.readdirSync(vault).filter(file => file.endsWith(".lock") || file.endsWith(".tmp") || file.startsWith("finding-"))).toEqual([]);
  await exportVault(store, vault, [], false);
  expect(fs.readdirSync(vault).filter(file => file.startsWith("finding-"))).toHaveLength(1);
  expect(notes().find(note => note.meta.fid === "aaaa0001")!.body).toContain("A finding to publish");
});

it("publishes the complete lock exclusively when an existing record appears during staging", async () => {
  const lock = path.join(fs.realpathSync.native(tmp.path), "vault", ".phren-vault.json.lock");
  const actual = await vi.importActual<typeof fs>("fs");
  const link = vi.mocked(fs.linkSync);
  const existing = JSON.stringify({ kind: "phren-vault-export", version: 1, pid: 42, host: "other-export",
    createdAt: "2026-01-01T00:00:00.000Z", nonce: "12345678-aaaa-4bbb-8ccc-123456789abc" });
  link.mockImplementation((staged, final) => {
    if (final === lock) {
      expect(JSON.parse(fs.readFileSync(staged, "utf8"))).toMatchObject({ kind: "phren-vault-export", pid: process.pid });
      expect(fs.existsSync(lock)).toBe(false);
      actual.writeFileSync(lock, existing, { flag: "wx" });
    }
    return actual.linkSync(staged, final);
  });
  try {
    await expect(exportVault(store, vault, [], false)).rejects.toThrow(/PID 42 on other-export/);
  } finally { link.mockImplementation(actual.linkSync); }
  expect(fs.readFileSync(lock, "utf8")).toBe(existing);
  expect(fs.readdirSync(vault)).toEqual([path.basename(lock)]);
});

it.each(["missing", "malformed"] as const)("stops with a recovery message for a %s manifest", async problem => {
  writeFile(path.join(store, "atlas", "FINDINGS.md"), "- A generated finding <!-- fid:aaaa0001 -->\n");
  await exportVault(store, vault, [], false);
  const manifest = path.join(vault, ".phren-vault.json");
  if (problem === "missing") {
    for (const note of notes()) {
      const file = path.join(vault, note.file);
      writeFile(file, fs.readFileSync(file, "utf8").replace("phren: generated", 'title: Synthetic note\nphren: "generated"'));
    }
    fs.unlinkSync(manifest);
  } else writeFile(manifest, "{\n");
  const snapshot = () => fs.readdirSync(vault).map(file => [file, fs.readFileSync(path.join(vault, file), "utf8")]);
  const before = snapshot();

  await expect(exportVault(store, vault, [], false)).rejects.toThrow(/Restore \.phren-vault\.json from a backup/);
  expect(snapshot()).toEqual(before);
});

it("refuses a manifest with a filename outside the vault", async () => {
  const userNote = path.join(tmp.path, "project-personal.md");
  const content = "---\nphren: generated\n---\n\nA separate note\n";
  writeFile(userNote, content);
  const manifest = JSON.stringify({ version: 1, files: { "../project-personal.md": createHash("sha256").update(content).digest("hex") } });
  writeFile(path.join(vault, ".phren-vault.json"), manifest);
  await expect(exportVault(store, vault, [], false)).rejects.toThrow(/Invalid vault manifest/);
  expect(fs.readFileSync(userNote, "utf8")).toBe(content);
  expect(fs.readFileSync(path.join(vault, ".phren-vault.json"), "utf8")).toBe(manifest);
});
