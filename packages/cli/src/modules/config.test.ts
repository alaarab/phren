import { moduleSnapshot } from "./runtime.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../test-helpers.js";
import { initializeModules, migrateModules, setModuleEnabled } from "./config.js";
import { enabled, moduleSource, readConfig } from "./registry.js";

let tmp: ReturnType<typeof makeTempDir>;
beforeEach(() => { tmp = makeTempDir("module-config-"); });
afterEach(() => tmp.cleanup());
const names = (profile?: string) => enabled(tmp.path, profile).map(module => module.name);

describe("module configuration writes", () => {
  it("preserves unrelated overrides and distinguishes store and profile sources", () => {
    setModuleEnabled(tmp.path, "git", true);
    setModuleEnabled(tmp.path, "tasks", false, "personal");
    setModuleEnabled(tmp.path, "schedules", true, "work");
    expect(names()).toEqual(["memory", "git"]);
    expect(names("personal")).toEqual(["memory", "git"]);
    expect(names("work")).toEqual(["memory", "git", "schedules"]);
    const config = readConfig(tmp.path);
    expect(moduleSource(config, "memory", "work")).toBe("default");
    expect(moduleSource(config, "git", "work")).toBe("store");
    expect(moduleSource(config, "tasks", "personal")).toBe("profile");
    expect(fs.existsSync(path.join(tmp.path, ".config", "modules.yaml.lock"))).toBe(false);
  });

  it("rejects dependencies in every profile without changing bytes", () => {
    setModuleEnabled(tmp.path, "hook", true);
    setModuleEnabled(tmp.path, "conductor", true, "work");
    const file = path.join(tmp.path, ".config", "modules.yaml");
    const before = fs.readFileSync(file, "utf8");
    expect(() => setModuleEnabled(tmp.path, "hook", false)).toThrow('Module "conductor" requires enabled module "hook"');
    expect(() => setModuleEnabled(tmp.path, "memory", false)).toThrow("cannot be disabled");
    expect(() => setModuleEnabled(tmp.path, "code-map", true)).toThrow("Unknown module");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("does not silently enable a dependency or overwrite malformed YAML", () => {
    expect(() => setModuleEnabled(tmp.path, "conductor", true)).toThrow('requires enabled module "hook"');
    const file = path.join(tmp.path, ".config", "modules.yaml");
    fs.writeFileSync(file, "version: 2\n");
    expect(() => setModuleEnabled(tmp.path, "tasks", false)).toThrow("Invalid");
    expect(fs.readFileSync(file, "utf8")).toBe("version: 2\n");
  });

  it("honors explicit configuration during idempotent legacy migration", () => {
    initializeModules(tmp.path);
    migrateModules(tmp.path, true);
    expect(names()).toEqual(["memory"]);
    setModuleEnabled(tmp.path, "tasks", false);
    migrateModules(tmp.path, true);
    expect(names()).toEqual(["memory"]);
  });

  it("freezes legacy Hook surfaces and preserves optional data", () => {
    fs.mkdirSync(path.join(tmp.path, "demo"));
    fs.writeFileSync(path.join(tmp.path, "demo", "tasks.md"), "- [ ] Retained\n");
    migrateModules(tmp.path, true);
    expect(names()).toEqual(["memory", "tasks", "hook", "git", "schedules", "conductor"]);
    const file = path.join(tmp.path, ".config", "modules.yaml");
    const before = fs.readFileSync(file, "utf8");
    migrateModules(tmp.path, true);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readFileSync(path.join(tmp.path, ".runtime", "modules.yaml.migration-backup"), "utf8")).toBe(before);
    expect(fs.existsSync(file + ".migration-backup")).toBe(false);
    setModuleEnabled(tmp.path, "tasks", false);
    expect(fs.readFileSync(path.join(tmp.path, "demo", "tasks.md"), "utf8")).toContain("Retained");
  });

  it("writes nothing while the store is mid-rebase", () => {
    fs.mkdirSync(path.join(tmp.path, ".git", "rebase-merge"), { recursive: true });
    migrateModules(tmp.path, true);
    expect(fs.readdirSync(tmp.path)).toEqual([".git"]);
  });
});


it("keeps an unbound legacy Hook host-only without creating a store", () => {
  const snapshot = moduleSnapshot(tmp.path, "", true);
  expect(snapshot.has("hook")).toBe(true);
  expect(snapshot.has("memory")).toBe(false);
  expect(snapshot.has("tasks")).toBe(false);
  expect(fs.readdirSync(tmp.path)).toEqual([]);
});


it("keeps snapshots read-only until legacy runtime activation", async () => {
  // An initialized legacy store: the marker file plus the .config directory
  // every set-up store has. A store without .config is never migrated.
  fs.writeFileSync(path.join(tmp.path, "phren.root.yaml"), "version: 1\n");
  fs.mkdirSync(path.join(tmp.path, ".config"), { recursive: true });
  expect(moduleSnapshot(tmp.path, "").has("git")).toBe(false);
  expect(fs.existsSync(path.join(tmp.path, ".config", "modules.yaml"))).toBe(false);
  const { activateModules } = await import("./runtime.js");
  expect(activateModules(tmp.path, "").has("git")).toBe(true);
});


it("freezes omitted legacy tasks without changing profile overrides", async () => {
  fs.mkdirSync(path.join(tmp.path, ".config"));
  const file = path.join(tmp.path, ".config", "modules.yaml");
  fs.writeFileSync(file, "version: 1\nenabled:\n  code: true\nprofiles:\n  personal:\n    enabled:\n      tasks: false\n");
  const { activateModules } = await import("./runtime.js");
  expect(activateModules(tmp.path, "").modules.map(module => module.name)).toEqual(["memory", "tasks", "code"]);
  expect(activateModules(tmp.path, "personal").has("tasks")).toBe(false);
  const frozen = fs.readFileSync(file, "utf8");
  activateModules(tmp.path, "");
  expect(fs.readFileSync(file, "utf8")).toBe(frozen);
});
