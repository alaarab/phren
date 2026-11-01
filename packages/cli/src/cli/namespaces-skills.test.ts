import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let phren = "";
let home = "";
let projects = "";
let cleanup: (() => void) | undefined;

beforeEach(() => {
  const tmp = makeTempDir("phren-skills-cli-");
  cleanup = tmp.cleanup;
  phren = path.join(tmp.path, ".phren");
  home = path.join(tmp.path, "home");
  projects = path.join(tmp.path, "projects");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(projects, "demo"), { recursive: true });
  initTestPhrenRoot(phren);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("PHREN_PATH", phren);
  vi.stubEnv("PROJECTS_DIR", projects);
  vi.stubEnv("PHREN_PROFILE", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cleanup?.();
  cleanup = undefined;
});

function writeSkill(root: string, name: string, content: string, format: "folder" | "flat" = "folder"): string {
  const file = format === "folder" ? path.join(root, name, "SKILL.md") : path.join(root, `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

async function run(args: string[]) {
  vi.resetModules();
  const { handleSkillsNamespace } = await import("./namespaces-skills.js");
  const logs: string[] = [];
  const errors: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    logs.push(values.map(String).join(" "));
  });
  const error = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    errors.push(values.map(String).join(" "));
  });
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    throw new ExitError(typeof code === "number" ? code : Number(code ?? 0));
  }) as never);
  let exitCode = 0;
  try {
    await handleSkillsNamespace(args, "");
  } catch (err) {
    if (err instanceof ExitError) exitCode = err.code;
    else throw err;
  } finally {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
  return { logs, errors, exitCode, out: logs.join("\n"), err: errors.join("\n") };
}

function globalSkill(name: string, content = `# ${name}\n`): string {
  return writeSkill(path.join(phren, "global", "skills"), name, content);
}

function projectSkill(project: string, name: string, content = `# ${name}\n`, format: "folder" | "flat" = "folder"): string {
  return writeSkill(path.join(phren, project, "skills"), name, content, format);
}

describe("phren skills", () => {
  it("lists global and project skills with their source, format and status", async () => {
    globalSkill("alpha", "---\ndescription: Alpha skill\n---\nAlpha body\n");
    projectSkill("demo", "beta", "# Beta\n", "flat");

    const result = await run(["list"]);

    expect(result.exitCode).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toMatch(/alpha\s+global\s+folder\s+\/alpha\s+enabled/);
    expect(result.out).toMatch(/beta\s+demo\s+flat\s+\/beta\s+enabled/);
    expect(result.out).toContain("2 skill(s) found.");
  });

  it("resolves a project's manifest through --project, preferring the project's copy and reporting the mirror", async () => {
    globalSkill("alpha", "# Global alpha\n");
    projectSkill("demo", "alpha", "# Project alpha\n");
    projectSkill("demo", "beta", "# Project beta\n", "flat");

    const result = await run(["list", "--project", "demo"]);

    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("Scope: demo");
    expect(result.out).toContain(`Mirror: ${path.join(projects, "demo", ".claude", "skills")}`);
    expect(result.out).toMatch(/\/alpha\s+alpha\s+demo\s+visible override:1/);
    expect(result.out).toMatch(/\/beta\s+beta\s+demo\s+visible/);
  });

  it("prints a skill's file verbatim for show", async () => {
    const content = "---\nname: alpha\ncommand: /a\n---\n# Alpha\n\nUse it carefully.\n";
    globalSkill("alpha", content);

    const result = await run(["show", "alpha"]);

    expect(result.exitCode).toBe(0);
    expect(result.logs).toEqual([content]);
    expect(result.err).toBe("");
  });

  it("refuses to show a skill that is not in the requested project", async () => {
    globalSkill("alpha");

    const result = await run(["show", "ghost", "--project", "demo"]);

    expect(result.exitCode).toBe(1);
    expect(result.logs).toEqual([]);
    expect(result.err).toContain('Skill not found: "ghost" in project "demo"');
  });

  it("links an added skill into the project, adding the .md extension", async () => {
    const source = path.join(projects, "incoming", "gamma-skill");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "# Gamma\n");

    const result = await run(["add", "demo", source]);

    const dest = path.join(phren, "demo", "skills", "gamma-skill.md");
    expect(result.exitCode).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toContain("into demo.");
    expect(fs.readFileSync(dest, "utf8")).toBe("# Gamma\n");
  });

  it("refuses to add a skill whose destination already exists and leaves it untouched", async () => {
    const dest = projectSkill("demo", "taken", "existing\n", "flat");
    const source = path.join(projects, "incoming", "taken.md");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "new\n");

    const result = await run(["add", "demo", source]);

    expect(result.exitCode).toBe(1);
    expect(result.err).toContain(`Skill already exists: ${dest}`);
    expect(result.logs).toEqual([]);
    expect(fs.readFileSync(dest, "utf8")).toBe("existing\n");
  });

  it("rejects an invalid project name and a source file that does not exist on add", async () => {
    const source = path.join(projects, "incoming", "gamma.md");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "# Gamma\n");

    const invalidProject = await run(["add", "Bad Name", source]);
    expect(invalidProject.exitCode).toBe(1);
    expect(invalidProject.err).toContain('Invalid project name: "Bad Name"');
    expect(fs.existsSync(path.join(phren, "Bad Name"))).toBe(false);

    const missing = path.join(projects, "incoming", "missing.md");
    const missingFile = await run(["add", "demo", missing]);
    expect(missingFile.exitCode).toBe(1);
    expect(missingFile.err).toContain(`Skill file not found: ${missing}`);

    const usage = await run(["add", "demo"]);
    expect(usage.exitCode).toBe(1);
    expect(usage.out).toContain("Usage:");
    expect(usage.out).toContain("phren skills add <project> <path>");
  });

  it("persists enable and disable for a global skill and names the wider scope", async () => {
    globalSkill("alpha");
    const prefsFile = path.join(phren, ".config", "skill-preferences.json");

    const enabled = await run(["enable", "global", "alpha"]);
    expect(enabled.exitCode).toBe(0);
    expect(enabled.out).toContain("Enabled skill alpha in global (all projects).");
    expect(JSON.parse(fs.readFileSync(prefsFile, "utf8")).enabledSkills).toMatchObject({ "global:alpha": true });

    const disabled = await run(["disable", "global", "alpha"]);
    expect(disabled.exitCode).toBe(0);
    expect(disabled.out).toContain("Disabled skill alpha in global (all projects).");
    expect(JSON.parse(fs.readFileSync(prefsFile, "utf8")).enabledSkills).toMatchObject({ "global:alpha": false });
  });

  it("refuses to toggle a missing skill or an invalid scope without writing preferences", async () => {
    globalSkill("alpha");
    const prefsFile = path.join(phren, ".config", "skill-preferences.json");

    const missing = await run(["enable", "global", "ghost"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.err).toContain('Skill not found: "ghost" in "global"');

    const invalidScope = await run(["disable", "Bad Scope", "alpha"]);
    expect(invalidScope.exitCode).toBe(1);
    expect(invalidScope.err).toContain('Invalid project name: "Bad Scope"');

    expect(fs.existsSync(prefsFile)).toBe(false);
  });

  it("removes folder and flat project skills while leaving siblings, and reports a missing one", async () => {
    const folder = path.join(phren, "demo", "skills", "delta");
    writeSkill(path.join(phren, "demo", "skills"), "delta", "# Delta\n");
    fs.writeFileSync(path.join(folder, "notes.txt"), "asset\n");
    const flat = projectSkill("demo", "epsilon", "# Epsilon\n", "flat");
    const sibling = projectSkill("demo", "zeta", "# Zeta\n", "flat");

    const removedFolder = await run(["remove", "demo", "delta"]);
    expect(removedFolder.exitCode).toBe(0);
    expect(removedFolder.out).toContain("Removed skill delta from demo.");
    expect(fs.existsSync(folder)).toBe(false);

    const removedFlat = await run(["remove", "demo", "epsilon"]);
    expect(removedFlat.exitCode).toBe(0);
    expect(fs.existsSync(flat)).toBe(false);
    expect(fs.readFileSync(sibling, "utf8")).toBe("# Zeta\n");

    const missing = await run(["remove", "demo", "ghost"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.err).toContain('Skill not found: "ghost" in project "demo"');
  });
});
