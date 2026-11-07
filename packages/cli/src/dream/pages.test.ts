import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import { buildIndex } from "../shared/index.js";
import { checkPageLinks, listPages, MAX_PAGE_BYTES, PageError, pageSlug, readPage, writePage } from "./pages.js";

describe("dream pages", () => {
  let tmp: { path: string; cleanup: () => void };
  let store: string;
  const project = "lantern";

  beforeEach(() => {
    tmp = makeTempDir("phren-pages-");
    store = tmp.path;
    initTestPhrenRoot(store);
    fs.mkdirSync(path.join(store, "global"), { recursive: true });
    fs.mkdirSync(path.join(store, project), { recursive: true });
  });
  afterEach(() => tmp.cleanup());

  it("accepts a slug or the changeset's page path and rejects anything that could leave pages/", () => {
    expect(pageSlug("rate-limiter")).toBe("rate-limiter");
    expect(pageSlug("reference/pages/rate-limiter.md")).toBe("rate-limiter");
    for (const bad of ["../truths", "reference/pages/../x.md", "Upper", "-lead", "trail-", "a/b", "", "x".repeat(65), "reference/topics/api.md"]) {
      expect(() => pageSlug(bad), bad).toThrow(PageError);
    }
  });

  it("writes a page in page shape, reads it back and lists it", async () => {
    const result = await writePage(store, project, "rate-limiter",
      "# Rate limiter\n\nPostgres advisory locks back the limiter (fid:a1000009). See [[database]].\n", ["database", "ops"]);
    expect(result.path).toBe(path.join(store, project, "reference", "pages", "rate-limiter.md"));
    expect(result.brokenLinks.sort()).toEqual(["database", "ops"]);

    const page = readPage(store, project, "reference/pages/rate-limiter.md")!;
    expect(page.title).toBe("Rate limiter");
    expect(page.summary).toContain("Postgres advisory locks");
    expect(page.markdown).toMatch(/^---\ntitle: Rate limiter\nsummary: .+\nupdated: \d{4}-\d{2}-\d{2}\n---\n/);
    expect(page.links).toEqual(["database", "ops"]);
    expect(page.fids).toEqual(["a1000009"]);
    expect(listPages(store, project).map((p) => p.slug)).toEqual(["rate-limiter"]);
  });

  it("keeps the model's frontmatter and resolves links once the target page exists", async () => {
    await writePage(store, project, "database", "---\ntitle: \"Database: Postgres\"\nsummary: Where data lives\n---\nBody [[rate-limiter]]", []);
    const second = await writePage(store, project, "rate-limiter", "Limiter. [[database]]", ["database"]);
    expect(second.brokenLinks).toEqual([]);
    expect(readPage(store, project, "database")!.title).toBe("Database: Postgres");
    expect(checkPageLinks(store, project)).toEqual([]);
  });

  it("reports broken links and unknown fids across a project", async () => {
    await writePage(store, project, "auth", "Tokens (fid:aaaaaaaa, fid:bbbbbbbb). [[sessions]] [[Bad Slug]]", []);
    expect(checkPageLinks(store, project, ["aaaaaaaa"])).toEqual([
      { slug: "auth", brokenLinks: ["sessions", "Bad Slug"], unknownFids: ["bbbbbbbb"] },
    ]);
  });

  it("refuses oversized pages and unknown projects", async () => {
    await expect(writePage(store, project, "big", "x".repeat(MAX_PAGE_BYTES), [])).rejects.toThrow(/over 16 KB/);
    await expect(writePage(store, "nope", "a", "body", [])).rejects.toThrow(/not found/);
    expect(readPage(store, project, "missing")).toBeNull();
  });

  it("is indexed as a reference doc by the existing search index", async () => {
    await writePage(store, project, "rate-limiter", "Postgres advisory locks back the limiter.", []);
    const db = await buildIndex(store, undefined, { force: true });
    const rows = db.exec("SELECT type, filename FROM docs WHERE path = ?", [path.join(store, project, "reference", "pages", "rate-limiter.md")]);
    expect(rows[0]?.values).toEqual([["reference", "rate-limiter.md"]]);
  });
});
