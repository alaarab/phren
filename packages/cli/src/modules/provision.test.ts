import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../test-helpers.js";
import { initializeModules, setModuleEnabled } from "./config.js";
import { reconcileStarterSkills } from "./provision.js";
import { syncScopeSkillsToDir } from "../skill/files.js";

let tmp: ReturnType<typeof makeTempDir>;
const starter = fileURLToPath(new URL("../../starter/", import.meta.url));
beforeEach(() => { tmp = makeTempDir("module-starters-"); });
afterEach(() => tmp.cleanup());

it("removes only generated optional skills and their mirrors, then restores them", () => {
  const store = path.join(tmp.path, "store"), mirrors = path.join(tmp.path, "agent", "skills");
  initializeModules(store);
  setModuleEnabled(store, "hook", true);
  setModuleEnabled(store, "conductor", true);
  reconcileStarterSkills(store, starter);
  const skill = path.join(store, "global", "skills", "conductor", "SKILL.md");
  expect(fs.existsSync(skill)).toBe(true);
  syncScopeSkillsToDir(store, "global", mirrors);
  expect(fs.lstatSync(path.join(mirrors, "conductor")).isSymbolicLink()).toBe(true);
  fs.writeFileSync(path.join(mirrors, "personal.md"), "My own skill\n");
  setModuleEnabled(store, "conductor", false);
  reconcileStarterSkills(store, starter);
  syncScopeSkillsToDir(store, "global", mirrors);
  expect(fs.existsSync(skill)).toBe(false);
  expect(fs.existsSync(path.join(mirrors, "conductor"))).toBe(false);
  expect(fs.readFileSync(path.join(mirrors, "personal.md"), "utf8")).toBe("My own skill\n");
  setModuleEnabled(store, "conductor", true);
  reconcileStarterSkills(store, starter);
  syncScopeSkillsToDir(store, "global", mirrors);
  expect(fs.existsSync(skill)).toBe(true);
});

it("preserves edited starter files while suppressing their disabled owner's mirror", () => {
  initializeModules(tmp.path);
  setModuleEnabled(tmp.path, "hook", true);
  setModuleEnabled(tmp.path, "conductor", true);
  reconcileStarterSkills(tmp.path, starter);
  const skill = path.join(tmp.path, "global", "skills", "conductor", "SKILL.md");
  fs.appendFileSync(skill, "\nMy own workflow.\n");
  setModuleEnabled(tmp.path, "conductor", false);
  setModuleEnabled(tmp.path, "tasks", false);
  reconcileStarterSkills(tmp.path, starter);
  expect(fs.readFileSync(skill, "utf8")).toContain("My own workflow.");
  expect(fs.readFileSync(path.join(tmp.path, "global", "AGENTS.md"), "utf8")).not.toContain("get_tasks");
});
