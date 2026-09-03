/**
 * Which file `e` and `E` open. Skills edit their own markdown; a project edits
 * the CLAUDE.md the store owns and symlinks into the repo, so editing it here
 * reaches every linked checkout.
 */

import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantAdmin, makeTempDir, writeFile } from "../test-helpers.js";
import { editTargetFor, type NavigationHost } from "./input.js";
import type { ShellState } from "../data/access.js";

function host(phrenPath: string, view: ShellState["view"], project?: string): NavigationHost {
  return { phrenPath, state: { version: 3, view, project } } as unknown as NavigationHost;
}

describe("editTargetFor", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("phren-edit-target-");
    grantAdmin(tmp.path);
    writeFile(path.join(tmp.path, "hub", "CLAUDE.md"), "# hub\n");
  });
  afterEach(() => tmp.cleanup());

  it("edits a skill's own file, using the path the list carries", () => {
    const skillPath = path.join(tmp.path, "global", "skills", "phren-sync", "SKILL.md");
    const target = editTargetFor(host(tmp.path, "Skills", "hub"), { name: "phren-sync", path: skillPath });
    expect(target).toEqual({ path: skillPath, label: "phren-sync", kind: "skill" });
  });

  it("edits the store's CLAUDE.md for a project, not a copy in the repo", () => {
    const target = editTargetFor(host(tmp.path, "Projects"), { name: "hub" });
    expect(target?.kind).toBe("claude");
    expect(target?.path).toBe(path.join(tmp.path, "hub", "CLAUDE.md"));
    expect(target?.label).toBe("hub/CLAUDE.md");
    // The store's copy is the real file the repo symlinks to.
    expect(fs.existsSync(target!.path)).toBe(true);
  });

  it("falls back to the active project when no row is selected", () => {
    const target = editTargetFor(host(tmp.path, "Projects", "hub"), undefined);
    expect(target?.path).toBe(path.join(tmp.path, "hub", "CLAUDE.md"));
  });

  it("offers a path for a CLAUDE.md that does not exist yet, so the editor can create it", () => {
    const target = editTargetFor(host(tmp.path, "Projects"), { name: "brand-new" });
    expect(target?.path).toBe(path.join(tmp.path, "brand-new", "CLAUDE.md"));
    expect(fs.existsSync(target!.path)).toBe(false);
  });

  it("declines when there is nothing editable", () => {
    // A skill row with no resolved path is the case that used to be recovered
    // by splitting a display string, which broke on paths containing the separator.
    expect(editTargetFor(host(tmp.path, "Skills", "hub"), { name: "x" })).toBeNull();
    expect(editTargetFor(host(tmp.path, "Projects"), undefined)).toBeNull();
    expect(editTargetFor(host(tmp.path, "Tasks", "hub"), { name: "x" })).toBeNull();
  });
});
