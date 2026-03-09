import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { bootstrapFromExisting, detectProjectDir, isProjectTracked } from "../init-setup.js";

describe("init setup onboarding helpers", () => {
  let tmp: { path: string; cleanup: () => void };
  let cortexPath: string;
  let projectRoot: string;

  beforeEach(() => {
    tmp = makeTempDir("init-setup-onboarding-");
    cortexPath = path.join(tmp.path, ".cortex");
    projectRoot = path.join(tmp.path, "app");
    fs.mkdirSync(path.join(cortexPath, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(cortexPath, "machines.yaml"), `${os.hostname()}: work\n`);
    fs.writeFileSync(path.join(cortexPath, "profiles", "personal.yaml"), "name: personal\nprojects:\n  - app-api\n");
    fs.writeFileSync(path.join(cortexPath, "profiles", "work.yaml"), "name: work\nprojects:\n  - global\n");
    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "CLAUDE.md"), "# app\n\nApp project.\n");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("detects the repo root from nested directories", () => {
    const nestedDir = path.join(projectRoot, "packages", "web");
    fs.mkdirSync(nestedDir, { recursive: true });
    expect(detectProjectDir(nestedDir, cortexPath)).toBe(projectRoot);
  });

  it("checks tracking against the active profile when provided", () => {
    expect(isProjectTracked(cortexPath, "app", "work")).toBe(false);
    expect(isProjectTracked(cortexPath, "app-api", "personal")).toBe(true);
  });

  it("adds the exact project to the selected profile without substring collisions", () => {
    const projectName = bootstrapFromExisting(cortexPath, projectRoot, "work");
    expect(projectName).toBe("app");

    const personal = fs.readFileSync(path.join(cortexPath, "profiles", "personal.yaml"), "utf8");
    const work = fs.readFileSync(path.join(cortexPath, "profiles", "work.yaml"), "utf8");

    expect(personal).toContain("app-api");
    expect(personal).not.toMatch(/\n\s*-\s+app\n/);
    expect(work).toMatch(/\n\s*-\s+app\n/);
  });

  it("falls back to the machine-mapped profile when none is provided", () => {
    const projectName = bootstrapFromExisting(cortexPath, projectRoot);

    expect(projectName).toBe("app");
    expect(fs.readFileSync(path.join(cortexPath, "profiles", "work.yaml"), "utf8")).toMatch(/\n\s*-\s+app\n/);
    expect(fs.readFileSync(path.join(cortexPath, "profiles", "personal.yaml"), "utf8")).not.toMatch(/\n\s*-\s+app\n/);
  });

  it("does not overwrite an existing summary when re-adding a project", () => {
    bootstrapFromExisting(cortexPath, projectRoot, "work");
    const summaryPath = path.join(cortexPath, "app", "summary.md");
    fs.writeFileSync(summaryPath, "# app\n\nCurated summary.\n");

    bootstrapFromExisting(cortexPath, projectRoot, "work");

    expect(fs.readFileSync(summaryPath, "utf8")).toContain("Curated summary.");
    expect(fs.readFileSync(summaryPath, "utf8")).not.toContain("Bootstrapped from");
  });

  it("does not overwrite an existing CLAUDE.md when re-adding a project", () => {
    bootstrapFromExisting(cortexPath, projectRoot, "work");
    const claudePath = path.join(cortexPath, "app", "CLAUDE.md");
    fs.writeFileSync(claudePath, "# app\n\nCurated cortex CLAUDE.\n");

    bootstrapFromExisting(cortexPath, projectRoot, "work");

    expect(fs.readFileSync(claudePath, "utf8")).toContain("Curated cortex CLAUDE.");
    expect(fs.readFileSync(claudePath, "utf8")).not.toContain("App project.");
  });
});
