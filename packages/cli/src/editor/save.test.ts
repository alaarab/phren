/**
 * Saving writes into a git-backed store other tools read, so the refusals
 * matter as much as the write.
 */

import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../test-helpers.js";
import { saveEditedFile } from "./save.js";

const SKILL = `---
name: phren-sync
description: Sync your skills across machines.
---

Do the thing.
`;

describe("saveEditedFile", () => {
  let tmp: { path: string; cleanup: () => void };
  let skill: string;

  beforeEach(() => {
    tmp = makeTempDir("phren-save-");
    skill = path.join(tmp.path, "global", "skills", "phren-sync", "SKILL.md");
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, SKILL);
  });
  afterEach(() => tmp.cleanup());

  it("writes a valid skill and reports no manifest churn when only the body changed", () => {
    const result = saveEditedFile(skill, SKILL.replace("Do the thing.", "Do it twice."), "skill");
    expect(result.ok).toBe(true);
    expect(result.frontmatterChanged).toBe(false);
    expect(fs.readFileSync(skill, "utf8")).toContain("Do it twice.");
  });

  it("flags a frontmatter change, because the manifests bake those fields in", () => {
    const renamed = SKILL.replace("Sync your skills across machines.", "Sync everything.");
    expect(saveEditedFile(skill, renamed, "skill").frontmatterChanged).toBe(true);
  });

  it("refuses a skill whose frontmatter no longer loads, and leaves the file alone", () => {
    const broken = "# just a heading\n\nno frontmatter at all\n";
    const result = saveEditedFile(skill, broken, "skill");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/frontmatter/i);
    expect(fs.readFileSync(skill, "utf8")).toBe(SKILL);
  });

  it("refuses a skill missing a required field", () => {
    const noDescription = "---\nname: phren-sync\n---\n\nbody\n";
    const result = saveEditedFile(skill, noDescription, "skill");
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(skill, "utf8")).toBe(SKILL);
  });

  it("refuses to write through a symlink, and the link survives", () => {
    const link = path.join(tmp.path, "mirror.md");
    fs.symlinkSync(skill, link);
    const result = saveEditedFile(link, SKILL.replace("Do the thing.", "clobbered"), "skill");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/symlink/i);
    // Both the link and what it points at are untouched.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(skill, "utf8")).toBe(SKILL);
  });

  it("writes a CLAUDE.md without demanding frontmatter", () => {
    const claude = path.join(tmp.path, "hub", "CLAUDE.md");
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, "# hub\n");
    const result = saveEditedFile(claude, "# hub\n\nNow with guidance.\n", "claude");
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(claude, "utf8")).toContain("Now with guidance.");
  });

  it("creates a file that does not exist yet", () => {
    const fresh = path.join(tmp.path, "new", "CLAUDE.md");
    expect(saveEditedFile(fresh, "# new\n", "claude").ok).toBe(true);
    expect(fs.readFileSync(fresh, "utf8")).toBe("# new\n");
  });

  it("reports a write it cannot make instead of throwing", () => {
    const impossible = path.join(os_devNull(), "nope", "CLAUDE.md");
    const result = saveEditedFile(impossible, "x\n", "claude");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

/** A file where a directory should be: fails fast, unlike a /proc path. */
function os_devNull(): string {
  return "/dev/null";
}
