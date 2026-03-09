import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "./test-helpers.js";
import { addProjectFromPath } from "./core-project.js";

describe("addProjectFromPath", () => {
  it("uses the selected profile and returns the created file paths", () => {
    const tmp = makeTempDir("core-project-test-");
    try {
      const cortexPath = path.join(tmp.path, ".cortex");
      const repoPath = path.join(tmp.path, "repo");
      fs.mkdirSync(path.join(cortexPath, "profiles"), { recursive: true });
      fs.writeFileSync(path.join(cortexPath, "profiles", "work.yaml"), "name: work\nprojects:\n  - global\n");
      fs.writeFileSync(path.join(cortexPath, "profiles", "personal.yaml"), "name: personal\nprojects:\n  - global\n");
      fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });

      const result = addProjectFromPath(cortexPath, repoPath, "work");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.project).toBe("repo");
      expect(result.data.profile).toBe("work");
      expect(result.data.files.claude).toBe(path.join(cortexPath, "repo", "CLAUDE.md"));
      expect(fs.readFileSync(path.join(cortexPath, "profiles", "work.yaml"), "utf8")).toContain("- repo");
      expect(fs.readFileSync(path.join(cortexPath, "profiles", "personal.yaml"), "utf8")).not.toContain("- repo");
    } finally {
      tmp.cleanup();
    }
  });

  it("requires an explicit path", () => {
    const tmp = makeTempDir("core-project-empty-");
    try {
      const result = addProjectFromPath(path.join(tmp.path, ".cortex"), undefined, "work");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Path is required");
    } finally {
      tmp.cleanup();
    }
  });
});
