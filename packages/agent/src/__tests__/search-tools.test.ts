import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { globTool } from "../tools/glob.js";
import { grepTool } from "../tools/grep.js";
import { ripgrepPath } from "../tools/search-support.js";

// Every case runs twice: through ripgrep (skipped when it is not installed) and
// through the JS walker, forced with PHREN_AGENT_RIPGREP=off.
const hasRg = (() => {
  try { execFileSync("rg", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();

let dir: string;
const originalCwd = process.cwd();
const write = (rel: string, text = "") => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "search-tools-")));
  process.chdir(dir); // the sandbox root is the cwd
  write(".gitignore", "dist/\ncoverage\n");
  write("src/app.ts", "const Needle = 1;\n");
  write("dist/bundle.js", "const Needle = 2;\n");
  write("coverage/report.txt", "Needle\n");
  write(".github/workflows/ci.yml", "name: Needle\n");
  write(".git/config", "Needle\n");
  write("node_modules/dep/index.js", "Needle\n");
});
afterEach(() => {
  process.chdir(originalCwd);
  delete process.env.PHREN_AGENT_RIPGREP;
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const mode of ["ripgrep", "fallback"] as const) {
  describe.runIf(mode === "fallback" || hasRg)(`search tools (${mode})`, () => {
    beforeEach(() => {
      if (mode === "fallback") process.env.PHREN_AGENT_RIPGREP = "off";
      // Ripgrep only reads .gitignore inside a git work tree, or with this file name.
      write(".ignore", "");
      expect(ripgrepPath() === null).toBe(mode === "fallback");
    });

    it("grep skips gitignored directories and .git, and searches .github", async () => {
      const result = await grepTool.execute({ pattern: "Needle", path: dir, output_mode: "files_with_matches" });
      const files = result.output.split("\n").sort();
      expect(files).toEqual([path.join(".github", "workflows", "ci.yml"), path.join("src", "app.ts")]);
    });

    it("grep is case-sensitive unless -i is set", async () => {
      expect((await grepTool.execute({ pattern: "needle", path: dir })).output).toBe("No matches.");
      const found = await grepTool.execute({ pattern: "needle", path: dir, "-i": true, output_mode: "count" });
      expect(found.output).toContain("src");
    });

    it("grep cuts long lines", async () => {
      write("min.js", `const x = "${"a".repeat(5000)}Needle";\n`);
      const result = await grepTool.execute({ pattern: "const x", path: dir, glob: "min.js" });
      expect(result.output).toContain("min.js");
      expect(result.output.length).toBeLessThan(1500);
    });

    it("grep applies type, glob, offset and head_limit", async () => {
      write("src/other.py", "Needle\n");
      const py = await grepTool.execute({ pattern: "Needle", path: dir, type: "py", output_mode: "files_with_matches" });
      expect(py.output).toBe(path.join("src", "other.py"));
      const skipped = await grepTool.execute({ pattern: "Needle", path: dir, output_mode: "files_with_matches", offset: 1, head_limit: 1 });
      expect(skipped.output.split("\n")).toHaveLength(1);
    });

    it("grep rejects an invalid regex", async () => {
      const result = await grepTool.execute({ pattern: "[invalid", path: dir });
      expect(result.is_error).toBe(true);
      expect(result.output).toContain("Invalid regex");
    });

    it("glob skips gitignored directories and lists .github", async () => {
      const result = await globTool.execute({ pattern: "**/*", path: dir });
      const files = result.output.split("\n").filter((l) => l && !l.startsWith("("));
      expect(files).toContain(path.join(".github", "workflows", "ci.yml").replace(/\\/g, "/"));
      expect(files).toContain("src/app.ts");
      expect(files.some((f) => f.startsWith("dist/") || f.startsWith("coverage/") || f.startsWith(".git/") || f.startsWith("node_modules/"))).toBe(false);
    });

    it("glob says when it shows only part of the matches", async () => {
      for (let i = 0; i < 520; i++) write(`many/f${i}.txt`);
      const result = await globTool.execute({ pattern: "many/*.txt", path: dir });
      expect(result.output.split("\n").filter((l) => l.startsWith("many/"))).toHaveLength(500);
      expect(result.output).toContain("showing the first 500 of 520 matches");
    });
  });
}

describe("search tools (fallback file cap)", () => {
  it("grep says when the walk stopped at the file cap", async () => {
    process.env.PHREN_AGENT_RIPGREP = "off";
    for (let i = 0; i < 5001; i++) write(`bulk/f${i}.txt`, "x\n");
    const result = await grepTool.execute({ pattern: "nomatch_anywhere", path: dir });
    expect(result.output).toContain("searched the first 5000 files; narrow the path or glob");
    expect(result.output.startsWith("No matches")).toBe(true);
  });
});
