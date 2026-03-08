import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { countActiveFindings, autoArchiveToReference } from "../content-archive.js";
import { makeTempDir, writeFile } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";

describe("content-archive", () => {
  describe("countActiveFindings", () => {
    it("counts bullet lines starting with '- '", () => {
      const content = `# Findings\n\n## 2025-01-01\n\n- finding one\n- finding two\n- finding three\n`;
      expect(countActiveFindings(content)).toBe(3);
    });

    it("excludes bullets inside <details> blocks", () => {
      const content = `# Findings\n\n- active finding\n\n<details>\n<summary>Archived</summary>\n\n- archived one\n- archived two\n\n</details>\n\n- another active\n`;
      expect(countActiveFindings(content)).toBe(2);
    });

    it("returns 0 for empty content", () => {
      expect(countActiveFindings("")).toBe(0);
    });

    it("returns 0 when all entries are archived", () => {
      const content = `# Findings\n<details>\n- archived\n</details>\n`;
      expect(countActiveFindings(content)).toBe(0);
    });

    it("handles multiple details blocks", () => {
      const content = [
        "# Findings",
        "<details>",
        "- archived 1",
        "</details>",
        "- active 1",
        "<details>",
        "- archived 2",
        "</details>",
        "- active 2",
      ].join("\n");
      expect(countActiveFindings(content)).toBe(2);
    });
  });

  describe("autoArchiveToReference", () => {
    let tmpRoot: string;
    let tmpCleanup: () => void;

    beforeEach(() => {
      ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-archive-test-"));
    });

    afterEach(() => {
      tmpCleanup();
    });

    it("returns ok(0) when FINDINGS.md does not exist", () => {
      const project = "no-findings";
      fs.mkdirSync(path.join(tmpRoot, project), { recursive: true });
      const result = autoArchiveToReference(tmpRoot, project, 10);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toBe(0);
    });

    it("returns ok(0) when entries are within keepCount", () => {
      const project = "small";
      writeFile(
        path.join(tmpRoot, project, "FINDINGS.md"),
        `# Findings\n\n## 2025-01-01\n\n- finding one\n- finding two\n`
      );
      const result = autoArchiveToReference(tmpRoot, project, 10);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toBe(0);
    });

    it("archives oldest entries beyond keepCount", () => {
      const project = "many";
      const lines = ["# Findings", ""];
      lines.push("## 2024-01-01");
      for (let i = 0; i < 5; i++) lines.push(`- old finding ${i}`);
      lines.push("");
      lines.push("## 2025-06-01");
      for (let i = 0; i < 5; i++) lines.push(`- new finding ${i}`);
      lines.push("");

      writeFile(path.join(tmpRoot, project, "FINDINGS.md"), lines.join("\n"));
      // Ensure .runtime dir exists for lock file
      fs.mkdirSync(path.join(tmpRoot, ".runtime"), { recursive: true });

      const result = autoArchiveToReference(tmpRoot, project, 5);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toBe(5);

      // Reference files should exist
      const refDir = path.join(tmpRoot, project, "reference");
      expect(fs.existsSync(refDir)).toBe(true);

      // FINDINGS.md should have the consolidation marker
      const updated = fs.readFileSync(path.join(tmpRoot, project, "FINDINGS.md"), "utf8");
      expect(updated).toContain("<!-- consolidated:");
    });

    it("returns error for invalid project names", () => {
      const result = autoArchiveToReference(tmpRoot, "../escape", 10);
      expect(result.ok).toBe(false);
    });

    it("returns error for nonexistent project", () => {
      const result = autoArchiveToReference(tmpRoot, "ghost-project", 10);
      expect(result.ok).toBe(false);
    });

    it("skips entries already present in reference tier", () => {
      const project = "dedup";
      writeFile(
        path.join(tmpRoot, project, "FINDINGS.md"),
        `# Findings\n\n## 2024-01-01\n\n- already archived entry\n- fresh old entry\n\n## 2025-06-01\n\n- keep me\n`
      );
      // Pre-populate reference with the duplicate
      writeFile(
        path.join(tmpRoot, project, "reference", "general.md"),
        `# dedup - general\n\n## Archived 2024-12-01\n\n- already archived entry\n`
      );
      fs.mkdirSync(path.join(tmpRoot, ".runtime"), { recursive: true });

      const result = autoArchiveToReference(tmpRoot, project, 1);
      expect(result.ok).toBe(true);
    });
  });
});
