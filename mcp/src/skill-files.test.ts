import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile } from "./test-helpers.js";
import { removeSkillPath, setSkillEnabledAndSync, syncSkillLinksForScope } from "./skill-files.js";

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
      const cortexPath = path.join(tmp.path, "cortex");
      const skillPath = path.join(cortexPath, "global", "skills", "helper.md");
      writeFile(skillPath, "---\nname: helper\ndescription: test\n---\nbody\n");

      syncSkillLinksForScope(cortexPath, "global");
      const linked = path.join(tmp.path, ".claude", "skills", "helper.md");
      expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);

      setSkillEnabledAndSync(cortexPath, "global", "helper", false);
      expect(fs.existsSync(skillPath)).toBe(true);
      expect(fs.existsSync(linked)).toBe(false);

      setSkillEnabledAndSync(cortexPath, "global", "helper", true);
      expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = priorUserProfile;
    }
  });
});
