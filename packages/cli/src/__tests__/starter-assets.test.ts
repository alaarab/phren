import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

const CLI_ROOT = path.resolve(__dirname, "..", "..");
const STARTER_ROOT = path.join(CLI_ROOT, "starter");
const TEMPLATE_ROOT = path.join(STARTER_ROOT, "templates");
const REQUIRED_TEMPLATE_FILES = ["CLAUDE.md", "summary.md", "tasks.md", "FINDINGS.md"];

describe("shipped starter assets", () => {
  it("parses bundled profile YAML files and machines.yaml comments cleanly", () => {
    const profilesDir = path.join(STARTER_ROOT, "profiles");
    const profileFiles = ["default.yaml", "personal.yaml", "work.yaml"];

    for (const file of profileFiles) {
      const fullPath = path.join(profilesDir, file);
      const parsed = yaml.load(fs.readFileSync(fullPath, "utf8"), { schema: yaml.CORE_SCHEMA }) as {
        name?: unknown;
        description?: unknown;
        projects?: unknown;
      };
      expect(parsed).toBeTruthy();
      expect(typeof parsed.name).toBe("string");
      expect(Array.isArray(parsed.projects)).toBe(true);
      expect((parsed.projects as unknown[]).every((entry) => typeof entry === "string")).toBe(true);
    }

    const machines = yaml.load(fs.readFileSync(path.join(STARTER_ROOT, "machines.yaml"), "utf8"), {
      schema: yaml.CORE_SCHEMA,
    });
    expect(machines ?? {}).toEqual({});
  });

  it("ships only documented templates, and every template has the required files", () => {
    const actualTemplates = fs.readdirSync(TEMPLATE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const readme = fs.readFileSync(path.join(TEMPLATE_ROOT, "README.md"), "utf8");
    const documentedTemplates = (readme.match(/Each subdirectory \(([^)]+)\)/)?.[1] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .sort();

    expect(actualTemplates).toEqual(documentedTemplates);

    for (const template of actualTemplates) {
      const dir = path.join(TEMPLATE_ROOT, template);
      for (const file of REQUIRED_TEMPLATE_FILES) {
        expect(fs.existsSync(path.join(dir, file)), `${template} is missing ${file}`).toBe(true);
      }
    }
  });

  it("no longer bundles sample example project directories in the starter tree", () => {
    // packages/cli/starter/{my-api,my-frontend,my-first-project}/ used to ship
    // here (60 KB) but copyDir() in init/init.ts unconditionally skipped
    // exactly those three names, so they were never actually copied to
    // ~/.phren — dead weight, since removed. ensureProjectScaffold() (called
    // from init/init.ts) generates the real first-project content instead.
    // This assertion locks in the removal; LEGACY_SAMPLE_PROJECTS in
    // init/setup.ts still prunes the old names out of profiles left behind by
    // installs that predate this cleanup.
    const nonCoreEntries = fs.readdirSync(STARTER_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !["global", "profiles", "templates"].includes(name))
      .sort();

    expect(nonCoreEntries).toEqual([]);
  });

  it("keeps legacy example project names out of fresh starter profiles", () => {
    const legacyExampleNames = ["my-api", "my-frontend", "my-first-project"];

    for (const profileFile of ["default.yaml", "personal.yaml", "work.yaml"]) {
      const parsed = yaml.load(
        fs.readFileSync(path.join(STARTER_ROOT, "profiles", profileFile), "utf8"),
        { schema: yaml.CORE_SCHEMA },
      ) as { projects?: unknown[] };
      const projects = (parsed.projects ?? []).map((entry) => String(entry));
      expect(projects).toContain("global");
      for (const legacyName of legacyExampleNames) {
        expect(projects).not.toContain(legacyName);
      }
    }
  });
});
