import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findContextImportLines, fixContextImports, rewriteContextImports, scanContextImports } from "./context-imports.js";

const SAMPLE = `# ogrid

Findings here.

---

@reference/topics/commands.md
@reference/topics/architecture.md

@reference/topics/conventions.md

> WARNING: stale docs.
`;

describe("context-imports", () => {
  it("finds @path lines outside code fences and ignores handles and inline mentions", () => {
    const content = [
      "@reference/topics/a.md",
      "email me@example.com",
      "```",
      "@not/an/import.md",
      "```",
      "@phren/cli",
      "@~/.phren/global/AGENTS.md",
      "See @reference/topics/b.md inline",
    ].join("\n");
    expect(findContextImportLines(content)).toEqual([
      { line: 1, target: "reference/topics/a.md" },
      { line: 7, target: "~/.phren/global/AGENTS.md" },
    ]);
  });

  it("collapses a run of imports into one plain reference list and keeps the rest", () => {
    const out = rewriteContextImports(SAMPLE);
    expect(out).not.toMatch(/^@/m);
    expect(out).toContain("Reference docs (the phren hook injects relevant parts on demand; not imported):\n- `reference/topics/commands.md`\n- `reference/topics/architecture.md`\n- `reference/topics/conventions.md`\n\n> WARNING: stale docs.");
    expect(out.startsWith("# ogrid\n\nFindings here.\n\n---\n\n")).toBe(true);
    expect(rewriteContextImports(out)).toBe(out);
  });

  describe("store scan", () => {
    let phrenPath: string;
    beforeEach(() => {
      phrenPath = fs.mkdtempSync(path.join(os.tmpdir(), "phren-ctx-imports-"));
      fs.mkdirSync(path.join(phrenPath, "ogrid"), { recursive: true });
      fs.mkdirSync(path.join(phrenPath, "clean"), { recursive: true });
      fs.writeFileSync(path.join(phrenPath, "ogrid", "AGENTS.md"), SAMPLE);
      fs.writeFileSync(path.join(phrenPath, "ogrid", "CLAUDE.md"), SAMPLE);
      fs.writeFileSync(path.join(phrenPath, "clean", "AGENTS.md"), "# clean\n\nSee `reference/topics/` for more.\n");
    });
    afterEach(() => fs.rmSync(phrenPath, { recursive: true, force: true }));

    it("reports both managed files of an affected project and nothing for clean ones", () => {
      const hits = scanContextImports(phrenPath);
      expect(hits.map((h) => path.basename(h.file)).sort()).toEqual(["AGENTS.md", "AGENTS.md", "AGENTS.md", "CLAUDE.md", "CLAUDE.md", "CLAUDE.md"]);
      expect(new Set(hits.map((h) => h.scope))).toEqual(new Set(["ogrid"]));
    });

    it("fix rewrites every affected file and leaves the scan empty", () => {
      const fixed = fixContextImports(phrenPath, scanContextImports(phrenPath));
      expect(fixed.length).toBe(2);
      expect(scanContextImports(phrenPath)).toEqual([]);
      expect(fs.readFileSync(path.join(phrenPath, "ogrid", "CLAUDE.md"), "utf8")).toContain("- `reference/topics/commands.md`");
      expect(fs.readFileSync(path.join(phrenPath, "clean", "AGENTS.md"), "utf8")).toContain("See `reference/topics/`");
    });
  });
});
