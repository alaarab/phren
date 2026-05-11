import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "./test-helpers.js";
import { addProjectFromPath } from "./core/project.js";

describe("addProjectFromPath", () => {
  it("uses the selected profile and returns the created file paths", () => {
    const tmp = makeTempDir("core-project-test-");
    try {
      const phrenPath = path.join(tmp.path, ".phren");
      const repoPath = path.join(tmp.path, "repo");
      fs.mkdirSync(path.join(phrenPath, "profiles"), { recursive: true });
      fs.writeFileSync(path.join(phrenPath, "profiles", "work.yaml"), "name: work\nprojects:\n  - global\n");
      fs.writeFileSync(path.join(phrenPath, "profiles", "personal.yaml"), "name: personal\nprojects:\n  - global\n");
      fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });

      const result = addProjectFromPath(phrenPath, repoPath, "work");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.project).toBe("repo");
      expect(result.data.profile).toBe("work");
      expect(result.data.ownership).toBe("phren-managed");
      expect(result.data.files.claude).toBe(path.join(phrenPath, "repo", "CLAUDE.md"));
      expect(fs.readFileSync(path.join(phrenPath, "profiles", "work.yaml"), "utf8")).toContain("- repo");
      expect(fs.readFileSync(path.join(phrenPath, "profiles", "personal.yaml"), "utf8")).not.toContain("- repo");
    } finally {
      tmp.cleanup();
    }
  });

  it("requires an explicit path", () => {
    const tmp = makeTempDir("core-project-empty-");
    try {
      const result = addProjectFromPath(path.join(tmp.path, ".phren"), undefined, "work");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Path is required");
    } finally {
      tmp.cleanup();
    }
  });

  it("supports repo-managed ownership", () => {
    const tmp = makeTempDir("core-project-repo-managed-");
    try {
      const phrenPath = path.join(tmp.path, ".phren");
      const repoPath = path.join(tmp.path, "repo");
      fs.mkdirSync(path.join(phrenPath, "profiles"), { recursive: true });
      fs.writeFileSync(path.join(phrenPath, "profiles", "work.yaml"), "name: work\nprojects:\n  - global\n");
      fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });
      fs.writeFileSync(path.join(repoPath, "CLAUDE.md"), "# Repo\n");

      const result = addProjectFromPath(phrenPath, repoPath, "work", "repo-managed");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.ownership).toBe("repo-managed");
      expect(result.data.files.claude).toBe(path.join(repoPath, "CLAUDE.md"));
      expect(fs.existsSync(path.join(phrenPath, "repo", "CLAUDE.md"))).toBe(false);
    } finally {
      tmp.cleanup();
    }
  });

  it("writes to a target store while updating the primary profile", () => {
    const tmp = makeTempDir("core-project-write-store-");
    try {
      const phrenPath = path.join(tmp.path, ".phren");
      const teamStorePath = path.join(tmp.path, "team-store");
      const repoPath = path.join(tmp.path, "repo");
      fs.mkdirSync(path.join(phrenPath, "profiles"), { recursive: true });
      fs.writeFileSync(path.join(phrenPath, "profiles", "work.yaml"), "name: work\nprojects:\n  - global\n");
      fs.mkdirSync(teamStorePath, { recursive: true });
      fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });

      const result = addProjectFromPath(phrenPath, repoPath, "work", "phren-managed", { writeToPath: teamStorePath });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.files.summary).toBe(path.join(teamStorePath, "repo", "summary.md"));
      expect(fs.existsSync(path.join(teamStorePath, "repo", "summary.md"))).toBe(true);
      expect(fs.existsSync(path.join(phrenPath, "repo", "summary.md"))).toBe(false);
      expect(fs.readFileSync(path.join(phrenPath, "profiles", "work.yaml"), "utf8")).toContain("- repo");
      expect(fs.existsSync(path.join(teamStorePath, "profiles"))).toBe(false);
    } finally {
      tmp.cleanup();
    }
  });
});
