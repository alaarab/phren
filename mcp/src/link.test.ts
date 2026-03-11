import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTempDir } from "./test-helpers.js";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { isVersionNewer } from "./init.js";
import { getMachineName } from "./machine-identity.js";
import { PACKAGE_NAME } from "./package-metadata.js";
import { runLink, runDoctor, parseSkillFrontmatter, validateSkillFrontmatter, validateSkillsDir, readSkillManifestHooks, updateFileChecksums, verifyFileChecksums } from "./link.js";

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

    let tmpCleanup: () => void;

    beforeEach(() => {
      ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-link-test-"));
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
      tmpCleanup();
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
      const projectKey = homeDir.replace(/[/\\:]/g, "-").replace(/^-/, "");
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
      const skillsSrc = path.join(cortexProject, "skills");
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
      const skillsSrc = path.join(cortexProject, "skills", "my-skill");
      fs.mkdirSync(skillsSrc, { recursive: true });
      fs.writeFileSync(path.join(skillsSrc, "SKILL.md"), "# My Skill");
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Test");

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      // Q69 fix: whole skill directory is symlinked, not just SKILL.md flattened to a .md file
      const linkedSkill = path.join(projectDir, ".claude", "skills", "my-skill");
      expect(fs.existsSync(linkedSkill)).toBe(true);
      expect(fs.readlinkSync(linkedSkill)).toBe(skillsSrc);
    });

    it("preserves existing regular files at destination", async () => {
      setupProfile(["sym-project"]);

      const projectDir = path.join(tmpRoot, "projects", "sym-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "sym-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Real content");

      // Create a user-owned file at destination
      const destClaude = path.join(projectDir, "CLAUDE.md");
      fs.writeFileSync(destClaude, "stale");

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      expect(fs.lstatSync(destClaude).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(destClaude, "utf8")).toBe("stale");
    });

    it("preserves existing non-cortex symlinks at destination", async () => {
      setupProfile(["sym-project"]);

      const projectDir = path.join(tmpRoot, "projects", "sym-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "sym-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Real content");

      const staleSource = path.join(tmpRoot, "stale.md");
      fs.writeFileSync(staleSource, "# Stale");
      const destClaude = path.join(projectDir, "CLAUDE.md");
      fs.symlinkSync(staleSource, destClaude);

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      expect(fs.lstatSync(destClaude).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(destClaude, "utf8")).toBe("# Stale");
    });

    it("replaces existing cortex-managed symlinks at destination", async () => {
      setupProfile(["managed-sym-project"]);

      const projectDir = path.join(tmpRoot, "projects", "managed-sym-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "managed-sym-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Real content");

      const oldManagedSource = path.join(cortexPath, "old-managed.md");
      fs.writeFileSync(oldManagedSource, "# Old managed");
      const destClaude = path.join(projectDir, "CLAUDE.md");
      fs.symlinkSync(oldManagedSource, destClaude);

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      expect(fs.lstatSync(destClaude).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(destClaude, "utf8")).toBe("# Real content");
    });

    it("normalizes array mcpServers in Claude settings before linking project MCP entries", async () => {
      setupProfile(["mcp-project"]);

      const projectDir = path.join(tmpRoot, "projects", "mcp-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "mcp-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Test");
      fs.writeFileSync(
        path.join(cortexProject, "cortex.project.yaml"),
        yaml.dump({
          mcpServers: {
            local: {
              command: "node",
              args: ["server.js"],
            },
          },
        })
      );

      const settingsPath = path.join(homeDir, ".claude", "settings.json");
      fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: [] }, null, 2));

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      expect(Array.isArray(settings.mcpServers)).toBe(false);
      expect(settings.mcpServers?.["cortex__mcp-project__local"]?.command).toBe("node");
      expect(settings.mcpServers?.["cortex__mcp-project__local"]?.args).toEqual(["server.js"]);
    });

    it("replaces identical managed file content with a symlink", async () => {
      setupProfile(["identical-project"]);

      const projectDir = path.join(tmpRoot, "projects", "identical-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "identical-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Same content");

      const destClaude = path.join(projectDir, "CLAUDE.md");
      fs.writeFileSync(destClaude, "# Same content");

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      expect(fs.lstatSync(destClaude).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(destClaude, "utf8")).toBe("# Same content");
    });

    it("skips repo mirrors for detached projects", async () => {
      setupProfile(["detached-project"]);

      const projectDir = path.join(tmpRoot, "projects", "detached-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "detached-project");
      fs.mkdirSync(path.join(cortexProject, "skills"), { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Cortex CLAUDE");
      fs.writeFileSync(path.join(cortexProject, "FINDINGS.md"), "# Findings");
      fs.writeFileSync(path.join(cortexProject, "cortex.project.yaml"), "ownership: detached\n");
      fs.writeFileSync(path.join(cortexProject, "skills", "deploy.md"), "# Deploy");

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      expect(fs.existsSync(path.join(projectDir, "CLAUDE.md"))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, "FINDINGS.md"))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, ".claude", "skills", "deploy.md"))).toBe(false);
    });

    it("linkProject creates REFERENCE.md and FINDINGS.md symlinks", async () => {
      setupProfile(["kb-project"]);

      const projectDir = path.join(tmpRoot, "projects", "kb-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "kb-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Test");
      fs.writeFileSync(path.join(cortexProject, "REFERENCE.md"), "# Knowledge base");
      fs.writeFileSync(path.join(cortexProject, "FINDINGS.md"), "# Findings");

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      expect(fs.lstatSync(path.join(projectDir, "REFERENCE.md")).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(projectDir, "FINDINGS.md")).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(projectDir, "REFERENCE.md"), "utf8")).toBe("# Knowledge base");
    });

    it("linkProject handles CLAUDE-*.md split files", async () => {
      setupProfile(["split-project"]);

      const projectDir = path.join(tmpRoot, "projects", "split-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "split-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Main");
      fs.writeFileSync(path.join(cortexProject, "CLAUDE-testing.md"), "# Testing instructions");
      fs.writeFileSync(path.join(cortexProject, "CLAUDE-deploy.md"), "# Deploy instructions");

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      expect(fs.lstatSync(path.join(projectDir, "CLAUDE-testing.md")).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(projectDir, "CLAUDE-deploy.md")).isSymbolicLink()).toBe(true);
    });

    it("writes context file in default mode", async () => {
      setupProfile(["ctx-project"]);

      const projectDir = path.join(tmpRoot, "projects", "ctx-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "ctx-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Test");

      const realContextFile = path.join(homeDir, ".cortex-context.md");
      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      expect(fs.existsSync(realContextFile)).toBe(true);
      const content = fs.readFileSync(realContextFile, "utf8");
      expect(content).toContain("cortex-managed");
    });

    it("writes context file in debugging mode", async () => {
      setupProfile(["dbg-project"]);

      const projectDir = path.join(tmpRoot, "projects", "dbg-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "dbg-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Test");
      fs.writeFileSync(path.join(cortexProject, "FINDINGS.md"), "# FINDINGS\n\n## 2025-01-01\n\n- debug insight\n");

      const realContextFile = path.join(homeDir, ".cortex-context.md");
      await runLink(cortexPath, { machine: "test-machine", profile: "test", task: "debugging" });

      const content = fs.readFileSync(realContextFile, "utf8");
      expect(content).toContain("debugging");
    });

    it("writes context file in planning mode", async () => {
      setupProfile(["plan-project"]);

      const projectDir = path.join(tmpRoot, "projects", "plan-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "plan-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Test");
      fs.writeFileSync(path.join(cortexProject, "summary.md"), "**What:** A planning test project\n");
      fs.writeFileSync(path.join(cortexProject, "tasks.md"), "# Task\n\n## Active\n\n- Important task\n");

      const realContextFile = path.join(homeDir, ".cortex-context.md");
      await runLink(cortexPath, { machine: "test-machine", profile: "test", task: "planning" });

      const content = fs.readFileSync(realContextFile, "utf8");
      expect(content).toContain("planning");
    });

    it("writes context file in clean mode", async () => {
      setupProfile(["clean-project"]);

      const projectDir = path.join(tmpRoot, "projects", "clean-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "clean-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Test");

      const realContextFile = path.join(homeDir, ".cortex-context.md");
      await runLink(cortexPath, { machine: "test-machine", profile: "test", task: "clean" });

      const content = fs.readFileSync(realContextFile, "utf8");
      expect(content).toContain("clean");
    });

    it("rebuildMemory creates per-project MEMORY files", async () => {
      setupProfile(["mem-project"]);

      const projectDir = path.join(tmpRoot, "projects", "mem-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "mem-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Test");
      fs.writeFileSync(path.join(cortexProject, "summary.md"), "**What:** A memory test project\n");

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      const projectKey = homeDir.replace(/[/\\:]/g, "-").replace(/^-/, "");
      const memDir = path.join(homeDir, ".claude", "projects", projectKey, "memory");
      const perProject = path.join(memDir, "MEMORY-mem-project.md");
      expect(fs.existsSync(perProject)).toBe(true);
      const content = fs.readFileSync(perProject, "utf8");
      expect(content).toContain("Mem Project");
      expect(content).toContain("memory test project");
    });

    it("rebuildMemory preserves existing header in MEMORY.md", async () => {
      setupProfile(["preserve-project"]);

      const projectDir = path.join(tmpRoot, "projects", "preserve-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "preserve-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Test");
      fs.writeFileSync(path.join(cortexProject, "summary.md"), "**What:** Preserve project\n");

      // Pre-populate MEMORY.md with custom header
      const projectKey = homeDir.replace(/[/\\:]/g, "-").replace(/^-/, "");
      const memDir = path.join(homeDir, ".claude", "projects", projectKey, "memory");
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(
        path.join(memDir, "MEMORY.md"),
        "# Custom Header\n\nMy custom notes here.\n\n<!-- cortex:projects:start -->\nold data\n<!-- cortex:projects:end -->\n"
      );

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      const content = fs.readFileSync(path.join(memDir, "MEMORY.md"), "utf8");
      expect(content).toContain("# Custom Header");
      expect(content).toContain("My custom notes here");
      expect(content).toContain("Preserve Project");
    });

    it("skips projects not found on disk", async () => {
      setupProfile(["missing-project"]);

      // Do NOT create the project directory on disk
      const cortexProject = path.join(cortexPath, "missing-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Test");

      // Should not throw, just skip
      await runLink(cortexPath, { machine: "test-machine", profile: "test" });
    });

    it("handles multiple projects in profile", async () => {
      setupProfile(["proj-a", "proj-b"]);

      for (const name of ["proj-a", "proj-b"]) {
        const projectDir = path.join(tmpRoot, "projects", name);
        fs.mkdirSync(projectDir, { recursive: true });

        const cortexProject = path.join(cortexPath, name);
        fs.mkdirSync(cortexProject, { recursive: true });
        fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), `# ${name}`);
        fs.writeFileSync(path.join(cortexProject, "summary.md"), `**What:** ${name} project\n`);
      }
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      // Both projects should have symlinks
      for (const name of ["proj-a", "proj-b"]) {
        const dest = path.join(tmpRoot, "projects", name, "CLAUDE.md");
        expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
      }

      // MEMORY.md should list both
      const projectKey = homeDir.replace(/[/\\:]/g, "-").replace(/^-/, "");
      const memFile = path.join(homeDir, ".claude", "projects", projectKey, "memory", "MEMORY.md");
      const content = fs.readFileSync(memFile, "utf8");
      expect(content).toContain("Proj A");
      expect(content).toContain("Proj B");
    });

    it("allTools option configures for copilot/cursor/codex", async () => {
      setupProfile(["tool-project"]);

      const projectDir = path.join(tmpRoot, "projects", "tool-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "tool-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Tool project");

      await runLink(cortexPath, { machine: "test-machine", profile: "test", allTools: true });

      // With allTools, should create AGENTS.md (codex link)
      const agentsMd = path.join(projectDir, "AGENTS.md");
      expect(fs.existsSync(agentsMd)).toBe(true);
    });

    it("allTools preserves an existing user-owned AGENTS.md", async () => {
      setupProfile(["tool-project"]);

      const projectDir = path.join(tmpRoot, "projects", "tool-project");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");
      fs.writeFileSync(path.join(projectDir, "AGENTS.md"), "local instructions");

      const cortexProject = path.join(cortexPath, "tool-project");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Tool project");

      await runLink(cortexPath, { machine: "test-machine", profile: "test", allTools: true });

      expect(fs.lstatSync(path.join(projectDir, "AGENTS.md")).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(projectDir, "AGENTS.md"), "utf8")).toBe("local instructions");
    });

    it("writes cortex.SKILL.md during link", async () => {
      setupProfile(["skill-test"]);

      const projectDir = path.join(tmpRoot, "projects", "skill-test");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "skill-test");
      fs.mkdirSync(cortexProject, { recursive: true });
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Test");

      await runLink(cortexPath, { machine: "test-machine", profile: "test" });

      const skillFile = path.join(cortexPath, "cortex.SKILL.md");
      expect(fs.existsSync(skillFile)).toBe(true);
      const content = fs.readFileSync(skillFile, "utf8");
      expect(content).toContain("cortex");
      expect(content).toContain("hooks:");
      expect(content).toContain(`npx -y ${PACKAGE_NAME}@`);
      expect(content).not.toContain(tmpRoot);
      expect(content).not.toContain(".npm/_npx");
    });

    it("mirrors resolved global plus project skills and generates AGENTS.md", async () => {
      setupProfile(["skill-test"]);

      const projectDir = path.join(tmpRoot, "projects", "skill-test");
      fs.mkdirSync(projectDir, { recursive: true });
      process.env.PROJECTS_DIR = path.join(tmpRoot, "projects");

      const cortexProject = path.join(cortexPath, "skill-test");
      fs.mkdirSync(path.join(cortexPath, "global", "skills"), { recursive: true });
      fs.mkdirSync(path.join(cortexProject, "skills"), { recursive: true });
      fs.writeFileSync(path.join(cortexPath, "global", "skills", "humanize.md"), "---\nname: humanize\ndescription: global\n---\nbody\n");
      fs.writeFileSync(path.join(cortexProject, "skills", "verify.md"), "---\nname: verify\ndescription: local\n---\nbody\n");
      fs.writeFileSync(path.join(cortexProject, "CLAUDE.md"), "# Test");

      await runLink(cortexPath, { machine: "test-machine", profile: "test", allTools: true });

      const projectMirror = path.join(projectDir, ".claude", "skills");
      const manifestPath = path.join(projectDir, ".claude", "skill-manifest.json");
      const agentsPath = path.join(projectDir, "AGENTS.md");
      expect(fs.lstatSync(path.join(projectMirror, "humanize.md")).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(projectMirror, "verify.md")).isSymbolicLink()).toBe(true);
      expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).skills.some((skill: { name: string; source: string }) => skill.name === "humanize" && skill.source === "global")).toBe(true);
      expect(fs.readFileSync(agentsPath, "utf8")).toContain("<!-- cortex:generated-agents -->");
      expect(fs.readFileSync(agentsPath, "utf8")).toContain("/humanize");
    });

    it("throws when profile has no projects", async () => {
      setupProfile([]);

      await expect(
        runLink(cortexPath, { machine: "test-machine", profile: "test" })
      ).rejects.toThrow("has no projects");
    });

    it("throws when profile not found", async () => {
      await expect(
        runLink(cortexPath, { machine: "test-machine", profile: "nonexistent" })
      ).rejects.toThrow("not found");
    });
  });

  describe("runDoctor", () => {
    let tmpRoot: string;
    let cortexPath: string;
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const origProjectsDir = process.env.PROJECTS_DIR;

    let tmpCleanup: () => void;

    beforeEach(() => {
      ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-doctor-test-"));
      cortexPath = path.join(tmpRoot, "cortex");
      fs.mkdirSync(cortexPath, { recursive: true });

      // Create minimal governance
      const govDir = path.join(cortexPath, ".governance");
      fs.mkdirSync(govDir, { recursive: true });
      fs.writeFileSync(
        path.join(govDir, "access-control.json"),
        JSON.stringify({ admins: ["test"], maintainers: [], contributors: [], viewers: [] })
      );
    });

    afterEach(() => {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
      process.env.PROJECTS_DIR = origProjectsDir;
      tmpCleanup();
    });

    it("returns DoctorResult with checks array", async () => {
      const result = await runDoctor(cortexPath);
      expect(result).toHaveProperty("ok");
      expect(result).toHaveProperty("checks");
      expect(Array.isArray(result.checks)).toBe(true);
      expect(result.checks.length).toBeGreaterThan(0);
    });

    it("checks include machine-registered", async () => {
      const result = await runDoctor(cortexPath);
      const machineCheck = result.checks.find(c => c.name === "machine-registered");
      expect(machineCheck).toBeDefined();
    });

    it("checks include fts-index", async () => {
      const result = await runDoctor(cortexPath);
      const ftsCheck = result.checks.find(c => c.name === "fts-index");
      expect(ftsCheck).toBeDefined();
    });

    it("checks include claude-hooks and lifecycle-hooks", async () => {
      const result = await runDoctor(cortexPath);
      const hookCheck = result.checks.find(c => c.name === "claude-hooks");
      const lifecycleCheck = result.checks.find(c => c.name === "lifecycle-hooks");
      expect(hookCheck).toBeDefined();
      expect(lifecycleCheck).toBeDefined();
    });

    it("checks include runtime-health-file", async () => {
      const result = await runDoctor(cortexPath);
      const runtimeCheck = result.checks.find(c => c.name === "runtime-health-file");
      expect(runtimeCheck).toBeDefined();
    });

    it("does not require project symlinks for detached projects", async () => {
      const profilesDir = path.join(cortexPath, "profiles");
      fs.mkdirSync(profilesDir, { recursive: true });
      fs.writeFileSync(
        path.join(profilesDir, "test.yaml"),
        yaml.dump({ name: "test", description: "Test", projects: ["detached-proj"] })
      );
      fs.writeFileSync(path.join(cortexPath, "machines.yaml"), `${getMachineName()}: test\n`);

      const projDir = path.join(cortexPath, "detached-proj");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, "CLAUDE.md"), "# Detached\n");
      fs.writeFileSync(path.join(projDir, "cortex.project.yaml"), "ownership: detached\n");

      const result = await runDoctor(cortexPath);
      const ownershipCheck = result.checks.find(c => c.name === "ownership:detached-proj");
      const symlinkCheck = result.checks.find(c => c.name === "symlink:detached-proj/CLAUDE.md");
      expect(ownershipCheck?.ok).toBe(true);
      expect(ownershipCheck?.detail).toContain("detached");
      expect(symlinkCheck).toBeUndefined();
    });

    it("checkData flag adds governance file validation", async () => {
      const result = await runDoctor(cortexPath, false, true);
      const govChecks = result.checks.filter(c => c.name.startsWith("data:governance:"));
      expect(govChecks.length).toBeGreaterThan(0);
    });

    it("checkData validates access-control.json", async () => {
      const result = await runDoctor(cortexPath, false, true);
      const accessCheck = result.checks.find(c => c.name === "data:governance:access-control.json");
      expect(accessCheck).toBeDefined();
      expect(accessCheck!.ok).toBe(true);
      expect(accessCheck!.detail).toBe("valid");
    });

    it("checkData detects invalid governance JSON", async () => {
      fs.writeFileSync(
        path.join(cortexPath, ".governance", "retention-policy.json"),
        "{ invalid json"
      );
      const result = await runDoctor(cortexPath, false, true);
      const policyCheck = result.checks.find(c => c.name === "data:governance:retention-policy.json");
      expect(policyCheck).toBeDefined();
      expect(policyCheck!.ok).toBe(false);
    });

    it("checkData validates task format", async () => {
      // Need a profile for getProjectDirs to work
      const profilesDir = path.join(cortexPath, "profiles");
      fs.mkdirSync(profilesDir, { recursive: true });
      fs.writeFileSync(
        path.join(profilesDir, "test.yaml"),
        yaml.dump({ name: "test", description: "Test", projects: ["doc-proj"] })
      );
      fs.writeFileSync(
        path.join(cortexPath, "machines.yaml"),
        `${getMachineName()}: test\n`
      );

      const projDir = path.join(cortexPath, "doc-proj");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, "tasks.md"),
        "# doc-proj Task\n\n## Active\n\n- Task one\n\n## Queue\n\n## Done\n\n"
      );

      const result = await runDoctor(cortexPath, false, true);
      const tasksCheck = result.checks.find(c => c.name === "data:tasks:doc-proj");
      expect(tasksCheck).toBeDefined();
      expect(tasksCheck!.ok).toBe(true);
    });

    it("checkData flags task items whose specific terms do not match repo/docs", async () => {
      const profilesDir = path.join(cortexPath, "profiles");
      const projectsRoot = path.join(tmpRoot, "projects");
      process.env.PROJECTS_DIR = projectsRoot;
      fs.mkdirSync(projectsRoot, { recursive: true });
      fs.mkdirSync(profilesDir, { recursive: true });
      fs.writeFileSync(
        path.join(profilesDir, "test.yaml"),
        yaml.dump({ name: "test", description: "Test", projects: ["doc-proj"] })
      );
      fs.writeFileSync(
        path.join(cortexPath, "machines.yaml"),
        `${getMachineName()}: test\n`
      );

      const projDir = path.join(cortexPath, "doc-proj");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, "tasks.md"),
        "# doc-proj Task\n\n## Active\n\n- Refactor `shell-view.ts` selection rendering\n\n## Queue\n\n- Improve chart interface with bubble details and device type filters\n\n## Done\n\n"
      );

      const repoDir = path.join(projectsRoot, "doc-proj");
      fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, "src", "shell-view.ts"), "export const shellView = true;\n");

      const result = await runDoctor(cortexPath, false, true);
      const hygieneCheck = result.checks.find(c => c.name === "data:task-hygiene:doc-proj");
      expect(hygieneCheck).toBeDefined();
      expect(hygieneCheck!.ok).toBe(false);
      expect(hygieneCheck!.detail).toContain("suspect task");
      expect(hygieneCheck!.detail).toContain("Q1");
    });

    it("checkData validates findings format", async () => {
      const profilesDir = path.join(cortexPath, "profiles");
      fs.mkdirSync(profilesDir, { recursive: true });
      fs.writeFileSync(
        path.join(profilesDir, "test.yaml"),
        yaml.dump({ name: "test", description: "Test", projects: ["learn-proj"] })
      );
      fs.writeFileSync(
        path.join(cortexPath, "machines.yaml"),
        `${getMachineName()}: test\n`
      );

      const projDir = path.join(cortexPath, "learn-proj");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, "FINDINGS.md"),
        "# learn-proj FINDINGS\n\n## 2025-01-01\n\n- An insight\n"
      );

      const result = await runDoctor(cortexPath, false, true);
      const findingsCheck = result.checks.find(c => c.name === "data:findings:learn-proj");
      expect(findingsCheck).toBeDefined();
      expect(findingsCheck!.ok).toBe(true);
    });

    it("returns machine and profile in result", async () => {
      const result = await runDoctor(cortexPath);
      expect(result.machine).toBeDefined();
      expect(typeof result.machine).toBe("string");
    });
  });

  describe("skill frontmatter validation (#294, #298)", () => {
    it("parses valid frontmatter", () => {
      const content = "---\nname: test\ndescription: A test skill\n---\n# Body";
      const { frontmatter, body } = parseSkillFrontmatter(content);
      expect(frontmatter).toEqual({ name: "test", description: "A test skill" });
      expect(body).toBe("# Body");
    });

    it("returns null for missing frontmatter", () => {
      const { frontmatter } = parseSkillFrontmatter("# No frontmatter");
      expect(frontmatter).toBeNull();
    });

    it("returns null for malformed YAML", () => {
      const { frontmatter } = parseSkillFrontmatter("---\n: bad: yaml: here\n---\n");
      expect(frontmatter).toBeNull();
    });

    it("validates required fields", () => {
      const result = validateSkillFrontmatter("---\nname: test\n---\n");
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('missing required field "description"');
    });

    it("validates name is required", () => {
      const result = validateSkillFrontmatter("---\ndescription: desc\n---\n");
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('missing required field "name"');
    });

    it("accepts valid skill with all fields", () => {
      const content = "---\nname: sync\ndescription: Sync stuff\ndependencies:\n  - git\n---\n# Sync";
      const result = validateSkillFrontmatter(content);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.frontmatter?.name).toBe("sync");
      expect(result.frontmatter?.dependencies).toEqual(["git"]);
    });

    it("rejects non-array dependencies", () => {
      const content = "---\nname: test\ndescription: desc\ndependencies: git\n---\n";
      const result = validateSkillFrontmatter(content);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('"dependencies" must be an array');
    });

    it("rejects non-string dependency entries", () => {
      const content = "---\nname: test\ndescription: desc\ndependencies:\n  - 123\n---\n";
      const result = validateSkillFrontmatter(content);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('"dependencies" entries must be strings');
    });

    it("rejects non-object hooks", () => {
      const content = "---\nname: test\ndescription: desc\nhooks: bad\n---\n";
      const result = validateSkillFrontmatter(content);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('"hooks" must be an object');
    });

    it("includes file path prefix in errors", () => {
      const result = validateSkillFrontmatter("---\nname: test\n---\n", "/path/to/SKILL.md");
      expect(result.errors[0]).toMatch(/^\/path\/to\/SKILL\.md: /);
    });

    it("validates a directory of skills", () => {
      const tmp = makeTempDir("skill-val-");
      try {
        const validSkill = path.join(tmp.path, "sync");
        fs.mkdirSync(validSkill);
        fs.writeFileSync(path.join(validSkill, "SKILL.md"), "---\nname: sync\ndescription: Sync\n---\n");

        const invalidSkill = path.join(tmp.path, "bad");
        fs.mkdirSync(invalidSkill);
        fs.writeFileSync(path.join(invalidSkill, "SKILL.md"), "---\nname: bad\n---\n");

        const results = validateSkillsDir(tmp.path);
        expect(results).toHaveLength(2);
        expect(results.filter(r => r.valid)).toHaveLength(1);
        expect(results.filter(r => !r.valid)).toHaveLength(1);
      } finally {
        tmp.cleanup();
      }
    });

    it("handles flat .md skill files in directory", () => {
      const tmp = makeTempDir("skill-val-");
      try {
        fs.writeFileSync(path.join(tmp.path, "flat.md"), "---\nname: flat\ndescription: A flat skill\n---\n# Flat");
        const results = validateSkillsDir(tmp.path);
        expect(results).toHaveLength(1);
        expect(results[0].valid).toBe(true);
      } finally {
        tmp.cleanup();
      }
    });

    it("returns empty for nonexistent directory", () => {
      expect(validateSkillsDir("/nonexistent/path")).toEqual([]);
    });
  });

  describe("readSkillManifestHooks (#297)", () => {
    it("returns null when no manifest exists", () => {
      const tmp = makeTempDir("manifest-");
      try {
        expect(readSkillManifestHooks(tmp.path)).toBeNull();
      } finally {
        tmp.cleanup();
      }
    });

    it("reads hooks from a valid manifest", () => {
      const tmp = makeTempDir("manifest-");
      try {
        const manifest = `---
name: cortex
description: Memory for AI agents
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "node /path/to/hook-session-start"
  UserPromptSubmit:
    - hooks:
        - type: command
          command: "node /path/to/hook-prompt"
  Stop:
    - hooks:
        - type: command
          command: "node /path/to/hook-stop"
---
# cortex
`;
        fs.writeFileSync(path.join(tmp.path, "cortex.SKILL.md"), manifest);
        const hooks = readSkillManifestHooks(tmp.path);
        expect(hooks).not.toBeNull();
        expect(hooks!.SessionStart).toBe("node /path/to/hook-session-start");
        expect(hooks!.UserPromptSubmit).toBe("node /path/to/hook-prompt");
        expect(hooks!.Stop).toBe("node /path/to/hook-stop");
      } finally {
        tmp.cleanup();
      }
    });

    it("returns null for manifest without hooks", () => {
      const tmp = makeTempDir("manifest-");
      try {
        fs.writeFileSync(path.join(tmp.path, "cortex.SKILL.md"), "---\nname: cortex\ndescription: test\n---\n");
        expect(readSkillManifestHooks(tmp.path)).toBeNull();
      } finally {
        tmp.cleanup();
      }
    });
  });

  describe("file checksums", () => {
    let tmp: ReturnType<typeof makeTempDir>;
    let cortex: string;

    beforeEach(() => {
      tmp = makeTempDir("cortex-checksum-test-");
      cortex = tmp.path;
      fs.mkdirSync(path.join(cortex, "testproj"), { recursive: true });
      fs.mkdirSync(path.join(cortex, ".governance"), { recursive: true });
      fs.writeFileSync(path.join(cortex, "testproj", "FINDINGS.md"), "# FINDINGS\n\n- Test finding\n");
      fs.writeFileSync(path.join(cortex, "testproj", "tasks.md"), "# task\n\n## Queue\n\n- Item\n");
    });

    afterEach(() => { tmp.cleanup(); });

    it("updateFileChecksums creates checksum store", () => {
      const result = updateFileChecksums(cortex);
      expect(result.updated).toBe(2);
      const storePath = path.join(cortex, ".governance", "file-checksums.json");
      expect(fs.existsSync(storePath)).toBe(true);
      const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
      expect(store["testproj/FINDINGS.md"]).toBeDefined();
      expect(store["testproj/FINDINGS.md"].sha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it("verifyFileChecksums returns ok for unchanged files", () => {
      updateFileChecksums(cortex);
      const results = verifyFileChecksums(cortex);
      expect(results.every((r) => r.status === "ok")).toBe(true);
    });

    it("verifyFileChecksums detects modified files", () => {
      updateFileChecksums(cortex);
      fs.writeFileSync(path.join(cortex, "testproj", "FINDINGS.md"), "# FINDINGS\n\n- Modified\n");
      const results = verifyFileChecksums(cortex);
      const findings = results.find((r) => r.file.includes("FINDINGS"));
      expect(findings?.status).toBe("mismatch");
    });

    it("verifyFileChecksums detects deleted files", () => {
      updateFileChecksums(cortex);
      fs.unlinkSync(path.join(cortex, "testproj", "FINDINGS.md"));
      const results = verifyFileChecksums(cortex);
      const findings = results.find((r) => r.file.includes("FINDINGS"));
      expect(findings?.status).toBe("missing");
    });
  });
});
