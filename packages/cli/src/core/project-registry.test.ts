import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, initTestPhrenRoot } from "../test-helpers.js";
import {
  bootstrapFromExisting,
  ensureProjectScaffold,
  inferInitScaffoldFromRepo,
} from "./project-registry.js";
import { getProjectSourcePath, writeProjectConfig } from "../project-config.js";
import { setModuleEnabled } from "../modules/config.js";
import { FINDINGS_FILENAME, TASKS_FILENAME } from "../filenames.js";

describe("inferInitScaffoldFromRepo", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("project-registry-infer-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("returns null for a missing directory or one with no recognisable project files", () => {
    expect(inferInitScaffoldFromRepo(path.join(tmp.path, "missing"))).toBeNull();
    expect(inferInitScaffoldFromRepo(tmp.path)).toBeNull();
  });

  it("infers a non-software domain from a config marker", () => {
    fs.writeFileSync(path.join(tmp.path, "project.godot"), "");

    const inferred = inferInitScaffoldFromRepo(tmp.path);

    expect(inferred?.domain).toBe("game");
    expect(inferred?.topics.length).toBeGreaterThan(0);
  });

  it("uses the fallback domain when files exist but carry no domain signal", () => {
    fs.writeFileSync(path.join(tmp.path, "README.md"), "# Notes\n\nSome generic observations.\n");

    const inferred = inferInitScaffoldFromRepo(tmp.path, "music");

    expect(inferred?.domain).toBe("music");
    expect(inferred?.confidence).toBe(0);
    expect(inferred?.reason).toBe("fallback defaults");
  });
});

describe("ensureProjectScaffold", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenPath: string;

  beforeEach(() => {
    tmp = makeTempDir("project-registry-scaffold-");
    phrenPath = path.join(tmp.path, ".phren");
    initTestPhrenRoot(phrenPath);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("keeps curated project files when scaffolding an existing project", () => {
    const projectDir = path.join(phrenPath, "curated");
    fs.mkdirSync(projectDir, { recursive: true });
    const curated: Record<string, string> = {
      "summary.md": "# curated\n\nA hand-written summary.\n",
      "AGENTS.md": "# curated\n\nHand-written agent notes.\n",
      "topic-config.json": "{\"version\":1,\"domain\":\"music\",\"topics\":[]}\n",
      [FINDINGS_FILENAME]: "# curated findings\n\nA real finding.\n",
      [TASKS_FILENAME]: "# curated tasks\n\n## Active\n\n- Ship it\n",
    };
    for (const [name, content] of Object.entries(curated)) {
      fs.writeFileSync(path.join(projectDir, name), content);
    }

    ensureProjectScaffold(projectDir, "curated", "software");

    for (const [name, content] of Object.entries(curated)) {
      expect(fs.readFileSync(path.join(projectDir, name), "utf8")).toBe(content);
    }
  });

  it("writes the tasks file only when the tasks module is enabled", () => {
    const withoutTasks = path.join(phrenPath, "without-tasks");
    setModuleEnabled(phrenPath, "tasks", false);
    ensureProjectScaffold(withoutTasks, "without-tasks");
    expect(fs.existsSync(path.join(withoutTasks, TASKS_FILENAME))).toBe(false);

    const withTasks = path.join(phrenPath, "with-tasks");
    setModuleEnabled(phrenPath, "tasks", true);
    ensureProjectScaffold(withTasks, "with-tasks");
    expect(fs.existsSync(path.join(withTasks, TASKS_FILENAME))).toBe(true);
  });
});

describe("bootstrapFromExisting", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenPath: string;
  let repo: string;

  beforeEach(() => {
    tmp = makeTempDir("project-registry-bootstrap-");
    phrenPath = path.join(tmp.path, ".phren");
    initTestPhrenRoot(phrenPath);
    vi.stubEnv("PHREN_PATH", phrenPath);
    vi.stubEnv("HOME", path.join(tmp.path, "home"));
    vi.stubEnv("USERPROFILE", path.join(tmp.path, "home"));
    repo = path.join(tmp.path, "MyProject");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    tmp.cleanup();
  });

  it("rejects a source path that does not exist", () => {
    expect(() => bootstrapFromExisting(phrenPath, path.join(tmp.path, "missing"))).toThrow(/Path does not exist/);
  });

  it("refuses a requested name that differs from an existing project only by casing", () => {
    fs.mkdirSync(path.join(phrenPath, "app"), { recursive: true });

    expect(() => bootstrapFromExisting(phrenPath, repo, { projectName: "App" })).toThrow(/different casing/);
  });

  it("registers under an explicit project name and persists the source path", () => {
    const result = bootstrapFromExisting(phrenPath, repo, { projectName: "custom-name" });

    expect(result.project).toBe("custom-name");
    expect(fs.existsSync(path.join(phrenPath, "custom-name", "AGENTS.md"))).toBe(true);
    expect(getProjectSourcePath(phrenPath, "custom-name")).toBe(path.resolve(repo));
  });

  it("reuses a project already recorded at the same source path", () => {
    fs.mkdirSync(path.join(phrenPath, "legacy-name"), { recursive: true });
    writeProjectConfig(phrenPath, "legacy-name", { sourcePath: repo });

    const result = bootstrapFromExisting(phrenPath, repo);

    expect(result.project).toBe("legacy-name");
    expect(fs.existsSync(path.join(phrenPath, "myproject"))).toBe(false);
  });

  it("treats a corrupt project config as unrecorded when matching a slug sibling", () => {
    const sibling = path.join(phrenPath, "my-project");
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "phren.project.yaml"), "ownership: [unclosed\n");

    const result = bootstrapFromExisting(phrenPath, repo);

    expect(result.project).toBe("my-project");
    expect(fs.existsSync(path.join(phrenPath, "myproject"))).toBe(false);
    expect(getProjectSourcePath(phrenPath, "my-project")).toBe(path.resolve(repo));
  });

  it("limits a project-local install to its owning workspace", () => {
    const workspace = path.join(tmp.path, "app");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    initTestPhrenRoot(phrenPath, {
      installMode: "project-local",
      workspaceRoot: workspace,
      primaryProject: "app",
    });

    const result = bootstrapFromExisting(phrenPath, workspace);
    expect(result.project).toBe("app");

    const outside = path.join(tmp.path, "elsewhere");
    fs.mkdirSync(outside, { recursive: true });
    expect(() => bootstrapFromExisting(phrenPath, outside)).toThrow(/only enroll the owning workspace/);
  });

  it("refuses a different project name in a project-local install", () => {
    const workspace = path.join(tmp.path, "app");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    initTestPhrenRoot(phrenPath, {
      installMode: "project-local",
      workspaceRoot: workspace,
      primaryProject: "app",
    });

    expect(() => bootstrapFromExisting(phrenPath, workspace, { projectName: "other" })).toThrow(/only enroll app/);
  });
});
