import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const STARTER_ROOT = path.join(REPO_ROOT, "starter");
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

  it("keeps bundled example projects out of fresh starter profiles", () => {
    const bundledExamples = fs.readdirSync(STARTER_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !["global", "profiles", "templates"].includes(name))
      .sort();

    expect(bundledExamples.length).toBeGreaterThan(0);

    for (const project of bundledExamples) {
      const projectDir = path.join(STARTER_ROOT, project);
      for (const file of REQUIRED_TEMPLATE_FILES) {
        expect(fs.existsSync(path.join(projectDir, file)), `${project} is missing ${file}`).toBe(true);
      }
    }

    for (const profileFile of ["default.yaml", "personal.yaml", "work.yaml"]) {
      const parsed = yaml.load(
        fs.readFileSync(path.join(STARTER_ROOT, "profiles", profileFile), "utf8"),
        { schema: yaml.CORE_SCHEMA },
      ) as { projects?: unknown[] };
      const projects = (parsed.projects ?? []).map((entry) => String(entry));
      expect(projects).toContain("global");
      for (const example of bundledExamples) {
        expect(projects).not.toContain(example);
      }
    }
  });
});
