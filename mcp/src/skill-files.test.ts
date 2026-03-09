import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile } from "./test-helpers.js";
import { removeSkillPath } from "./skill-files.js";

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
});
