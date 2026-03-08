import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getProjectGlobBoost, clearProjectGlobCache } from "../cli-hooks-globs.js";
import { makeTempDir } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";

describe("cli-hooks-globs", () => {
  let tmpRoot: string;
  let tmpCleanup: () => void;

  beforeEach(() => {
    clearProjectGlobCache();
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-globs-test-"));
  });

  afterEach(() => {
    tmpCleanup();
  });

  describe("getProjectGlobBoost", () => {
    it("returns 1.0 when project CLAUDE.md has no globs", () => {
      const project = "my-project";
      fs.mkdirSync(path.join(tmpRoot, project), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, project, "CLAUDE.md"),
        "# My Project\nNo frontmatter here.\n"
      );

      const boost = getProjectGlobBoost(tmpRoot, project, "/some/cwd", undefined);
      expect(boost).toBe(1.0);
    });

    it("returns 1.0 when project directory does not exist", () => {
      const boost = getProjectGlobBoost(tmpRoot, "nonexistent", "/some/cwd", undefined);
      expect(boost).toBe(1.0);
    });

    it("returns 1.3 when cwd matches a glob pattern", () => {
      const project = "web-app";
      fs.mkdirSync(path.join(tmpRoot, project), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, project, "CLAUDE.md"),
        `---
globs:
  - src/**/*.ts
  - "tests/**/*.test.ts"
---
# Web App
`
      );

      const boost = getProjectGlobBoost(tmpRoot, project, "src/components/button.ts", undefined);
      expect(boost).toBe(1.3);
    });

    it("returns 0.7 when cwd does not match any glob", () => {
      const project = "web-app";
      fs.mkdirSync(path.join(tmpRoot, project), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, project, "CLAUDE.md"),
        `---
globs:
  - src/**/*.ts
---
# Web App
`
      );

      const boost = getProjectGlobBoost(tmpRoot, project, "/totally/different/path.py", undefined);
      expect(boost).toBe(0.7);
    });

    it("checks changed files against globs", () => {
      const project = "my-lib";
      fs.mkdirSync(path.join(tmpRoot, project), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, project, "CLAUDE.md"),
        `---
globs:
  - lib/**/*.js
---
# Lib
`
      );

      const changedFiles = new Set(["lib/utils/helper.js"]);
      const boost = getProjectGlobBoost(tmpRoot, project, "/unrelated", changedFiles);
      expect(boost).toBe(1.3);
    });

    it("parses inline glob format", () => {
      const project = "inline";
      fs.mkdirSync(path.join(tmpRoot, project), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, project, "CLAUDE.md"),
        `---
globs: [src/**/*.ts, tests/**/*.ts]
---
# Inline
`
      );

      const boost = getProjectGlobBoost(tmpRoot, project, "src/utils/main.ts", undefined);
      expect(boost).toBe(1.3);
    });

    it("caches results across calls", () => {
      const project = "cached";
      fs.mkdirSync(path.join(tmpRoot, project), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, project, "CLAUDE.md"),
        "# No frontmatter\n"
      );

      const boost1 = getProjectGlobBoost(tmpRoot, project, "/a", undefined);
      const boost2 = getProjectGlobBoost(tmpRoot, project, "/b", undefined);
      expect(boost1).toBe(1.0);
      expect(boost2).toBe(1.0);
    });
  });

  describe("clearProjectGlobCache", () => {
    it("clears cached globs so re-read happens", () => {
      const project = "clearing";
      fs.mkdirSync(path.join(tmpRoot, project), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, project, "CLAUDE.md"), "# No globs\n");

      getProjectGlobBoost(tmpRoot, project, "/a", undefined);
      clearProjectGlobCache();

      // After clearing, writing new globs should take effect
      fs.writeFileSync(
        path.join(tmpRoot, project, "CLAUDE.md"),
        `---
globs:
  - src/**
---
# Now with globs
`
      );

      const boost = getProjectGlobBoost(tmpRoot, project, "src/test.ts", undefined);
      expect(boost).toBe(1.3);
    });
  });
});
