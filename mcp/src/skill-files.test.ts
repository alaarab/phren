import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile } from "./test-helpers.js";
import { removeSkillPath, setSkillEnabledAndSync, syncSkillLinksForScope } from "./skill/skill-files.js";

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe("removeSkillPath", () => {
  it("removes folder-format skills by deleting the containing folder", () => {
    const tmp = makeTempDir("skill-files-test-");
    cleanup = tmp.cleanup;

    const skillDir = path.join(tmp.path, "demo", ".claude", "skills", "ss");
    writeFile(path.join(skillDir, "SKILL.md"), "# ss\ncontent");
    writeFile(path.join(skillDir, "notes.txt"), "extra asset");

    const removed = removeSkillPath(path.join(skillDir, "SKILL.md"));

    expect(removed).toBe(skillDir);
    expect(fs.existsSync(skillDir)).toBe(false);
  });

  it("removes flat skill files without deleting sibling skills", () => {
    const tmp = makeTempDir("skill-files-test-");
    cleanup = tmp.cleanup;

    const skillsDir = path.join(tmp.path, "global", "skills");
    const target = path.join(skillsDir, "pipeline.md");
    const sibling = path.join(skillsDir, "release.md");
    writeFile(target, "# pipeline");
    writeFile(sibling, "# release");

    const removed = removeSkillPath(target);

    expect(removed).toBe(target);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
  });

  it("disables a global skill without deleting its file and prunes the linked symlink", () => {
    const tmp = makeTempDir("skill-files-test-");
    cleanup = tmp.cleanup;

    const priorHome = process.env.HOME;
    const priorUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmp.path;
    process.env.USERPROFILE = tmp.path;

    try {
      const phrenPath = path.join(tmp.path, "phren");
      const skillPath = path.join(phrenPath, "global", "skills", "helper.md");
      writeFile(skillPath, "---\nname: helper\ndescription: test\n---\nbody\n");

      syncSkillLinksForScope(phrenPath, "global");
      const linked = path.join(tmp.path, ".claude", "skills", "helper.md");
      expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);

      setSkillEnabledAndSync(phrenPath, "global", "helper", false);
      expect(fs.existsSync(skillPath)).toBe(true);
      expect(fs.existsSync(linked)).toBe(false);

      setSkillEnabledAndSync(phrenPath, "global", "helper", true);
      expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = priorUserProfile;
    }
  });

  it("syncs a project mirror with inherited global skills and generated artifacts", () => {
    const tmp = makeTempDir("skill-files-test-");
    cleanup = tmp.cleanup;

    const priorHome = process.env.HOME;
    const priorUserProfile = process.env.USERPROFILE;
    const priorProjectsDir = process.env.PROJECTS_DIR;
    process.env.HOME = tmp.path;
    process.env.USERPROFILE = tmp.path;
    process.env.PROJECTS_DIR = path.join(tmp.path, "projects");

    try {
      const phrenPath = path.join(tmp.path, "phren");
      const projectDir = path.join(tmp.path, "projects", "demo");
      fs.mkdirSync(projectDir, { recursive: true });
      writeFile(path.join(phrenPath, "global", "skills", "humanize.md"), "---\nname: humanize\ndescription: global\n---\nbody\n");
      writeFile(path.join(phrenPath, "demo", "skills", "verify.md"), "---\nname: verify\ndescription: local\n---\nbody\n");

      const manifest = syncSkillLinksForScope(phrenPath, "demo");
      const linkedGlobal = path.join(projectDir, ".claude", "skills", "humanize.md");
      const linkedLocal = path.join(projectDir, ".claude", "skills", "verify.md");
      const manifestPath = path.join(projectDir, ".claude", "skill-manifest.json");
      const commandsPath = path.join(projectDir, ".claude", "skill-commands.json");

      expect(manifest?.skills.map((skill) => skill.name)).toContain("humanize");
      expect(manifest?.skills.map((skill) => skill.name)).toContain("verify");
      expect(fs.lstatSync(linkedGlobal).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(linkedLocal).isSymbolicLink()).toBe(true);
      expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).skills.some((skill: { name: string; source: string }) => skill.name === "humanize" && skill.source === "global")).toBe(true);
      expect(JSON.parse(fs.readFileSync(commandsPath, "utf8")).commands.some((command: { command: string; skillId: string }) => command.command === "/humanize" && command.skillId === "humanize")).toBe(true);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = priorUserProfile;
      if (priorProjectsDir === undefined) delete process.env.PROJECTS_DIR;
      else process.env.PROJECTS_DIR = priorProjectsDir;
    }
  });
});
