import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { runTopLevelCommand } from "../entrypoint.js";
import { buildIndex, queryFragmentLinks, queryRows } from "../shared/index.js";
import { initTestPhrenRoot, makeTempDir, writeFile } from "../test-helpers.js";

const interruption = vi.hoisted(() => ({ beforeWrite: undefined as ((file: string) => void) | undefined }));

vi.mock("../phren-paths.js", async original => {
  const paths = await original<typeof import("../phren-paths.js")>();
  return {
    ...paths,
    atomicWriteText: (...args: Parameters<typeof paths.atomicWriteText>) => {
      interruption.beforeWrite?.(args[0]);
      paths.atomicWriteText(...args);
    },
  };
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("phren import vault", () => {
  let tmp: ReturnType<typeof makeTempDir>;
  let vault: string;
  let store: string;
  let reference: string;

  beforeEach(() => {
    tmp = makeTempDir("phren-vault-import-");
    vault = path.join(tmp.path, "Field Notes");
    store = path.join(tmp.path, "store");
    reference = path.join(store, "demo", "reference");
    fs.mkdirSync(vault);
    writeFile(path.join(reference, "existing.md"), "Original reference\n");
    initTestPhrenRoot(store);
    vi.stubEnv("PHREN_PATH", store);
    vi.stubEnv("PHREN_PROFILE", "");
  });

  afterEach(() => {
    interruption.beforeWrite = undefined;
    vi.unstubAllEnvs();
    tmp.cleanup();
  });

  async function run(flags: string[] = [], dir = vault, project = "demo") {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExit = process.exitCode;
    try {
      expect(await runTopLevelCommand(["import", "vault", dir, "--project", project, ...flags])).toBe(true);
      return { code: process.exitCode, output: stdout.mock.calls.flat().join("\n"), error: stderr.mock.calls.flat().join("\n") };
    } finally {
      process.exitCode = previousExit;
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }

  function importRoot() {
    const parent = path.join(reference, "obsidian");
    return path.join(parent, fs.readdirSync(parent)[0]);
  }

  it("uses the current PHREN_PATH when the next import targets a different store", async () => {
    const nextStore = path.join(tmp.path, "next-store");
    const nextReference = path.join(nextStore, "demo", "reference");
    initTestPhrenRoot(nextStore);
    fs.mkdirSync(nextReference, { recursive: true });
    writeFile(path.join(vault, "Note.md"), "Import to the selected store\n");
    expect(await run(["--dry-run"])).toMatchObject({ code: 0, error: "" });

    vi.stubEnv("PHREN_PATH", nextStore);
    expect(await run()).toMatchObject({ code: 0, error: "" });
    const parent = path.join(nextReference, "obsidian");
    expect(fs.readFileSync(path.join(parent, fs.readdirSync(parent)[0], "Note.md"), "utf8")).toBe("Import to the selected store\n");
    expect(fs.existsSync(path.join(reference, "obsidian"))).toBe(false);
  });

  it("previews, filters and indexes a nested vault without altering note bytes", async () => {
    const body = "\uFEFF---\r\ntags: [synthetic]\r\n---\r\n# Field journal\r\nquartzsignal\r\n"
      + "[[Note]] [[Spindrift|display-label]] [[Mooring#tide-line]] [[Guides/Lantern.md#Setup|label]] ![[picture.png]] [[#Local]]\r\n";
    writeFile(path.join(vault, "Guides", "Journal.MD"), body);
    writeFile(path.join(vault, "Guides", "Lantern.md"), "# Lantern\n");
    writeFile(path.join(vault, ".obsidian", "Workspace.md"), "Workspace content\n");
    writeFile(path.join(vault, ".trash", "Deleted.md"), "Trashed content\n");
    writeFile(path.join(vault, ".git", "Cache.md"), "Repository metadata\n");
    writeFile(path.join(vault, "Attachments", "Asset.md"), "Attached content\n");
    writeFile(path.join(vault, "picture.png"), "Synthetic attachment\n");
    writeFile(path.join(vault, "Frontmatter.md"), "\uFEFF---\r\nphren: 'generated' # export\r\n---\r\nMarked export\r\n");
    writeFile(path.join(vault, "finding-listed.md"), "Manifest-only export\n");
    writeFile(path.join(vault, "fragment-pending.md"), "Pending export\n");
    writeFile(path.join(vault, "project-stale.md"), "Personal replacement\n");
    writeFile(path.join(vault, ".phren-vault.json"), JSON.stringify({
      version: 1,
      files: { "finding-listed.md": sha256("Manifest-only export\n"), "project-stale.md": sha256("Old export\n") },
      pending: { "fragment-pending.md": sha256("Pending export\n"), "project-stale.md": sha256("Another export\n") },
    }));

    const preview = await run(["--dry-run"]);
    expect(preview.code).toBe(0);
    expect(preview.output).toContain("3 added, 0 updated, 0 unchanged");
    expect(preview.output).toContain("3 generated and 0 oversized skipped");
    expect(preview.output).toContain('Would add: "Guides/Journal.md"');
    expect(fs.existsSync(path.join(reference, "obsidian"))).toBe(false);

    (await buildIndex(store)).close();
    expect((await run()).code).toBe(0);
    const root = importRoot();
    expect(fs.readdirSync(root).sort()).toEqual([".phren-import.json", "Guides", "project-stale.md"]);
    expect(fs.readdirSync(path.join(root, "Guides")).sort()).toEqual(["Journal.md", "Lantern.md"]);
    expect(fs.readFileSync(path.join(root, "Guides", "Journal.md"), "utf8")).toBe(body);
    expect(fs.readFileSync(path.join(root, "project-stale.md"), "utf8")).toBe("Personal replacement\n");
    for (const note of ["Guides/Journal.md", "Guides/Lantern.md", "project-stale.md"]) {
      fs.utimesSync(path.join(root, note), 946684800, 946684800);
    }

    const db = await buildIndex(store);
    try {
      expect(queryRows(db, "SELECT filename, type FROM docs WHERE docs MATCH ?", ["quartzsignal"])).toEqual([["Journal.md", "reference"]]);
      const source = `demo/reference/obsidian/${path.basename(root)}/Guides/Journal.md`;
      for (const name of ["note", "spindrift", "mooring", "lantern"]) {
        expect(queryFragmentLinks(db, name).related).toEqual([source]);
      }
      for (const name of ["display-label", "tide-line", "picture.png", "local"]) {
        expect(queryFragmentLinks(db, name).related).toEqual([]);
      }
    } finally {
      db.close();
    }
  });

  it.each([
    { version: 2, files: {} },
    { version: 1, files: ["finding-listed.md"] },
    { version: 1, files: {}, pending: { "finding-pending.md": "invalid" } },
  ])("rejects an invalid export manifest without importing notes", async manifest => {
    writeFile(path.join(vault, "Personal.md"), "Personal note\n");
    writeFile(path.join(vault, ".phren-vault.json"), JSON.stringify(manifest));
    expect(await run()).toMatchObject({ code: 1, error: expect.stringContaining("Invalid export manifest") });
    expect(fs.existsSync(path.join(reference, "obsidian"))).toBe(false);
  });

  it("leaves identical copies untouched, refreshes edits and only prunes missing tracked notes", async () => {
    for (const filename of ["Stable.md", "Changed.md", "Gone.md", "Growing.md"]) writeFile(path.join(vault, filename), "Original text\n");
    expect((await run()).code).toBe(0);
    const root = importRoot();
    const stable = path.join(root, "Stable.md");
    fs.utimesSync(stable, 946684800, 946684800);
    const oldMtime = fs.statSync(stable).mtimeMs;
    writeFile(path.join(root, "Manual.md"), "Hand-written reference\n");
    writeFile(path.join(vault, "Changed.md"), "Edited text\n");
    writeFile(path.join(vault, "Growing.md"), "x".repeat(1024 * 1024 + 1));
    fs.unlinkSync(path.join(vault, "Gone.md"));

    const updated = await run();
    expect(updated.code).toBe(0);
    expect(updated.output).toContain("0 added, 1 updated, 1 unchanged, 1 missing, 0 pruned");
    expect(updated.output).toContain('Missing from vault: "Gone.md"');
    expect(updated.output).toContain('Over 1 MiB: "Growing.md"');
    expect(fs.statSync(stable).mtimeMs).toBe(oldMtime);
    expect(fs.readFileSync(path.join(root, "Changed.md"), "utf8")).toBe("Edited text\n");
    expect(fs.existsSync(path.join(root, "Gone.md"))).toBe(true);

    expect((await run(["--dry-run", "--prune"])).output).toContain("1 missing, 1 pruned");
    expect(fs.existsSync(path.join(root, "Gone.md"))).toBe(true);
    expect((await run(["--prune"])).output).toContain("1 missing, 1 pruned");
    expect(fs.existsSync(path.join(root, "Gone.md"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "Growing.md"), "utf8")).toBe("Original text\n");
    expect(fs.readFileSync(path.join(root, "Manual.md"), "utf8")).toBe("Hand-written reference\n");
    expect((await run(["--prune"])).output).toContain("0 missing, 0 pruned");
  });

  it.each([
    { phase: "before the first publication", failAt: "Existing.md", edited: false, published: false, counts: "1 added, 1 updated, 0 unchanged" },
    { phase: "before a nested publication", failAt: "New.md", edited: true, published: false, counts: "1 added, 0 updated, 1 unchanged" },
    { phase: "before inventory commit", failAt: ".phren-import.json", edited: true, published: true, counts: "0 added, 0 updated, 2 unchanged" },
  ])("recovers an import interrupted $phase", async ({ failAt, edited, published, counts }) => {
    writeFile(path.join(vault, "Existing.md"), "Original text\n");
    expect((await run()).code).toBe(0);
    const root = importRoot();
    const existing = path.join(root, "Existing.md");
    const added = path.join(root, "Guide", "New.md");
    writeFile(path.join(vault, "Existing.md"), "Edited text\n");
    writeFile(path.join(vault, "Guide", "New.md"), "New note\n");
    interruption.beforeWrite = file => {
      const name = path.basename(file);
      if (name === failAt && (!published || fs.existsSync(added))) {
        if (name === "New.md") fs.mkdirSync(path.dirname(file), { recursive: true });
        throw new Error("Simulated import interruption");
      }
    };

    expect(await run()).toMatchObject({ code: 1, error: expect.stringContaining("Simulated import interruption") });
    interruption.beforeWrite = undefined;
    expect(fs.readFileSync(existing, "utf8")).toBe(edited ? "Edited text\n" : "Original text\n");
    expect(fs.existsSync(added)).toBe(published);

    const retried = await run();
    expect(retried.code).toBe(0);
    expect(retried.output).toContain(counts);
    expect(fs.readdirSync(root).sort()).toEqual([".phren-import.json", "Existing.md", "Guide"]);
    expect(fs.readFileSync(existing, "utf8")).toBe("Edited text\n");
    expect(fs.readFileSync(added, "utf8")).toBe("New note\n");
  });

  it("keeps a manually replaced copy when its vault note changes or goes missing", async () => {
    writeFile(path.join(vault, "Personal.md"), "Imported text\n");
    expect((await run()).code).toBe(0);
    const copy = path.join(importRoot(), "Personal.md");
    writeFile(copy, "Hand-written replacement\n");
    writeFile(path.join(vault, "Personal.md"), "Different vault text\n");
    expect((await run()).output).toContain('Kept modified copy: "Personal.md"');
    expect(fs.readFileSync(copy, "utf8")).toBe("Hand-written replacement\n");

    fs.unlinkSync(path.join(vault, "Personal.md"));
    const pruned = await run(["--prune"]);
    expect(pruned.output).toContain("1 missing, 0 pruned");
    expect(pruned.output).toContain('Kept modified copy: "Personal.md"');
    expect(fs.readFileSync(copy, "utf8")).toBe("Hand-written replacement\n");
  });

  it("does not prune legacy path reservations without a completed copy digest", async () => {
    writeFile(path.join(vault, "Seed.md"), "Seed\n");
    expect((await run()).code).toBe(0);
    const root = importRoot();
    const personal = path.join(root, "Reserved.md");
    writeFile(personal, "Written after an interruption\n");
    writeFile(path.join(root, ".phren-import.json"), JSON.stringify({ version: 1, files: { "Reserved.md": "Reserved.md" } }));
    expect((await run(["--prune"])).code).toBe(0);
    expect(fs.readFileSync(personal, "utf8")).toBe("Written after an interruption\n");
  });

  it("avoids case-only collisions with personal files, directories and occupied suffixes", async () => {
    writeFile(path.join(vault, "Seed.md"), "Seed\n");
    expect((await run()).code).toBe(0);
    const root = importRoot();
    writeFile(path.join(root, "Note.md"), "Personal note\n");
    const occupiedSuffix = `NOTE~${sha256("note.md").slice(0, 12)}.md`;
    writeFile(path.join(root, occupiedSuffix), "Occupied suffix\n");
    writeFile(path.join(root, "Guide", "Personal.md"), "Personal folder\n");
    writeFile(path.join(vault, "note.md"), "Imported note\n");
    writeFile(path.join(vault, "guide", "Imported.md"), "Imported folder\n");

    expect((await run()).output).toContain("2 added, 0 updated, 1 unchanged");
    const names = fs.readdirSync(root);
    expect(new Set(names.map(name => name.toLowerCase())).size).toBe(names.length);
    expect(fs.readFileSync(path.join(root, occupiedSuffix), "utf8")).toBe("Occupied suffix\n");
    expect(fs.readFileSync(path.join(root, "Note.md"), "utf8")).toBe("Personal note\n");
    const allocatedNote = names.find(name => name.startsWith("note~"))!;
    const allocatedDir = names.find(name => name.startsWith("guide~"))!;
    expect(fs.readFileSync(path.join(root, allocatedNote), "utf8")).toBe("Imported note\n");
    expect(fs.readFileSync(path.join(root, allocatedDir, "Imported.md"), "utf8")).toBe("Imported folder\n");
    expect(fs.readdirSync(path.join(root, "Guide"))).toEqual(["Personal.md"]);
  });

  it("keeps vaults with the same folder name in separate import directories", async () => {
    const second = path.join(tmp.path, "other", path.basename(vault));
    writeFile(path.join(vault, "Shared.md"), "First vault\n");
    writeFile(path.join(second, "Shared.md"), "Second vault\n");
    expect((await run()).code).toBe(0);
    const firstRoot = importRoot();
    expect((await run([], second)).code).toBe(0);
    const parent = path.dirname(firstRoot);
    const roots = fs.readdirSync(parent);
    expect(roots).toHaveLength(2);
    const secondRoot = path.join(parent, roots.find(root => root !== path.basename(firstRoot))!);

    fs.unlinkSync(path.join(second, "Shared.md"));
    expect((await run(["--prune"], second)).output).toContain("1 missing, 1 pruned");
    expect(fs.existsSync(path.join(secondRoot, "Shared.md"))).toBe(false);
    expect(fs.readFileSync(path.join(firstRoot, "Shared.md"), "utf8")).toBe("First vault\n");
  });

  it.skipIf(process.platform === "win32")("keeps distinct notes whose original names sanitize to the same path", async () => {
    writeFile(path.join(vault, "Outline.", "chapter:one.md"), "Punctuation\n");
    writeFile(path.join(vault, "Outline.", "chapter_one.md"), "Underscore\n");
    writeFile(path.join(vault, "Outline.", "CON.md"), "Device name\n");

    expect((await run()).code).toBe(0);
    const folder = path.join(importRoot(), "Outline");
    const files = fs.readdirSync(folder);
    expect(files).toHaveLength(3);
    expect(files).toContain("_CON.md");
    expect(files.every(file => /^[_a-z0-9~]+\.md$/i.test(file))).toBe(true);
    expect(files.map(file => fs.readFileSync(path.join(folder, file), "utf8")).sort()).toEqual(["Device name\n", "Punctuation\n", "Underscore\n"]);
    expect((await run()).output).toContain("0 added, 0 updated, 3 unchanged");
  });

  it("skips linked source directories and rejects linked destinations or a traversal project", async () => {
    const outside = path.join(tmp.path, "outside");
    writeFile(path.join(outside, "Private.md"), "Outside content\n");
    writeFile(path.join(vault, "Public.md"), "Vault content\n");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(outside, path.join(vault, "Link"), linkType);
    const traversal = await run([], vault, "../outside");
    expect(traversal.code).toBe(1);
    expect(traversal.error).toContain('Invalid project name: "../outside"');

    const destination = path.join(reference, "obsidian");
    fs.symlinkSync(outside, destination, linkType);
    const redirected = await run();
    expect(redirected.code).toBe(1);
    expect(redirected.error).toContain("Unexpected file type");
    expect(fs.readdirSync(outside)).toEqual(["Private.md"]);

    fs.unlinkSync(destination);
    expect((await run()).code).toBe(0);
    expect(fs.readdirSync(importRoot()).sort()).toEqual([".phren-import.json", "Public.md"]);
  });
});
