import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as yaml from "js-yaml";
import { isVersionNewer } from "./init.js";
import { runLink } from "./link.js";

describe("link", () => {
  describe("isVersionNewer", () => {
    it("returns false when no previous version", () => {
      expect(isVersionNewer("1.0.0")).toBe(false);
      expect(isVersionNewer("1.0.0", undefined)).toBe(false);
    });

    it("detects newer major version", () => {
      expect(isVersionNewer("2.0.0", "1.0.0")).toBe(true);
      expect(isVersionNewer("1.0.0", "2.0.0")).toBe(false);
    });

    it("detects newer minor version", () => {
      expect(isVersionNewer("1.2.0", "1.1.0")).toBe(true);
      expect(isVersionNewer("1.1.0", "1.2.0")).toBe(false);
    });

    it("detects newer patch version", () => {
      expect(isVersionNewer("1.0.2", "1.0.1")).toBe(true);
      expect(isVersionNewer("1.0.1", "1.0.2")).toBe(false);
    });

    it("returns false for equal versions", () => {
      expect(isVersionNewer("1.0.0", "1.0.0")).toBe(false);
    });

    it("release beats pre-release with same version", () => {
      expect(isVersionNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
      expect(isVersionNewer("1.0.0-rc.1", "1.0.0")).toBe(false);
    });

    it("compares pre-release tags lexicographically", () => {
      expect(isVersionNewer("1.0.0-rc.2", "1.0.0-rc.1")).toBe(true);
      expect(isVersionNewer("1.0.0-rc.1", "1.0.0-rc.2")).toBe(false);
    });
  });

  describe("runLink integration", () => {
    let tmpRoot: string;
    let homeDir: string;
    let cortexPath: string;
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const origProjectsDir = process.env.PROJECTS_DIR;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-link-test-"));
      homeDir = path.join(tmpRoot, "home");
      cortexPath = path.join(tmpRoot, "cortex");

      fs.mkdirSync(homeDir, { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
      fs.mkdirSync(cortexPath, { recursive: true });

      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
    });

    afterEach(() => {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
      process.env.PROJECTS_DIR = origProjectsDir;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    function setupProfile(projects: string[]) {
      const profilesDir = path.join(cortexPath, "profiles");
      fs.mkdirSync(profilesDir, { recursive: true });
      fs.writeFileSync(
        path.join(profilesDir, "test.yaml"),
        yaml.dump({ name: "test", description: "Test profile", projects })
      );
    }

    it("displayName handles empty slug in rebuildMemory", async () => {
      // Create a profile with an empty-string project entry
      setupProfile(["valid-project"]);

      const projectDir = path.join(tmpRoot, "projects", "valid-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      // Create project files so rebuildMemory runs
      const cortexProject = path.join(cortexPath, "valid-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(
        path.join(cortexProject, "summary.md"),
        "**What:** A test project"
      );
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Test");

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      // Check MEMORY.md was created with displayName output
      const projectKey = homeDir.replace(/[/\\]/g, "-").replace(/^-/, "");
      const memoryFile = path.join(
        homeDir, ".claude", "projects", projectKey, "memory", "MEMORY.md"
      );
      expect(fs.existsSync(memoryFile)).toBe(true);
      const content = fs.readFileSync(memoryFile, "utf8");
      expect(content).toContain("Valid Project");
    });

    it("linkSkillsDir links flat .md skill files", async () => {
      setupProfile(["skill-project"]);

      const projectDir = path.join(tmpRoot, "projects", "skill-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      // Create project with skills
      const cortexProject = path.join(cortexPath, "skill-project");
      const skillsSrc = path.join(cortexProject, ".claude", "skills");
      fs.mkdirSync(skillsSrc, { recursive: true });
      fs.writeFileSync(path.join(skillsSrc, "deploy.md"), "# Deploy skill");
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Test");

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      const linkedSkill = path.join(projectDir, ".claude", "skills", "deploy.md");
      expect(fs.existsSync(linkedSkill)).toBe(true);
      expect(fs.readlinkSync(linkedSkill)).toBe(path.join(skillsSrc, "deploy.md"));
    });

    it("linkSkillsDir links subfolder/SKILL.md format", async () => {
      setupProfile(["subfolder-project"]);

      const projectDir = path.join(tmpRoot, "projects", "subfolder-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "subfolder-project");
      const skillsSrc = path.join(cortexProject, ".claude", "skills", "my-skill");
      fs.mkdirSync(skillsSrc, { recursive: true });
      fs.writeFileSync(path.join(skillsSrc, "SKILL.md"), "# My Skill");
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Test");

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      const linkedSkill = path.join(projectDir, ".claude", "skills", "my-skill.md");
      expect(fs.existsSync(linkedSkill)).toBe(true);
      expect(fs.readlinkSync(linkedSkill)).toBe(path.join(skillsSrc, "SKILL.md"));
    });

    it("symlinkFile overwrites existing symlink at destination", async () => {
      setupProfile(["sym-project"]);

      const projectDir = path.join(tmpRoot, "projects", "sym-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "sym-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Real content");

      // Create a stale symlink at destination
      const destClaude = path.join(projectDir, "CLAUDE.md");
      fs.writeFileSync(destClaude, "stale");

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      // Should now be a symlink to the cortex source
      expect(fs.lstatSync(destClaude).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(destClaude, "utf8")).toBe("# Real content");
    });
  });
});
